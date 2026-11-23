import { randomUUID } from 'node:crypto';
import { resultSnapshot } from './results.mjs';

export function updateBrief(s, brief) {
  s.task ??= { id: randomUUID(), brief_revision: 0, revisions: [], reviews: [], no_progress_rounds: 0 };
  if (JSON.stringify(s.brief) === JSON.stringify(brief) && s.task.brief_revision) return;
  s.brief = structuredClone(brief);
  s.task.brief_revision++;
  s.task.revisions.push({ revision: s.task.brief_revision, brief: s.brief, at: new Date().toISOString() });
  s.task.review = null;
  s.task.no_progress_rounds = 0;
}

export function taskState(s) {
  const review = s.task?.review;
  // Only a review of this exact report/revision can authorize delivery.
  const current = review && review.report_id === resultSnapshot(s).id ? review : null;
  let phase = s.status === 'completed' ? 'awaiting_review'
    : ['running','starting'].includes(s.status) ? 'executing'
    : s.status === 'waiting_approval' ? 'waiting_input'
    : s.status === 'cancelled' ? 'cancelled' : 'blocked';
  if (current) phase = current.verdict === 'accepted' ? 'ready_to_explain' : current.verdict === 'needs_changes' ? 'needs_changes' : 'blocked';
  return { task_id: s.task?.id || null, phase, brief_revision: s.task?.brief_revision || 0,
    acceptance_status: current?.verdict || 'not_assessed', review: current || null,
    no_progress_rounds: s.task?.no_progress_rounds || 0,
    delivery_status: current?.verdict === 'accepted' ? 'prepared_not_confirmed_sent' : 'not_ready' };
}

export function recordReview(s, args) {
  if (s.status !== 'completed') throw new Error('Review requires a completed turn; inspect or recover execution first');
  if (!s.brief?.acceptance_criteria?.length) throw new Error('Attach a brief with acceptance criteria before recording review');
  const snapshot = resultSnapshot(s);
  if (args.report_id !== snapshot.id) throw new Error('Review report_id is stale; read the current codex_result first');
  const count = s.brief.acceptance_criteria.length, seen = new Set();
  for (const a of args.assessments) {
    if (a.criterion_index >= count || seen.has(a.criterion_index)) throw new Error('Review contains an unknown or repeated criterion_index');
    seen.add(a.criterion_index);
    if (a.source === 'codex_event' && (!a.evidence_id || !snapshot.evidence.some(e => e.id === a.evidence_id))) throw new Error('Review evidence_id is not an observed event from this turn');
  }
  if (seen.size !== count) throw new Error('Assess every saved acceptance criterion');
  if (args.verdict === 'accepted' && args.assessments.some(a => a.status !== 'met' || a.source === 'codex_claim')) {
    throw new Error('Acceptance requires evidence beyond a Codex self-report for every criterion');
  }
  const review = { verdict: args.verdict, report_id: snapshot.id, turn_id: s.turnId,
    brief_revision: s.task.brief_revision, assessments: structuredClone(args.assessments),
    summary: args.summary, how_to_use: args.how_to_use || [], limitations: args.limitations || [],
    progress_made: args.progress_made,
    observed_evidence: snapshot.evidence.filter(e => args.assessments.some(a => a.evidence_id === e.id)),
    provenance: 'host_declared_review', at: new Date().toISOString() };
  s.task.review = review;
  s.task.reviews.push(review);
  const alreadyCounted = s.task.reviews.slice(0, -1).some(r => r.report_id === snapshot.id && r.verdict === 'needs_changes' && r.progress_made === false);
  s.task.no_progress_rounds = args.verdict === 'needs_changes' && args.progress_made === false
    ? s.task.no_progress_rounds + (alreadyCounted ? 0 : 1) : 0;
  return review;
}
