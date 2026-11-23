import { createHash } from 'node:crypto';

export function turnMessages(s) {
  const boundary = s.messages.findIndex(m => m.id === s.resultStartId);
  let messages;
  if (s.resultStartId) messages = boundary >= 0 ? s.messages.slice(boundary + 1)
    : s.messages.filter(m => s.turnId && m.turn_id === s.turnId);
  else {
    const lastUser = s.messages.findLastIndex(m => m.role === 'user' && !m.steering);
    messages = s.messages.slice(lastUser + 1);
  }
  return messages.filter(m => m.role === 'assistant' && (!m.turn_id || !s.turnId || m.turn_id === s.turnId));
}

export function resultSnapshot(s) {
  const messages = turnMessages(s);
  // Keep commentary as well as final answers: earlier messages can contain
  // failures, caveats or decisions omitted from a short terminal answer.
  const text = messages.map(m => m.text || '').join('\n\n');
  const evidence = (s.evidence || []).filter(e => e.turn_id === s.turnId);
  const identity = JSON.stringify({ turn: s.turnId, boundary: s.resultStartId, status: s.status,
    revision: s.task?.brief_revision || 0, brief: s.brief, messages, evidence });
  return { id: createHash('sha256').update(identity).digest('hex'), text, evidence, messages };
}

export function resultPage(s, args) {
  const snapshot = resultSnapshot(s), offset = args.offset ?? 0;
  if ((offset > 0 && !args.report_id) || (args.report_id && args.report_id !== snapshot.id)) {
    throw new Error('Result changed or report_id is missing. Restart at offset 0 and use its report_id on subsequent pages.');
  }
  if (offset > snapshot.text.length) throw new Error('Result offset is no longer valid; restart at offset 0');
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(snapshot.text[offset]) && /[\uD800-\uDBFF]/.test(snapshot.text[offset - 1])) throw new Error('Result offset splits a Unicode character');
  let end = Math.min(snapshot.text.length, offset + (args.limit ?? 12000));
  if (end < snapshot.text.length && /[\uD800-\uDBFF]/.test(snapshot.text[end - 1])) end--;
  if (end === offset && end < snapshot.text.length) end = Math.min(snapshot.text.length, offset + 2);
  return { report_id: snapshot.id, text: snapshot.text.slice(offset, end), offset,
    next_offset: end < snapshot.text.length ? end : null, total_chars: snapshot.text.length,
    source: 'codex_turn_messages', message_count: snapshot.messages.length,
    is_partial: s.status !== 'completed', available: snapshot.messages.length > 0 };
}

export function observedEvidence(params) {
  const item = params.item;
  if (!item || !['commandExecution', 'fileChange'].includes(item.type)) return null;
  const common = { id: item.id, turn_id: params.turnId, source: 'app_server_event', type: item.type };
  if (item.type === 'commandExecution') return { ...common, command: item.command,
    status: item.status, exit_code: item.exitCode ?? null,
    output: String(item.aggregatedOutput || '').slice(-8000), output_truncated: String(item.aggregatedOutput || '').length > 8000 };
  return { ...common, status: item.status, changes: (item.changes || []).map(c => ({ path: c.path, kind: c.kind })).slice(0,100) };
}
