const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createLocalSpeechRuntime } = require('../src/server/modules/assistant/providers/local-speech/local-speech.cjs');
const { childEnvironment } = require('../src/server/modules/assistant/providers/local-speech/local-speech-config.cjs');
const local = {
  enabled: true,
  production: false,
  host: '127.0.0.1',
  origin: '',
  additionalOrigins: [],
  releaseGate: false,
  processRole: 'combined',
};
function wav(rate = 16000) {
  const bytes = Buffer.alloc(44 + Math.floor(rate / 10) * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return { bytes, seconds: 0.1 };
}
const request = (payload = wav()) => ({
  kind: 'stt',
  payload,
  provider: { provider: 'local', model: 'whisper-base' },
  timeoutMs: 3000,
});
function harness(runProcess, options = {}) {
  const calls = [];
  const runtime = createLocalSpeechRuntime(
    { ...local, ...options },
    {
      platform: 'linux',
      findRuntime: () => ({ executable: '/synthetic/whisper', model: '/synthetic/ggml-base.bin' }),
      runProcess: async (call) => {
        calls.push(call);
        call.guard();
        if (runProcess) return runProcess(call);
        await fs.promises.writeFile(
          call.args[call.args.indexOf('-of') + 1] + '.txt',
          'Синтетическая команда',
        );
      },
    },
  );
  return { runtime, calls };
}
test('local speech never inspects or starts a runtime outside the exact local preview guards', () => {
  for (const override of [
    { enabled: false },
    { production: true },
    { host: '0.0.0.0' },
    { host: 'localhost' },
    { origin: 'https://synthetic.invalid' },
    { additionalOrigins: ['https://synthetic.invalid'] },
    { additionalOrigins: undefined },
    { releaseGate: true },
    { processRole: 'worker' },
    { processRole: 'preflight' },
  ]) {
    let probes = 0;
    const runtime = createLocalSpeechRuntime(
      { ...local, ...override },
      {
        findRuntime() {
          probes++;
          return {};
        },
      },
    );
    assert.equal(probes, 0);
    assert.equal(runtime.available, false);
    assert.equal(runtime.sttAvailable, false);
    assert.equal(runtime.ttsAvailable, false);
  }
});
test('local whisper uses isolated WAV, explicit Russian multilingual model and bounded dictionary argv then deletes every temp file', async () => {
  const f = harness(null, { threads: 64 });
  const prompt = '  Синтетические имена; --threads 99  ';
  const result = await f.runtime.run(request({ ...wav(), prompt }));
  assert.deepEqual(result, { text: 'Синтетическая команда', local: true });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0],
    args = call.args;
  assert.equal(args[args.indexOf('-l') + 1], 'ru');
  assert.equal(args[args.indexOf('-t') + 1], '4');
  assert.equal(args[args.indexOf('-m') + 1], '/synthetic/ggml-base.bin');
  assert.equal(args[args.indexOf('--prompt') + 1], prompt.trim());
  assert.equal(args.filter((value) => value === '--prompt').length, 1);
  assert.ok(args.includes('-otxt') && args.includes('-np') && args.includes('-nt'));
  assert.equal(fs.existsSync(call.cwd), false);
  assert.equal(typeof call.env.OPENAI_API_KEY, 'undefined');
});
test('unsupported local WAV rate and malformed dictionary are rejected before process dispatch', async () => {
  const f = harness();
  for (const payload of [
    wav(44100),
    { ...wav(), prompt: 'bad\u0000dictionary' },
    { ...wav(), prompt: 'x'.repeat(4001) },
  ])
    await assert.rejects(f.runtime.run(request(payload)), { status: 400 });
  assert.equal(f.calls.length, 0);
  await f.runtime.run(request());
  assert.equal(f.calls[0].args.includes('--prompt'), false);
});
test('whisper has no pending queue and permits another request after the active process and cleanup complete', async () => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = harness(async (call) => {
    entered();
    await held;
    await fs.promises.writeFile(call.args[call.args.indexOf('-of') + 1] + '.txt', 'Синтетика');
  });
  const first = f.runtime.run(request());
  await started;
  await assert.rejects(f.runtime.run(request()), { status: 429 });
  assert.equal(f.calls.length, 1);
  release();
  await first;
  assert.equal(fs.existsSync(f.calls[0].cwd), false);
  await f.runtime.run(request());
  assert.equal(f.calls.length, 2);
});
test('timeout errors and overlong output remove WAV and text without leaking provider diagnostics', async () => {
  for (const mode of ['timeout', 'oversize']) {
    const f = harness(async (call) => {
      if (mode === 'timeout') throw Object.assign(Error('Synthetic timeout'), { status: 504 });
      await fs.promises.writeFile(
        call.args[call.args.indexOf('-of') + 1] + '.txt',
        'x'.repeat(16385),
      );
      return { stdout: 'synthetic-private-diagnostic', stderr: 'synthetic-private-diagnostic' };
    });
    await assert.rejects(f.runtime.run(request()), (error) => {
      assert.equal(error.status, mode === 'timeout' ? 504 : 502);
      assert.doesNotMatch(error.message, /synthetic-private-diagnostic/);
      return true;
    });
    assert.equal(fs.existsSync(f.calls[0].cwd), false);
  }
});
test('local TTS is independent of whisper installation and never starts a process or a remote voice', async () => {
  const runtime = createLocalSpeechRuntime(local, {
    findRuntime: () => null,
    runProcess: () => assert.fail('No TTS process'),
  });
  assert.equal(runtime.available, true);
  assert.equal(runtime.sttAvailable, false);
  assert.equal(runtime.ttsAvailable, true);
  assert.deepEqual(
    await runtime.run({
      kind: 'tts',
      provider: { provider: 'local', model: 'system-ru', voice: 'ru-local' },
      payload: { input: 'Синтетический ответ' },
    }),
    { audioBase64: null, mimeType: null, text: 'Синтетический ответ', local: true },
  );
});
test('whisper child environment never inherits model credentials or Node injection options', () => {
  assert.deepEqual(
    childEnvironment('/synthetic/temp', {
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      OPENAI_API_KEY: 'synthetic',
      TIMEWEB_API_KEY: 'synthetic',
      NODE_OPTIONS: '--require fake',
      PATH: '/synthetic/injected',
    }),
    {
      TEMP: '/synthetic/temp',
      TMP: '/synthetic/temp',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    },
  );
});
