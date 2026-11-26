#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, VERSION, generateToken, getStatus, resolveUpstream, startCdpShare, stopCdpShare } from './index.mjs';
import { tcpOpen } from './upstream.mjs';

const HELP = `cdp-share ${VERSION}
Share one approved Chrome remote-debugging connection between many CDP clients.

Usage:
  cdp-share [start] [options]   start the daemon in the background
  cdp-share status [--port N]   print status JSON (exit 1 if not running)
  cdp-share stop [--port N]     stop the daemon

Options:
  --port <n>              port to listen on, 127.0.0.1 only (default ${DEFAULT_PORT})
  --chrome <url>          Chrome http://host:port or ws://... URL
                          (default: DevToolsActivePort of the default Chrome/Edge/Brave profile, else http://127.0.0.1:9222)
  --token <t|auto>        require a token (?token= on ws URLs, Authorization: Bearer / x-cdp-share-token on HTTP)
  --log <file.jsonl>      audit log: connects, disconnects, commands (no params except Target.* and Page.navigate url)
  --include-url <regex>   show only targets whose URL matches
  --exclude-url <regex>   hide targets whose URL matches
  --no-focus              keep Chrome in the background (force background: true on new tabs, no-op focus commands, enable focus emulation)
  --no-focus-emulation    with --no-focus, do not send Emulation.setFocusEmulationEnabled({ enabled: true })
  --foreground            keep attached, log to stderr
  --timeout <sec>         how long start waits for Chrome's Allow prompt (default 90)
  --version, --help

Environment: CDP_SHARE_PORT, CDP_SHARE_CHROME, CDP_SHARE_TOKEN, CDP_SHARE_LOG, CDP_SHARE_INCLUDE_URL, CDP_SHARE_EXCLUDE_URL, CDP_SHARE_NO_FOCUS, CDP_SHARE_NO_FOCUS_EMULATION, CDP_SHARE_HOME (state dir).
`;

const VALUE_FLAGS = new Set(['port', 'chrome', 'token', 'log', 'include-url', 'exclude-url', 'timeout', 'home', 'token-file', 'out-file']);
const BOOL_FLAGS = new Set(['foreground', 'no-focus', 'no-focus-emulation', 'help', 'version']);

function parseArgs(argv) {
  const out = { cmd: '', flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      if (!out.cmd) out.cmd = a;
      else throw new Error(`unexpected argument: ${a}`);
      continue;
    }
    let [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOL_FLAGS.has(name)) {
      out.flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      out.flags[name] = v;
    } else {
      throw new Error(`unknown option: --${name}`);
    }
  }
  return out;
}

const env = process.env;
let homeOverride = '';
const stateDir = () => homeOverride || env.CDP_SHARE_HOME || path.join(os.homedir(), '.cdp-share');
const stateFile = (port) => path.join(stateDir(), `${port}.json`);

function readState(port) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(port), 'utf8'));
  } catch {
    return null;
  }
}

function settings(flags) {
  const port = Number(flags.port ?? env.CDP_SHARE_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port ${flags.port}`);
  const noFocusEmulation = Boolean(
    flags['no-focus-emulation'] ||
    /^(1|true|yes)$/i.test(String(env.CDP_SHARE_NO_FOCUS_EMULATION ?? '')) ||
    /^(0|false|no)$/i.test(String(env.CDP_SHARE_FOCUS_EMULATION ?? ''))
  );
  return {
    port,
    chrome: flags.chrome ?? env.CDP_SHARE_CHROME ?? '',
    token: flags.token ?? env.CDP_SHARE_TOKEN ?? '',
    log: flags.log ?? env.CDP_SHARE_LOG ?? '',
    includeUrl: flags['include-url'] ?? env.CDP_SHARE_INCLUDE_URL ?? '',
    excludeUrl: flags['exclude-url'] ?? env.CDP_SHARE_EXCLUDE_URL ?? '',
    noFocus: Boolean(flags['no-focus'] || /^(1|true|yes)$/i.test(String(env.CDP_SHARE_NO_FOCUS ?? ''))),
    noFocusEmulation,
    focusEmulation: !noFocusEmulation,
    timeoutMs: Math.max(1, Number(flags.timeout ?? 90)) * 1000,
  };
}

// Token for status/stop: --token, env, then the state file the daemon wrote for that port.
function clientToken(flags, port) {
  return flags.token || env.CDP_SHARE_TOKEN || readState(port)?.token || '';
}

function printUrls(url, wsUrl, token, generated) {
  console.log(`cdp-share ${VERSION} running`);
  if (token) {
    // Many clients (chrome-devtools-mcp --browserUrl, plain fetch) cannot send an Authorization header: hand out the ws URL.
    console.log(`  ws:   ${wsUrl}   <- use this one`);
    console.log(`  http: ${url}   (needs an Authorization: Bearer header or ?token=)`);
    console.log(`  token: ${token}${generated ? ' (generated)' : ''}`);
    console.log(`Examples:
  chrome-devtools-mcp --wsEndpoint "${wsUrl}"
  Playwright: chromium.connectOverCDP("${wsUrl}")`);
  } else {
    console.log(`  http: ${url}`);
    console.log(`  ws:   ${wsUrl}`);
    console.log('Point CDP clients at the http URL (or the ws URL). Chrome keeps one connection, so Allow is asked once.');
  }
}

// Windows: Win32_Process.Create starts the daemon under the WMI service, outside any kill-on-close Job Object of the
// caller (Claude Code, VS Code). Returns the pid, or 0 when it cannot be used (caller then falls back to spawn).
function spawnViaWmi(args) {
  if (process.platform !== 'win32' || env.CDP_SHARE_NO_WMI === '1' || args.some((a) => a.includes('"'))) return 0;
  try {
    const cmdLine = [process.execPath, ...args].map((a) => `"${a}"`).join(' ');
    const escaped = cmdLine.replace(/'/g, "''");
    // DETACHED_PROCESS (no console) + SW_HIDE.
    const ps = "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]8 }; " +
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escaped}'; ProcessStartupInformation = $si }; ` +
      'if ($r.ReturnValue -ne 0) { exit 1 }; Write-Output $r.ProcessId';
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = Number(out.trim().split(/\s+/).pop());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function runDaemon(s, { foreground, generated = false }) {
  const logger = (m) => console.error(`[cdp-share] ${m}`);
  // Exit codes: 0 shutdown, 1 failed to start, 3 upstream Chrome gone for good, 4 own server socket lost.
  let handle;
  // Close sockets and servers first, then set the exit code and let the event loop drain; the unref'd timer is only a
  // safety net. (process.exit() with handles still closing can abort libuv on Windows: exit 0xC0000409.)
  let finishing = false;
  const finish = (code) => {
    if (finishing) return;
    finishing = true;
    const done = () => { process.exitCode = code; setTimeout(() => process.exit(code), 3000).unref(); };
    if (handle) handle.close().catch(() => {}).then(done); else done();
  };
  try {
    handle = await startCdpShare({
      chrome: s.chrome, port: s.port, token: s.token, log: s.log, includeUrl: s.includeUrl, excludeUrl: s.excludeUrl,
      noFocus: s.noFocus, focusEmulation: s.focusEmulation, noFocusEmulation: s.noFocusEmulation,
      reconnectMs: 2500, logger,
      onUpstreamLost: () => finish(3),
      onServerLost: () => finish(4),
    });
  } catch (err) {
    console.error(`[cdp-share] failed to start: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(stateFile(handle.port), JSON.stringify({ pid: process.pid, port: handle.port, token: handle.token, startedAt: new Date().toISOString() }), { mode: 0o600 });
    process.on('exit', () => { try { fs.unlinkSync(stateFile(handle.port)); } catch {} });
  } catch {
    // state file is a convenience only
  }
  if (foreground) printUrls(handle.url, handle.wsUrl, handle.token, generated);
  else console.log(`cdp-share listening at ${handle.url}`);
  // Runs after serverLost(): an unexpected close has already started exit 4; a /cdp-share/shutdown close exits 0.
  handle.server.on('close', () => setTimeout(() => finish(0), 200));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => finish(0));
}

async function cmdStart(flags) {
  const s = settings(flags);
  if (s.token === 'auto') s.token = generateToken();
  const generated = Boolean(flags.token === 'auto' || env.CDP_SHARE_TOKEN === 'auto');

  if (flags.foreground) {
    await runDaemon(s, { foreground: true, generated });
    return;
  }

  const existing = await getStatus(s.port, { token: s.token || clientToken(flags, s.port) });
  if (existing && !existing.unauthorized) {
    const tok = s.token || clientToken(flags, s.port);
    printUrls(`http://127.0.0.1:${s.port}`, `ws://127.0.0.1:${s.port}/devtools/browser/cdp-share${tok ? `?token=${encodeURIComponent(tok)}` : ''}`, tok, false);
    console.log('(already running)');
    return;
  }
  if (existing?.unauthorized) throw new Error(`a cdp-share is already on port ${s.port} and needs another token (--token)`);
  if (await tcpOpen('127.0.0.1', s.port, 400)) throw new Error(`port ${s.port} is already in use by something else`);

  const upstream = await resolveUpstream(s.chrome);
  const outFile = path.join(os.tmpdir(), `cdp-share-${s.port}.out`);
  const fd = fs.openSync(outFile, 'w');
  const args = [fileURLToPath(import.meta.url), '__daemon', '--port', String(s.port), '--chrome', upstream];
  if (s.log) args.push('--log', path.resolve(s.log));
  if (s.includeUrl) args.push('--include-url', s.includeUrl);
  if (s.excludeUrl) args.push('--exclude-url', s.excludeUrl);
  if (s.noFocus) args.push('--no-focus');
  if (s.noFocusEmulation) args.push('--no-focus-emulation');
  let exited = null;
  let child = null;
  let wmiPid = 0;
  if (process.platform === 'win32') {
    const wargs = [...args, '--home', stateDir(), '--out-file', outFile];
    if (s.token) {
      const tf = path.join(stateDir(), `.start-${s.port}.token`);
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(tf, s.token, { mode: 0o600 });
      wargs.push('--token-file', tf);
    }
    wmiPid = spawnViaWmi(wargs);
  }
  if (!wmiPid) {
    child = spawn(process.execPath, args, {
      detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
      env: { ...env, CDP_SHARE_TOKEN: s.token || '' },
    });
    child.on('exit', (code) => { exited = code; });
    child.on('error', (err) => { exited = `spawn error: ${err.message}`; });
  }
  fs.closeSync(fd);

  const started = Date.now();
  let hinted = false;
  for (;;) {
    if (wmiPid && !pidAlive(wmiPid)) exited = 'process gone';
    if (exited !== null) {
      let tail = '';
      try { tail = fs.readFileSync(outFile, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch {}
      throw new Error(`daemon exited (${exited})${tail ? `\n${tail}` : ''}`);
    }
    const st = await getStatus(s.port, { token: s.token });
    if (st && !st.unauthorized && st.upstream?.connected) break;
    if (Date.now() - started > s.timeoutMs) {
      try { child ? child.kill() : process.kill(wmiPid); } catch {}
      throw new Error(`timed out after ${Math.round(s.timeoutMs / 1000)}s waiting for Chrome. Click "Allow" in the Chrome prompt and run again.`);
    }
    if (!hinted && Date.now() - started > 3000) {
      hinted = true;
      console.error('Waiting for Chrome... if it shows "Allow remote debugging", click Allow.');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child?.unref();
  const tokenQ = s.token ? `?token=${encodeURIComponent(s.token)}` : '';
  printUrls(`http://127.0.0.1:${s.port}`, `ws://127.0.0.1:${s.port}/devtools/browser/cdp-share${tokenQ}`, s.token, generated);
}

async function cmdStatus(flags) {
  const s = settings(flags);
  const st = await getStatus(s.port, { token: clientToken(flags, s.port) });
  if (!st) {
    console.log(JSON.stringify({ running: false, port: s.port }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(st, null, 2));
  if (st.unauthorized) process.exitCode = 1;
}

async function cmdStop(flags) {
  const s = settings(flags);
  const token = clientToken(flags, s.port);
  const st = await getStatus(s.port, { token });
  if (!st) {
    console.log(`cdp-share is not running on port ${s.port}`);
    return;
  }
  if (await stopCdpShare(s.port, { token })) console.log(`cdp-share on port ${s.port} stopped`);
  else {
    console.error(`could not stop the cdp-share on port ${s.port}${st.unauthorized ? ' (wrong or missing --token)' : ''}`);
    process.exitCode = 1;
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`cdp-share: ${err.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  const { cmd, flags } = parsed;
  if (flags.help) return console.log(HELP);
  if (flags.version) return console.log(VERSION);
  try {
    if (cmd === '__daemon') {
      if (flags.home) homeOverride = flags.home;
      if (flags['token-file']) {
        try { flags.token = fs.readFileSync(flags['token-file'], 'utf8').trim(); fs.unlinkSync(flags['token-file']); } catch {}
      }
      if (flags['out-file']) {
        const w = (...a) => { try { fs.appendFileSync(flags['out-file'], `${a.join(' ')}\n`); } catch {} };
        console.log = w;
        console.error = w;
      }
      return await runDaemon(settings(flags), { foreground: false });
    }
    if (cmd === '' || cmd === 'start') return await cmdStart(flags);
    if (cmd === 'status') return await cmdStatus(flags);
    if (cmd === 'stop') return await cmdStop(flags);
    console.error(`cdp-share: unknown command ${cmd}\n\n${HELP}`);
    process.exitCode = 2;
  } catch (err) {
    console.error(`cdp-share: ${err.message}`);
    process.exitCode = 1;
  }
}

await main();
