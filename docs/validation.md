# Validation record

Initial implementation environment: Windows, Node.js 24.19.0, Codex CLI 0.147.0.

## Observed locally

- JavaScript syntax and manifest JSON parsing passed.
- Child-process app-server fixture tests passed for streamed conversation messages, file side effects, follow-up turns, request-id deduplication, persisted state, approvals, steering, interruption, project root validation, failed turns and disconnected processes.
- MCP stdio initialization, tool discovery, resource reads and invalid-message handling passed.
- Follow-up validation on 2026-11-23 passed 10 tests with one HTTP test skipped. Invalid JSON-RPC values (`null`, arrays and numbers) now return protocol errors without terminating the server.
- The IDE panel waits for the webview readiness notification before selecting a requested conversation. A mocked extension-host regression test covers initial load, switching conversations, disposal and reopening; this is not a real IDE rendering test.
- Native history discovery and read-only history access passed fixture tests across projects, providers, source kinds and archived conversations. Pagination reconstructs long Unicode messages without dropping text and rejects cursors belonging to another thread. The updated suite passed 12 tests with one HTTP test skipped.
- A real Codex 0.147.0 app-server accepted the native `thread/list` discovery parameters using an isolated temporary CODEX_HOME and returned an empty history. This validates the interface, not access to the user's populated history or cloud-only conversations.
- VSIX packaging produced an archive containing the extension manifest, runtime and shared UI.
- A real Codex 0.147.0 app-server completed initialize/initialized with a fresh temporary CODEX_HOME. No model task or account credentials were used for that check.

## Historical limits of the original validation environment

- The execution sandbox denies outbound loopback connections (`connect EACCES 127.0.0.1`). HTTP integration tests detect this restriction and report skipped; they run normally in an unrestricted environment and CI.
- The existing user CODEX_HOME is outside writable sandbox roots. Real app-server initialization using that home failed to initialize its SQLite state. An isolated-home handshake succeeded instead.
- Antigravity application access could not be obtained before the UI approval request timed out. Native panel mounting and a real signed-in two-turn coding task were not verified.
- On follow-up, Antigravity exposed its accessibility tree, but its minimized window could not be operated. Native panel mounting remains unverified.

Do not interpret the fixture tests or isolated-home handshake as proof of a completed live model task. Run `node scripts/smoke.mjs --live-task` from a normal user terminal, then check `codex_open` in Antigravity to finish local acceptance.

The repository CI matrix targets Node 22 on Windows, Linux and macOS. A configured GitHub workflow is not itself proof that those remote jobs passed; inspect the actual run.

## 0.2.0 orchestration update — 2026-11-23

Validated on Linux with Node.js 24.22.3 and Codex CLI 0.172.0-alpha.2.

- All 19 fixture/integration tests passed with no skips, including authenticated loopback HTTP in this environment.
- New coverage exercises structured delegation and file effects, request-id deduplication, brief persistence/reload, updated user goals in the same thread, compact monitoring, current-turn report isolation, final-answer selection, lossless Unicode report pagination, invalid briefs, and MCP workflow resources/prompts.
- Execution completion remains distinct from acceptance. Report packets label Codex claims as self-reports; Antigravity performs the actual assessment and user-facing explanation.
- A real app-server completed the initialize/initialized handshake and empty native-history discovery using an isolated temporary CODEX_HOME. This did not use an account or run a model task.

The Antigravity host's interpretation, natural-language task refinement, actual signed-in model execution and quality of final explanations still require an end-to-end check in the user's installed Antigravity. Protocol/fixture tests do not establish those behaviors. No autonomous host wake-up mechanism is claimed.

## 0.3.0 native coordination and recovery — 2026-11-23

Validated on Linux, Node.js 24.22.3, Codex CLI 0.172.0-alpha.2:

- All 29 fixture/integration tests passed with no skips. Coverage includes actual loopback HTTP, full-turn caveat preservation, report identity/pagination, durable criterion reviews, stale/forged evidence rejection, exact-thread continuation after worker restart, lost-response uncertainty without replay, two no-progress rounds, read-only research promotion, and live-catalog reasoning values.
- Installation tests cover dry runs, preservation of other servers and explicit Codex binary/state/root/timeout settings, refusal to replace unmanaged skills, and managed-skill backups outside active discovery. Cross-volume backups use copy while rollback renames stay on the skill's volume.
- Syntax, JSON manifests, native skill frontmatter and referenced resource paths passed. VSIX 0.3.0 was built; npm dry-run packaging includes the skill and all runtime modules.
- A real isolated-home app-server handshake and native history discovery passed. No account credentials or model tasks were used in that check.
- An independent assistant used the packaged coordination skill on a partial login-fix handoff. It preserved the missing real-account validation and the 503 blocker rather than reporting full success. This is an assistant behavior probe, not an actual Antigravity integration test.

This executor has no `agy` CLI. The user's real Antigravity skill discovery, tracked completion notifications, and signed-in end-to-end dialogue were not verified. Host-declared review records do not prove arbitrary behavior or actual message delivery, and the bridge does not continuously watch for external filesystem changes. Reassess evidence when relevant code or conditions change.

The opt-in `scripts/smoke.mjs --live-task` now exercises structured delegation, exact-thread follow-up, file inspection and recorded acceptance. It consumes Codex quota and still does not replace an actual Antigravity dialogue check.
