const test = require('node:test'),
  assert = require('node:assert/strict');
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path');
const { serveStatic } = require('../src/server/http/static-files.cjs');
const { secureRequest } = require('../src/server/http/security.cjs');
const { clientRelease } = require('../src/server/http/client-release.cjs');
const { publicRoot } = require('./helpers/interface-assets.cjs');
test(
  'real browser plays PCM through the protected session worklet, pauses, resumes and releases',
  { skip: process.env.CARTOTECA_PLAYBACK_BROWSER !== '1' },
  async (t) => {
    const root = path.resolve(__dirname, '..'),
      version = await clientRelease(publicRoot);
    const source = fs.readFileSync(
      path.join(root, 'src/client/modules/assistant-playback.js'),
      'utf8',
    );
    const samples = Buffer.alloc(24000);
    for (let i = 0; i < samples.length / 2; i++)
      samples.writeInt16LE(Math.round(Math.sin((i / 24000) * Math.PI * 2 * 440) * 6000), i * 2);
    let requests = 0;
    const script =
      source +
      `
document.querySelector('button').addEventListener('click', async () => {
  const output = createAssistantPlayback({ assistantGeneration:1, assistantBundleId:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    account:{ id:'synthetic', organizationId:'synthetic', role:'owner' } }, {}).assistantPlayback();
  let started=0, paused=false, resumed=false;
  try {
    await output.unlock();
    const cue = await output.cue({startCue:true});
    const played = await output.play({
      streamUrl:'/api/assistant/speak-audio?ticket='+'s'.repeat(43)+'&accountContext=synthetic&organizationContext=synthetic',
      mimeType:'audio/pcm', sampleRate:24000, channels:1, sampleFormat:'s16le', playbackRate:1,
      onStarted() { started++; void output.pause().then(value=>{
        paused=value; resumed=output.resume();
      }); }
    });
    window.probeResult={cue,played,started,paused,resumed,playingAfter:output.playing()};
  } catch(error) { window.probeResult={error:error.message}; }
  finally { output.release(); }
});`;
    const server = http.createServer(async (req, res) => {
      try {
        secureRequest(req, res, '');
        const url = new URL(req.url, 'http://' + req.headers.host);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(
            '<!doctype html><meta name="cartoteca-build" content="' +
              version +
              '"><button>Start synthetic audio</button><script src="/probe.js"></script>',
          );
        }
        if (url.pathname === '/probe.js') {
          res.writeHead(200, { 'Content-Type': 'text/javascript' });
          return res.end(script);
        }
        if (url.pathname === '/favicon.ico') {
          res.writeHead(204);
          return res.end();
        }
        if (url.pathname === '/api/assistant/speak-audio') {
          assert.equal(url.searchParams.get('ticket'), 's'.repeat(43));
          requests++;
          res.writeHead(200, {
            'Content-Type': 'audio/pcm',
            'X-Audio-Sample-Rate': '24000',
            'X-Audio-Channels': '1',
            'X-Audio-Sample-Format': 's16le',
            'Cache-Control': 'no-store',
          });
          res.write(samples.subarray(0, 17));
          return setTimeout(() => res.end(samples.subarray(17)), 20);
        }
        await serveStatic(req, res, url, req.headers.cookie === 'synthetic=1' ? {} : null, publicRoot);
      } catch (error) {
        if (!res.headersSent) res.writeHead(error.status || 500);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const method of ['GET', 'HEAD']) {
      assert.equal(
        (await fetch(base + '/assistant-playback-worklet.js?v=' + version, { method })).status,
        401,
      );
      const options = { method, headers: { Cookie: 'synthetic=1' } };
      const response = await fetch(base + '/assistant-playback-worklet.js?v=' + version, options);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
      assert.equal(
        (await fetch(base + '/assistant-playback-worklet.js?v=stale', options)).status,
        409,
      );
    }
    const { chromium } = require('playwright');
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CARTOTECA_CHROMIUM_CHANNEL
        ? { channel: process.env.CARTOTECA_CHROMIUM_CHANNEL }
        : {}),
    });
    t.diagnostic('Browser version: ' + browser.version());
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([{ name: 'synthetic', value: '1', url: base }]);
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await page.locator('button').click();
    await page.waitForFunction(() => Boolean(window.probeResult), {}, { timeout: 12000 });
    const result = await page.evaluate(() => window.probeResult);
    assert.equal(result.error, undefined);
    assert.equal(result.cue, true);
    assert.equal(result.played, true);
    assert.equal(result.started, 1);
    assert.equal(result.paused, true);
    assert.equal(result.resumed, true);
    assert.equal(result.playingAfter, false);
    assert.equal(requests, 1);
    assert.deepEqual(errors, []);
  },
);
