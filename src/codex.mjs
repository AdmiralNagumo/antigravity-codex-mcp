import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { resolveCommand } from './config.mjs';

export class CodexClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
    this.readyPromise = null;
    this.closed = false;
  }
  async start() {
    if (this.closed) throw new Error('Codex process was closed; restart the bridge');
    return this.readyPromise ??= this.connect().catch(error => {
      this.close();
      throw error;
    });
  }
  async connect() {
    const launch = resolveCommand(this.config.command, [...this.config.commandArgs, 'app-server']);
    this.child = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, CODEX_BRIDGE_CHILD: '1' },
    });
    this.child.stdin.on('error', () => {});
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => { this.stderr = (this.stderr + text).slice(-6000); });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.emit('diagnostic', `Invalid app-server message: ${error.message}`); }
    });
    const fail = error => {
      this.closed = true;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
      this.emit('disconnect', error.message);
    };
    this.child.once('error', error => fail(new Error(`Could not start Codex: ${error.message}`)));
    this.child.once('exit', (code, signal) => fail(new Error(`Codex exited (${code ?? signal}). Check the daemon log and codex login status.`)));
    const result = await this.request('initialize', {
      clientInfo: { name: 'antigravity_codex_bridge', title: 'Antigravity Codex Bridge', version: '0.1.0' },
      capabilities: {},
    });
    this.write({ method: 'initialized', params: {} });
    return result;
  }
  write(message) {
    if (this.closed || !this.child?.stdin.writable) throw new Error('Codex app-server is not connected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex ${method} timed out; completion is unknown. Query the conversation before retrying.`);
        error.uncertain = true;
        reject(error);
      }, this.config.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id, result, error) {
    this.write(error ? { id, error } : { id, result });
  }
  receive(message) {
    if (message.method && message.id !== undefined) this.emit('request', message);
    else if (message.method) this.emit('notification', message);
    else {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else item.resolve(message.result);
    }
  }
  close() {
    if (this.child && !this.child.killed) {
      this.child.stdin.end();
      // The npm wrapper forwards signals; direct executables are supported too.
      this.child.kill();
    }
    this.lines?.close();
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Codex client closed')); }
    this.pending.clear();
  }
}
