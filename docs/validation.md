# Validation record

Initial implementation environment: Windows, Node.js 24.19.0, Codex CLI 0.147.0.

## Observed locally

- JavaScript syntax and manifest JSON parsing passed.
- Child-process app-server fixture tests passed for streamed conversation messages, file side effects, follow-up turns, request-id deduplication, persisted state, approvals, steering, interruption, project root validation, failed turns and disconnected processes.
- MCP stdio initialization, tool discovery, resource reads and invalid-message handling passed.
- Follow-up validation on 2026-11-23 passed 10 tests with one HTTP test skipped. Invalid JSON-RPC values (`null`, arrays and numbers) now return protocol errors without terminating the server.
- The IDE panel waits for the webview readiness notification before selecting a requested conversation. A mocked extension-host regression test covers initial load, switching conversations, disposal and reopening; this is not a real IDE rendering test.
- VSIX packaging produced an archive containing the extension manifest, runtime and shared UI.
- A real Codex 0.147.0 app-server completed initialize/initialized with a fresh temporary CODEX_HOME. No model task or account credentials were used for that check.

## Limits of this environment

- The execution sandbox denies outbound loopback connections (`connect EACCES 127.0.0.1`). HTTP integration tests detect this restriction and report skipped; they run normally in an unrestricted environment and CI.
- The existing user CODEX_HOME is outside writable sandbox roots. Real app-server initialization using that home failed to initialize its SQLite state. An isolated-home handshake succeeded instead.
- Antigravity application access could not be obtained before the UI approval request timed out. Native panel mounting and a real signed-in two-turn coding task were not verified.
- On follow-up, Antigravity exposed its accessibility tree, but its minimized window could not be operated. Native panel mounting remains unverified.

Do not interpret the fixture tests or isolated-home handshake as proof of a completed live model task. Run `node scripts/smoke.mjs --live-task` from a normal user terminal, then check `codex_open` in Antigravity to finish local acceptance.

The repository CI matrix targets Node 22 on Windows, Linux and macOS. A configured GitHub workflow is not itself proof that those remote jobs passed; inspect the actual run.
