import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import puppeteer from 'puppeteer-core';
import { chromium } from 'playwright-core';
import { startCdpShare } from '../src/index.mjs';
import { cap, freePort, launchUpstream, rawCdp, rawHttp, sleep } from './helpers.mjs';

describe('shared bridge: several CDP clients at once', () => {
  let up, share, upRaw;
  before(async () => {
    up = await launchUpstream();
    share = await startCdpShare({ chrome: up.wsUrl, port: await freePort() });
    upRaw = await rawCdp(up.wsUrl); // direct line to MY chromium, to inspect contexts
  });
  after(async () => {
    upRaw?.close();
    await share?.close().catch(() => {});
    await up?.close();
  });

  const contextCount = async () => (await upRaw.send('Target.getBrowserContexts')).result.browserContextIds.length;

  it('Playwright and Puppeteer drive different tabs at the same time', async () => {
    const pw = await cap(chromium.connectOverCDP(share.url), 15000, 'playwright connect');
    const pp = await cap(puppeteer.connect({ browserURL: share.url }), 15000, 'puppeteer connect');
    try {
      const pwPage = await cap(pw.contexts()[0].newPage(), 10000, 'pw newPage');
      await pwPage.goto('data:text/html,<title>PW</title><button id=b onclick="document.title=\'pw-clicked\'">x</button>');
      const ppPage = await cap(pp.newPage(), 10000, 'pp newPage');
      await ppPage.goto('data:text/html,<title>PP</title><button id=b onclick="document.title=\'pp-clicked\'">x</button>');

      assert.equal(await cap(pwPage.evaluate('1+1')), 2);
      assert.equal(await cap(ppPage.evaluate('2+2')), 4);
      await Promise.all([cap(pwPage.click('#b')), cap(ppPage.click('#b'))]);
      assert.equal(await pwPage.title(), 'pw-clicked');
      assert.equal(await ppPage.title(), 'pp-clicked');

      // each sees the other's tab too (same Chrome), and both keep working after the other acted
      const seen = (await pp.pages()).map((p) => p.url());
      assert.ok(seen.some((u) => u.includes('PW')), 'puppeteer sees the Playwright tab');
      assert.equal(await cap(pwPage.evaluate('3+3')), 6);

      const st = await (await fetch(`${share.url}/cdp-share/status`)).json();
      assert.ok(st.clients.length >= 2, 'status lists both clients');
      await ppPage.close();
    } finally {
      await pp.disconnect();
      await pw.close().catch(() => {});
    }
  });

  it('a client that disconnects loses only its own browser contexts', async () => {
    const base = await contextCount();
    const pw = await cap(chromium.connectOverCDP(share.url), 15000, 'pw connect');
    const pp = await cap(puppeteer.connect({ browserURL: share.url }), 15000, 'pp connect');
    try {
      const pwCtx = await cap(pw.newContext());
      const pwPage = await cap(pwCtx.newPage());
      await pwPage.goto('data:text/html,<title>pwctx</title>');
      const ppCtx = await cap(pp.createBrowserContext());
      const ppPage = await cap(ppCtx.newPage());
      await ppPage.goto('data:text/html,<title>ppctx</title>');
      assert.equal(await contextCount(), base + 2);

      await pw.close(); // Playwright drops its connection
      let n = await contextCount();
      for (let i = 0; i < 30 && n !== base + 1; i++) { await sleep(100); n = await contextCount(); }
      assert.equal(n, base + 1, 'only the Playwright context was disposed');
      assert.equal(await cap(ppPage.evaluate('40+2')), 42, 'Puppeteer context and page still alive');
    } finally {
      await pp.disconnect();
      await pw.close().catch(() => {});
    }
    let n = await contextCount();
    for (let i = 0; i < 30 && n !== base; i++) { await sleep(100); n = await contextCount(); }
    assert.equal(n, base, 'Puppeteer context disposed when its client left');
  });

  it('Browser.close from a client does not close the browser', async () => {
    const c = await rawCdp(share.wsUrl);
    const r = await c.send('Browser.close');
    assert.ok(r.result, 'acknowledged');
    await sleep(300);
    assert.equal(c.closed, true, 'that client is dropped');
    assert.ok(up.browser.isConnected(), 'upstream browser still connected');
    const v = await (await fetch(`http://127.0.0.1:${up.cdpPort}/json/version`)).json();
    assert.ok(v.Browser, 'upstream still answers');
    const again = await rawCdp(share.wsUrl);
    assert.ok((await again.send('Browser.getVersion')).result.product);
    again.close();
  });

  it('a page-scoped websocket from /json/list drives that tab', async () => {
    const page = await up.browser.newPage();
    await page.goto('data:text/html,<title>scoped</title>');
    const list = await (await fetch(`${share.url}/json/list`)).json();
    const t = list.find((x) => x.title === 'scoped');
    assert.ok(t, '/json/list shows the tab');
    assert.ok(t.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${share.port}/devtools/page/`));
    const c = await rawCdp(t.webSocketDebuggerUrl);
    assert.equal(c.status, 101);
    assert.equal((await c.send('Runtime.evaluate', { expression: '6*7', returnByValue: true })).result.result.value, 42);
    c.close();
    await page.close();
  });

  it('/json/version points to the bridge, /json/protocol passes through, /json/new needs PUT', async () => {
    const v = await (await fetch(`${share.url}/json/version`)).json();
    assert.equal(v.webSocketDebuggerUrl, `ws://127.0.0.1:${share.port}/devtools/browser/cdp-share`);
    assert.ok(v.Browser);
    const proto = await rawHttp(`${share.url}/json/protocol`);
    assert.equal(proto.status, 200);
    assert.ok(JSON.parse(proto.text).domains);
    assert.equal((await rawHttp(`${share.url}/json/new?about:blank`, { method: 'GET' })).status, 405);
    const made = await rawHttp(`${share.url}/json/new?about:blank`, { method: 'PUT' });
    assert.equal(made.status, 200);
    const t = JSON.parse(made.text);
    assert.ok(t.webSocketDebuggerUrl.includes(`:${share.port}/devtools/page/${t.id}`), 'ws url rewritten to the bridge');
  });

  it('the bridge does not attach to tabs until a client asks', async () => {
    const c = await rawCdp(share.wsUrl, { headers: { 'user-agent': 'x' } });
    const idle = await (await fetch(`${share.url}/cdp-share/status`)).json();
    const me = idle.clients.find((x) => x.sessions === 0);
    assert.ok(me, 'fresh client has 0 sessions');
    await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const busy = await (await fetch(`${share.url}/cdp-share/status`)).json();
    assert.ok(busy.clients.some((x) => x.sessions > 0), 'sessions appear only after Target.setAutoAttach');
    c.close();
  });
});
