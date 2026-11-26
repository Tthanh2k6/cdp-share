# cdp-share

Chrome 144 and later shows an "Allow remote debugging" prompt for every new DevTools Protocol connection to your everyday Chrome. If an agent reconnects on every step, or you run two MCP servers against the same browser, you click Allow over and over, and the two clients can step on each other's sessions.

cdp-share is a small local daemon that holds one approved connection to Chrome and lets any number of CDP clients connect through it: chrome-devtools-mcp, Playwright, Puppeteer, or your own scripts. You click Allow once. Clients come and go without new prompts, and each one gets its own CDP sessions.

No runtime dependencies. Node 20 or later.

## Quick start

1. In Chrome, open `chrome://inspect/#remote-debugging` and turn on remote debugging.
2. Start the daemon and click **Allow** when Chrome asks:

   ```sh
   npx -y cdp-share
   ```

   It prints the address to use and goes to the background:

   ```
   cdp-share 0.1.0 running
     http: http://127.0.0.1:9333
     ws:   ws://127.0.0.1:9333/devtools/browser/cdp-share
   ```

3. Point your clients at `http://127.0.0.1:9333` instead of Chrome.

`npx cdp-share status` prints the upstream state and the connected clients as JSON. `npx cdp-share stop` stops the daemon. If Chrome turns remote debugging off or quits, the daemon exits (code 3), and the next start asks for Allow again.

Chrome started the old way, with `--remote-debugging-port=9222`, works too: `npx cdp-share --chrome http://127.0.0.1:9222`.

## Connecting clients

chrome-devtools-mcp (MCP config):

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9333"]
    }
  }
}
```

Playwright:

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
```

Puppeteer:

```js
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333' });
```

Anything that reads `/json/version` and opens `webSocketDebuggerUrl` should work the same way. `/json/list` is built from `Target.getTargets`, so it also works when Chrome runs in the new inspect mode, which serves no `/json` endpoints of its own.

## What each client sees

All clients see the same tabs. Each client's commands, events and one-time page setup (init scripts, auto-attach) stay separate from the others.

- `Browser.close` from a client is ignored, so a script that ends with `browser.close()` does not close your Chrome.
- Browser contexts a client creates (for example `browser.newContext()` in Playwright) are closed when that client disconnects. Tabs in the default context stay open.
- Commands still in flight when a client disconnects are dropped, so nothing piles up in the daemon.
- With `--no-focus`, new tabs created via `Target.createTarget` are opened with `background: true` (unless `newWindow: true`), `Target.activateTarget` / `Page.bringToFront` are answered with `{}` instead of bringing Chrome to the foreground, and `Emulation.setFocusEmulationEnabled({ enabled: true })` is sent on attached page sessions so background tabs continue rendering and receiving input without blank screenshots (pass `--no-focus-emulation` or `CDP_SHARE_NO_FOCUS_EMULATION=1` to turn focus emulation off). Useful on macOS and desktop setups when background agents should not steal window focus.

## Security

Remote debugging gives full control of the browser, including every site you are signed in to. cdp-share does not make that safer by itself. It tries not to make it worse:

- It listens on `127.0.0.1` only.
- It rejects requests whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` (DNS rebinding), and WebSocket upgrades with an `Origin` from a web page, as Chrome does.
- Start it with `--token auto` unless you have a reason not to. Without a token, any program on this machine that can reach the port gets the already-approved connection, so it can read the cookies of every site you are signed in to without seeing Chrome's Allow prompt.
- `--token auto` generates a token and requires it on every connection: `?token=` on the WebSocket URL, or an `Authorization: Bearer` / `x-cdp-share-token` header on HTTP. With a token set, use the printed ws URL, for example `chrome-devtools-mcp --wsEndpoint "ws://127.0.0.1:9333/devtools/browser/cdp-share?token=..."`, since `--browserUrl` cannot send headers.
- `--log audit.jsonl` writes one JSON line per connect, disconnect and command: time, client id, optional client name (`?name=` on the ws URL), method, target or session id, ok or error. Command parameters are not logged, so typed text and passwords stay out of the file. The exceptions are target ids and the URL in `Target.*` commands and `Page.navigate` (a URL can itself contain secrets).
- `--include-url <regex>` and `--exclude-url <regex>` hide tabs from clients: hidden tabs do not show up in `Target.getTargets`, target events or `/json/list`, and attaching to them fails.

The token is stored in plain text in `~/.cdp-share/<port>.json` so `status` and `stop` can find the daemon. Any process running as your user can read it, and can also reach Chrome directly.

## Options

```
cdp-share [start] [options]   start the daemon in the background
cdp-share status [--port N]   print status JSON (exit 1 if not running)
cdp-share stop [--port N]     stop the daemon

--port <n>              port on 127.0.0.1 (default 9333)
--chrome <url>          Chrome http://host:port or ws:// URL (default: DevToolsActivePort
                        of the default Chrome, Edge or Brave profile, else http://127.0.0.1:9222)
--token <t|auto>        require a token
--log <file.jsonl>      audit log
--include-url <regex>   show only tabs whose URL matches
--exclude-url <regex>   hide tabs whose URL matches
--no-focus              keep Chrome in the background (background: true on new tabs, no-op focus commands, focus emulation on)
--no-focus-emulation    disable automatic Emulation.setFocusEmulationEnabled under --no-focus
--foreground            stay attached and log to stderr
--timeout <sec>         how long start waits for the Allow click (default 90)
```

Every option also has an environment variable: `CDP_SHARE_PORT`, `CDP_SHARE_CHROME`, `CDP_SHARE_TOKEN`, `CDP_SHARE_LOG`, `CDP_SHARE_INCLUDE_URL`, `CDP_SHARE_EXCLUDE_URL`, `CDP_SHARE_NO_FOCUS`, `CDP_SHARE_NO_FOCUS_EMULATION`, and `CDP_SHARE_HOME` for the state directory.

From Node:

```js
import { startCdpShare } from 'cdp-share';
const share = await startCdpShare({ chrome: 'http://127.0.0.1:9222', port: 9333 });
console.log(share.url); // http://127.0.0.1:9333
await share.close();
```

## Known limits

- The URL filter checks a tab's URL only. A client already attached to a tab stays attached if the tab later navigates to a hidden URL, and iframes and workers of a visible page are not filtered.
- Each client gets its own sessions after a tab exists, so an init script registered by one client can miss the first moments of a tab that another client created.
- The audit log records commands, not events.
- On Windows, `start` launches the daemon outside the calling process tree (through WMI), so it survives when an editor or terminal that started it closes. If that fails it falls back to a detached child process.
- CI runs the test suite on Linux, macOS and Windows (Node 20 and 22) against headless Chromium. Against a real, signed-in Chrome profile it has only been tried on Windows 11 so far; reports from other systems are welcome.

## Tested with

- A regular Chrome 157 profile with remote debugging turned on in `chrome://inspect`: one Allow click, then Playwright (3 connections), Puppeteer (2) and chrome-devtools-mcp (2) connected and disconnected without another prompt.
- chrome-devtools-mcp, Playwright and turbo-browser-mcp driving the same Chromium at the same time.
- The test suite: Playwright 1.65 and Puppeteer 25 against headless Chromium and Google Chrome 157, plus a soak test (3 clients, 30 rounds) that checks for leftover contexts, sessions and memory growth (`CDP_SHARE_SOAK=1 npm run test:soak`).

cdp-share started as the keep-alive bridge inside [turbo-browser-mcp](https://github.com/Tthanh2k6/turbo-browser-mcp).

## License

MIT
