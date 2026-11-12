const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  path = require('node:path');
const read = (n) => fs.readFileSync(path.join(__dirname, '../src/client/modules', n), 'utf8');
function signal() {
  const c = { window: { Float32Array }, Math };
  vm.createContext(c);
  return vm
    .runInContext(read('assistant-barge-signal.js') + ';createAssistantBargeSignal()', c)
    .assistantBargeSignal(44100);
}
test('proven echo resets only onset and noise adaptation, preserving microphone prefix', () => {
  const s = signal();
  let phase = 0;
  const frame = () =>
    Float32Array.from({ length: 512 }, () => 0.1 * Math.sin((2 * Math.PI * 440 * phase++) / 44100));
  for (let i = 0; i < 30; i++) {
    const a = frame();
    s.inspect(a);
    s.remember(a);
    s.discardEchoDetectionUpdate();
  }
  const count = s.prebuffer().length;
  assert.ok(count > 20);
  assert.ok(s.inspect(frame()).onsetMs < 64);
  assert.ok(s.inspect(frame()).onsetMs < 64);
  assert.equal(s.inspect(new Float32Array(512)).onsetMs, 0);
  assert.equal(s.prebuffer().length, count);
  for (let i = 0; i < 6; i++) s.inspect(frame());
  assert.ok(s.inspect(frame()).onsetMs >= 64);
});
const fixtureSource = fs
  .readFileSync(path.join(__dirname, 'assistant-barge-in.test.cjs'), 'utf8')
  .split("test('voice barge")[0];
const fixture = vm.runInNewContext(fixtureSource + ';fixture', {
  require,
  __dirname,
  Float32Array,
  console,
});
test('actual barge branch cannot borrow echo onset for a short independent transient', async () => {
  const f = fixture();
  let echo = true;
  f.actions.assistantOutputReference = () => ({ stream: f.media, current: () => true });
  f.actions.assistantEchoProof = () => ({ feed() {}, echo: () => echo, close() {} });
  const ready = await f.start();
  ready.playbackStarted();
  f.feed(20);
  assert.equal(f.calls.pause, 0);
  echo = false;
  f.feed(1);
  assert.equal(f.calls.pause, 0);
  f.feed(1, 0);
  assert.equal(f.calls.pause, 0);
  f.feed(3);
  await new Promise((r) => setImmediate(r));
  f.feed(7);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.pause, 1);
  assert.equal(f.calls.interrupt, 1);
  assert.equal(f.api.assistantBargeInState().phase, 'capturing');
});
test('proof rejects expired history, drops current owner and late results after Stop', () => {
  let worker,
    current = true,
    terminated = 0;
  const c = {
    window: {
      Float32Array,
      performance: { now: () => 0 },
      Worker: class {
        constructor() {
          worker = this;
        }
        postMessage() {}
        terminate() {
          terminated++;
        }
      },
    },
    document: { querySelector: () => ({ content: '1111111111111111' }) },
    Math,
    Number,
    Object,
  };
  vm.createContext(c);
  let s = read('assistant-echo-proof.js').replace(
    '        feed,',
    '        probe(){nativeEnd=100000;analysisEnd=100000;return [nativeInput(100,512),input(100,1)];},\n        feed,',
  );
  vm.runInContext(s, c);
  const api = c
    .createAssistantEchoProof({}, { assistantEchoMath: () => ({}) })
    .assistantEchoProof(44100, () => current);
  assert.deepEqual(Array.from(api.probe()), [null, null]);
  current = false;
  worker.onmessage({ data: { type: 'fit', request: 1, result: { status: 'FIT' } } });
  api.close();
  api.close();
  assert.equal(terminated, 1);
  worker.onmessage({ data: { type: 'fit', request: 1, result: { status: 'FIT' } } });
  assert.equal(api.echo({ voiced: true, onsetMs: 100 }), false);
});

test('one pending Worker job survives candidate resets; stale reply frees slot without promoting fit', () => {
  let worker,
    posts = [],
    validations = 0;
  const c = {
    window: {
      Float32Array,
      performance: { now: () => 0 },
      Worker: class {
        constructor() {
          worker = this;
        }
        postMessage(m) {
          posts.push(m);
        }
        terminate() {}
      },
    },
    document: { querySelector: () => ({ content: '1111111111111111' }) },
    Math,
    Number,
    Object,
  };
  vm.createContext(c);
  vm.runInContext(read('assistant-echo-proof.js'), c);
  const api = c
    .createAssistantEchoProof(
      {},
      {
        assistantEchoMath: () => ({
          validate() {
            validations++;
            return { status: 'ECHO' };
          },
          validateCurrent() {
            validations++;
            return { status: 'ECHO' };
          },
        }),
      },
    )
    .assistantEchoProof(44100, () => true);
  worker.onmessage({ data: { type: 'ready', protocol: 1 } });
  let end = 0;
  const frame = (voiced) => {
    end += 512;
    api.feed(new Float32Array(512), new Float32Array(512), end / 44100);
    return api.echo({ voiced, onsetMs: voiced ? 35 : 0 });
  };
  for (let i = 0; i < 12; i++) {
    frame(true);
    frame(true);
    frame(true);
    frame(true);
    frame(false);
  }
  assert.equal(posts.length, 1);
  const old = posts[0];
  worker.onmessage({
    data: {
      type: 'fit',
      request: old.request,
      result: {
        status: 'FIT',
        fit: { owner: old.input.owner, epoch: old.input.epoch, candidate: old.request },
      },
    },
  });
  frame(true);
  frame(true);
  frame(true);
  frame(true);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[1].request, old.request);
  assert.equal(api.echo({ voiced: true, onsetMs: 70 }), false);
  assert.equal(validations, 0);
  api.close();
});
test('an early held-out residual gets one later PCM fit with its own validation deadline', () => {
  for (const rate of [44100, 48000]) {
    for (const scenario of [
      'proved',
      'timeout',
      'pending-first',
      'new-owner',
      'no-output',
      'legacy',
    ]) {
      let worker;
      const jobs = [],
        validated = [],
        currentFrames = [];
      const c = {
        window: {
          Float32Array,
          Worker: class {
            constructor() {
              worker = this;
            }
            postMessage(job) {
              jobs.push(job);
            }
            terminate() {}
          },
        },
        document: { querySelector: () => ({ content: '1111111111111111' }) },
        Math,
        Number,
        Object,
      };
      vm.createContext(c);
      vm.runInContext(read('assistant-echo-proof.js'), c);
      const api = c
        .createAssistantEchoProof(
          {},
          {
            assistantEchoMath: () => ({
              validate(fit, input) {
                validated.push(input.native.micStart);
                return fit.candidate === jobs[0].request
                  ? { status: 'UNKNOWN', reason: 'native-heldout-residual' }
                  : { status: 'ECHO' };
              },
              validateCurrent(fit, input) {
                currentFrames.push(input.native.micStart);
                return { status: 'ECHO' };
              },
            }),
          },
        )
        .assistantEchoProof(rate, () => true);
      worker.onmessage({ data: { type: 'ready', protocol: 1 } });
      const resolve = (job) =>
        worker.onmessage({
          data: {
            type: 'fit',
            request: job.request,
            result: {
              status: 'FIT',
              fit: {
                candidate: job.request,
                owner: job.input.owner,
                epoch: job.input.epoch,
                nativeLag: 512,
              },
            },
          },
        });
      const signal = new Float32Array(512).fill(0.1);
      let end = 0,
        onset = 0,
        onsetResolved = false;
      function feed(reference, playback, voiced = true) {
        end += 512;
        onset = voiced ? onset + (512 / rate) * 1000 : 0;
        api.feed(signal, reference, end / rate);
        return api.echo({ voiced, onsetMs: onset }, playback);
      }
      for (let i = 0; i < 4; i++) feed(signal, 7, false);
      while (onset + (512 / rate) * 1000 < 64) {
        feed(signal, 7);
        if (jobs.length && !onsetResolved && scenario !== 'pending-first') {
          resolve(jobs[0]);
          onsetResolved = true;
        }
      }
      assert.equal(jobs.length, 1);
      const empty = new Float32Array(512);
      assert.equal(
        feed(scenario === 'no-output' ? empty : signal, scenario === 'legacy' ? null : 7),
        false,
      );
      if (scenario === 'legacy' || scenario === 'no-output') {
        assert.equal(jobs.length, 1);
        assert.equal(api.deferProbe(), false);
        api.close();
        continue;
      }
      if (scenario === 'pending-first') {
        assert.equal(api.deferProbe(), true);
        for (let frame = 1; frame <= 3; frame++) {
          assert.equal(feed(signal, 7), false);
          assert.equal(api.deferProbe(), frame < 3);
        }
        assert.equal(jobs.length, 1);
        resolve(jobs[0]);
        assert.equal(feed(signal, 7), false);
        assert.equal(api.deferProbe(), false);
        api.close();
        continue;
      }
      assert.equal(jobs.length, 2, String(rate));
      assert.equal(api.deferProbe(), true);
      assert(jobs[1].input.native.micStart > jobs[0].input.native.micStart);
      if (scenario === 'proved') resolve(jobs[1]);
      const nextPlayback = scenario === 'new-owner' ? 8 : 7;
      let proved = false;
      for (let frame = 1; frame <= 3; frame++) {
        proved = feed(signal, nextPlayback);
        if (proved) break;
        assert.equal(api.deferProbe(), scenario !== 'new-owner' && frame < 3);
      }
      assert.equal(proved, scenario === 'proved');
      assert.equal(api.deferProbe(), false);
      assert.equal(jobs.length, 2);
      if (scenario === 'proved') {
        const retry = jobs[1].input.native;
        assert.deepEqual(validated, [
          jobs[0].input.native.micStart + retry.mic.length,
          retry.micStart + retry.mic.length,
        ]);
        assert(currentFrames[0] > validated[1]);
      }
      api.close();
    }
  }
});
test('failed Worker post closes proof and follows UNKNOWN without retry', () => {
  let worker,
    terminated = 0;
  const c = {
    window: {
      Float32Array,
      performance: { now: () => 0 },
      Worker: class {
        constructor() {
          worker = this;
        }
        postMessage() {
          throw Error('closed port');
        }
        terminate() {
          terminated++;
        }
      },
    },
    document: { querySelector: () => ({ content: '1111111111111111' }) },
    Math,
    Number,
    Object,
  };
  vm.createContext(c);
  vm.runInContext(read('assistant-echo-proof.js'), c);
  const api = c
    .createAssistantEchoProof({}, { assistantEchoMath: () => ({}) })
    .assistantEchoProof(44100, () => true);
  worker.onmessage({ data: { type: 'ready', protocol: 1 } });
  for (let i = 1; i <= 5; i++) {
    api.feed(new Float32Array(512), new Float32Array(512), (i * 512) / 44100);
    assert.equal(api.echo({ voiced: true, onsetMs: 35 }), false);
  }
  assert.equal(terminated, 1);
  api.close();
  assert.equal(terminated, 1);
});

function establishedEcho(playback = 7, firstCurrent = 'native-heldout-proof') {
  const rate = 44100,
    jobs = [];
  let worker,
    checked = 0,
    ended = 0,
    onset = 0,
    reason = 'native-heldout-proof';
  const context = vm.createContext({
    window: {
      Float32Array,
      Worker: class {
        constructor() {
          worker = this;
        }
        postMessage(job) {
          jobs.push(job);
        }
        terminate() {}
      },
    },
    document: { querySelector: () => ({ content: '1111111111111111' }) },
  });
  vm.runInContext(read('assistant-echo-proof.js'), context);
  const api = context
    .createAssistantEchoProof(
      {},
      {
        assistantEchoMath: () => ({
          validate: () => ({ status: 'ECHO' }),
          validateCurrent() {
            checked++;
            return { status: reason === 'native-heldout-proof' ? 'ECHO' : 'UNKNOWN', reason };
          },
        }),
      },
    )
    .assistantEchoProof(rate, () => true);
  const signal = new Float32Array(512).fill(0.1);
  function frame(reasonForFrame, playbackForFrame = playback, { voiced = true, gap = 0 } = {}) {
    ended += 512 + gap;
    onset = voiced ? onset + (512 / rate) * 1000 : 0;
    reason = reasonForFrame;
    api.feed(signal, signal, ended / rate);
    const echo = api.echo({ voiced, onsetMs: onset }, playbackForFrame);
    if (echo) onset = 0;
    return echo;
  }
  worker.onmessage({ data: { type: 'ready', protocol: 1 } });
  for (let i = 0; i < 4; i++) frame('native-heldout-proof', playback, { voiced: false });
  for (let i = 0; i < 5 && !jobs.length; i++) frame('native-heldout-proof');
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  const result = {
    type: 'fit',
    request: job.request,
    result: {
      status: 'FIT',
      fit: {
        candidate: job.request,
        owner: job.input.owner,
        epoch: job.input.epoch,
        nativeLag: 512,
      },
    },
  };
  worker.onmessage({ data: result });
  for (let i = 0; i < 6 && onset + (512 / rate) * 1000 < 64; i++) frame('native-heldout-proof');
  assert.equal(frame(firstCurrent), firstCurrent === 'native-heldout-proof');
  return {
    api,
    frame,
    jobs,
    checkCount: () => checked,
    onsetMs: () => onset,
    replayFit: () => worker.onmessage({ data: result }),
  };
}

test('a single residual keeps a matched PCM fit only for the next full frame', () => {
  const f = establishedEcho();
  assert.equal(f.frame('native-heldout-residual'), false, 'the mismatch still reaches VAD');
  assert.ok(f.onsetMs() > 0);
  assert.equal(f.api.deferProbe(), false, 'the old deadline cannot postpone a real probe');
  assert.equal(f.frame('native-heldout-proof'), true);
  assert.equal(f.jobs.length, 1, 'the steady echo needs no new fit');
  assert.equal(f.onsetMs(), 0);

  for (let i = 0; i < 6; i++) assert.equal(f.frame('native-heldout-residual'), false);
  assert.ok(f.onsetMs() >= 64, 'continuing voice retains its original onset');
  assert.equal(f.jobs.length, 2, 'training restarts on the second consecutive mismatch');
  f.api.close();
});

test('one-frame recheck cannot cross a PCM owner, a capture gap or Stop', () => {
  for (const fence of ['new-playback', 'capture-gap', 'stop', 'missing-reference', 'unbound']) {
    const f = establishedEcho(fence === 'unbound' ? null : 7);
    const reason =
      fence === 'missing-reference' ? 'missing-native-reference' : 'native-heldout-residual';
    assert.equal(f.frame(reason), false, fence);
    const checked = f.checkCount();
    if (fence === 'stop') {
      f.api.close();
      f.replayFit();
    }
    assert.equal(
      f.frame('native-heldout-proof', fence === 'new-playback' ? 8 : undefined, {
        gap: fence === 'capture-gap' ? 512 : 0,
      }),
      false,
      fence,
    );
    assert.equal(f.checkCount(), checked, fence);
    assert.equal(f.api.deferProbe(), false, fence);
    f.api.close();
  }
});

test('a held-out match alone does not retain a fit when its first current frame fails', () => {
  const f = establishedEcho(7, 'native-heldout-residual');
  assert.equal(f.checkCount(), 1);
  assert.equal(f.frame('native-heldout-proof'), false);
  assert.equal(f.checkCount(), 1);
  assert.equal(f.api.deferProbe(), false);
  f.api.close();
});

test('an ambiguous opening trains once on the next window within the original probe deadline', () => {
  for (const rate of [44100, 48000]) {
    for (const mode of ['match', 'ambiguous', 'already-pending', 'no-reference']) {
      let worker;
      const jobs = [],
        heldout = [];
      const context = vm.createContext({
        window: {
          Float32Array,
          Worker: class {
            constructor() {
              worker = this;
            }
            postMessage(job) {
              jobs.push(job);
            }
            terminate() {}
          },
        },
        document: { querySelector: () => ({ content: '1111111111111111' }) },
      });
      vm.runInContext(read('assistant-echo-proof.js'), context);
      const api = context
        .createAssistantEchoProof(
          {},
          {
            assistantEchoMath: () => ({
              validate(fit, input) {
                heldout.push(input.native.micStart);
                return { status: 'ECHO' };
              },
              validateCurrent: () => ({ status: 'ECHO' }),
            }),
          },
        )
        .assistantEchoProof(rate, () => true);
      const signal = new Float32Array(512).fill(0.1),
        empty = new Float32Array(512),
        frameMs = (512 / rate) * 1000;
      let end = 0,
        onset = 0;
      function frame(voiced, reference = signal) {
        end += 512;
        onset = voiced ? onset + frameMs : 0;
        api.feed(signal, reference, end / rate);
        return api.echo({ voiced, onsetMs: onset }, 7);
      }
      function reject(job) {
        worker.onmessage({
          data: {
            type: 'fit',
            request: job.request,
            result: { status: 'UNKNOWN', reason: 'ambiguous-lag' },
          },
        });
      }
      worker.onmessage({ data: { type: 'ready', protocol: 1 } });
      for (let i = 0; i < 4; i++) frame(false);
      for (let i = 0; i < 5 && jobs.length === 0; i++) assert.equal(frame(true), false);
      assert.equal(jobs.length, 1);
      if (mode === 'already-pending') {
        for (let i = 0; i < 8 && onset < 64; i++) assert.equal(frame(true), false);
        assert.ok(onset >= 64);
        assert.equal(api.deferProbe(), true);
      }
      reject(jobs[0]);
      if (mode === 'no-reference') {
        for (let i = 0; i < 8; i++) assert.equal(frame(true, empty), false);
        assert.equal(jobs.length, 1);
        assert.equal(api.deferProbe(), false);
        api.close();
        continue;
      }
      if (mode === 'already-pending') {
        for (let i = 1; i <= 3; i++) {
          assert.equal(frame(true), false);
          assert.equal(api.deferProbe(), i < 3);
        }
        assert.equal(jobs.length, 2);
        api.close();
        continue;
      }
      for (let i = 0; i < 8 && jobs.length === 1; i++) assert.equal(frame(true), false);
      assert.equal(jobs.length, 2);
      const [first, retry] = jobs;
      assert.equal(retry.input.micStart, first.input.micStart + 512);
      assert.equal(retry.input.priorFit, undefined);
      if (mode === 'ambiguous') {
        reject(retry);
        for (let i = 0; i < 8; i++) assert.equal(frame(true), false);
        assert.equal(jobs.length, 2);
        assert.equal(api.deferProbe(), false);
      } else {
        worker.onmessage({
          data: {
            type: 'fit',
            request: retry.request,
            result: {
              status: 'FIT',
              fit: {
                owner: retry.input.owner,
                epoch: retry.input.epoch,
                candidate: retry.request,
                nativeLag: 512,
              },
            },
          },
        });
        let matched = false;
        for (let i = 0; i < 4 && !matched; i++) matched = frame(true);
        assert.equal(matched, true);
        assert.deepEqual(heldout, [retry.input.native.micStart + retry.input.native.mic.length]);
        assert.equal(api.deferProbe(), false);
      }
      api.close();
    }
  }
});

test('a refused optional reference connection falls back to single microphone and retains barge-in', async () => {
  const f = fixture();
  const context = f.context.window.AudioContext.prototype;
  const originalSource = context.createMediaStreamSource;
  const borrowed = {};
  let closed = 0,
    disconnected = 0;
  context.createMediaStreamSource = function (media) {
    if (media === borrowed)
      return {
        connect() {
          throw Error('optional input refused');
        },
        disconnect() {
          disconnected++;
        },
      };
    return originalSource.call(this, media);
  };
  const inputs = [];
  f.context.window.AudioWorkletNode = class extends f.context.window.AudioWorkletNode {
    constructor(...args) {
      super(...args);
      inputs.push(args[2].numberOfInputs);
    }
  };
  f.actions.assistantOutputReference = () => ({ stream: borrowed, current: () => true });
  f.actions.assistantEchoProof = () => ({
    close() {
      closed++;
    },
  });
  const ready = await f.start();
  assert.equal(ready.ready, true);
  assert.deepEqual(inputs, [2, 1]);
  assert.equal(closed, 1);
  assert.equal(disconnected, 1);
  ready.playbackStarted();
  f.feed(3);
  await new Promise((r) => setImmediate(r));
  f.feed(7);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.interrupt, 1);
  assert.equal(f.api.assistantBargeInState().phase, 'capturing');
});
