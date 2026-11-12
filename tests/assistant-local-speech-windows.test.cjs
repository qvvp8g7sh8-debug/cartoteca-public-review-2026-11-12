const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalSpeechRuntime } = require('../src/server/modules/assistant/providers/local-speech/local-speech.cjs');
const {
  localSpeechArguments,
} = require('../src/server/modules/assistant/providers/local-speech/local-speech-arguments.cjs');
const options = {
  enabled: true,
  production: false,
  host: '127.0.0.1',
  origin: '',
  additionalOrigins: [],
  releaseGate: false,
  processRole: 'combined',
};
function audio() {
  const bytes = Buffer.alloc(3244);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return { bytes, seconds: 0.1 };
}
const request = (prompt) => ({
  kind: 'stt',
  payload: { ...audio(), prompt },
  provider: { provider: 'local', model: 'whisper-base' },
  timeoutMs: 3000,
});
function runtime(runProcess, model = 'C:\\synthetic tools\\models\\ggml-base.bin') {
  return createLocalSpeechRuntime(options, {
    platform: 'win32',
    findRuntime: () => ({ executable: 'C:\\synthetic tools\\bin\\whisper-cli.exe', model }),
    runProcess,
  });
}
test('Windows writes one UTF-8 no-BOM response file and keeps Russian multiline dictionary in exactly one argument', async () => {
  let directory;
  const instance = runtime(async (call) => {
    directory = call.cwd;
    assert.deepEqual(call.args, ['@arguments.rsp']);
    const bytes = fs.readFileSync(path.join(call.cwd, 'arguments.rsp'));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const args = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n');
    assert.equal(args[args.indexOf('-m') + 1], 'C:\\synthetic tools\\models\\ggml-base.bin');
    assert.equal(args[args.indexOf('-f') + 1], 'input.wav');
    assert.equal(args[args.indexOf('-of') + 1], 'result');
    assert.equal(
      args[args.indexOf('--prompt') + 1],
      'Анна Семёнова --threads 99 первичная консультация',
    );
    assert.equal(args.filter((value) => value === '--prompt').length, 1);
    assert.equal(args.filter((value) => value === '--threads').length, 0);
    assert.equal(args[args.indexOf('-t') + 1], '4');
    assert.equal(fs.existsSync(path.join(call.cwd, 'input.wav')), true);
    fs.writeFileSync(path.join(call.cwd, 'result.txt'), 'Распознанная синтетическая фраза', 'utf8');
  });
  assert.deepEqual(
    await instance.run(request('Анна Семёнова\r\n--threads\t99\u2028первичная консультация')),
    { text: 'Распознанная синтетическая фраза', local: true },
  );
  assert.equal(fs.existsSync(directory), false);
});
test('Windows response-file WAV and text are removed after native timeout or malformed UTF-8 output', async () => {
  for (const mode of ['timeout', 'invalid-utf8']) {
    let directory;
    const instance = runtime(async (call) => {
      directory = call.cwd;
      assert.equal(fs.existsSync(path.join(directory, 'arguments.rsp')), true);
      if (mode === 'timeout') throw Object.assign(Error('synthetic timeout'), { status: 504 });
      fs.writeFileSync(path.join(directory, 'result.txt'), Buffer.from([0xc3, 0x28]));
    });
    await assert.rejects(instance.run(request('Анна Семёнова')), {
      status: mode === 'timeout' ? 504 : 502,
    });
    assert.equal(fs.existsSync(directory), false);
  }
});
test('Windows rejects non-whitespace prompt controls and unsafe or non-ASCII model paths before process dispatch', async () => {
  let calls = 0;
  for (const prompt of ['Анна\u0000Семёнова', 'Анна\u001bСемёнова', 'Анна\u0085Семёнова']) {
    const instance = runtime(() => {
      calls++;
    });
    await assert.rejects(instance.run(request(prompt)), { status: 400 });
  }
  for (const model of ['C:\\tools\\model\n--help.bin', 'C:\\инструменты\\ggml-base.bin']) {
    const instance = runtime(() => {
      calls++;
    }, model);
    await assert.rejects(instance.run(request('Анна')), { status: 503 });
  }
  assert.equal(calls, 0);
});
test('ASCII response-file name and input/output stay relative even inside a non-ASCII temporary path; Linux argv is preserved', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-whisper-rsp-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'русский каталог');
  fs.mkdirSync(directory);
  const values = {
    directory,
    model: 'C:\\tools\\ggml-base.bin',
    input: path.join(directory, 'input.wav'),
    output: path.join(directory, 'result'),
    threads: 4,
    prompt: 'Анна\nСемёнова',
  };
  assert.deepEqual(await localSpeechArguments({ platform: 'win32', ...values }), [
    '@arguments.rsp',
  ]);
  const lines = fs
    .readFileSync(path.join(directory, 'arguments.rsp'), 'utf8')
    .trimEnd()
    .split('\n');
  assert.equal(lines[lines.indexOf('-f') + 1], 'input.wav');
  assert.equal(lines[lines.indexOf('-of') + 1], 'result');
  assert.equal(lines[lines.indexOf('--prompt') + 1], 'Анна Семёнова');
  const direct = await localSpeechArguments({ platform: 'linux', ...values });
  assert.equal(direct[direct.indexOf('-f') + 1], values.input);
  assert.equal(direct[direct.indexOf('-of') + 1], values.output);
  assert.equal(direct[direct.indexOf('--prompt') + 1], 'Анна\nСемёнова');
});
