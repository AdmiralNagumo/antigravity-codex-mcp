import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { allowedDirectory } from './config.mjs';

const active = new Set(['running', 'starting', 'waiting_approval', 'unknown']);
const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
function fingerprint(value) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function bounded(items, budget, latest = false) {
  const output = []; let size = 0;
  for (const original of latest ? [...items].reverse() : items) {
    const item = typeof original.text === 'string' && original.text.length > 18000
      ? { ...original, text: original.text.slice(0, 18000) + '\n[Message truncated in panel; full history remains in Codex]', truncated: true } : original;
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (size + bytes > budget) break;
    size += bytes; output.push(item);
  }
  return latest ? output.reverse() : output;
}
export class Manager {
  constructor(config, client) {
    this.config = config;
    this.client = client;
    this.sessions = new Map();
    this.requests = new Map();
    this.operations = new Map();
    this.locks = new Map();
    this.openSequence = 0;
    this.openConversation = null;
    this.flushChain = Promise.resolve();
    client.on('notification', msg => this.notification(msg));
    client.on('request', msg => this.serverRequest(msg));
    client.on('disconnect', reason => {
      if (this.closing) return;
      this.requests.clear();
      for (const s of this.sessions.values()) {
        s.loaded = false;
        s.pendingRequests = [];
        if (active.has(s.status)) { s.status = 'disconnected'; this.event(s, 'disconnect', { message: reason }); }
      }
    });
  }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.config.stateDir, 'sessions.json'), 'utf8'));
      for (const session of data.sessions || []) {
        session.loaded = false;
        session.pendingRequests = [];
        if (active.has(session.status)) session.status = 'disconnected';
        this.sessions.set(session.id, session);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read session state: ${error.message}`); }
  }
  save() {
    this.flushChain = this.flushChain.catch(() => {}).then(async () => {
      const filename = path.join(this.config.stateDir, 'sessions.json');
      const temp = filename + '.tmp';
      await fs.writeFile(temp, JSON.stringify({ version: 1, sessions: [...this.sessions.values()] }), { mode: 0o600 });
      await fs.rename(temp, filename);
    });
    this.flushChain.catch(error => { console.error(`Session persistence failed: ${error.message}`); });
    return this.flushChain;
  }
  event(s, type, data = {}) {
    if (this.closing) return;
    s.updatedAt = new Date().toISOString();
    s.events.push({ cursor: ++s.cursor, type, data, at: s.updatedAt });
    if (s.events.length > 400) s.events.splice(0, s.events.length - 400);
    if (s.messages.length > 800) s.messages.splice(0, s.messages.length - 800);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 150);
  }
  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown conversation: ${id}. Use codex_list or codex_resume.`);
    allowedDirectory(s.cwd, this.config.roots);
    return s;
  }
  summary(s) {
    return { conversation_id: s.id, thread_id: s.threadId, title: s.title, cwd: s.cwd, status: s.status,
      turn_id: s.turnId, model: s.model, created_at: s.createdAt, updated_at: s.updatedAt, cursor: s.cursor,
      pending_requests: s.pendingRequests, error: s.error || null };
  }
  async locked(id, fn) {
    if (this.locks.has(id)) throw new Error('Another operation is in progress for this conversation; query its state before retrying');
    this.locks.set(id, true);
    try { return await fn(); } finally { this.locks.delete(id); }
  }
  async idempotent(name, args, fn) {
    const requestId = args.request_id;
    if (!requestId) return fn();
    const key = name + ':' + requestId;
    const digest = fingerprint(args);
    for (const s of this.sessions.values()) {
      const previous = (s.receipts || []).find(r => r.key === key);
      if (previous) {
        if (previous.fingerprint !== digest) throw new Error('request_id was already used with different arguments');
        return { ...this.summary(s), deduplicated: true };
      }
    }
    const pending = this.operations.get(key);
    if (pending) {
      if (pending.fingerprint !== digest) throw new Error('request_id was already used with different arguments');
      return pending.promise;
    }
    const promise = fn().then(async result => {
      const s = this.get(result.conversation_id);
      s.receipts ??= [];
      if (!s.receipts.some(r => r.key === key)) s.receipts.push({ key, fingerprint: digest });
      s.receipts = s.receipts.slice(-100);
      await this.save();
      return result;
    });
    this.operations.set(key, { fingerprint: digest, promise });
    try { return await promise; } finally { this.operations.delete(key); }
  }
  recordIntent(s, name, args) {
    if (!args.request_id) return;
    const key = name + ':' + args.request_id;
    if (!(s.receipts || []).some(r => r.key === key)) {
      s.receipts ??= [];
      s.receipts.push({ key, fingerprint: fingerprint(args) });
      s.receipts = s.receipts.slice(-100);
    }
  }
  list() {
    return { conversations: [...this.sessions.values()].filter(s => {
      try { allowedDirectory(s.cwd, this.config.roots); return true; } catch { return false; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(s => this.summary(s)),
    open_sequence: this.openSequence, open_conversation: this.openConversation, allowed_roots: this.config.roots };
  }
  async start(args) {
    return this.idempotent('start', args, async () => {
      const cwd = allowedDirectory(args.cwd, this.config.roots);
      if (this.locks.has('workspace:' + cwd)) throw new Error('This workspace already has a task starting. Query codex_list before retrying.');
      this.locks.set('workspace:' + cwd, true);
      try {
      this.checkWorkspace(cwd);
      await this.client.start();
      const result = await this.client.request('thread/start', {
        cwd, ...(args.model ? { model: args.model } : {}),
        approvalPolicy: 'on-request', sandbox: args.sandbox || 'workspace-write',
      });
      if (!result.thread?.id) throw new Error('Codex did not return a thread id');
      const now = new Date().toISOString();
      const s = { id: randomUUID(), threadId: result.thread.id, cwd, model: args.model || result.model || null, sandbox: args.sandbox || 'workspace-write',
        title: args.title || args.prompt.slice(0, 60), status: 'idle', createdAt: now, updatedAt: now,
        turnId: null, cursor: 0, messages: [], events: [], pendingRequests: [], receipts: [], loaded: true };
      this.sessions.set(s.id, s);
      this.recordIntent(s, 'start', args);
      this.event(s, 'conversation_created');
      await this.save();
      await this.turn(s, args.prompt);
      this.openConversation = s.id;
      this.openSequence++;
      return this.summary(s);
      } finally { this.locks.delete('workspace:' + cwd); }
    });
  }
  checkWorkspace(cwd, ownId) {
    if ([...this.sessions.values()].some(s => s.id !== ownId && s.cwd === cwd && active.has(s.status))) {
      throw new Error('This workspace already has an active Codex turn. Wait, cancel it, or use a separate worktree.');
    }
  }
  async turn(s, prompt) {
    this.checkWorkspace(s.cwd, s.id);
    s.status = 'starting';
    s.error = null;
    s.messages.push({ id: randomUUID(), role: 'user', text: prompt, at: new Date().toISOString() });
    this.event(s, 'user_message', { text: prompt });
    // Persist intent before sending a mutation. On a timeout its result is
    // deliberately unknown, never silently re-submitted.
    await this.save();
    try {
      const result = await this.client.request('turn/start', { threadId: s.threadId, input: [{ type: 'text', text: prompt }] });
      s.turnId = result.turn.id;
      if (s.status === 'starting') s.status = 'running';
      await this.save();
    } catch (error) {
      s.status = error.uncertain ? 'unknown' : 'failed';
      s.error = error.message;
      this.event(s, 'error', { message: error.message });
      await this.save();
      // Return the existing conversation id so callers can inspect uncertainty.
    }
  }
  async ensureLoaded(s) {
    await this.client.start();
    if (!s.loaded) {
      const result = await this.client.request('thread/resume', { threadId: s.threadId, cwd: s.cwd, approvalPolicy: 'on-request', sandbox: s.sandbox || 'workspace-write' });
      s.loaded = true;
      this.hydrate(s, result.thread);
      if (s.status === 'disconnected') s.status = 'idle';
    }
  }
  async send(args) {
    return this.idempotent('send', args, () => this.locked(args.conversation_id, async () => {
      const s = this.get(args.conversation_id);
      await this.ensureLoaded(s);
      if (args.mode === 'steer') {
        if (s.status !== 'running' || !s.turnId) throw new Error('Steer requires a running turn');
        this.recordIntent(s, 'send', args);
        await this.save();
        try {
          await this.client.request('turn/steer', { threadId: s.threadId, expectedTurnId: s.turnId, input: [{ type: 'text', text: args.prompt }] });
        } catch (error) {
          if (error.uncertain) { s.status = 'unknown'; s.error = error.message; await this.save(); }
          throw error;
        }
        s.messages.push({ id: randomUUID(), role: 'user', text: args.prompt, at: new Date().toISOString(), steering: true });
        this.event(s, 'steered', { text: args.prompt });
      } else {
        if (active.has(s.status)) throw new Error('Conversation is active. Use mode=steer, wait, or cancel; do not submit a duplicate turn.');
        this.recordIntent(s, 'send', args);
        await this.save();
        await this.turn(s, args.prompt);
      }
      await this.save();
      return this.summary(s);
    }));
  }
  async resume(args) {
    await this.client.start();
    let s = [...this.sessions.values()].find(x => x.threadId === args.thread_id);
    if (!s) {
      const read = await this.client.request('thread/read', { threadId: args.thread_id, includeTurns: true });
      const cwd = allowedDirectory(read.thread.cwd, this.config.roots);
      const now = new Date().toISOString();
      s = { id: randomUUID(), threadId: args.thread_id, cwd, model: read.thread.model || null,
        title: read.thread.name || read.thread.preview || 'Resumed Codex conversation', status: 'idle',
        createdAt: now, updatedAt: now, turnId: null, cursor: 0, messages: [], events: [], pendingRequests: [], receipts: [], loaded: false };
      this.hydrate(s, read.thread);
      this.sessions.set(s.id, s);
    }
    allowedDirectory(s.cwd, this.config.roots);
    await this.locked(s.id, async () => { await this.ensureLoaded(s); });
    await this.save();
    return this.open({ conversation_id: s.id });
  }
  hydrate(s, thread) {
    if (s.messages.length || !thread?.turns?.length) return;
    for (const turn of thread.turns) for (const item of turn.items || []) {
      const role = item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' ? 'assistant' : null;
      if (role) s.messages.push({ id: item.id || randomUUID(), role,
        text: item.text || (item.content || []).map(c => c.text || '').join('\n'), at: s.createdAt });
    }
  }
  open(args = {}) {
    if (args.conversation_id) this.openConversation = this.get(args.conversation_id).id;
    this.openSequence++;
    return { ...this.list(), conversation_id: this.openConversation,
      hint: 'MCP Apps hosts show the Codex side panel. On Antigravity IDE install the companion VSIX and run Codex Bridge: Open Conversation.' };
  }
  read(args) {
    const s = this.get(args.conversation_id);
    const after = args.after ?? 0;
    const events = bounded(s.events.filter(e => e.cursor > after).slice(0, 100), 100000);
    const oldest = s.events[0]?.cursor ?? 0;
    return { ...this.summary(s), messages: bounded(s.messages.slice(-150), 180000, true), events,
      next_cursor: events.at(-1)?.cursor ?? after, has_more: events.length > 0 && events.at(-1).cursor < s.cursor,
      truncated: after > 0 && after < oldest - 1 };
  }
  async cancel(args) {
    return this.locked(args.conversation_id, async () => {
      const s = this.get(args.conversation_id);
      if (!active.has(s.status)) return this.summary(s);
      if (!s.turnId) throw new Error('Turn id is not known yet. Query again before cancelling.');
      await this.client.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId });
      // Wait for turn/completed before releasing the workspace lock.
      this.event(s, 'cancel_requested');
      return this.summary(s);
    });
  }
  async respond(args) {
    const s = this.get(args.conversation_id);
    const pending = this.requests.get(args.request_id);
    if (!pending || pending.sessionId !== s.id) throw new Error('Approval request expired or belongs to another conversation');
    let result;
    if (approvalMethods.has(pending.method)) result = { decision: args.decision };
    else if (pending.method === 'item/tool/requestUserInput') {
      const answers = args.answers;
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('answers is required for requestUserInput');
      for (const q of pending.params.questions || []) {
        if (!Array.isArray(answers[q.id]?.answers) || !answers[q.id].answers.every(x => typeof x === 'string')) throw new Error(`Missing answers for question ${q.id}`);
      }
      result = { answers };
    } else throw new Error('Unsupported server request');
    if (approvalMethods.has(pending.method) && !['accept', 'decline', 'cancel'].includes(args.decision)) throw new Error('decision must be accept, decline or cancel');
    this.client.respond(pending.id, result);
    this.requests.delete(args.request_id);
    s.pendingRequests = s.pendingRequests.filter(x => x.request_id !== args.request_id);
    s.status = s.pendingRequests.length ? 'waiting_approval' : 'running';
    this.event(s, 'approval_resolved', { request_id: args.request_id, decision: args.decision || 'answered' });
    await this.save();
    return this.summary(s);
  }
  serverRequest(msg) {
    if (this.closing) return;
    const s = [...this.sessions.values()].find(s => s.threadId === (msg.params?.threadId || msg.params?.conversationId));
    if (!s || (!approvalMethods.has(msg.method) && msg.method !== 'item/tool/requestUserInput')) {
      this.client.respond(msg.id, null, { code: -32601, message: `Bridge does not support server request ${msg.method}` });
      return;
    }
    const id = randomUUID();
    const request = { request_id: id, method: msg.method, params: msg.params };
    this.requests.set(id, { ...msg, sessionId: s.id });
    s.pendingRequests.push(request);
    s.status = 'waiting_approval';
    this.event(s, 'approval_requested', request);
  }
  notification(msg) {
    if (this.closing) return;
    const p = msg.params || {};
    const s = [...this.sessions.values()].find(s => s.threadId === (p.threadId || p.conversationId));
    if (!s) return;
    const item = p.item;
    if (msg.method === 'turn/started') {
      s.turnId = p.turn?.id || s.turnId;
      s.status = 'running';
    } else if (msg.method === 'turn/completed') {
      s.turnId = p.turn?.id || s.turnId;
      s.status = p.turn?.status === 'interrupted' ? 'cancelled' : p.turn?.status === 'failed' ? 'failed' : 'completed';
      s.error = p.turn?.error?.message || null;
      for (const req of s.pendingRequests) this.requests.delete(req.request_id);
      s.pendingRequests = [];
    } else if (msg.method === 'error') {
      s.error = p.error?.message || p.message || 'Codex error';
    }
    if (msg.method === 'item/agentMessage/delta') {
      let message = s.messages.find(m => m.id === p.itemId);
      if (!message) { message = { id: p.itemId, role: 'assistant', text: '', at: new Date().toISOString() }; s.messages.push(message); }
      message.text += p.delta || '';
    }
    if (item?.type === 'agentMessage' && item.text !== undefined) {
      let message = s.messages.find(m => m.id === item.id);
      if (!message) { message = { id: item.id, role: 'assistant', at: new Date().toISOString() }; s.messages.push(message); }
      message.text = item.text;
    }
    // Keep useful execution events; omit reasoning deltas and bound each payload.
    if (!msg.method.includes('reasoning') && !msg.method.includes('Reasoning')) {
      const serialized = JSON.stringify(p);
      this.event(s, msg.method, serialized.length > 16000 ? { preview: serialized.slice(0, 16000), truncated: true } : p);
    }
  }
  async close() {
    if (this.closing) return this.flushChain;
    this.closing = true;
    clearTimeout(this.saveTimer);
    for (const s of this.sessions.values()) {
      if (active.has(s.status)) s.status = 'disconnected';
      s.loaded = false;
      s.pendingRequests = [];
    }
    this.client.close();
    await this.save();
  }
}
