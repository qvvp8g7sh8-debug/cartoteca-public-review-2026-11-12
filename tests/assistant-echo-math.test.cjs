const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  path = require('node:path');
const context = { window: { Float32Array, Float64Array, performance }, Math, Number, Object };
vm.createContext(context);
const api = vm.runInContext(
  ['assistant-echo-reflection.js', 'assistant-echo-math.js']
    .map((name) => fs.readFileSync(path.join(__dirname, '../src/client/modules', name), 'utf8'))
    .join('\n') +
    ';createAssistantEchoMath(null, createAssistantEchoReflection()).assistantEchoMath()',
  context,
);
const rows = [];
function resample(ref, mic, rate) {
  const a = [],
    b = [];
  let previousRef = 0,
    previousMic = 0,
    nextPosition = 0,
    end = 0;
  for (let n = 0; n < ref.length; n++) {
    while (nextPosition <= n) {
      const f = Math.max(0, Math.min(1, nextPosition - (n - 1)));
      a.push(Math.fround(previousRef + f * (ref[n] - previousRef)));
      b.push(Math.fround(previousMic + f * (mic[n] - previousMic)));
      nextPosition = (++end * rate) / 16000;
    }
    previousRef = ref[n];
    previousMic = mic[n];
  }
  return { ref: a, mic: b };
}
function fixture(rate, reflection = false, thirdReflection = false) {
  let seed = 37,
    low = 0;
  const pcm = Float32Array.from({ length: 24000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    low = 0.88 * low + 0.12 * ((seed / 4294967296) * 2 - 1);
    return Math.round(low * 0.9 * 32767) / 32768;
  });
  const ref = Float32Array.from({ length: rate }, (_, i) => {
    const q = (i * 24000) / rate,
      n = Math.floor(q),
      f = q - n;
    return (pcm[n] || 0) * (1 - f) + (pcm[n + 1] || 0) * f;
  });
  const secondLag = 2078 + Math.round(rate * 0.018),
    thirdLag = 2078 + Math.round(rate * 0.044);
  const mic = Float32Array.from(
      ref,
      (_, i) =>
        0.6 * (ref[i - 2078] || 0) +
        (reflection ? 0.18 * (ref[i - secondLag] || 0) : 0) +
        (thirdReflection ? 0.2 * (ref[i - thirdLag] || 0) : 0),
    ),
    analysis = resample(ref, mic, rate),
    start = 5120,
    N = Math.floor(rate * 0.032),
    analysisStart = Math.ceil((start * 16000) / rate),
    analysisEnd = analysisStart + 512;
  const owner = { owner: 'synthetic', epoch: 1, candidate: 1 };
  const native = (s, length = N, values = mic) => ({
    sampleRate: rate,
    reference: ref.slice(Math.max(0, s + length - Math.floor(rate * 0.5)), s + length),
    referenceStart: Math.max(0, s + length - Math.floor(rate * 0.5)),
    mic: values.slice(s, s + length),
    micStart: s,
  });
  const input = {
    ...owner,
    analysisRate: 16000,
    reference: Float32Array.from(analysis.ref.slice(0, analysisEnd)),
    referenceStart: 0,
    mic: Float32Array.from(analysis.mic.slice(analysisStart, analysisEnd)),
    micStart: analysisStart,
    native: native(start),
  };
  return { ref, mic, analysis, start, N, owner, input, native };
}
test('separate reflected path matches held-out echo but does not mask new near-end speech', () => {
  for (const rate of [44100, 48000]) {
    const f = fixture(rate, true);
    const trained = api.train(f.input);
    assert.equal(trained.status, 'FIT', trained.reason);
    assert.ok(trained.fit.secondLag > 0);
    const heldout = f.native(f.start + f.N);
    assert.equal(api.validate(trained.fit, { ...f.owner, native: heldout }).status, 'ECHO');
    const start = f.start + f.N * 2,
      length = 512,
      end = start + length;
    const current = f.native(start, length);
    const slice = (lag) => f.ref.slice(start - lag - 1, end - lag + 1);
    current.reference = slice(trained.fit.nativeLag);
    current.referenceStart = start - trained.fit.nativeLag - 1;
    current.referenceSecond = slice(trained.fit.secondLag);
    current.referenceSecondStart = start - trained.fit.secondLag - 1;
    assert.equal(api.validateCurrent(trained.fit, { ...f.owner, native: current }).status, 'ECHO');
    current.mic = current.mic.map((x, i) => x + 0.012 * Math.sin((2 * Math.PI * 733 * i) / rate));
    assert.equal(
      api.validateCurrent(trained.fit, { ...f.owner, native: current }).status,
      'UNKNOWN',
    );
  }
});
test('a third echo path requires independent held-out and fresh reference windows', () => {
  for (const rate of [44100, 48000]) {
    const f = fixture(rate, true, true);
    const trained = api.train(f.input);
    assert.equal(trained.status, 'FIT', trained.reason);
    const fit = trained.fit;
    assert.ok(fit.thirdLag > 0);
    const heldout = f.native(f.start + f.N);
    assert.equal(api.validate(fit, { ...f.owner, native: heldout }).status, 'ECHO');
    const start = f.start + f.N * 2;
    const current = f.native(start, 512);
    for (const [name, lag] of [
      ['reference', fit.nativeLag],
      ['referenceSecond', fit.secondLag],
      ['referenceThird', fit.thirdLag],
    ]) {
      current[name] = f.ref.slice(start - lag - 1, start - lag + 513);
      current[name + 'Start'] = start - lag - 1;
    }
    const input = { ...f.owner, native: current };
    assert.equal(api.validateCurrent(fit, input).status, 'ECHO');
    assert.equal(
      api.validateCurrent(fit, { ...input, native: { ...current, referenceThird: null } }).status,
      'UNKNOWN',
    );
    assert.equal(api.validateCurrent({ ...fit, thirdLag: fit.secondLag }, input).status, 'UNKNOWN');
    current.mic = current.mic.map((x, i) => x + 0.012 * Math.sin((2 * Math.PI * 733 * i) / rate));
    assert.equal(api.validateCurrent(fit, input).status, 'UNKNOWN');
  }
});
test('deterministic44.1/48 native heldout and current512 use frozen native fit', () => {
  for (const rate of [44100, 48000]) {
    const f = fixture(rate),
      trained = api.train(f.input);
    assert.equal(trained.status, 'FIT');
    const frozen = JSON.stringify(trained.fit),
      v = api.validate(trained.fit, { ...f.owner, native: f.native(f.start + f.N) }),
      current = api.validateCurrent(trained.fit, {
        ...f.owner,
        native: f.native(f.start + 2 * f.N - 512, 512),
      });
    assert.equal(v.status, 'ECHO');
    assert.equal(current.status, 'ECHO');
    assert.equal(JSON.stringify(trained.fit), frozen);
    rows.push({ case: 'heldout-' + rate, trainCpuMs: trained.trainCpuMs, heldout: v, current });
  }
});
test('quiet nearend mixed .004/.01 RMS and fresh8ms highband bursts are not fitted away', () => {
  for (const rate of [44100, 48000]) {
    const f = fixture(rate),
      fit = api.train(f.input).fit;
    for (const rms of [0.004, 0.01]) {
      const mixed = Float32Array.from(
        f.mic,
        (x, i) =>
          x +
          (i >= f.start + f.N && i < f.start + 2 * f.N
            ? rms * Math.SQRT2 * Math.sin((2 * Math.PI * 733 * i) / rate)
            : 0),
      );
      const v = api.validate(fit, { ...f.owner, native: f.native(f.start + f.N, f.N, mixed) });
      assert.equal(v.status, 'UNKNOWN');
      assert.ok(v.residualRms > 0.003);
    }
    const currentStart = f.start + 2 * f.N + 512,
      end = currentStart + 512,
      high = Float32Array.from(
        f.mic,
        (x, i) =>
          x +
          (i >= end - Math.ceil(rate * 0.008) && i < end
            ? 0.02 * Math.SQRT2 * Math.sin((2 * Math.PI * 10000 * i) / rate)
            : 0),
      );
    assert.equal(
      api.validateCurrent(fit, { ...f.owner, native: f.native(currentStart, 512, high) }).status,
      'UNKNOWN',
    );
  }
});
test('stale ownership/generation gap, unsafe indices and coefficients never produce proof', () => {
  const f = fixture(44100),
    fit = api.train(f.input).fit,
    held = { ...f.owner, native: f.native(f.start + f.N) };
  for (const change of [{ owner: 'other' }, { epoch: 2 }, { candidate: 3 }])
    assert.equal(api.validate(fit, { ...held, ...change }).status, 'UNKNOWN');
  for (const change of [
    { t0: NaN },
    { t1: 5 },
    { nativeTrainStart: -1 },
    { nativeTrainStart: Number.MAX_SAFE_INTEGER },
    { nativeLag: -1 },
  ])
    assert.equal(api.validate({ ...fit, ...change }, held).status, 'UNKNOWN');
  assert.equal(
    api.validate(fit, { ...held, native: { ...held.native, micStart: -1 } }).status,
    'UNKNOWN',
  );
  assert.equal(
    api.validate(fit, { ...held, native: { ...held.native, micStart: held.native.micStart + 1 } })
      .status,
    'UNKNOWN',
  );
});
test('periodic and independent nearend analysis remain ambiguous, not new echo authority', () => {
  const f = fixture(44100);
  const tone = Float32Array.from(
      { length: f.input.reference.length },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 16000),
    ),
    t = {
      ...f.input,
      reference: tone,
      mic: Float32Array.from(
        { length: 512 },
        (_, i) => 0.12 * Math.sin((2 * Math.PI * 440 * (f.input.micStart + i - 640)) / 16000),
      ),
    };
  assert.equal(api.train(t).status, 'UNKNOWN');
  const independent = {
    ...f.input,
    mic: Float32Array.from(
      { length: 512 },
      (_, i) => 0.08 * Math.sin((2 * Math.PI * 733 * i) / 16000),
    ),
  };
  assert.equal(api.train(independent).status, 'UNKNOWN');
});
test('maximum500ms native history remains bounded and uses the same frozen proof', () => {
  const rate = 44100,
    f = fixture(rate),
    start = Math.ceil(rate * 0.6),
    N = f.N,
    aStart = Math.ceil((start * 16000) / rate),
    aEnd = aStart + 512,
    referenceStart = aEnd - 8000;
  const trained = api.train({
    ...f.owner,
    analysisRate: 16000,
    reference: Float32Array.from(f.analysis.ref.slice(referenceStart, aEnd)),
    referenceStart,
    mic: Float32Array.from(f.analysis.mic.slice(aStart, aEnd)),
    micStart: aStart,
    native: f.native(start),
  });
  assert.equal(trained.status, 'FIT');
  const held = { ...f.owner, native: f.native(start + N) };
  assert.equal(held.native.reference.length, Math.floor(rate * 0.5));
  const v = api.validate(trained.fit, held),
    current = api.validateCurrent(trained.fit, {
      ...f.owner,
      native: f.native(start + 2 * N - 512, 512),
    });
  assert.equal(v.status, 'ECHO');
  assert.equal(current.status, 'ECHO');
  rows.push({
    case: 'max500ms-history-44100',
    historySamples: held.native.reference.length,
    heldout: v,
    current,
  });
});

test('fresh current validation accepts exact FIR span and rejects missing neighbors or future reference', () => {
  const f = fixture(44100),
    { fit } = api.train(f.input);
  assert.ok(fit);
  const micStart = f.start + 2 * f.N - 512;
  const referenceStart = micStart - fit.nativeLag - 1;
  const reference = f.ref.slice(referenceStart, referenceStart + 514);
  const frame = { ...f.native(micStart, 512), referenceStart, reference };
  const validate = (native) => api.validateCurrent(fit, { ...f.owner, native });
  assert.equal(reference.length, 514);
  assert.equal(validate(frame).status, 'ECHO');
  assert.equal(
    validate({ ...frame, referenceStart: referenceStart + 1, reference: reference.subarray(1) })
      .status,
    'UNKNOWN',
  );
  assert.equal(validate({ ...frame, reference: reference.subarray(0, 513) }).status, 'UNKNOWN');
  assert.equal(
    validate({ ...frame, reference: f.ref.slice(referenceStart, micStart + 513) }).status,
    'UNKNOWN',
  );
});
