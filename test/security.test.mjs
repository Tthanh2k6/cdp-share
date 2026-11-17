import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import puppeteer from 'puppeteer-core';
import { chromium } from 'playwright-core';
import { startCdpShare } from '../src/index.mjs';
import { auditParams } from '../src/bridge.mjs';
import { cap, freePort, launchUpstream, rawCdp, rawHttp, sleep, startSite, tmpDir } from './helpers.mjs';

describe('token, Host and Origin checks', () => {
  let up, share;
  before(async () => {
    up = await launchUpstream();
    share = await startCdpShare({ chrome: up.wsUrl, port: await freePort(), token: 'sekret-token' });
  });
  after(async () => {
    await share?.close().catch(() => {});
    await up?.close();
  });

  it('refuses HTTP without or with a wrong token, accepts the three right forms', async () => {
    assert.equal((await rawHttp(`${share.url}/json/version`)).status, 401);
    assert.equal((await rawHttp(`${share.url}/json/version?token=nope`)).status, 401);
    assert.equal((await rawHttp(`${share.url}/cdp-share/status`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await rawHttp(`${share.url}/json/version?token=sekret-token`)).status, 200);
    assert.equal((await rawHttp(`${share.url}/json/version`, { headers: { Authorization: 'Bearer sekret-token' } })).status, 200);
    assert.equal((await rawHttp(`${share.url}/json/version`, { headers: { 'x-cdp-share-token': 'sekret-token' } })).status, 200);
    assert.equal((await rawHttp(`${share.url}/cdp-share/shutdown`, { method: 'POST' })).status, 401, 'shutdown needs the token too');
  });

  it('ws urls handed out by /json endpoints carry the token; the websocket needs it', async () => {
    const v = JSON.parse((await rawHttp(`${share.url}/json/version`, { headers: { 'x-cdp-share-token': 'sekret-token' } })).text);
    assert.ok(v.webSocketDebuggerUrl.endsWith('?token=sekret-token'));
    const page = await up.browser.newPage();
    const list = JSON.parse((await rawHttp(`${share.url}/json/list`, { headers: { Authorization: 'Bearer sekret-token' } })).text);
    assert.ok(list.length >= 1);
    assert.ok(list.every((t) => t.webSocketDebuggerUrl.endsWith('?token=sekret-token')));
    await page.close();

    assert.equal((await rawCdp(`ws://127.0.0.1:${share.port}/devtools/browser/cdp-share`)).status, 401);
    assert.equal((await rawCdp(`ws://127.0.0.1:${share.port}/devtools/browser/cdp-share?token=wrong`)).status, 401);
    const ok = await rawCdp(v.webSocketDebuggerUrl);
    assert.equal(ok.status, 101);
    ok.close();
    const viaHeader = await rawCdp(`ws://127.0.0.1:${share.port}/devtools/browser/cdp-share`, { headers: { Authorization: 'Bearer sekret-token' } });
    assert.equal(viaHeader.status, 101);
    viaHeader.close();
  });

  it('Playwright and Puppeteer work with the token', async () => {
    const pw = await cap(chromium.connectOverCDP(share.url, { headers: { Authorization: 'Bearer sekret-token' } }), 15000, 'pw connect');
    const pp = await cap(puppeteer.connect({ browserWSEndpoint: share.wsUrl }), 15000, 'pp connect');
    try {
      const page = await cap(pw.contexts()[0].newPage());
      assert.equal(await cap(page.evaluate('5+5')), 10);
      assert.ok((await pp.version()).length > 0);
    } finally {
      await pp.disconnect();
      await pw.close().catch(() => {});
    }
  });

  it('rejects a foreign Host header (DNS rebinding) on HTTP and on websocket', async () => {
    const t = { 'x-cdp-share-token': 'sekret-token' };
    assert.equal((await rawHttp(`${share.url}/json/version`, { headers: { ...t, Host: 'evil.example:9999' } })).status, 403);
    assert.equal((await rawHttp(`${share.url}/json/version`, { headers: { ...t, Host: `localhost:${share.port}` } })).status, 200);
    assert.equal((await rawHttp(`${share.url}/json/version`, { headers: { ...t, Host: `[::1]:${share.port}` } })).status, 200);
    assert.equal((await rawCdp(share.wsUrl, { headers: { Host: 'evil.example' } })).status, 403);
  });

  it('rejects websocket and HTTP requests with a web-page Origin; allows extension and devtools origins', async () => {
    assert.equal((await rawCdp(share.wsUrl, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await rawCdp(share.wsUrl, { headers: { Origin: 'null' } })).status, 403);
    assert.equal((await rawHttp(`${share.url}/json/version`, { headers: { 'x-cdp-share-token': 'sekret-token', Origin: 'https://evil.example' } })).status, 403);
    const ext = await rawCdp(share.wsUrl, { headers: { Origin: 'chrome-extension://abcdef' } });
    assert.equal(ext.status, 101);
    ext.close();
    const dt = await rawCdp(share.wsUrl, { headers: { Origin: 'devtools://devtools' } });
    assert.equal(dt.status, 101);
    dt.close();
  });

  it('only listens on 127.0.0.1', async () => {
    await assert.rejects(startCdpShare({ chrome: up.wsUrl, port: await freePort(), host: '0.0.0.0' }), /127\.0\.0\.1/);
    assert.equal(share.server.address().address, '127.0.0.1');
  });
});

describe('target filter', () => {
  let up, site, pagePublic, pageSecret, secretId, publicId;
  before(async () => {
    up = await launchUpstream();
    site = await startSite();
    pagePublic = await up.browser.newPage();
    await pagePublic.goto(site.url('/public/one'));
    pageSecret = await up.browser.newPage();
    await pageSecret.goto(site.url('/secret/bank'));
    const raw = await rawCdp(up.wsUrl);
    const infos = (await raw.send('Target.getTargets')).result.targetInfos;
    secretId = infos.find((t) => t.url.includes('/secret/')).targetId;
    publicId = infos.find((t) => t.url.includes('/public/')).targetId;
    raw.close();
  });
  after(async () => {
    await site?.close();
    await up?.close();
  });

  for (const mode of ['exclude', 'include']) {
    describe(`--${mode}-url`, () => {
      let share;
      before(async () => {
        share = await startCdpShare({ chrome: up.wsUrl, port: await freePort(), ...(mode === 'exclude' ? { excludeUrl: '/secret/' } : { includeUrl: '/public/' }) });
      });
      after(async () => { await share?.close().catch(() => {}); });

      it('hides the target from Target.getTargets and /json/list', async () => {
        const c = await rawCdp(share.wsUrl);
        const ids = (await c.send('Target.getTargets')).result.targetInfos.map((t) => t.targetId);
        assert.ok(ids.includes(publicId));
        assert.ok(!ids.includes(secretId));
        const list = await (await fetch(`${share.url}/json/list`)).json();
        assert.ok(list.some((t) => t.id === publicId));
        assert.ok(!list.some((t) => t.id === secretId));
        c.close();
      });

      it('hides it from Target.targetCreated events and refuses to attach (error, not a hang)', async () => {
        const c = await rawCdp(share.wsUrl);
        await c.send('Target.setDiscoverTargets', { discover: true });
        await sleep(200);
        const created = c.events.filter((e) => e.method === 'Target.targetCreated').map((e) => e.params.targetInfo.targetId);
        assert.ok(created.includes(publicId));
        assert.ok(!created.includes(secretId));
        const r = await c.send('Target.attachToTarget', { targetId: secretId, flatten: true });
        assert.ok(r.error, 'attach to a hidden target fails');
        assert.equal((await c.send('Target.getTargetInfo', { targetId: secretId })).error?.code, -32602);
        assert.equal((await c.send('Target.activateTarget', { targetId: secretId })).error?.code, -32602);
        const ok = await c.send('Target.attachToTarget', { targetId: publicId, flatten: true });
        assert.ok(ok.result?.sessionId, 'visible target still attaches');
        c.close();
      });

      it('a hidden target is not even served over its page websocket', async () => {
        const res = await rawCdp(`ws://127.0.0.1:${share.port}/devtools/page/${secretId}`);
        assert.equal(res.status, 404);
      });

      it('Puppeteer and Playwright see only allowed tabs and can still open new ones', async () => {
        const pp = await cap(puppeteer.connect({ browserURL: share.url }), 15000, 'pp connect');
        const pw = await cap(chromium.connectOverCDP(share.url), 15000, 'pw connect');
        try {
          const urls = (await pp.pages()).map((p) => p.url());
          assert.ok(urls.some((u) => u.includes('/public/')));
          assert.ok(!urls.some((u) => u.includes('/secret/')), 'puppeteer cannot see the hidden tab');
          const pwUrls = pw.contexts().flatMap((c) => c.pages()).map((p) => p.url());
          assert.ok(!pwUrls.some((u) => u.includes('/secret/')), 'playwright cannot see the hidden tab');
          const fresh = await cap(pw.contexts()[0].newPage(), 10000, 'pw newPage');
          await fresh.goto(site.url('/public/new'));
          assert.equal(await cap(fresh.evaluate('7*6')), 42);
          await fresh.close();
        } finally {
          await pp.disconnect();
          await pw.close().catch(() => {});
        }
      });
    });
  }

  it('createTarget on a blocked URL is refused', async () => {
    const share = await startCdpShare({ chrome: up.wsUrl, port: await freePort(), excludeUrl: '/secret/' });
    const c = await rawCdp(share.wsUrl);
    const r = await c.send('Target.createTarget', { url: site.url('/secret/x') });
    assert.ok(r.error);
    c.close();
    await share.close();
  });

  it('a tab that navigates into the hidden range disappears for discover clients, and back', async () => {
    const share = await startCdpShare({ chrome: up.wsUrl, port: await freePort(), excludeUrl: '/secret/' });
    const c = await rawCdp(share.wsUrl);
    await c.send('Target.setDiscoverTargets', { discover: true });
    const page = await up.browser.newPage();
    await page.goto(site.url('/public/walk'));
    const seen = await c.waitEvent((e) => (e.method === 'Target.targetInfoChanged' || e.method === 'Target.targetCreated') && Boolean(e.params.targetInfo?.url?.includes('/public/walk')));
    const id = seen.params.targetInfo.targetId;
    await page.goto(site.url('/secret/walk'));
    await c.waitEvent((e) => e.method === 'Target.targetDestroyed' && e.params.targetId === id);
    const n = c.events.length;
    await page.goto(site.url('/public/back'));
    await c.waitEvent((e) => c.events.indexOf(e) >= n && e.method === 'Target.targetCreated' && e.params.targetInfo.targetId === id);
    c.close();
    await page.close();
    await share.close();
  });
});

describe('audit log', () => {
  let up, share, dir, logFile;
  before(async () => {
    up = await launchUpstream();
    dir = tmpDir();
    logFile = path.join(dir, 'audit.jsonl');
    share = await startCdpShare({ chrome: up.wsUrl, port: await freePort(), log: logFile });
  });
  after(async () => {
    await share?.close().catch(() => {});
    await up?.close();
  });

  it('writes connect, command and disconnect lines and never the typed text', async () => {
    const page = await up.browser.newPage();
    await page.goto('data:text/html,<input id=i autofocus>');
    const targetId = (await (await fetch(`${share.url}/json/list`)).json()).find((t) => t.url.startsWith('data:text/html,<input'))?.id;
    assert.ok(targetId);
    const c = await rawCdp(`${share.wsUrl}?name=${encodeURIComponent('my agent')}`);
    const att = await c.send('Target.attachToTarget', { targetId, flatten: true });
    const sid = att.result.sessionId;
    await c.send('Page.enable', {}, sid);
    await c.send('Runtime.evaluate', { expression: 'document.cookie="token=hunter2-cookie"' }, sid);
    const ins = await c.send('Input.insertText', { text: 'hunter2-password' }, sid);
    assert.ok(ins.result || ins.error, 'command got an answer');
    await c.send('Page.navigate', { url: 'data:text/html,<title>nav-target</title>' }, sid);
    await c.send('Page.bogusMethod', { secret: 'hunter2-param' }, sid);
    c.close();
    await sleep(400);
    await page.close();

    const raw = fs.readFileSync(logFile, 'utf8');
    assert.ok(!raw.includes('hunter2'), 'no param values leaked');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.every((l) => typeof l.ts === 'string' && l.client));
    const mine = lines.filter((l) => l.name === 'my agent');
    assert.ok(mine.some((l) => l.event === 'connect'));
    assert.ok(mine.some((l) => l.event === 'disconnect'));
    const cmd = (m) => mine.find((l) => l.event === 'command' && l.method === m);
    assert.equal(cmd('Input.insertText').ok, true);
    assert.equal(cmd('Input.insertText').sessionId, sid);
    assert.equal(cmd('Input.insertText').params, undefined);
    assert.equal(cmd('Target.attachToTarget').targetId, targetId);
    assert.equal(cmd('Page.navigate').params.url, 'data:text/html,<title>nav-target</title>');
    assert.equal(cmd('Page.bogusMethod').ok, false);
    assert.ok(cmd('Page.bogusMethod').error);
    assert.equal(cmd('Runtime.evaluate').params, undefined);
  });

  it('auditParams keeps only URL and ids', () => {
    assert.deepEqual(auditParams('Page.navigate', { url: 'http://x/', referrer: 'secret' }), { url: 'http://x/' });
    assert.equal(auditParams('Input.insertText', { text: 'x' }), undefined);
    assert.deepEqual(auditParams('Target.createTarget', { url: 'http://x/', message: 'nope' }), { url: 'http://x/' });
    assert.equal(auditParams('Network.setCookie', { value: 'x' }), undefined);
  });
});
