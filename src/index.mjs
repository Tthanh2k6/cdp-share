import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createBridge, DEFAULT_PORT, VERSION } from './bridge.mjs';
import { resolveUpstream, tcpOpen } from './upstream.mjs';

export { DEFAULT_PORT, VERSION, resolveUpstream };

export const generateToken = () => crypto.randomBytes(24).toString('base64url');

/**
 * Start the shared-Chrome bridge inside this process.
 * options: { chrome, port, token ('auto' to generate), includeUrl, excludeUrl, log (jsonl path), host, userDataDirs,
 *            reconnectMs, onUpstreamLost, onServerLost, logger }
 * Returns { url, wsUrl, port, token, status(), close() }.
 */
export async function startCdpShare(options = {}) {
  const {
    chrome, port = DEFAULT_PORT, host = '127.0.0.1', includeUrl = null, excludeUrl = null, noFocus = false, log = '', userDataDirs,
    reconnectMs = 0, onUpstreamLost = null, onServerLost = null, logger = null, connectTimeoutMs = 60000,
  } = options;
  const token = options.token === 'auto' ? generateToken() : options.token || '';
  const upstreamUrl = await resolveUpstream(chrome, userDataDirs ? { userDataDirs } : {});
  const b = await createBridge({
    upstreamUrl, port, host, token, includeUrl, excludeUrl, noFocus, logFile: log, reconnectMs, onUpstreamLost, onServerLost, log: logger, connectTimeoutMs,
  });
  return { url: b.httpUrl, wsUrl: b.wsUrl, server: b.server, port: b.port, token, upstreamUrl, status: b.status, close: b.close };
}

const authHeaders = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

/** Status object of the cdp-share on `port`, `{ running: true, unauthorized: true }` when the token is wrong, or null when none runs there. */
export async function getStatus(port = DEFAULT_PORT, { token = '', host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(`http://${host}:${port}/cdp-share/status`, { headers: authHeaders(token), signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401) return { running: true, unauthorized: true };
    if (!res.ok) return null;
    const data = await res.json();
    return data?.name === 'cdp-share' ? data : null;
  } catch {
    return null;
  }
}

/**
 * A daemon from older code, or a hung one, may not answer /cdp-share/shutdown. Stop it only when the process that
 * listens on the port provably is our daemon (command line has cli.mjs, __daemon and --port <port>).
 */
export async function killVerifiedStaleDaemon(port = DEFAULT_PORT, host = '127.0.0.1') {
  let pid = 0;
  let cmd = '';
  try {
    if (process.platform === 'win32') {
      const ps = `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -ErrorAction Stop | Where-Object { $_.RemotePort -eq 0 } | Select-Object -First 1; ` +
        '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; "$($p.ProcessId)|$($p.CommandLine)"';
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      pid = Number(out.split('|')[0]);
      cmd = out.slice(out.indexOf('|') + 1);
    } else {
      pid = Number(execFileSync('lsof', ['-ti', `tcp:${Number(port)}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s+/)[0]);
      cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    }
  } catch {
    return false;
  }
  if (!pid || pid === process.pid || !/cli\.mjs/.test(cmd) || !/__daemon\b/.test(cmd) || !new RegExp('--port\s+' + Number(port) + '\b').test(cmd)) return false;
  try { process.kill(pid); } catch { return false; }
  return waitPortFree(port, host, 2500);
}

async function waitPortFree(port, host, waitMs) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    if (!(await tcpOpen(host, port, 300))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Ask the cdp-share on `port` to exit and wait until the port is free. Returns true when nothing listens any more. */
export async function stopCdpShare(port = DEFAULT_PORT, { token = '', host = '127.0.0.1', waitMs = 3000 } = {}) {
  const before = await getStatus(port, { token, host });
  if (!before) return !(await tcpOpen(host, port, 300)) || (await killVerifiedStaleDaemon(port, host));
  if (before.unauthorized) return false;
  try {
    await fetch(`http://${host}:${port}/cdp-share/shutdown`, { method: 'POST', headers: authHeaders(token), signal: AbortSignal.timeout(1500) });
  } catch {
    // check below
  }
  if (await waitPortFree(port, host, waitMs)) return true;
  return killVerifiedStaleDaemon(port, host);
}
