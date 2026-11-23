# Evidence-based review

1. Read every result page. Bind pagination to `report.report_id` and restart from offset 0 if it changed. Read caveats in earlier messages as well as the final answer.
2. Compare every saved acceptance criterion with evidence. Inspect relevant changed files or outputs; check for scope drift and preserve pre-existing work.
3. Distinguish sources:
   - `host_observed`: what you actually inspected or ran. Describe the observation specifically.
   - `codex_event`: a command/file completion observed by the bridge, identified by an exact `evidence_id`. Check its exit status and output. A file event alone does not prove behavior.
   - `codex_claim`: the worker's prose. Useful as a lead, insufficient by itself to accept a criterion.
4. Run necessary checks proportional to the change. Reuse still-valid evidence; rerun affected checks after subsequent edits or changed conditions. Do not claim a real account, browser or device test when only a fixture passed.
5. Call `codex_review` with current `report_id`, a stable `request_id`, verdict, plain-language summary, optional usage/limitations, `progress_made`, and one assessment per criterion. Each assessment needs zero-based `criterion_index`, `status` (`met`, `not_met`, `unverified`), evidence description and source.

Choose `accepted` only when all criteria are met with evidence beyond a self-report. Choose `needs_changes` for actionable gaps and send focused feedback in the same conversation. Choose `blocked` for missing access, resources or a consequential decision that cannot be resolved autonomously.

Feedback should name the difference between actual and expected behavior, supporting evidence and the desired correction. Avoid generic "continue improving" prompts. Preserve the goal while allowing Codex to revise the technical approach.

After two reviews with no progress, stop repeating the same request. Investigate a different hypothesis and attach an updated brief, or report the concrete blocker. A review is a host-declared assessment, not a bridge guarantee that arbitrary product behavior is correct.
