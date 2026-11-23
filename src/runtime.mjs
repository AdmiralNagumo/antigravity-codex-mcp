import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.mjs';
const entrypoint = fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function readRuntime(stateDir) {
  const value = JSON.parse(await fs.readFile(path.join(stateDir, 'runtime.json'), 'utf8'));
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('Invalid bridge discovery file');
  return value;
}
export async function api(runtime, name, args = {}) {
  const response = await fetch(runtime.url + '/api/tool', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.token}` },
    body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(90000),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || `Bridge HTTP ${response.status}`);
  return result;
}
export async function health(runtime) {
  try {
    const res = await fetch(runtime.url + '/health', { headers: { Authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch { return false; }
}
export async function ensureRuntime(config) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  try {
    const existing = await readRuntime(config.stateDir);
    if (await health(existing)) { await checkConfig(existing, config); return existing; }
  } catch (error) { if (error.message.startsWith('Bridge is already')) throw error; }
  const lockDir = path.join(config.stateDir, 'startup.lock');
  const deadline = Date.now() + 15000;
  let ownsLock = false;
  while (Date.now() < deadline) {
    try { await fs.mkdir(lockDir); ownsLock = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { const r = await readRuntime(config.stateDir); if (await health(r)) { await checkConfig(r, config); return r; } }
      catch (e) { if (e.message.startsWith('Bridge is already')) throw e; }
      await sleep(150);
    }
  }
  if (!ownsLock) throw new Error(`Bridge startup lock is busy: ${lockDir}. If a previous startup crashed, remove only this empty startup.lock directory.`);
  try {
    try { const r = await readRuntime(config.stateDir); if (await health(r)) { await checkConfig(r, config); return r; } }
    catch (e) { if (e.message.startsWith('Bridge is already')) throw e; }
    const args = [entrypoint, 'daemon', '--state-dir', config.stateDir, '--codex', config.command,
      '--request-timeout', String(config.requestTimeout)];
    for (const root of config.roots) args.push('--allow-root', root);
    for (const arg of config.commandArgs) args.push('--codex-arg', arg);
    const logfile = await fs.open(path.join(config.stateDir, 'daemon.log'), 'a', 0o600);
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ['ignore', logfile.fd, logfile.fd] });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.unref();
    await logfile.close();
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if (spawnError) throw spawnError;
      try { const r = await readRuntime(config.stateDir); if (await health(r)) { await checkConfig(r, config); return r; } }
      catch (e) { if (e.message.startsWith('Bridge is already')) throw e; }
      await sleep(150);
    }
    throw new Error(`Bridge daemon did not start. See ${path.join(config.stateDir, 'daemon.log')}`);
  } finally { await fs.rmdir(lockDir); }
}
async function checkConfig(runtime, config) {
  const res = await fetch(runtime.url + '/config', { headers: { Authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(2000) });
  const actual = await res.json();
  if (actual.version !== VERSION) {
    throw new Error('Bridge is already running a different version. Stop the old daemon with the configured --state-dir, then refresh the MCP connection to load the updated tools.');
  }
  if (JSON.stringify(actual.roots) !== JSON.stringify(config.roots) || actual.command !== config.command || JSON.stringify(actual.commandArgs) !== JSON.stringify(config.commandArgs)) {
    throw new Error('Bridge is already running with different allowed roots or Codex command. Stop it before changing configuration, or use a separate --state-dir.');
  }
}
