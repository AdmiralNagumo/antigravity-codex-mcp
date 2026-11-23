import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';

test('extension selects the requested conversation after the webview is ready', async () => {
  const commands = new Map(), panels = [];
  let poll, openConversation = 'requested-thread', openSequence = 1;
  const vscode = {
    workspace: { isTrusted: true, getConfiguration: () => ({ get: key => key === 'autoOpen' ? true : '/state' }) },
    ViewColumn: { Beside: 2 },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; } },
    window: {
      showErrorMessage: message => assert.fail(message),
      createWebviewPanel: () => {
        const panel = {
          posted: [], reveal() {},
          onDidDispose(fn) { this.dispose = fn; },
          webview: {
            onDidReceiveMessage(fn) { panel.receive = fn; },
            async postMessage(message) { panel.posted.push(message); return true; },
          },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  const require = createRequire(import.meta.url);
  const sandbox = {
    module: { exports: {} }, URL, AbortSignal,
    setInterval: fn => { poll = fn; return 1; }, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({ open_sequence: openSequence, open_conversation: openConversation }) }),
    require: name => name === 'vscode' ? vscode : name === 'node:fs/promises' ? {
      readFile: async filename => filename.endsWith('runtime.json')
        ? JSON.stringify({ url: 'http://127.0.0.1:1234', token: 'a'.repeat(64) })
        : '<head><style></style></head><script></script>',
    } : require(name),
  };
  vm.runInNewContext(await fs.readFile(new URL('../extension/extension.cjs', import.meta.url), 'utf8'), sandbox);
  sandbox.module.exports.activate({ extensionPath: '/extension', subscriptions: [] });
  await poll();
  const first = panels[0];
  assert.equal(first.posted.length, 0, 'selection must wait for the webview listener');
  await first.receive({ jsonrpc: '2.0', method: 'bridge/ready' });
  assert.equal(first.posted.at(-1).params.conversation_id, 'requested-thread');
  openConversation = 'another-thread'; openSequence++;
  await poll();
  assert.equal(first.posted.at(-1).params.conversation_id, 'another-thread');
  first.dispose();
  await commands.get('codexBridge.open')();
  const second = panels[1];
  await first.receive({ jsonrpc: '2.0', method: 'bridge/ready' });
  assert.equal(second.posted.length, 0, 'disposed webviews cannot select a new panel');
  await second.receive({ jsonrpc: '2.0', method: 'bridge/ready' });
  assert.equal(second.posted.at(-1).params.conversation_id, 'another-thread');
});
