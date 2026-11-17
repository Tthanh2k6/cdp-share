// Soak: 3 overlapping clients (2 Playwright, 1 Puppeteer) x 30 rounds against a daemon running as its own process.
// Skipped unless CDP_SHARE_SOAK=1 (npm run test:soak). Random ports, own Chromium; never 9222/9224.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import puppeteer from 'puppeteer-core';
import { chromium } from 'playwright-core';
import { getStatus } from '../src/index.mjs';
import { cap, freePort, launchUpstream, rawCdp, sleep, tmpDir } from './helpers.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const ROUNDS = Number(process.env.CDP_SHARE_SOAK_ROUNDS) || 30;

describe('soak', { skip: process.env.CDP_SHARE_SOAK !== '1' && 'set CDP_SHARE_SOAK=1 to run' }, () => {
  let up, daemon, port, upRaw, out = '';
  before(async () => {
    up = await launchUpstream();
    port = await freePort();
    daemon = spawn(process.execPath, [CLI, 'start', '--foreground', '--port', String(port), '--chrome', up.wsUrl], {
      env: { ...process.env, CDP_SHARE_HOME: tmpDir('cdp-share-home-') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    daemon.stdout.on('data', (d) => (out += d));
    daemon.stderr.on('data', (d) => (out += d));
    for (let i = 0; i < 100 && !/running/.test(out); i++) await sleep(100);
    upRaw = await rawCdp(up.wsUrl);
  });
  after(async () => {
    upRaw?.close();
    try { daemon.kill(); } catch {}
    await up?.close();
  });

  const url = (n) => `data:text/html,<title>t${n}</title><p>${n}</p>`;
  const ctxIds = async () => (await upRaw.send('Target.getBrowserContexts')).result.browserContextIds;
  const pageCount = async () => (await upRaw.send('Target.getTargets')).result.targetInfos.filter((t) => t.type === 'page').length;

  async function playwrightClient(tag) {
    const b = await cap(chromium.connectOverCDP(`http://127.0.0.1:${port}`), 20000, `${tag} connect`);
    const ctx = await cap(b.newContext(), 10000, `${tag} newContext`);
    const page = await cap(ctx.newPage(), 10000, `${tag} newPage`);
    for (let i = 1; i <= 3; i++) {
      await cap(page.goto(url(`${tag}${i}`)), 10000, `${tag} goto`);
      assert.equal(await page.title(), `t${tag}${i}`);
    }
    await b.close();
  }
  async function puppeteerClient(tag) {
    const b = await cap(puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }), 20000, `${tag} connect`);
    const ctx = await cap(b.createBrowserContext(), 10000, `${tag} createContext`);
    const page = await cap(ctx.newPage(), 10000, `${tag} newPage`);
    for (let i = 1; i <= 3; i++) {
      await cap(page.goto(url(`${tag}${i}`)), 10000, `${tag} goto`);
      assert.equal(await page.title(), `t${tag}${i}`);
    }
    await b.disconnect();
  }

  it(`${ROUNDS} overlapping rounds leave nothing behind`, { timeout: 600000 }, async () => {
    const baseCtx = (await ctxIds()).length;
    const basePages = await pageCount();
    const rss0 = (await getStatus(port)).rssMB;
    for (let r = 1; r <= ROUNDS; r++) {
      await Promise.all([
        playwrightClient(`a${r}`),
        sleep(80).then(() => playwrightClient(`b${r}`)),
        sleep(160).then(() => puppeteerClient(`c${r}`)),
      ]);
    }
    let st;
    for (let i = 0; i < 50; i++) {
      st = await getStatus(port);
      if (st.clients.length === 0 && st.internal.pendingCalls === 0) break;
      await sleep(100);
    }
    let ctxs = await ctxIds();
    for (let i = 0; i < 50 && ctxs.length !== baseCtx; i++) { await sleep(100); ctxs = await ctxIds(); }
    const rss1 = st.rssMB;
    console.log(`soak: ${ROUNDS} rounds, daemon RSS ${rss0} MB -> ${rss1} MB (growth ${rss1 - rss0} MB)`);
    assert.equal(st.clients.length, 0, 'no clients left');
    assert.equal(ctxs.length, baseCtx, 'no browser contexts left upstream');
    assert.equal(await pageCount(), basePages, 'no pages left upstream');
    assert.deepEqual({ ...st.internal, pendingMethods: undefined }, { sessions: 0, heldTargets: 0, pendingCalls: 0, pendingMethods: undefined }, `no leftover sessions or pending calls: ${st.internal.pendingMethods.join(', ')}`);
    assert.ok(rss1 - rss0 <= 100, `RSS grew ${rss1 - rss0} MB`);
  });
});
