# Task types and brief construction

Write the brief yourself. Keep it proportional; a typo fix needs a few concrete statements, not a design document. Do not fill templates with speculative requirements.

| Kind | Include | Observable acceptance |
| --- | --- | --- |
| implementation | Desired behavior, context, relevant scope, compatibility constraints | The requested behavior works and important existing behavior remains |
| bugfix | Symptom, expected behavior, reproduction if known, suspected cause labelled as hypothesis | The reproduction is resolved and relevant regression evidence supports the fix |
| research | Specific questions, relevant area, required evidence, read-only boundary | Questions are answered with inspectable sources and uncertainties |
| review | Target change/behavior, review focus, read-only boundary | Findings identify evidence and practical impact; absence of findings retains uncertainty |

Use brief fields `kind`, `user_request`, `goal`, `context`, `scope`, `acceptance_criteria`, `constraints` and `assumptions`. Only the original request, goal, scope and criteria are mandatory. Do not ask the user to supply parameter names.

For "关闭应用再打开不要每次都让我登录", a relevant criterion is restoring still-valid login state after restart. Preserve logout and credential expiry. Do not silently lengthen authentication validity or introduce a new login provider.

For "把登录弄方便一点" with no other context, first inspect the existing flow. Ask one focused question only if materially different interpretations remain. If a reversible default is reasonable, state it briefly and proceed.

Do not require Git initialization, an initial commit or a clean checkout for every task. Preserve existing changes; use available diffs, file inspection and focused behavior checks. Never stage or commit unrelated files to manufacture a baseline.

Use local model/effort defaults unless the user specifies otherwise. Discover explicit selections from `codex_models`, including advertised reasoning levels; do not substitute a weaker model or lower effort without explanation.

When an authorized task moves from read-only investigation to implementation, continue the same conversation with an updated implementation brief and `codex_send` `sandbox: workspace-write` on a next turn. Change permissions only within existing user authorization. Never promote permissions through a running turn's steering request.
