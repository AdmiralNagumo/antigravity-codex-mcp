export const UI_URI = 'ui://antigravity-codex/conversation.html';
const str = (description, extra = {}) => ({ type: 'string', minLength: 1, description, ...extra });
const id = str('Bridge conversation_id returned by codex_start/resume/list');
const prompt = str('Task or follow-up instructions. Include scope and acceptance criteria.', { maxLength: 100000 });
const requestId = str('Stable idempotency key. Reuse the SAME key and arguments when retrying.', { maxLength: 200 });
function tool(name, description, properties, required = [], readOnly = false) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true } };
}
export const TOOLS = [
  tool('codex_open', 'Open the embedded Codex conversation side panel. Pass a conversation_id or omit it for the session list. On IDE, the companion extension opens the same conversation.', { conversation_id: id }),
  tool('codex_start', 'Delegate a coding task to Codex and open its conversation. Returns immediately; MUST use codex_read/wait until a terminal status before reporting completion. One active turn per project. Uses the local Codex login.', {
    cwd: str('Absolute project directory inside an allowed root'), prompt, title: str('Short conversation title', { maxLength: 160 }),
    model: str('Optional Codex model id; omit to use local settings'), sandbox: { type: 'string', enum: ['read-only', 'workspace-write'], default: 'workspace-write' }, request_id: requestId,
  }, ['cwd', 'prompt', 'request_id']),
  tool('codex_send', 'Send a follow-up in the SAME Codex conversation, preserving context. mode=next starts a new turn after completion; mode=steer adds instructions to a running turn. Do not retry unknown mutations with a new request_id.', {
    conversation_id: id, prompt, mode: { type: 'string', enum: ['next', 'steer'], default: 'next' }, request_id: requestId,
  }, ['conversation_id', 'prompt', 'request_id']),
  tool('codex_list', 'List bridge-managed Codex conversations, their states and configured project roots.', {}, [], true),
  tool('codex_read', 'Read bounded conversation messages, execution events and pending approvals. after is an event cursor; follow next_cursor when has_more is true.', {
    conversation_id: id, after: { type: 'integer', minimum: 0, default: 0 },
  }, ['conversation_id'], true),
  tool('codex_wait', 'Wait up to 20 seconds for new events or completion, then return conversation state. Continue waiting if status remains running/starting. waiting_approval requires attention.', {
    conversation_id: id, after: { type: 'integer', minimum: 0, default: 0 }, timeout_ms: { type: 'integer', minimum: 0, maximum: 20000, default: 15000 },
  }, ['conversation_id'], true),
  tool('codex_resume', 'Import/resume an existing Codex thread by its exact thread_id and open the panel. Never attach to a conversation being controlled by another client.', { thread_id: str('Existing Codex thread id') }, ['thread_id']),
  tool('codex_cancel', 'Request interruption of the current Codex turn. File edits already made are retained. Query state until cancelled/completed.', { conversation_id: id }, ['conversation_id']),
  tool('codex_respond', 'Answer a pending Codex approval or user-input request. Only accept actions within user authorization. Read pending_requests first; approvals are never auto-accepted.', {
    conversation_id: id, request_id: str('Exact pending request_id'), decision: { type: 'string', enum: ['accept', 'decline', 'cancel'] },
    answers: { type: 'object', description: 'For user-input requests: {questionId: {answers: ["answer"]}}', additionalProperties: { type: 'object', properties: { answers: { type: 'array', items: { type: 'string' } } }, required: ['answers'], additionalProperties: false } },
  }, ['conversation_id', 'request_id']),
  tool('codex_models', 'List available models from the configured Codex account.', {}, [], true),
  tool('codex_diagnose', 'Check the bridge and app-server handshake without starting a model turn. Never returns auth tokens.', {}, [], true),
];
TOOLS[0]._meta = { ui: { resourceUri: UI_URI, visibility: ['model', 'app'] },
  'com.google.antigravity/ui': { entrypoints: [{ type: 'aux_pane', title: 'Codex Conversations' }, { type: 'global', title: 'Codex Conversations' }] } };

export function validate(schema, value, at = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} must be an object`);
    for (const key of schema.required || []) if (value[key] === undefined) throw new Error(`${at}.${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child) validate(child, v, `${at}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`Unknown argument: ${at}.${key}`);
      else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, `${at}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${at} must be an array`);
    value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || 100000)) throw new Error(`${at} must be a valid string`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${at} is outside the permitted integer range`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at} must be one of: ${schema.enum.join(', ')}`);
}

export async function dispatch(manager, name, args = {}) {
  const definition = TOOLS.find(t => t.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  validate(definition.inputSchema, args);
  switch (name) {
    case 'codex_open': return manager.open(args);
    case 'codex_start': return manager.start(args);
    case 'codex_send': return manager.send(args);
    case 'codex_list': return manager.list();
    case 'codex_read': return manager.read(args);
    case 'codex_wait': {
      const end = Date.now() + (args.timeout_ms ?? 15000);
      while (Date.now() < end) {
        const s = manager.get(args.conversation_id);
        if (s.cursor > (args.after ?? 0) || !['running', 'starting'].includes(s.status)) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(200, end - Date.now())));
      }
      return manager.read(args);
    }
    case 'codex_resume': return manager.resume(args);
    case 'codex_cancel': return manager.cancel(args);
    case 'codex_respond': return manager.respond(args);
    case 'codex_models': await manager.client.start(); return manager.client.request('model/list', {});
    case 'codex_diagnose': {
      const handshake = await manager.client.start();
      return { ok: true, codex: handshake, roots: manager.config.roots, conversations: manager.sessions.size };
    }
  }
}
