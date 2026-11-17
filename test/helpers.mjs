// Test helpers. Everything runs on random free ports against a Chromium launched here.
// NEVER point a test at 9222 or 9224: the machine owner's real Chrome and bridge live there.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import { WsConnection } from '../src/ws.mjs';

export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.once('error', reject);
  });

export const cap = (p, ms = 8000, what = 'operation') =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`HANG: ${what} after ${ms} ms`)), ms))]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tmpDir(prefix = 'cdp-share-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function findChromium() {
  // CDP_SHARE_TEST_CHROME=<path to chrome.exe> runs the suite on that browser (Playwright gives it a fresh temp profile).
  if (process.env.CDP_SHARE_TEST_CHROME) return { executablePath: process.env.CDP_SHARE_TEST_CHROME };
  const p = chromium.executablePath();
  if (p && fs.existsSync(p)) return {};
  // Bundled revision missing: take the newest Playwright cache entry.
  const cache = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') : path.join(os.homedir(), '.cache', 'ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium_headless_shell-\d+$|^chromium-\d+$/.test(d)) : [];
  dirs.sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
  for (const d of dirs) {
    const stack = [path.join(cache, d)];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (/^(chrome|headless_shell|chrome-headless-shell)(\.exe)?$/.test(e.name)) return { executablePath: full };
      }
    }
  }
  return {};
}

/** Launch headless Chromium with a remote debugging port. Returns { browser, cdpPort, wsUrl, close }. */
export async function launchUpstream() {
  const cdpPort = await freePort();
  const browser = await chromium.launch({ headless: true, ...findChromium(), args: [`--remote-debugging-port=${cdpPort}`] });
  const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
  return { browser, cdpPort, wsUrl: v.webSocketDebuggerUrl, close: () => browser.close().catch(() => {}) };
}

/** Tiny HTTP server with /public and /secret pages. */
export async function startSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${req.url}</title><input id=i><h1>${req.url}</h1>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, url: (p) => `http://127.0.0.1:${port}${p}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/**
 * Raw CDP-over-WebSocket client with arbitrary headers. Resolves { status } when the server refuses the upgrade,
 * or a connected client { send(method, params, sessionId), events, close() }.
 */
export function rawCdp(wsUrl, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...headers },
    });
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: 0 }) : reject(e)));
    req.on('upgrade', (_res, socket, head) => {
      const ws = new WsConnection(socket, { maskOutgoing: true, initialChunk: head });
      let id = 0;
      const pending = new Map();
      const events = [];
      const waiters = [];
      let closed = false;
      ws.onMessage = (text) => {
        const m = JSON.parse(text);
        if (m.id !== undefined && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          p(m);
        } else {
          events.push(m);
          for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
        }
      };
      ws.onClose = () => { closed = true; for (const p of pending.values()) p({ error: { message: 'closed' } }); };
      resolve({
        status: 101,
        events,
        get closed() { return closed; },
        // Resolves with the whole reply message ({ result } or { error }).
        send: (method, params = {}, sessionId) => cap(new Promise((r) => {
          const myId = ++id;
          pending.set(myId, r);
          ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
        }), 8000, `raw ${method}`),
        waitEvent: (pred) => {
          const hit = events.find(pred);
          if (hit) return Promise.resolve(hit);
          return cap(new Promise((r) => waiters.push({ pred, resolve: r })), 8000, 'raw waitEvent');
        },
        close: () => ws.close(),
      });
    });
    req.end();
  });
}

export async function rawHttp(url, { method = 'GET', headers = {} } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
