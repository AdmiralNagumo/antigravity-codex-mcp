import fs from 'node:fs/promises';
import { TOOLS, UI_URI } from './tools.mjs';
import { ensureRuntime, api, health } from './runtime.mjs';
import { ORCHESTRATOR_INSTRUCTIONS, WORKFLOW_TEXT, WORKFLOW_URI, WORKFLOW_PROMPT } from './orchestration.mjs';
import { VERSION } from './version.mjs';

export async function serveMcp(config, input = process.stdin, output = process.stdout) {
  let initialized = false;
  let ready = false;
  let buffer = '';
  let runtime;
  const write = obj => output.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  const versions = ['2025-11-25', '2025-06-18', '2024-11-05'];
  const handle = async msg => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      write({ id: msg?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request' } }); return;
    }
    if (msg.id === undefined) {
      if (msg.method === 'notifications/initialized' && initialized) ready = true;
      // Cancellation ends the MCP wait; actual Codex turns are explicitly
      // cancelled through codex_cancel, so losing a UI does not kill work.
      return;
    }
    try {
      let result;
      if (msg.method === 'initialize') {
        if (initialized) throw new Error('Already initialized');
        initialized = true;
        const extensions = msg.params?.capabilities?.extensions || {};
        result = { protocolVersion: versions.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : versions[0],
          serverInfo: { name: 'antigravity-codex-mcp', version: VERSION },
          capabilities: { tools: {}, resources: {}, prompts: {}, ...(extensions['io.modelcontextprotocol/ui'] ? { extensions: { 'io.modelcontextprotocol/ui': {} } } : {}) },
          instructions: ORCHESTRATOR_INSTRUCTIONS };
      } else if (msg.method === 'ping') result = {};
      else {
        if (!ready) throw new Error('MCP initialization handshake is incomplete');
        switch (msg.method) {
          case 'tools/list': result = { tools: TOOLS }; break;
          case 'resources/list': result = { resources: [
            { uri: WORKFLOW_URI, name: 'Antigravity directs Codex', mimeType: 'text/markdown', description: 'Understand user intent, delegate, verify, and explain the outcome in plain language' },
            { uri: UI_URI, name: 'Codex Conversations', mimeType: 'text/html;profile=mcp-app', description: 'Optional technical conversation panel' },
          ] }; break;
          case 'resources/templates/list': result = { resourceTemplates: [] }; break;
          case 'resources/read':
            if (msg.params?.uri === WORKFLOW_URI) {
              result = { contents: [{ uri: WORKFLOW_URI, mimeType: 'text/markdown', text: WORKFLOW_TEXT }] }; break;
            }
            if (msg.params?.uri !== UI_URI) throw Object.assign(new Error('Unknown resource'), { rpcCode: -32002 });
            result = { contents: [{ uri: UI_URI, mimeType: 'text/html;profile=mcp-app', text: await fs.readFile(new URL('../ui/conversation.html', import.meta.url), 'utf8'), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } } }] };
            break;
          case 'prompts/list': result = { prompts: [{ name: WORKFLOW_PROMPT, description: 'Let Antigravity interpret your request, direct Codex, verify results and explain them clearly' }] }; break;
          case 'prompts/get':
            if (msg.params?.name !== WORKFLOW_PROMPT) throw Object.assign(new Error('Unknown prompt'), { rpcCode: -32602 });
            if (msg.params.arguments && Object.keys(msg.params.arguments).length) throw new Error('This prompt takes no arguments; use the current user request');
            result = { description: 'Antigravity is the primary collaborator; Codex implements.', messages: [{ role: 'user', content: { type: 'text', text: ORCHESTRATOR_INSTRUCTIONS } }] }; break;
          case 'tools/call':
            try {
              if (!runtime || !await health(runtime)) runtime = await ensureRuntime(config);
              const data = await api(runtime, msg.params?.name, msg.params?.arguments || {});
              result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
            } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
            break;
          default: throw Object.assign(new Error(`Unknown method: ${msg.method}`), { rpcCode: -32601 });
        }
      }
      write({ id: msg.id, result });
    } catch (error) { write({ id: msg.id, error: { code: error.rpcCode || -32602, message: error.message } }); }
  };
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { buffer = ''; write({ id: null, error: { code: -32700, message: 'MCP input exceeds 8 MiB' } }); return; }
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { void handle(JSON.parse(line)); }
      catch { write({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); }
    }
  });
  // The detached daemon intentionally survives an MCP connection closing.
  return new Promise(resolve => input.once('end', resolve));
}
