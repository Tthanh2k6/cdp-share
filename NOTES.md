# NOTES (cdp-share 0.1.0)

Derived from `turbo-browser-mcp/src/cdp-bridge.mjs` (read only). Runtime is Node >= 20 built-ins only.

## Layout
- `src/ws.mjs` WebSocket frames/connection (copied from turbo's bridge).
- `src/bridge.mjs` the multiplexer, HTTP endpoints, security checks, filter, audit log.
- `src/upstream.mjs` Chrome discovery (`/json/version` or `DevToolsActivePort` in default Chrome/Edge/Brave dirs).
- `src/index.mjs` `startCdpShare`, `getStatus`, `stopCdpShare` (+ `resolveUpstream`, `generateToken`).
- `src/cli.mjs` `start | status | stop`.

## Changed from turbo's bridge
- Removed all turbo / MCP / Playwright-loader / unattended-Chrome-launch code. Env vars are `CDP_SHARE_*`. Daemon is `cli.mjs __daemon` (no `--upstream` flag; `--chrome`).
- New: CLI, token auth, Host/Origin checks, `/json/list` + `/json` built from `Target.getTargets` (so it works in Chrome 144+ inspect mode, where Chrome serves no `/json`), page websockets `/devtools/page/<id>`, `/json/protocol` and `/json/new` (PUT) passthrough, `/cdp-share/status`, `/cdp-share/shutdown` (POST), audit log, URL filter, client names (`?name=`), state file `~/.cdp-share/<port>.json` (pid, token; mode 0600; removed on exit; `CDP_SHARE_HOME` overrides the dir).
- Dropped turbo's "context heir" rule: a client's browser contexts are always disposed when that client disconnects. With auto-attach every client is "inside" every tab, so the heir rule kept them alive whenever two clients were connected.
- Bridge-level upstream auto-attach is switched on only when a client first sends `Target.setAutoAttach` (as in turbo); a client that only sends commands never causes tabs to be attached (status shows `sessions: 0`).
- Exit codes: 0 shutdown, 1 start failed, 3 upstream Chrome gone (after a 2.5 s reconnect window that only applies to classic `--remote-debugging-port`), 4 own socket lost.

## Filter semantics
`--exclude-url` hides targets whose URL matches. `--include-url` shows only matches. `about:blank`/empty URLs always pass the include rule, and `Target.createTarget` with a blocked URL is refused, so clients can still open new tabs. Hidden targets vanish from `Target.getTargets`, discover events, `/json/list`, page websockets and attach (`Target.attachToTarget`, `getTargetInfo`, `activateTarget`, `closeTarget` answer -32602). A tab that navigates into/out of the hidden range is announced as destroyed/created to discover clients.

## Known limits
- Filter is evaluated on target URL only; a tab a client is already attached to stays attached if it later navigates to a blocked URL. Child targets (iframes, workers of an allowed page) are not filtered.
- When a filter is active and some client uses auto-attach, Chrome briefly attaches the bridge to hidden tabs (it is resumed and detached at once); nobody sees them.
- Playwright/Puppeteer `waitForDebuggerOnStart` is emulated per client (turbo's hold-session design). Per-client sessions are attached after the target exists, so scripts injected "on new document" can miss the very first moments of a tab created by another client.
- Audit log does not record events, only commands; params are never logged except `Target.*` identifiers/URL and `Page.navigate` url (a URL can itself contain secrets).
- Token on a command line is visible to other local users; `start --token auto` passes it to the daemon by environment, not argv. The state file holds the token in plain text (0600 on POSIX; Windows ignores the mode).
- Detached start on Windows uses `spawn(detached, windowsHide)`. Turbo escaped a parent Job Object via `Win32_Process.Create`; if the launcher is killed together with its children, use `--foreground` under a service manager instead.
- Not verified here: the real Chrome 144+ "Allow remote debugging" prompt (tests use headless Chromium with `--remote-debugging-port`), macOS/Linux, chrome-devtools-mcp and browser-use themselves (Playwright and Puppeteer cover the same protocol paths).

## Round 2 changes
- Windows `start` launches the daemon through `Win32_Process.Create` (outside any kill-on-close Job Object, as turbo does), falling back to `spawn(detached)`; `CDP_SHARE_NO_WMI=1` forces the fallback. The token goes to the daemon through a one-shot file (`--token-file`, deleted after reading) because WMI does not pass the caller's environment; the daemon also gets `--home` and `--out-file` (start-up log in the temp dir).
- Token mode prints the ws URL first, with `chrome-devtools-mcp --wsEndpoint` and Playwright examples; clients that cannot send headers cannot use the http URL.
- Fix found by the soak test: commands a client was still waiting for when it left stayed in the pending table forever (576 after 30 rounds). They are dropped on disconnect now. `/cdp-share/status` also reports `rssMB` and `internal` counters.
- `npm run test:soak` (needs `CDP_SHARE_SOAK=1`; skipped by default): 30 overlapping rounds, 3 clients; daemon RSS grew about 8 MB (69 to 77 MB).

## Tested with
- chrome-devtools-mcp latest, via `--browserUrl` (no token) and `--wsEndpoint` with token (coordinator's live run).
- turbo-browser-mcp 0.7.0, Playwright 1.65.1, puppeteer-core 25.17.0 (the automated suite uses the last two).
- Node 24.15.0 on Windows 11. Suite: Playwright's bundled headless Chromium (default) and installed Google Chrome 157.0.8103.51 (`CDP_SHARE_TEST_CHROME=<chrome.exe>`, headless, fresh temp profile): all pass. Earlier flake (about 3 of 9 full runs): a `cdp-share start` child died with exit 0xC0000409 twice and the "exits with code 3" test failed once. Round 3: no root cause reproduced (8 cli.test runs under CPU load, 30 clean cli.test runs, 5 clean full runs after the change). Most likely cause: `process.exit()` called while sockets/servers were still closing (libuv abort on Windows). The daemon now closes the bridge first, sets `process.exitCode` and lets the loop drain (an unref'd 3 s timer is only a safety net); no other `process.exit()` is left in `src/` (the CLI sets `exitCode`). Not proven to be the cause, since the crash never reproduced.
