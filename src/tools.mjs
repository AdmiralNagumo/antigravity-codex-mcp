import { BRIEF_SCHEMA, buildDelegationPrompt } from './orchestration.mjs';
export const UI_URI = 'ui://antigravity-codex/conversation.html';
const str = (description, extra = {}) => ({ type: 'string', minLength: 1, description, ...extra });
const id = str('Bridge conversation_id returned by codex_delegate/start/resume/list');
const prompt = str('Task or follow-up instructions. Include scope and acceptance criteria.', { maxLength: 100000 });
const requestId = str('Stable idempotency key. Reuse the SAME key and arguments when retrying.', { maxLength: 200 });
function tool(name, description, properties, required = [], readOnly = false) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true } };
}
export const TOOLS = [
  tool('codex_open', 'Open the embedded Codex conversation side panel. Pass a conversation_id or omit it for the session list. On IDE, the companion extension opens the same conversation.', { conversation_id: id }),
  tool('codex_delegate', 'Preferred new-task entry point. Antigravity interprets the user request and fills the brief itself; Codex implements. Returns immediately. Monitor, fetch codex_result, verify against the brief and explain the outcome in plain language. Continue corrections in the same conversation.', {
    cwd: str('Absolute project directory inside an allowed root'), brief: BRIEF_SCHEMA,
    title: str('Short task title', { maxLength: 160 }), model: str('Optional model id; omit to use local settings'),
    reasoning_effort: str('Optional effort advertised for the selected model by codex_models; omit to retain local settings', { maxLength: 40 }),
    sandbox: { type: 'string', enum: ['read-only', 'workspace-write'], default: 'workspace-write' }, request_id: requestId,
  }, ['cwd', 'brief', 'request_id']),
  tool('codex_start', 'Low-level prompt entry point; prefer codex_delegate for user tasks. Returns immediately. Monitor with codex_read/wait, review with codex_result, then explain the verified outcome. A completed turn does not establish task acceptance.', {
    cwd: str('Absolute project directory inside an allowed root'), prompt, title: str('Short conversation title', { maxLength: 160 }),
    model: str('Optional Codex model id; omit to use local settings'), sandbox: { type: 'string', enum: ['read-only', 'workspace-write'], default: 'workspace-write' }, request_id: requestId,
    reasoning_effort: str('Optional effort from the live model catalog', { maxLength: 40 }),
  }, ['cwd', 'prompt', 'request_id']),
  tool('codex_send', 'Send a follow-up in the SAME Codex conversation, preserving context. mode=next starts a new turn after completion; mode=steer adds instructions to a running turn. Do not retry unknown mutations with a new request_id.', {
    conversation_id: id, prompt, mode: { type: 'string', enum: ['next', 'steer'], default: 'next' }, request_id: requestId,
    brief: { ...BRIEF_SCHEMA, description: 'Optional complete updated brief when the user changes the goal, boundaries or acceptance criteria. Antigravity writes it; omit for routine corrections.' },
    reasoning_effort: str('Optional advertised effort for the next turn; cannot change effort through steer', { maxLength: 40 }),
    sandbox: { type: 'string', enum: ['read-only', 'workspace-write'], description: 'Optional permission mode for a next turn within user authorization; use an updated implementation brief when promoting read-only research to edits' },
  }, ['conversation_id', 'prompt', 'request_id']),
  tool('codex_list', 'List bridge-managed Codex conversations, their states and configured project roots.', {}, [], true),
  tool('codex_history', 'Automatically discover existing conversations in the local Codex history, including conversations created outside this bridge. No manual thread selection is needed. Search titles with query, read matches with codex_history_read, and follow next_cursor to enumerate every page. archived=true lists archived conversations separately.', {
    query: str('Optional substring to match conversation titles'), cursor: str('Opaque next_cursor from the previous history page'),
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    archived: { type: 'boolean', default: false }, cwd: str('Optional exact project directory filter; omit to list all local projects'),
  }, [], true),
  tool('codex_history_read', 'Read an existing local Codex conversation by a thread_id discovered through codex_history. Does not resume or take control of the thread. Follow next_cursor for additional messages or the remaining text of a long message. Works across all local projects; continuing a coding task still requires codex_resume and an allowed project root.', {
    thread_id: str('Existing Codex thread id from codex_history'), cursor: str('Opaque next_cursor from the preceding read of this same thread'),
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  }, ['thread_id'], true),
  tool('codex_read', 'Read bounded conversation messages, execution events and pending approvals. after is an event cursor; follow next_cursor when has_more is true.', {
    conversation_id: id, after: { type: 'integer', minimum: 0, default: 0 },
    compact: { type: 'boolean', default: false, description: 'Return state and pending requests without replaying messages/events; use codex_result after completion' },
  }, ['conversation_id'], true),
  tool('codex_wait', 'Wait up to 20 seconds for new events or completion, then return conversation state. Continue waiting if status remains running/starting. waiting_approval requires attention.', {
    conversation_id: id, after: { type: 'integer', minimum: 0, default: 0 }, timeout_ms: { type: 'integer', minimum: 0, maximum: 20000, default: 15000 },
    compact: { type: 'boolean', default: false, description: 'Prefer true for orchestration monitoring; omits raw transcript and logs' },
  }, ['conversation_id'], true),
  tool('codex_result', 'Get the saved user brief and latest turn report for Antigravity to assess. Reports are Codex self-reports, not verified acceptance. Follow report.next_offset; inspect evidence and send corrections if needed, then explain user-visible results instead of forwarding this packet.', {
    conversation_id: id, offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 24000, default: 12000 },
    report_id: str('Exact report.report_id from page 1; required for nonzero offsets and for recording review'),
  }, ['conversation_id'], true),
  tool('codex_review', 'Record Antigravity assessment of every saved criterion against current evidence. accepted means ready to explain, not confirmed delivery. Host observations are declarations; preserve provenance. Corrections use the same conversation. Two no-progress rounds require reconsideration.', {
    conversation_id: id, report_id: str('Current report.report_id from codex_result'), request_id: requestId,
    verdict: { type: 'string', enum: ['accepted', 'needs_changes', 'blocked'] },
    assessments: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false,
      properties: { criterion_index: { type: 'integer', minimum: 0, maximum: 11 }, status: { type: 'string', enum: ['met', 'not_met', 'unverified'] },
        evidence: str('Specific inspected behavior, command/result or remaining gap', { maxLength: 4000 }),
        source: { type: 'string', enum: ['host_observed', 'codex_event', 'codex_claim'] },
        evidence_id: str('Required for codex_event: exact observed evidence id from this result') },
      required: ['criterion_index', 'status', 'evidence', 'source'] } },
    summary: str('Plain-language outcome or blocker for the user', { maxLength: 4000 }),
    how_to_use: { type: 'array', maxItems: 12, items: str('A practical usage step', { maxLength: 1000 }) },
    limitations: { type: 'array', maxItems: 12, items: str('A material limitation or unverified behavior', { maxLength: 1000 }) },
    progress_made: { type: 'boolean', description: 'Whether this attempt made meaningful progress; prevents repeating ineffective corrections' },
  }, ['conversation_id', 'report_id', 'request_id', 'verdict', 'assessments', 'summary', 'progress_made']),
  tool('codex_recover', 'Reconnect a lost Codex process and inspect the exact native thread to reconcile execution. Does not replay a prompt or start a model turn. Active/ambiguous native turns remain unknown; inspect before new work.', { conversation_id: id }, ['conversation_id']),
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
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${at} has an invalid number of items`);
    value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.trim().length < (schema.minLength || 0) || value.length > (schema.maxLength || 100000)) throw new Error(`${at} must be a valid string`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${at} is outside the permitted integer range`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${at} must be a boolean`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at} must be one of: ${schema.enum.join(', ')}`);
}

export async function dispatch(manager, name, args = {}) {
  const definition = TOOLS.find(t => t.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  validate(definition.inputSchema, args);
  switch (name) {
    case 'codex_open': return manager.open(args);
    case 'codex_delegate': {
      const readOnly = ['research', 'review'].includes(args.brief.kind);
      if (readOnly && args.sandbox && args.sandbox !== 'read-only') throw new Error('Research/review delegation requires read-only sandbox');
      return manager.start({ ...args, ...(readOnly ? { sandbox: 'read-only' } : {}), prompt: buildDelegationPrompt(args.brief), title: args.title || args.brief.goal.slice(0, 160) });
    }
    case 'codex_start': return manager.start(args);
    case 'codex_send': return manager.send(args.brief ? { ...args, prompt: buildDelegationPrompt(args.brief) + '\n\n## Follow-up instruction\n' + args.prompt } : args);
    case 'codex_list': return manager.list();
    case 'codex_history': return manager.history(args);
    case 'codex_history_read': return manager.historyRead(args);
    case 'codex_read': return manager.read(args);
    case 'codex_result': return manager.result(args);
    case 'codex_review': return manager.review(args);
    case 'codex_recover': return manager.recover(args);
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
