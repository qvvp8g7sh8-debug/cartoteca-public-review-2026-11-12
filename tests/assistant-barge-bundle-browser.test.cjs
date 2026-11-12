const { assetPath, publicRoot } = require('./helpers/interface-assets.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { serveStatic } = require('../src/server/http/static-files.cjs');
const { secureRequest } = require('../src/server/http/security.cjs');
const { clientRelease } = require('../src/server/http/client-release.cjs');

// Native browser audio, production assistant bundle/ports and protected worklets.
// The microphone source is an oscillator; getUserMedia is forbidden, not faked as a device.
for (const echoMode of ['all', true])
  test(
    'actual deferred assistant bundle wires native capture and barge-in with verified echo mode ' +
      echoMode +
      ' without a physical microphone',
    { skip: process.env.CARTOTECA_BARGE_BUNDLE_BROWSER !== '1', timeout: 25000 },
    async (t) => {
      const root = path.resolve(__dirname, '..');
      const version = await clientRelease(publicRoot);
      const bundle = fs.readFileSync(assetPath('app-assistant.js'), 'utf8');
      for (const name of [
        'assistant-playback',
        'assistant-audio',
        'assistant-barge-signal',
        'assistant-barge-in',
      ])
        assert.ok(
          bundle.includes(
            fs.readFileSync(path.join(root, 'src/client/modules', name + '.js'), 'utf8'),
          ),
          'Fresh bundle source: ' + name,
        );
      const ports = fs.readFileSync(path.join(root, 'src/client/core/module-ports.js'), 'utf8');
      const pcm = Buffer.alloc(24000 * 2 * 3);
      for (let i = 0; i < pcm.length / 2; i++)
        pcm.writeInt16LE(Math.round(Math.sin((i / 24000) * Math.PI * 2 * 660) * 5000), i * 2);
      let audioRequests = 0;
      const requested = [];
      const script =
        `import * as assistantModule from '/app-assistant.js?v=${version}';\n` +
        ports +
        `\n
const observations = { contexts:[], statuses:[], errors:[], interruptions:0, physicalMicrophoneCalls:0 };
const NativeContext = window.AudioContext;
window.AudioContext = class extends NativeContext {
  constructor(...args) { super(...args); observations.contexts.push({ options:args, sampleRate:this.sampleRate, context:this }); }
};
const forbiddenMicrophone = () => { observations.physicalMicrophoneCalls++; throw Error('Physical microphone forbidden in synthetic integration test'); };
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable:true, value:forbiddenMicrophone });
const state = { assistantGeneration:1, account:{id:'synthetic',organizationId:'synthetic',role:'owner'}, currentView:'calendar' };
const actions = {};
assistantModule.install(state, actions, createModulePorts);
document.querySelector('button').addEventListener('click', async () => {
  let input, oscillator, microphoneGain, stream;
  try {
    const portsReady = ['assistantBargeSignal','startAssistantBargeIn','stopAssistantBargeIn','startAssistantCapture','playAssistantAudio','unlockAssistantAudio'].every(name=>typeof actions[name]==='function');
    if (!portsReady) throw Error('Unbound actual assistant bundle action');
    const unlocked = actions.unlockAssistantAudio();
    input = new window.AudioContext();
    oscillator = input.createOscillator(); oscillator.frequency.value=440;
    microphoneGain = input.createGain(); microphoneGain.gain.value=0;
    const destination=input.createMediaStreamDestination();
    oscillator.connect(microphoneGain); microphoneGain.connect(destination); oscillator.start();
    stream=destination.stream;
    const clone = () => {
      const media=stream.clone();
      // A generated track has no device AEC; explicitly mark only this synthetic track.
      // Native stream/source/worklet processing and all production AEC checks stay intact.
      const track=media.getAudioTracks()[0], original=track.getSettings.bind(track);
      Object.defineProperty(track,'getSettings',{value:()=>({...original(),echoCancellation:${JSON.stringify(echoMode)}})});
      return media;
    };
    await input.resume(); await unlocked;
    const cue=await actions.playAssistantReadyCue({startCue:true});
    const capture=await actions.startAssistantCapture(()=>observations.errors.push('unexpected capture completion'),error=>observations.errors.push(error.name),2,{
      acquireMedia:async()=>clone(),silenceStop:true,readyCue:options=>actions.playAssistantReadyCue(options)
    });
    actions.stopAssistantCapture(true);
    let finishAnswer, rejectAnswer;
    const answer=new Promise((resolve,reject)=>{finishAnswer=resolve;rejectAnswer=reject;});
    const answerTimer=setTimeout(()=>rejectAnswer(Error('Synthetic barge-in did not complete')),6000);
    const barge=await actions.startAssistantBargeIn((wav,info)=>{clearTimeout(answerTimer);finishAnswer({wav,info});},error=>{clearTimeout(answerTimer);rejectAnswer(error);},2,{
      current:()=>true,acquireMedia:async()=>clone(),shortAnswer:true,
      onStatus:value=>observations.statuses.push(value),
      onInterrupt(){observations.interruptions++;microphoneGain.gain.value=0;}
    });
    if (!barge.ready) throw Error(JSON.stringify(observations.statuses));
    let started;
    const outputStarted=new Promise(resolve=>{started=resolve;});
    const played=actions.playAssistantAudio({streamUrl:'/api/assistant/speak-audio?ticket='+'s'.repeat(43)+'&accountContext=synthetic&organizationContext=synthetic',mimeType:'audio/pcm',sampleRate:24000,channels:1,sampleFormat:'s16le',playbackRate:1,onStarted:started});
    await outputStarted; microphoneGain.gain.value=0.12;
    const completed=await answer, playedResult=await played;
    const bytes=Uint8Array.from(atob(completed.wav),character=>character.charCodeAt(0));
    const wavRate=new DataView(bytes.buffer).getUint32(24,true);
    const signal=actions.assistantBargeSignal; delete actions.assistantBargeSignal;
    const failed=await actions.startAssistantBargeIn(()=>{},()=>{},2,{
      acquireMedia:async()=>clone(),onStatus:value=>observations.statuses.push(value)
    });
    actions.assistantBargeSignal=signal;
    window.probeResult={portsReady,cue,capture,bargeReady:barge.ready,echoMode:barge.echoCancellation,playedResult,
      interrupted:completed.info.interrupted,wavRate,wavBytes:bytes.length,
      faultReady:failed.ready,diagnostic:observations.statuses.at(-1).diagnostic,
      interruptions:observations.interruptions,physicalMicrophoneCalls:observations.physicalMicrophoneCalls,
      errors:observations.errors,contexts:observations.contexts.map(({options,sampleRate})=>({options,sampleRate}))};
  } catch(error) { window.probeResult={error:error.message,statuses:observations.statuses}; }
  finally {
    actions.stopAssistantBargeIn(true); actions.stopAssistantCapture(true); actions.releaseAssistantAudio();
    try{oscillator?.stop();}catch{} oscillator?.disconnect(); microphoneGain?.disconnect();
    stream?.getTracks().forEach(track=>track.stop()); await input?.close();
    window.probeCleanup=observations.contexts.every(value=>value.context.state==='closed');
  }
});`;
      const server = http.createServer(async (req, res) => {
        try {
          secureRequest(req, res, '');
          const url = new URL(req.url, 'http://' + req.headers.host);
          requested.push(url.pathname);
          if (url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(
              '<!doctype html><meta name="cartoteca-build" content="' +
                version +
                '"><button>Start synthetic bundle integration</button><script type="module" src="/probe.js"></script>',
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
            audioRequests++;
            res.writeHead(200, {
              'Content-Type': 'audio/pcm',
              'X-Audio-Sample-Rate': '24000',
              'X-Audio-Channels': '1',
              'X-Audio-Sample-Format': 's16le',
              'Cache-Control': 'no-store',
            });
            return res.end(pcm);
          }
          await serveStatic(req, res, url, req.headers.cookie === 'synthetic=1' ? {} : null, publicRoot);
        } catch (error) {
          if (!res.headersSent) res.writeHead(error.status || 500);
          res.end();
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(
        () =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections?.();
          }),
      );
      const base = 'http://127.0.0.1:' + server.address().port;
      const { chromium } = require('playwright');
      const browser = await chromium.launch({
        headless: true,
        channel:
          process.env.CARTOTECA_CHROMIUM_CHANNEL ||
          (process.platform === 'win32' ? 'msedge' : undefined),
        args: ['--mute-audio'],
      });
      t.diagnostic('Browser: ' + browser.version());
      t.after(() => browser.close());
      const context = await browser.newContext();
      await context.addCookies([{ name: 'synthetic', value: '1', url: base }]);
      const external = [],
        errors = [];
      await context.route('**/*', (route) => {
        if (
          route
            .request()
            .url()
            .startsWith(base + '/')
        )
          return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base);
      await page.locator('button').click();
      await page.waitForFunction(
        () => window.probeResult && window.probeCleanup !== undefined,
        {},
        { timeout: 14000 },
      );
      const result = await page.evaluate(() => ({
        result: window.probeResult,
        cleanup: window.probeCleanup,
      }));
      t.diagnostic(JSON.stringify(result));
      assert.equal(result.result.error, undefined);
      assert.equal(result.result.portsReady, true);
      assert.equal(result.result.cue, true);
      assert.equal(result.result.capture, true);
      assert.equal(result.result.bargeReady, true);
      assert.equal(result.result.echoMode, echoMode);
      assert.equal(
        result.result.playedResult,
        false,
        'A confirmed interruption cancels the native output',
      );
      assert.equal(result.result.interrupted, true);
      assert.equal(result.result.interruptions, 1);
      assert.equal(result.result.wavRate, 16000);
      assert.ok(result.result.wavBytes > 44);
      assert.equal(result.result.physicalMicrophoneCalls, 0);
      assert.deepEqual(result.result.errors, []);
      assert.equal(result.result.faultReady, false);
      assert.deepEqual(result.result.diagnostic, {
        stage: 'signal-initialization',
        name: 'Error',
      });
      assert.ok(result.result.contexts.length >= 4);
      assert.ok(result.result.contexts.every((value) => value.options.length === 0));
      assert.equal(new Set(result.result.contexts.map((value) => value.sampleRate)).size, 1);
      assert.equal(result.cleanup, true);
      assert.equal(audioRequests, 1);
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      assert.ok(requested.includes('/app-assistant.js'));
      assert.ok(requested.includes('/assistant-capture-worklet.js'));
      assert.ok(requested.includes('/assistant-playback-worklet.js'));
      assert.deepEqual(
        requested.filter((value) => value.startsWith('/api/')),
        ['/api/assistant/speak-audio'],
      );
    },
  );
