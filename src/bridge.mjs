import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { WS_GUID, WsConnection } from './ws.mjs';

export const VERSION = '0.1.0';
export const DEFAULT_PORT = 9333; // not 9224: turbo-browser-mcp's own bridge uses that port
const BROWSER_PATH = '/devtools/browser/cdp-share';
const RESUME_FALLBACK_MS = 10000;
// Target types Chrome's browser-level auto-attach hands to a client.
const ATTACHABLE_TYPES = new Set(['page', 'background_page', 'service_worker', 'shared_worker', 'webview']);
// Sessionless commands that name a target and must not reach a hidden one.
const TARGET_GUARDED = new Set([
  'Target.attachToTarget', 'Target.getTargetInfo', 'Target.activateTarget', 'Target.closeTarget', 'Target.exposeDevToolsProtocol',
]);
const LOG_TARGET_KEYS = ['targetId', 'url', 'browserContextId', 'sessionId', 'autoAttach', 'discover', 'flatten', 'waitForDebuggerOnStart', 'newWindow', 'background'];

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim());
  if (!m) return false;
  return ['localhost', '127.0.0.1', '[::1]'].includes(m[1].toLowerCase());
}

// Chrome's own rule: a page origin is refused; extensions and DevTools are fine. No Origin header = not a browser page.
function originAllowed(origin) {
  if (origin === undefined) return true;
  return /^(chrome-extension|devtools):\/\//i.test(String(origin));
}

function cleanName(name) {
  if (!name) return '';
  return String(name).replace(/[^\w .:@/+-]/g, '').slice(0, 64);
}

function compileRe(src, label) {
  if (!src) return null;
  if (src instanceof RegExp) return src;
  try {
    return new RegExp(src);
  } catch (err) {
    throw new Error(`invalid ${label} regex: ${err.message}`);
  }
}

/** Params that may go into the audit log. Everything else (typed text, expressions, cookies) is never logged. */
export function auditParams(method, params) {
  if (!params || typeof params !== 'object') return undefined;
  if (method === 'Page.navigate') return typeof params.url === 'string' ? { url: params.url } : undefined;
  if (method.startsWith('Target.')) {
    const out = {};
    for (const k of LOG_TARGET_KEYS) {
      const v = params[k];
      if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

/**
 * Start the sharing bridge. ONE upstream WebSocket to Chrome (so the "Allow remote debugging" prompt shows once),
 * a separate CDP session set per client.
 */
export async function createBridge({
  upstreamUrl,
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  token = '',
  includeUrl = null,
  excludeUrl = null,
  noFocus = false,
  logFile = '',
  connectTimeoutMs = 60000,
  // The daemon sets reconnectMs and the two callbacks; library use keeps a bridge with a dead upstream alive.
  reconnectMs = 0,
  onUpstreamLost = null,
  onServerLost = null,
  log = null,
} = {}) {
  if (!upstreamUrl || !/^wss?:\/\//.test(upstreamUrl)) {
    throw new Error(`createBridge requires a ws:// or wss:// upstreamUrl (got ${upstreamUrl})`);
  }
  if (host === 'localhost') host = '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error(`cdp-share only listens on 127.0.0.1 (got host ${host})`);
  const includeRe = compileRe(includeUrl, 'include-url');
  const excludeRe = compileRe(excludeUrl, 'exclude-url');
  const filterActive = Boolean(includeRe || excludeRe);
  const startedAt = Date.now();

  function targetAllowed(info) {
    if (!filterActive || !info || info.type === 'browser') return true;
    const url = info.url || '';
    if (excludeRe && excludeRe.test(url)) return false;
    // Blank tabs carry nothing to protect; this also keeps new tabs a client creates reachable.
    if (includeRe && url && url !== 'about:blank' && !includeRe.test(url)) return false;
    return true;
  }
  const allowedFor = (client, info) => targetAllowed(info) || client.allowedTargets.has(info?.targetId);

  // ---- audit log ----
  let auditFd = null;
  if (logFile) auditFd = fs.openSync(logFile, 'a');
  function audit(entry) {
    if (auditFd === null) return;
    try {
      fs.writeSync(auditFd, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch {
      // a full disk must not take the bridge down
    }
  }

  let upstreamWs = null;
  let upstreamConnected = false;
  let browserVersionInfo = { Browser: 'Chrome', 'Protocol-Version': '1.3', 'User-Agent': 'Mozilla/5.0 Chrome' };

  let nextUpstreamId = 100000;
  const pendingCalls = new Map(); // upstreamId -> { client, clientMsgId, internalResolve, method, ... }
  const clients = new Set();
  const discoveredTargets = new Map(); // targetId -> targetInfo
  // Every client gets its own CDP sessions: two Playwright clients on one session fight over one-time setup.
  const owners = new Map(); // upstream sessionId -> { client, targetId, root }
  const bridgeAttached = new Map(); // bridge-owned hold session (S0) -> Target.attachedToTarget params
  const resumes = new Map(); // S0 sessionId -> { waiting: Set<client>, timer }
  let upstreamAutoAttach = null;
  let upstreamDiscover = null;

  function sendUpstreamRaw(obj) {
    if (!upstreamWs || upstreamWs.closed) return false;
    upstreamWs.send(JSON.stringify(obj));
    return true;
  }

  function callUpstreamInternal(method, params = {}, sessionId) {
    return new Promise((resolve) => {
      if (!upstreamWs || upstreamWs.closed) return resolve(null);
      const id = nextUpstreamId++;
      pendingCalls.set(id, { client: null, clientMsgId: null, internalResolve: resolve, method: `${method}${sessionId ? '@session' : ''}` });
      sendUpstreamRaw({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }

  // Deliver to a client. A page-scoped client (/devtools/page/<id>) never sees its session id.
  function deliver(client, text) {
    if (client.closed) return;
    if (client.pageSession && text.includes(client.pageSession)) {
      try {
        const m = JSON.parse(text);
        if (m.sessionId === client.pageSession) {
          delete m.sessionId;
          text = JSON.stringify(m);
        }
      } catch {
        // send as is
      }
    }
    client.send(text);
  }

  function logCommand(client, parsed, ok, error) {
    if (auditFd === null) return;
    const params = auditParams(parsed.method, parsed.params);
    audit({
      event: 'command',
      client: client.id,
      ...(client.name ? { name: client.name } : {}),
      method: parsed.method,
      ...(parsed.params?.targetId ? { targetId: parsed.params.targetId } : {}),
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      ok,
      ...(error ? { error } : {}),
      ...(params ? { params } : {}),
    });
  }

  function resumeBridgeSession(s0) {
    const rec = resumes.get(s0);
    if (!rec) return;
    clearTimeout(rec.timer);
    resumes.delete(s0);
    void callUpstreamInternal('Runtime.runIfWaitingForDebugger', {}, s0);
  }

  function clientResumed(client, s0) {
    const rec = resumes.get(s0);
    if (!rec) return;
    rec.waiting.delete(client);
    if (rec.waiting.size === 0) resumeBridgeSession(s0);
  }

  // One new upstream session for this client to a target, then announce it.
  async function attachForClient(client, params, waiting) {
    const targetId = params.targetInfo?.targetId;
    if (!targetId || client.attachedTargetIds.has(targetId)) return;
    if (!allowedFor(client, params.targetInfo)) return;
    client.attachedTargetIds.add(targetId);
    const res = await callUpstreamInternal('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = res?.sessionId;
    if (!sessionId) {
      client.attachedTargetIds.delete(targetId);
      return;
    }
    if (client.closed) {
      void callUpstreamInternal('Target.detachFromTarget', { sessionId });
      return;
    }
    owners.set(sessionId, { client, targetId, root: true });
    client.sessions.add(sessionId);
    if (waiting && params.sessionId) resumes.get(params.sessionId)?.waiting.add(client);
    client.send(
      JSON.stringify({
        method: 'Target.attachedToTarget',
        params: { sessionId, targetInfo: params.targetInfo, waitingForDebugger: Boolean(waiting) },
      })
    );
  }

  function trackTask(client, p) {
    client.tasks.add(p);
    void p.then(() => client.tasks.delete(p), () => client.tasks.delete(p));
    return p;
  }

  // A target Chrome's browser-level auto-attach just attached the bridge to: hold it, give every autoAttach client its own session.
  function handleNewTarget(params) {
    const s0 = params.sessionId;
    if (!targetAllowed(params.targetInfo)) {
      // Hidden target: let it run and drop the bridge's hold at once. No client will ever see it.
      if (params.waitingForDebugger) void callUpstreamInternal('Runtime.runIfWaitingForDebugger', {}, s0);
      void callUpstreamInternal('Target.detachFromTarget', { sessionId: s0 });
      return;
    }
    bridgeAttached.set(s0, params);
    const waiting = Boolean(params.waitingForDebugger);
    const targets = [...clients].filter((c) => c.autoAttach && !c.closed && !c.pageSession);
    if (waiting) resumes.set(s0, { waiting: new Set(), timer: setTimeout(() => resumeBridgeSession(s0), RESUME_FALLBACK_MS) });
    const tasks = targets.map((c) => trackTask(c, attachForClient(c, params, waiting && c.waitDbg)));
    Promise.all(tasks)
      .catch(() => {})
      .then(() => {
        if (waiting && resumes.get(s0)?.waiting.size === 0) resumeBridgeSession(s0);
      });
  }

  // Targets a joining autoAttach client should get: held ones, and (with a filter) ones that became visible later.
  function attachCandidates(client) {
    const byId = new Map();
    for (const p of bridgeAttached.values()) byId.set(p.targetInfo?.targetId, p);
    if (filterActive) {
      for (const info of discoveredTargets.values()) {
        if (!byId.has(info.targetId) && ATTACHABLE_TYPES.has(info.type)) byId.set(info.targetId, { targetInfo: info });
      }
    }
    return [...byId.values()].filter((p) => allowedFor(client, p.targetInfo));
  }

  // Browser contexts a client created through the bridge die with that client (the default context is never touched).
  // No hand-over to other clients: with auto-attach every client is "in" every tab, so ownership is the creator's.
  function disposeClientContexts(client) {
    for (const ctxId of [...client.createdContexts]) {
      client.createdContexts.delete(ctxId);
      void callUpstreamInternal('Target.disposeBrowserContext', { browserContextId: ctxId });
    }
  }

  function releaseClient(client) {
    // Commands this client still waits for may never be answered (their session is about to be detached): forget them,
    // except createBrowserContext, whose reply is needed to dispose the context it creates.
    for (const [id, p] of pendingCalls) {
      if (p.client === client && p.method !== 'Target.createBrowserContext') pendingCalls.delete(id);
    }
    disposeClientContexts(client);
    for (const sid of client.sessions) {
      owners.delete(sid);
      void callUpstreamInternal('Target.detachFromTarget', { sessionId: sid });
    }
    client.sessions.clear();
    for (const s0 of [...resumes.keys()]) clientResumed(client, s0);
    for (const [sid, o] of owners) if (o.client === client) owners.delete(sid);
  }

  function onUpstreamResponse(msg, pending) {
    const c = pending.client;
    const failed = Boolean(msg.error);
    if (c && !c.closed) {
      if (pending.method === 'Target.createBrowserContext' && msg.result?.browserContextId) {
        c.createdContexts.add(msg.result.browserContextId);
      } else if (pending.method === 'Target.disposeBrowserContext' && !failed && pending.contextId) {
        c.createdContexts.delete(pending.contextId);
      } else if (pending.method === 'Target.createTarget' && msg.result?.targetId) {
        c.allowedTargets.add(msg.result.targetId);
      } else if (pending.method === 'Target.getTargets' && filterActive && Array.isArray(msg.result?.targetInfos)) {
        msg = { ...msg, result: { ...msg.result, targetInfos: msg.result.targetInfos.filter((i) => allowedFor(c, i)) } };
      }
      if ((pending.method === 'Target.attachToTarget' || pending.method === 'Target.attachToBrowserTarget') && msg.result?.sessionId) {
        owners.set(msg.result.sessionId, { client: c, targetId: pending.targetId, root: false });
        c.sessions.add(msg.result.sessionId);
        if (pending.targetId) c.allowedTargets.add(pending.targetId);
      } else if (pending.method === 'Target.detachFromTarget' && pending.detachSessionId) {
        owners.delete(pending.detachSessionId);
        c.sessions.delete(pending.detachSessionId);
      }
    } else if (c && pending.method === 'Target.createBrowserContext' && msg.result?.browserContextId) {
      // The client left before the answer: do not leak the context.
      void callUpstreamInternal('Target.disposeBrowserContext', { browserContextId: msg.result.browserContextId });
    }
    if (c) logCommand(c, { method: pending.method, params: pending.logParams, sessionId: pending.sessionId }, !failed, msg.error?.message);
    if (!c || c.closed) return;
    const out = JSON.stringify({ ...msg, id: pending.clientMsgId });
    if (pending.method === 'Target.createTarget' && c.tasks.size > 0) {
      // Chrome announces the new target (attachedToTarget) before this reply; keep that order.
      void Promise.all([...c.tasks]).catch(() => {}).then(() => deliver(c, out));
    } else {
      deliver(c, out);
    }
  }

  function onDiscoverEvent(msg, rawText) {
    const info = msg.params?.targetInfo;
    for (const c of clients) {
      if (c.closed || c.pageSession || !c.discover) continue;
      if (!filterActive) {
        c.send(rawText);
        continue;
      }
      if (msg.method === 'Target.targetCreated') {
        if (allowedFor(c, info)) {
          c.visible.add(info.targetId);
          c.send(rawText);
        }
      } else if (msg.method === 'Target.targetInfoChanged') {
        if (allowedFor(c, info)) {
          if (c.visible.has(info.targetId)) c.send(rawText);
          else {
            c.visible.add(info.targetId);
            c.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: info } }));
          }
        } else if (c.visible.has(info.targetId)) {
          c.visible.delete(info.targetId);
          c.send(JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId: info.targetId } }));
        }
      } else if (c.visible.has(msg.params?.targetId)) {
        c.visible.delete(msg.params.targetId);
        c.send(rawText);
      }
    }
    // A target that just became visible: autoAttach clients get it now.
    if (filterActive && msg.method === 'Target.targetInfoChanged' && ATTACHABLE_TYPES.has(info.type) && targetAllowed(info)) {
      for (const c of clients) {
        if (c.autoAttach && !c.closed && !c.pageSession && !c.attachedTargetIds.has(info.targetId)) {
          trackTask(c, attachForClient(c, { targetInfo: info }, false));
        }
      }
    }
  }

  function onUpstreamMessage(rawText) {
    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      const pending = pendingCalls.get(msg.id);
      if (pending) {
        pendingCalls.delete(msg.id);
        if (pending.internalResolve) pending.internalResolve(msg.result ?? null);
        else onUpstreamResponse(msg, pending);
      }
      return;
    }

    if (msg.sessionId) {
      // Session event: only the client that owns the session sees it.
      const owner = owners.get(msg.sessionId);
      if (!owner || owner.client.closed) return;
      if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
        owners.set(msg.params.sessionId, { client: owner.client, targetId: msg.params.targetInfo?.targetId, root: false });
        owner.client.sessions.add(msg.params.sessionId);
      } else if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) {
        owners.delete(msg.params.sessionId);
        owner.client.sessions.delete(msg.params.sessionId);
      }
      deliver(owner.client, rawText);
      return;
    }

    if (!msg.method) return;
    if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
      handleNewTarget(msg.params);
      return;
    }
    if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) {
      const sid = msg.params.sessionId;
      bridgeAttached.delete(sid);
      const resume = resumes.get(sid);
      if (resume) {
        clearTimeout(resume.timer);
        resumes.delete(sid);
      }
      const owner = owners.get(sid);
      if (owner) {
        owners.delete(sid);
        owner.client.sessions.delete(sid);
        deliver(owner.client, rawText);
      }
      return;
    }
    let discoverEvent = false;
    if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo?.targetId) {
      discoveredTargets.set(msg.params.targetInfo.targetId, msg.params.targetInfo);
      discoverEvent = true;
    } else if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId) {
      discoveredTargets.delete(msg.params.targetId);
      discoverEvent = true;
    } else if (msg.method === 'Target.targetInfoChanged' && msg.params?.targetInfo?.targetId) {
      const tInfo = msg.params.targetInfo;
      discoveredTargets.set(tInfo.targetId, tInfo);
      for (const [sid, entry] of bridgeAttached.entries()) {
        if (entry.targetInfo?.targetId === tInfo.targetId) bridgeAttached.set(sid, { ...entry, targetInfo: tInfo });
      }
      discoverEvent = true;
    }
    if (discoverEvent) {
      onDiscoverEvent(msg, rawText);
      return;
    }
    for (const c of clients) if (!c.closed && !c.pageSession) c.send(rawText);
  }

  async function connectUpstream() {
    return new Promise((resolve, reject) => {
      const parsed = new URL(upstreamUrl);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        hostname: parsed.hostname || '127.0.0.1',
        port: Number(parsed.port) || 9222,
        path: `${parsed.pathname || '/'}${parsed.search || ''}`,
        method: 'GET',
        headers: { Host: parsed.host, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
      });
      const timer = setTimeout(() => {
        try { req.destroy(); } catch {}
        reject(new Error(`Timed out connecting to upstream CDP WebSocket: ${upstreamUrl}`));
      }, connectTimeoutMs);

      req.on('upgrade', async (res, socket, head) => {
        clearTimeout(timer);
        const ws = new WsConnection(socket, { maskOutgoing: true, initialChunk: head });
        upstreamWs = ws;
        upstreamConnected = true;
        ws.onMessage = onUpstreamMessage;
        ws.onClose = () => {
          if (upstreamWs !== ws) return;
          upstreamConnected = false;
          upstreamWs = null;
          for (const c of clients) c.close(1011, 'cdp-share: upstream Chrome closed the remote-debugging connection');
          clients.clear();
          for (const [id, p] of pendingCalls) {
            pendingCalls.delete(id);
            p.internalResolve?.(null);
          }
          owners.clear();
          bridgeAttached.clear();
          discoveredTargets.clear();
          for (const r of resumes.values()) clearTimeout(r.timer);
          resumes.clear();
          upstreamAutoAttach = null;
          upstreamDiscover = null;
          if (!shuttingDown) void handleUpstreamLost();
        };
        try {
          const ver = await callUpstreamInternal('Browser.getVersion', {});
          if (ver && ver.product) {
            browserVersionInfo = {
              Browser: ver.product,
              'Protocol-Version': ver.protocolVersion || '1.3',
              'User-Agent': ver.userAgent || browserVersionInfo['User-Agent'],
              'V8-Version': ver.jsVersion || '',
              'WebKit-Version': ver.revision || '',
            };
          }
        } catch {}
        resolve(ws);
      });
      req.on('response', (res) => {
        clearTimeout(timer);
        reject(new Error(`Upstream CDP rejected WebSocket upgrade with HTTP ${res.statusCode}`));
      });
      req.on('error', (err) => {
        if (!upstreamConnected) {
          clearTimeout(timer);
          reject(new Error(`Upstream CDP WebSocket error on ${upstreamUrl}: ${err?.message || 'connection failed'}`));
        }
      });
      req.end();
    });
  }

  let shuttingDown = false;
  let lostHandled = false;

  // Reconnect only where no approval is involved: a classic --remote-debugging-port answers /json/version with the same
  // browser URL. Chrome 144+ inspect mode would show a fresh "Allow" prompt, so never retry there.
  async function upstreamStillSameBrowser() {
    try {
      const u = new URL(upstreamUrl);
      const res = await fetch(`http://${u.hostname}:${u.port}/json/version`, { signal: AbortSignal.timeout(800) });
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data) && data.webSocketDebuggerUrl === upstreamUrl;
    } catch {
      return false;
    }
  }

  async function handleUpstreamLost() {
    if (lostHandled || shuttingDown) return;
    lostHandled = true;
    const deadline = Date.now() + reconnectMs;
    while (Date.now() < deadline && !shuttingDown) {
      if (await upstreamStillSameBrowser()) {
        try {
          await connectUpstream();
          lostHandled = false;
          log?.('upstream reconnected');
          return;
        } catch {
          // keep trying until the deadline
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (shuttingDown) return;
    log?.(`upstream ${upstreamUrl} closed and could not be re-established`);
    try { await onUpstreamLost?.(); } catch {}
  }

  await connectUpstream();

  // ---- HTTP side ----
  const upstreamHttpBase = (() => {
    const u = new URL(upstreamUrl);
    return { hostname: u.hostname, port: Number(u.port) || 80 };
  })();

  function passthrough(method, urlPath) {
    return new Promise((resolve) => {
      const req = http.request({ ...upstreamHttpBase, path: urlPath, method, timeout: 8000 }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode || 502, type: res.headers['content-type'] || 'application/json', body: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => resolve({ status: 502, type: 'application/json', body: Buffer.from(JSON.stringify({ error: `upstream: ${err.message}` })) }));
      req.end();
    });
  }

  function getRequestToken(req, url) {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^bearer /i.test(auth)) return auth.slice(7).trim();
    const hdr = req.headers['x-cdp-share-token'];
    if (typeof hdr === 'string') return hdr;
    return url.searchParams.get('token') || '';
  }

  // Returns an error status or 0. Same rules for HTTP and WebSocket upgrades.
  function guardRequest(req, url) {
    if (!hostAllowed(req.headers.host)) return [403, 'host not allowed'];
    if (!originAllowed(req.headers.origin)) return [403, 'origin not allowed'];
    if (token && !safeEq(getRequestToken(req, url), token)) return [401, 'token required'];
    return [0, ''];
  }

  const tokenSuffix = () => (token ? `?token=${encodeURIComponent(token)}` : '');
  const wsBase = (req) => `ws://${req.headers.host}`;

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  function statusObject() {
    const addr = server.address();
    return {
      name: 'cdp-share',
      version: VERSION,
      running: true,
      pid: process.pid,
      port: typeof addr === 'object' && addr ? addr.port : port,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      internal: { sessions: owners.size, heldTargets: bridgeAttached.size, pendingCalls: pendingCalls.size, pendingMethods: [...pendingCalls.values()].map((p) => (p.client ? 'client:' : 'internal:') + (p.method || '?')).slice(0, 10) },
      upstream: { url: upstreamUrl, connected: upstreamConnected },
      tokenRequired: Boolean(token),
      noFocus: Boolean(noFocus),
      filter: { includeUrl: includeRe ? includeRe.source : null, excludeUrl: excludeRe ? excludeRe.source : null },
      clients: [...clients].filter((c) => !c.closed).map((c) => ({
        id: c.id,
        name: c.name || null,
        connectedAt: new Date(c.connectedAt).toISOString(),
        sessions: c.sessions.size,
        ...(c.pageTargetId ? { pageTarget: c.pageTargetId } : {}),
      })),
    };
  }

  async function listTargets(req) {
    const res = await callUpstreamInternal('Target.getTargets', {});
    const list = (res?.targetInfos || []).filter((i) => i.type !== 'browser' && i.type !== 'tab' && targetAllowed(i));
    return list.map((i) => ({
      description: '',
      id: i.targetId,
      title: i.title || '',
      type: i.type,
      url: i.url || '',
      webSocketDebuggerUrl: `${wsBase(req)}/devtools/page/${i.targetId}${tokenSuffix()}`,
    }));
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return json(res, 400, { error: 'bad url' });
    }
    const [bad, why] = guardRequest(req, url);
    if (bad) return json(res, bad, { error: why });
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (p === '/json/version') {
        return json(res, 200, { ...browserVersionInfo, webSocketDebuggerUrl: `${wsBase(req)}${BROWSER_PATH}${tokenSuffix()}` });
      }
      if (p === '/json' || p === '/json/list') {
        if (!upstreamConnected) return json(res, 503, { error: 'upstream Chrome not connected' });
        return json(res, 200, await listTargets(req));
      }
      if (p === '/json/protocol') {
        const r = await passthrough('GET', '/json/protocol');
        res.writeHead(r.status, { 'Content-Type': r.type });
        return res.end(r.body);
      }
      if (p === '/json/new') {
        if (req.method !== 'PUT') return json(res, 405, { error: 'use PUT (as Chrome does)' });
        const target = url.search.replace(/^\?/, '').replace(/(^|&)token=[^&]*/g, '').replace(/^&/, '');
        if (target && !targetAllowed({ type: 'page', url: decodeURIComponent(target) })) return json(res, 403, { error: 'url blocked by filter' });
        const r = await passthrough('PUT', `/json/new${target ? `?${target}` : ''}`);
        let body = r.body;
        if (r.status === 200) {
          try {
            const o = JSON.parse(r.body.toString('utf8'));
            if (o.id) {
              o.webSocketDebuggerUrl = `${wsBase(req)}/devtools/page/${o.id}${tokenSuffix()}`;
              delete o.devtoolsFrontendUrl;
              body = Buffer.from(JSON.stringify(o));
            }
          } catch {}
        }
        res.writeHead(r.status, { 'Content-Type': r.type });
        return res.end(body);
      }
      if (p === '/cdp-share/status') return json(res, 200, statusObject());
      if (p === '/cdp-share/shutdown' && req.method === 'POST') {
        json(res, 200, { ok: true });
        beginShutdown();
        return;
      }
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) });
    }
    return json(res, 404, { error: 'not found' });
  });

  function beginShutdown() {
    shuttingDown = true;
    setTimeout(() => {
      for (const c of clients) c.close(1001, 'cdp-share: shutting down');
      clients.clear();
      try { upstreamWs?.close(); } catch {}
      server.close();
      server.closeAllConnections?.();
    }, 20);
  }

  function reject(socket, status, why) {
    try {
      socket.end(`HTTP/1.1 ${status} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {}
    socket.destroy();
  }

  server.on('upgrade', async (req, socket) => {
    socket.on('error', () => {});
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    const [bad, why] = guardRequest(req, url);
    if (bad) return reject(socket, bad, why);
    const key = req.headers['sec-websocket-key'];
    if (!key || !upstreamConnected) return reject(socket, 503, 'Service Unavailable');

    const pageMatch = /^\/devtools\/page\/([^/]+)$/.exec(url.pathname);
    const isBrowser = url.pathname === BROWSER_PATH || /^\/devtools\/browser(\/[^/]*)?$/.test(url.pathname);
    if (!pageMatch && !isBrowser) return reject(socket, 404, 'Not Found');
    if (pageMatch) {
      // A hidden target gets the same answer as an unknown one.
      let info = discoveredTargets.get(pageMatch[1]);
      if (!info) info = (await callUpstreamInternal('Target.getTargetInfo', { targetId: pageMatch[1] }))?.targetInfo;
      if (!info || !targetAllowed(info)) return reject(socket, 404, 'Not Found');
    }
    if (socket.destroyed) return;

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '\r\n'].join('\r\n'));

    const client = new WsConnection(socket);
    Object.assign(client, {
      id: crypto.randomBytes(4).toString('hex'),
      name: cleanName(url.searchParams.get('name')),
      connectedAt: Date.now(),
      autoAttach: false,
      waitDbg: false,
      discover: false,
      sessions: new Set(),
      tasks: new Set(),
      attachedTargetIds: new Set(),
      createdContexts: new Set(),
      allowedTargets: new Set(), // targets this client created or attached on purpose: always visible to it
      visible: new Set(), // targets announced to a discover client (only tracked when a filter is active)
      pageSession: null,
      pageTargetId: pageMatch ? pageMatch[1] : null,
      ready: Promise.resolve(),
    });
    clients.add(client);
    audit({ event: 'connect', client: client.id, ...(client.name ? { name: client.name } : {}), ...(client.pageTargetId ? { targetId: client.pageTargetId } : {}) });

    if (pageMatch) {
      client.allowedTargets.add(pageMatch[1]);
      client.ready = (async () => {
        const res = await callUpstreamInternal('Target.attachToTarget', { targetId: pageMatch[1], flatten: true });
        if (!res?.sessionId || client.closed) {
          client.close(1011, 'cdp-share: could not attach to target');
          return;
        }
        client.pageSession = res.sessionId;
        owners.set(res.sessionId, { client, targetId: pageMatch[1], root: false });
        client.sessions.add(res.sessionId);
      })();
    }

    const reply = (id, result, sessionId) => client.send(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), result: result ?? {} }));
    const fail = (id, code, message, sessionId) =>
      client.send(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), error: { code, message } }));

    client.onMessage = async (rawMsg) => {
      let parsed;
      try {
        parsed = JSON.parse(rawMsg);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      await client.ready;
      if (client.closed) return;
      if (client.pageSession && !parsed.sessionId) parsed.sessionId = client.pageSession;

      const clientMsgId = parsed.id;
      const method = String(parsed.method || '');
      const local = (ok, error) => logCommand(client, parsed, ok, error);

      if (!parsed.sessionId && method === 'Browser.close') {
        // A shared client must not close the owner's Chrome: acknowledge and drop only this client.
        reply(clientMsgId, {});
        local(true);
        client.close();
        return;
      }

      if (!parsed.sessionId && method === 'Target.setAutoAttach') {
        if (parsed.params?.autoAttach === true) {
          client.autoAttach = true;
          client.waitDbg = Boolean(parsed.params?.waitForDebuggerOnStart);
          // Upstream auto-attach is switched on only now, when a client first asks for it.
          if (!upstreamAutoAttach) {
            upstreamAutoAttach = callUpstreamInternal('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
          }
          if (filterActive && !upstreamDiscover) upstreamDiscover = callUpstreamInternal('Target.setDiscoverTargets', { discover: true });
          await upstreamAutoAttach;
          if (filterActive) await upstreamDiscover;
          for (const p of attachCandidates(client)) trackTask(client, attachForClient(client, p, false));
          await Promise.all([...client.tasks]).catch(() => {});
        } else {
          client.autoAttach = false;
        }
        reply(clientMsgId, {});
        local(true);
        return;
      }
      if (!parsed.sessionId && method === 'Target.setDiscoverTargets') {
        if (parsed.params?.discover === true) {
          client.discover = true;
          if (!upstreamDiscover) upstreamDiscover = callUpstreamInternal('Target.setDiscoverTargets', { discover: true });
          await upstreamDiscover;
          for (const targetInfo of discoveredTargets.values()) {
            if (!allowedFor(client, targetInfo)) continue;
            if (filterActive) client.visible.add(targetInfo.targetId);
            client.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo } }));
          }
        } else {
          client.discover = false;
        }
        reply(clientMsgId, {});
        local(true);
        return;
      }

      if (parsed.sessionId) {
        const owner = owners.get(parsed.sessionId);
        if (!owner || owner.client !== client) {
          fail(clientMsgId, -32001, 'Session with given id not found.', parsed.sessionId);
          local(false, 'session not found');
          return;
        }
        if (owner.root && method === 'Runtime.runIfWaitingForDebugger') {
          // The target is held by the bridge's own session until every client has said it is ready.
          for (const [s0, p] of bridgeAttached) {
            if (p.targetInfo?.targetId === owner.targetId) clientResumed(client, s0);
          }
          reply(clientMsgId, {}, parsed.sessionId);
          local(true);
          return;
        }
      } else if (filterActive) {
        // Target filter: hidden targets answer like unknown ones.
        let blockedMsg = '';
        if (TARGET_GUARDED.has(method) && parsed.params?.targetId && !client.allowedTargets.has(parsed.params.targetId)) {
          const id = parsed.params.targetId;
          let info = discoveredTargets.get(id);
          if (!info) info = (await callUpstreamInternal('Target.getTargetInfo', { targetId: id }))?.targetInfo;
          if (info && !targetAllowed(info)) blockedMsg = 'No target with given id found';
        } else if (method === 'Target.createTarget' && typeof parsed.params?.url === 'string' && !targetAllowed({ type: 'page', url: parsed.params.url })) {
          blockedMsg = 'URL blocked by cdp-share filter';
        }
        if (blockedMsg) {
          fail(clientMsgId, blockedMsg.startsWith('No target') ? -32602 : -32000, blockedMsg);
          local(false, blockedMsg);
          return;
        }
      }

      if (noFocus) {
        if (method === 'Page.bringToFront' || (!parsed.sessionId && method === 'Target.activateTarget')) {
          reply(clientMsgId, {}, parsed.sessionId);
          local(true);
          return;
        }
        if (!parsed.sessionId && method === 'Target.createTarget') {
          const params = (parsed.params && typeof parsed.params === 'object') ? { ...parsed.params } : {};
          if (!params.newWindow) params.background = true;
          parsed = { ...parsed, params };
        }
      }

      const upstreamId = nextUpstreamId++;
      pendingCalls.set(upstreamId, {
        client,
        clientMsgId,
        internalResolve: null,
        method,
        sessionId: parsed.sessionId,
        logParams: auditParams(method, parsed.params),
        targetId: parsed.params?.targetId,
        contextId: method === 'Target.disposeBrowserContext' ? parsed.params?.browserContextId : undefined,
        detachSessionId: method === 'Target.detachFromTarget' ? parsed.params?.sessionId : undefined,
      });
      sendUpstreamRaw({ ...parsed, id: upstreamId });
    };

    client.onClose = () => {
      clients.delete(client);
      releaseClient(client);
      audit({ event: 'disconnect', client: client.id, ...(client.name ? { name: client.name } : {}) });
      // With no clients left, drop the bridge's own attachments so Chrome stops instrumenting tabs.
      if (clients.size === 0 && upstreamConnected) {
        for (const s0 of [...resumes.keys()]) resumeBridgeSession(s0);
        upstreamAutoAttach = null;
        upstreamDiscover = null;
        for (const s0 of bridgeAttached.keys()) void callUpstreamInternal('Target.detachFromTarget', { sessionId: s0 });
        bridgeAttached.clear();
        discoveredTargets.clear();
        callUpstreamInternal('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
        callUpstreamInternal('Target.setDiscoverTargets', { discover: false }).catch(() => {});
      }
    };
  });

  await new Promise((resolve, rej) => {
    server.once('error', rej);
    server.listen(port, host, () => resolve());
  });

  let serverLostFired = false;
  const serverLost = (why) => {
    if (shuttingDown || serverLostFired) return;
    serverLostFired = true;
    log?.(`bridge server socket lost (${why})`);
    for (const c of clients) c.close(1011, 'cdp-share: bridge server failed');
    clients.clear();
    try { upstreamWs?.close(); } catch {}
    try { onServerLost?.(why); } catch {}
  };
  server.on('error', (err) => serverLost(err?.message || 'error'));
  server.on('close', () => serverLost('closed'));
  if (onServerLost) {
    // A listening socket that vanished without an event (seen once on Windows) must not leave a zombie daemon.
    setInterval(() => { if (!server.listening) serverLost('not listening'); }, 3000).unref();
  }

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    server,
    port: actualPort,
    httpUrl: `http://${host}:${actualPort}`,
    wsUrl: `ws://${host}:${actualPort}${BROWSER_PATH}${tokenSuffix()}`,
    status: statusObject,
    close: async () => {
      shuttingDown = true;
      for (const c of clients) c.close(1001, 'cdp-share: shutting down');
      clients.clear();
      try { upstreamWs?.close(); } catch {}
      if (auditFd !== null) {
        try { fs.closeSync(auditFd); } catch {}
        auditFd = null;
      }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
