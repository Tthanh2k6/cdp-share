import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { getStatus, resolveUpstream, startCdpShare, stopCdpShare } from '../src/index.mjs';
import { cap, freePort, launchUpstream, rawCdp, sleep, tmpDir } from './helpers.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

// Run the CLI to completion.
function runCli(args, env = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { child.kill(); reject(new Error(`cli timeout: ${args.join(' ')}\n${out}\n${err}`)); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('CLI: start / status / stop', () => {
  let up, home, port;
  before(async () => {
    up = await launchUpstream();
    home = tmpDir('cdp-share-home-');
    port = await freePort();
  });
  after(async () => {
    await runCli(['stop', '--port', String(port)], { CDP_SHARE_HOME: home }).catch(() => {});
    await up?.close();
  });

  it('--version and --help', async () => {
    assert.equal((await runCli(['--version'])).out.trim(), '0.1.0');
    const h = await runCli(['--help']);
    assert.equal(h.code, 0);
    assert.match(h.out, /--include-url/);
    assert.equal((await runCli(['--nope'])).code, 2);
  });

  it('status exits 1 when nothing runs', async () => {
    const r = await runCli(['status', '--port', String(port)], { CDP_SHARE_HOME: home });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).running, false);
  });

  it('start detaches, prints urls and the generated token; status shows clients; stop frees the port', async () => {
    const env = { CDP_SHARE_HOME: home };
    const started = await runCli(['start', '--port', String(port), '--chrome', up.wsUrl, '--token', 'auto'], env);
    assert.equal(started.code, 0, `exit ${started.code}
stdout: ${started.out}
stderr: ${started.err}`);
    assert.match(started.out, new RegExp(`http: http://127\\.0\\.0\\.1:${port}`));
    const token = /token: (\S+)/.exec(started.out)?.[1];
    assert.ok(token && token.length >= 24, 'token printed');
    const wsUrl = /ws:\s+(\S+)/.exec(started.out)[1];
    assert.ok(wsUrl.endsWith(`?token=${encodeURIComponent(token)}`));

    const c = await rawCdp(`${wsUrl}&name=cli-test`);
    assert.equal(c.status, 101);
    await c.send('Browser.getVersion');
    // token comes from the state file the daemon wrote
    const st = await runCli(['status', '--port', String(port)], env);
    assert.equal(st.code, 0, st.err);
    const status = JSON.parse(st.out);
    assert.equal(status.upstream.connected, true);
    assert.equal(status.upstream.url, up.wsUrl);
    assert.ok(status.uptimeSec >= 0);
    const me = status.clients.find((x) => x.name === 'cli-test');
    assert.ok(me && me.id && me.connectedAt && typeof me.sessions === 'number');
    c.close();

    const again = await runCli(['start', '--port', String(port), '--chrome', up.wsUrl], env);
    assert.match(again.out, /already running/);

    const stopped = await runCli(['stop', '--port', String(port)], env);
    assert.equal(stopped.code, 0, stopped.err);
    assert.match(stopped.out, /stopped/);
    await sleep(200);
    assert.equal((await runCli(['status', '--port', String(port)], env)).code, 1);
    assert.equal(await getStatus(port), null);
  });
});

describe('daemon exit codes', () => {
  it('exits with code 3 when the upstream Chrome dies', async () => {
    const up = await launchUpstream();
    const port = await freePort();
    const child = spawn(process.execPath, [CLI, 'start', '--foreground', '--port', String(port), '--chrome', up.wsUrl], {
      env: { ...process.env, CDP_SHARE_HOME: tmpDir('cdp-share-home-') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      for (let i = 0; i < 100 && !/running/.test(out); i++) await sleep(100);
      assert.match(out, /running/, out);
      const c = await rawCdp(`ws://127.0.0.1:${port}/devtools/browser/cdp-share`);
      assert.equal(c.status, 101);
      await up.close();
      const code = await cap(exited, 20000, 'daemon exit');
      assert.equal(code, 3, out);
      assert.equal(await getStatus(port), null);
    } finally {
      child.kill();
      await up.close();
    }
  });

  it('exits with code 1 when the upstream cannot be reached', async () => {
    const port = await freePort();
    const dead = await freePort();
    const r = await runCli(['start', '--foreground', '--port', String(port), '--chrome', `ws://127.0.0.1:${dead}/devtools/browser/x`], { CDP_SHARE_HOME: tmpDir('cdp-share-home-') });
    assert.equal(r.code, 1);
  });
});

describe('library API and Chrome discovery', () => {
  let up;
  before(async () => { up = await launchUpstream(); });
  after(async () => { await up?.close(); });

  it('startCdpShare / getStatus / stopCdpShare', async () => {
    const port = await freePort();
    const h = await startCdpShare({ chrome: up.wsUrl, port, token: 'auto' });
    assert.ok(h.token.length >= 24);
    assert.equal(h.url, `http://127.0.0.1:${port}`);
    assert.ok(h.wsUrl.includes(`?token=${h.token}`));
    assert.equal((await getStatus(port)).unauthorized, true, 'no token: reported as protected');
    const st = await getStatus(port, { token: h.token });
    assert.equal(st.running, true);
    assert.equal(st.tokenRequired, true);
    assert.equal(await stopCdpShare(port, { token: h.token }), true);
    assert.equal(await getStatus(port), null);
  });

  it('resolveUpstream: http url via /json/version, ws passthrough, DevToolsActivePort file', async () => {
    assert.equal(await resolveUpstream(up.wsUrl), up.wsUrl);
    assert.equal(await resolveUpstream(`http://127.0.0.1:${up.cdpPort}`), up.wsUrl);
    // Chrome 144+ style: no /json/version needed, the port file names the browser URL.
    const dir = tmpDir('cdp-share-udd-');
    const u = new URL(up.wsUrl);
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${u.port}\n${u.pathname}\n`);
    assert.equal(await resolveUpstream('', { userDataDirs: [dir] }), up.wsUrl);
    const empty = tmpDir('cdp-share-udd-');
    await assert.rejects(resolveUpstream(`http://127.0.0.1:${await freePort()}`, { userDataDirs: [empty] }), /not reachable/);
  });
});

describe('detached start survives its launcher', () => {
  let up;
  before(async () => { up = await launchUpstream(); });
  after(async () => { await up?.close(); });

  for (const noWmi of [false, true]) {
    it(`daemon keeps answering after the launcher process tree is killed${noWmi ? ' (spawn fallback)' : ''}`, async () => {
      const port = await freePort();
      const home = tmpDir('cdp-share-home-');
      const env = { ...process.env, CDP_SHARE_HOME: home, ...(noWmi ? { CDP_SHARE_NO_WMI: '1' } : {}) };
      // The launcher stays alive as the parent of `cdp-share start`, like an MCP host or shell would.
      const script = `const {spawnSync}=require('child_process');` +
        `const r=spawnSync(process.execPath,[${JSON.stringify(CLI)},'start','--port','${port}','--chrome',${JSON.stringify(up.wsUrl)},'--token','auto'],{stdio:'inherit'});` +
        `console.log('LAUNCHED '+r.status);setInterval(()=>{},1000);`;
      const launcher = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      launcher.stdout.on('data', (d) => (out += d));
      launcher.stderr.on('data', (d) => (out += d));
      let token = '';
      try {
        for (let i = 0; i < 300 && !/LAUNCHED/.test(out); i++) await sleep(100);
        assert.match(out, /LAUNCHED 0/, out);
        token = /token: (\S+)/.exec(out)[1];
        assert.ok((await getStatus(port, { token }))?.running);
        // kill the launcher and everything below it
        if (process.platform === 'win32') {
          await new Promise((r) => spawn('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('exit', r));
        } else {
          launcher.kill('SIGKILL');
        }
        await sleep(1000);
        const st = await getStatus(port, { token });
        assert.ok(st?.running && st.upstream.connected, 'daemon still answers');
        assert.notEqual(st.pid, launcher.pid);
        const c = await rawCdp(`ws://127.0.0.1:${port}/devtools/browser/cdp-share?token=${token}`);
        assert.equal(c.status, 101);
        assert.ok((await c.send('Browser.getVersion')).result.product);
        c.close();
      } finally {
        try { launcher.kill(); } catch {}
        await stopCdpShare(port, { token });
      }
    });
  }

  it('token mode prints the ws url first with ready-to-paste examples; no token keeps http first', async () => {
    const home = tmpDir('cdp-share-home-');
    const port = await freePort();
    const t = await runCli(['start', '--port', String(port), '--chrome', up.wsUrl, '--token', 'auto'], { CDP_SHARE_HOME: home });
    assert.equal(t.code, 0, t.err);
    const ws = /ws:\s+(\S+)/.exec(t.out)[1];
    assert.ok(t.out.indexOf('ws:') < t.out.indexOf('http:'));
    assert.ok(t.out.includes(`chrome-devtools-mcp --wsEndpoint "${ws}"`));
    assert.ok(t.out.includes(`connectOverCDP("${ws}")`));
    const token = /token: (\S+)/.exec(t.out)[1];
    await stopCdpShare(port, { token });
    const port2 = await freePort();
    const p = await runCli(['start', '--port', String(port2), '--chrome', up.wsUrl], { CDP_SHARE_HOME: home });
    assert.ok(p.out.indexOf('http:') < p.out.indexOf('ws:'));
    assert.ok(!p.out.includes('chrome-devtools-mcp'));
    await stopCdpShare(port2);
  });
});
