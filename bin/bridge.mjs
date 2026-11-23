#!/usr/bin/env node
import { options } from '../src/config.mjs';
import { serveMcp } from '../src/mcp.mjs';
import { startDaemon } from '../src/daemon.mjs';
import { ensureRuntime, readRuntime, api } from '../src/runtime.mjs';

try {
  const config = options();
  if (config.mode === 'help') console.log(`Antigravity Codex Bridge\n\nnode bin/bridge.mjs [mcp|doctor|stop]\n  --allow-root PATH      Allowed project directory (repeatable)\n  --state-dir PATH       Shared state/discovery directory\n  --codex PATH           Codex executable (default: codex)\n  --codex-arg ARG        Argument before app-server (repeatable)\n  --request-timeout MS   App-server request timeout (default: 30000)\n\nMCP stdout contains only JSON-RPC. Codex auth stays in your local Codex account.\nUse the same roots, command and state-dir in every MCP/extension client.`);
  else if (config.mode === 'mcp') await serveMcp(config);
  else if (config.mode === 'daemon') {
    const daemon = await startDaemon(config);
    const close = () => daemon.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    process.once('SIGINT', close); process.once('SIGTERM', close);
    console.error('Codex bridge daemon ready (loopback only)');
  } else if (config.mode === 'doctor') console.log(JSON.stringify(await api(await ensureRuntime(config), 'codex_diagnose'), null, 2));
  else if (config.mode === 'stop') {
    const runtime = await readRuntime(config.stateDir);
    const res = await fetch(runtime.url + '/shutdown', { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}` } });
    if (!res.ok) throw new Error(`Shutdown failed: HTTP ${res.status}`);
    console.log('Bridge stopped.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
