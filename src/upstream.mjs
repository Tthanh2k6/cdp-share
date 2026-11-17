// Finding the Chrome to share: explicit http/ws URL, or DevToolsActivePort in the default user-data dirs.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function defaultUserDataDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Google', 'Chrome Beta', 'User Data'),
      path.join(local, 'Google', 'Chrome Dev', 'User Data'),
      path.join(local, 'Google', 'Chrome SxS', 'User Data'),
      path.join(local, 'Chromium', 'User Data'),
      path.join(local, 'Microsoft', 'Edge', 'User Data'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    ];
  }
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [
      path.join(base, 'Google', 'Chrome'),
      path.join(base, 'Google', 'Chrome Beta'),
      path.join(base, 'Google', 'Chrome Canary'),
      path.join(base, 'Chromium'),
      path.join(base, 'Microsoft Edge'),
      path.join(base, 'BraveSoftware', 'Brave-Browser'),
    ];
  }
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    path.join(cfg, 'google-chrome'),
    path.join(cfg, 'google-chrome-beta'),
    path.join(cfg, 'google-chrome-unstable'),
    path.join(cfg, 'chromium'),
    path.join(cfg, 'microsoft-edge'),
    path.join(cfg, 'BraveSoftware', 'Brave-Browser'),
    path.join(home, 'snap', 'chromium', 'common', 'chromium'),
  ];
}

export function tcpOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Parse a DevToolsActivePort file into { port, wsPath } or null. */
export function readDevToolsActivePort(dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const port = Number.parseInt(lines[0], 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || !lines[1].startsWith('/')) return null;
    return { port, wsPath: lines[1] };
  } catch {
    return null;
  }
}

async function wsFromPortFiles(dirs, onlyPort) {
  for (const dir of dirs) {
    const found = readDevToolsActivePort(dir);
    if (!found) continue;
    if (onlyPort && found.port !== onlyPort) continue;
    if (await tcpOpen('127.0.0.1', found.port)) return `ws://127.0.0.1:${found.port}${found.wsPath}`;
  }
  return null;
}

/**
 * Resolve the upstream browser WebSocket URL.
 *  - ws:// or wss:// URL: used as is.
 *  - http(s):// URL: /json/version first (classic --remote-debugging-port); when that is disabled
 *    (Chrome 144+ "Allow remote debugging" mode) the DevToolsActivePort file for that port.
 *  - nothing given: DevToolsActivePort of the default Chrome/Edge/Brave dirs, else http://127.0.0.1:9222.
 */
export async function resolveUpstream(chrome, opts = {}) {
  const explicitDirs = Array.isArray(opts.userDataDirs);
  const userDataDirs = explicitDirs ? opts.userDataDirs : defaultUserDataDirs();
  const timeoutMs = opts.timeoutMs ?? 1500;
  const raw = chrome ? String(chrome).trim() : '';
  if (/^wss?:\/\//i.test(raw)) return raw;
  if (raw) {
    if (!/^https?:\/\//i.test(raw)) throw new Error(`--chrome must be an http(s):// or ws(s):// URL (got ${raw})`);
    const u = new URL(raw);
    try {
      const res = await fetch(new URL('/json/version', u).href, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const data = await res.json();
        if (data?.webSocketDebuggerUrl) {
          // Chrome may report another host name; keep the one the caller can reach.
          const ws = new URL(data.webSocketDebuggerUrl);
          ws.hostname = u.hostname;
          if (u.port) ws.port = u.port;
          return ws.href;
        }
      }
    } catch {
      // fall through to DevToolsActivePort
    }
    const viaFile = await wsFromPortFiles(userDataDirs, Number(u.port) || 80);
    if (viaFile) return viaFile;
    throw new Error(`Chrome not reachable at ${raw} (no /json/version and no matching DevToolsActivePort)`);
  }
  const viaFile = await wsFromPortFiles(userDataDirs);
  if (viaFile) return viaFile;
  // Explicit dirs mean "look only there"; the classic port 9222 is the last resort of the default search.
  if (explicitDirs) throw new Error('no DevToolsActivePort found in the given user-data dirs');
  return resolveUpstream('http://127.0.0.1:9222', { userDataDirs: [], timeoutMs });
}
