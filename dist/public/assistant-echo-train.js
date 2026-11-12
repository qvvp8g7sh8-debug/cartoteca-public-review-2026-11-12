const window=self;
function createAssistantEchoReflection() {
  // Search the first window only. The caller verifies a separate window and every fresh frame.
  function assistantEchoReflection(native, fit, energy) {
    const { sampleRate, mic, reference } = native,
      origin = native.micStart - native.referenceStart,
      primary = origin - fit.lag,
      step = Math.round(sampleRate / 4000),
      count = Math.floor(mic.length / step),
      phase = origin % step,
      first = (origin - phase) / step,
      minSeparation = Math.round(sampleRate * 0.002);
    const lags = [fit.lag];
    if (fit.secondLag !== undefined) lags.push(fit.secondLag);
    const separated = (lag) => lags.every((prior) => Math.abs(lag - prior) >= minSeparation);
    const residual = new window.Float64Array(mic.length);
    const reduced = new window.Float64Array(count);
    const ref = new window.Float64Array(Math.floor((reference.length - phase) / step));
    for (let i = 0; i < residual.length; i++) {
      const p = primary + i;
      residual[i] =
        mic[i] - (fit.t0 * reference[p + 1] + fit.t1 * reference[p] + fit.t2 * reference[p - 1]);
      if (fit.secondLag !== undefined) {
        const s = origin - fit.secondLag + i;
        residual[i] -=
          fit.s0 * reference[s + 1] + fit.s1 * reference[s] + fit.s2 * reference[s - 1];
      }
      const block = Math.floor(i / step);
      if (block < count) reduced[block] += residual[i];
    }
    for (let i = 0; i < ref.length; i++) {
      const start = phase + i * step;
      for (let j = 0; j < step; j++) ref[i] += reference[start + j];
    }
    const minimum = Math.max(1, fit.lag - Math.round(sampleRate * 0.08)),
      maximum = Math.min(
        origin - 1,
        Math.floor(sampleRate * 0.3),
        fit.lag + Math.round(sampleRate * 0.08),
      );
    let coarse = 0,
      score = 0;
    for (let offset = Math.ceil(minimum / step); offset <= Math.floor(maximum / step); offset++) {
      const lag = offset * step;
      if (!separated(lag)) continue;
      let xx = 0,
        xy = 0;
      for (let i = 0; i < count; i++) {
        const x = ref[first - offset + i];
        xx += x * x;
        xy += x * reduced[i];
      }
      const quality = xx > 1e-8 ? (xy * xy) / xx : 0;
      if (quality > score) {
        coarse = lag;
        score = quality;
      }
    }
    if (!coarse) return null;
    let extraLag = 0;
    score = 0;
    for (
      let lag = Math.max(minimum, coarse - step);
      lag <= Math.min(maximum, coarse + step);
      lag++
    ) {
      if (!separated(lag)) continue;
      let xx = 0,
        xy = 0;
      const start = origin - lag;
      if (start - 1 < 0 || start + mic.length >= reference.length) continue;
      for (let i = 0; i < mic.length; i++) {
        const x = reference[start + i];
        xx += x * x;
        xy += x * residual[i];
      }
      const quality = xx > 1e-8 ? (xy * xy) / xx : 0;
      if (quality > score) {
        extraLag = lag;
        score = quality;
      }
    }
    if (!extraLag) return null;
    lags.push(extraLag);
    const offsets = lags.flatMap((lag) => [origin - lag + 1, origin - lag, origin - lag - 1]);
    const dimension = offsets.length;
    const matrix = Array.from({ length: dimension }, () => new window.Float64Array(dimension));
    const rhs = new window.Float64Array(dimension);
    const row = new window.Float64Array(dimension);
    for (let i = 0; i < mic.length; i++) {
      for (let k = 0; k < dimension; k++) row[k] = reference[offsets[k] + i];
      for (let k = 0; k < dimension; k++) {
        rhs[k] += row[k] * mic[i];
        for (let j = 0; j <= k; j++) matrix[k][j] += row[k] * row[j];
      }
    }
    // Cholesky in place. A nearly singular system cannot prove echo.
    for (let k = 0; k < dimension; k++) {
      for (let j = 0; j <= k; j++) {
        let value = matrix[k][j];
        for (let i = 0; i < j; i++) value -= matrix[k][i] * matrix[j][i];
        if (k === j && !(value > 1e-8)) return null;
        matrix[k][j] = k === j ? Math.sqrt(value) : value / matrix[j][j];
      }
    }
    const coefficients = new window.Float64Array(dimension);
    for (let k = 0; k < dimension; k++) {
      let value = rhs[k];
      for (let j = 0; j < k; j++) value -= matrix[k][j] * coefficients[j];
      coefficients[k] = value / matrix[k][k];
    }
    for (let k = dimension - 1; k >= 0; k--) {
      let value = coefficients[k];
      for (let j = k + 1; j < dimension; j++) value -= matrix[j][k] * coefficients[j];
      coefficients[k] = value / matrix[k][k];
    }
    if (
      !coefficients.every(Number.isFinite) ||
      coefficients.reduce((sum, value) => sum + Math.abs(value), 0) > 4
    )
      return null;
    const error = Math.max(
      0,
      energy - coefficients.reduce((sum, value, k) => sum + value * rhs[k], 0),
    );
    const previousError = fit.residual ?? residual.reduce((sum, value) => sum + value * value, 0);
    if (!(error < previousError / 2)) return null;
    const [lag, secondLag, thirdLag] = lags;
    const [t0, t1, t2, s0, s1, s2, u0, u1, u2] = coefficients;
    return {
      lag,
      t0,
      t1,
      t2,
      secondLag,
      s0,
      s1,
      s2,
      residual: error,
      ...(thirdLag !== undefined ? { thirdLag, u0, u1, u2 } : {}),
    };
  }
  return { assistantEchoReflection };
}

function createAssistantEchoMath(state, actions = {}) {
  const N = 512,
    RATE = 16000,
    MAX_REFERENCE = 8000,
    MAX_LAG = 4800;
  const unknown = (reason) => ({ status: 'UNKNOWN', reason });
  const clock = () => (typeof window.performance === 'object' ? window.performance.now() : 0);
  function valid(input) {
    if (
      !input ||
      input.analysisRate !== RATE ||
      typeof input.owner !== 'string' ||
      !input.owner.length ||
      input.owner.length > 128 ||
      !Number.isSafeInteger(input.epoch) ||
      input.epoch < 0 ||
      !Number.isSafeInteger(input.candidate) ||
      input.candidate < 0 ||
      !Number.isSafeInteger(input.micStart) ||
      input.micStart < 0 ||
      !Number.isSafeInteger(input.micStart + N) ||
      !Number.isSafeInteger(input.referenceStart) ||
      input.referenceStart < 0 ||
      !(input.mic instanceof window.Float32Array) ||
      input.mic.length !== N ||
      !(input.reference instanceof window.Float32Array) ||
      input.reference.length > MAX_REFERENCE ||
      input.reference.length < N ||
      input.referenceStart + input.reference.length !== input.micStart + N
    )
      return false;
    for (let i = 0; i < N; i++) if (!Number.isFinite(input.mic[i])) return false;
    for (let i = 0; i < input.reference.length; i++)
      if (!Number.isFinite(input.reference[i])) return false;
    return true;
  }
  function train(input) {
    const at = clock();
    if (!valid(input)) return unknown('invalid-training-window');
    const ref = input.reference,
      y = input.mic,
      length = ref.length;
    let energy = 0;
    for (let i = 0; i < N; i++) energy += y[i] * y[i];
    if (energy / N < 0.009 * 0.009) return unknown('below-speech-floor');
    const maxLag = Math.min(MAX_LAG, length - N - 2);
    if (maxLag < 1) return unknown('missing-reference');
    const coarseLength = Math.floor(length / 8),
      h = new window.Float64Array(coarseLength),
      cy = new window.Float64Array(64);
    for (let i = 0; i < coarseLength; i++) {
      let sum = 0;
      const start = length - (coarseLength - i) * 8;
      for (let j = 0; j < 8; j++) sum += ref[start + j];
      h[i] = sum / 8;
    }
    let ey = 0;
    for (let i = 0; i < 64; i++) {
      let sum = 0;
      for (let j = 0; j < 8; j++) sum += y[i * 8 + j];
      cy[i] = sum / 8;
      ey += cy[i] * cy[i];
    }
    const scores = [];
    let coarseLag = 0,
      coarseBest = 0;
    for (let lag = 0; lag <= maxLag; lag += 8) {
      const start = coarseLength - 64 - lag / 8;
      if (start < 0) continue;
      let xx = 0,
        xy = 0;
      for (let i = 0; i < 64; i++) {
        const x = h[start + i];
        xx += x * x;
        xy += x * cy[i];
      }
      const corr = xx && ey ? Math.abs(xy) / Math.sqrt(xx * ey) : 0;
      scores.push({ lag, corr });
      if (corr > coarseBest) {
        coarseBest = corr;
        coarseLag = lag;
      }
    }
    function correlation(lag) {
      const start = length - N - lag;
      let xx = 0,
        xy = 0;
      for (let i = 0; i < N; i++) {
        const x = ref[start + i];
        xx += x * x;
        xy += x * y[i];
      }
      return xx ? Math.abs(xy) / Math.sqrt(xx * energy) : 0;
    }
    let bestLag = coarseLag,
      best = correlation(coarseLag);
    for (let lag = Math.max(1, coarseLag - 8); lag <= Math.min(maxLag, coarseLag + 8); lag++) {
      const corr = correlation(lag);
      if (corr > best) {
        best = corr;
        bestLag = lag;
      }
    }
    let alternative = 0;
    for (const row of scores)
      if (Math.abs(row.lag - bestLag) > 128) alternative = Math.max(alternative, row.corr);
    if (best < 0.75 || alternative > best * 0.85) return unknown('ambiguous-lag');

    const native = input.native;
    if (!validNative(native, true)) return unknown('invalid-native-training');
    const ratio = native.sampleRate / RATE,
      first = Math.floor(input.micStart * ratio),
      last = Math.ceil((input.micStart + N - 1) * ratio);
    if (
      first < native.micStart ||
      last >= native.micStart + native.mic.length ||
      Math.abs(native.micStart - input.micStart * ratio) > Math.ceil(ratio)
    )
      return unknown('native-analysis-alignment');
    const radius = Math.ceil(ratio) * 3,
      center = Math.round(bestLag * ratio),
      minimum = Math.max(1, center - radius),
      maximum = Math.min(
        Math.floor(native.sampleRate * 0.3),
        center + radius,
        native.micStart - native.referenceStart - 1,
      );
    let nativeEnergy = 0;
    for (let i = 0; i < native.mic.length; i++) nativeEnergy += native.mic[i] ** 2;
    let chosen = null;
    const seed = retrySeed(input, native, minimum, maximum);
    if (seed) {
      // Keep the two previously fitted lags while searching the new window for a third.
      chosen = actions.assistantEchoReflection?.(native, seed, nativeEnergy);
    } else {
      for (let lag = minimum; lag <= maximum; lag++) {
        const trial = nativeFit(native, lag, nativeEnergy);
        if (trial && (!chosen || trial.residual < chosen.residual)) chosen = trial;
      }
      if (chosen && chosen.residual / nativeEnergy > 0.0005) {
        const reflected = actions.assistantEchoReflection?.(native, chosen, nativeEnergy);
        if (reflected) {
          chosen = reflected;
          if (chosen.residual >= native.mic.length * 0.003 ** 2)
            chosen = actions.assistantEchoReflection(native, chosen, nativeEnergy) ?? chosen;
        }
      }
    }
    if (!chosen || Math.sqrt(chosen.residual / native.mic.length) >= 0.003)
      return unknown('native-training-residual');
    const frozen = Object.freeze({
      owner: input.owner,
      epoch: input.epoch,
      candidate: input.candidate,
      analysisTrainStart: input.micStart,
      correlation: best,
      alternative,
      nativeRate: native.sampleRate,
      nativeN: native.mic.length,
      nativeTrainStart: native.micStart,
      nativeLag: chosen.lag,
      t0: chosen.t0,
      t1: chosen.t1,
      t2: chosen.t2,
      ...(chosen.secondLag
        ? { secondLag: chosen.secondLag, s0: chosen.s0, s1: chosen.s1, s2: chosen.s2 }
        : {}),
      ...(chosen.thirdLag
        ? { thirdLag: chosen.thirdLag, u0: chosen.u0, u1: chosen.u1, u2: chosen.u2 }
        : {}),
      trainEnergy: nativeEnergy,
      trainResidual: chosen.residual,
    });
    return { status: 'FIT', fit: frozen, trainCpuMs: clock() - at };
  }
  function retrySeed(input, native, minimum, maximum) {
    const prior = input.priorFit;
    if (
      !prior ||
      prior.candidate !== input.candidate - 1 ||
      !safeFit(prior, { ...input, candidate: prior.candidate }) ||
      prior.nativeRate !== native.sampleRate ||
      prior.nativeTrainStart >= native.micStart ||
      native.micStart - prior.nativeTrainStart > prior.nativeN + 1 ||
      prior.nativeLag < minimum ||
      prior.nativeLag > maximum ||
      prior.secondLag === undefined ||
      prior.thirdLag !== undefined
    )
      return null;
    const { nativeLag: lag, t0, t1, t2, secondLag, s0, s1, s2 } = prior;
    const origin = native.micStart - native.referenceStart;
    if (secondLag >= origin) return null;
    return { lag, t0, t1, t2, secondLag, s0, s1, s2 };
  }
  function validNative(n, training = false, current = false) {
    if (
      !n ||
      ![44100, 48000].includes(n.sampleRate) ||
      !Number.isSafeInteger(n.micStart) ||
      n.micStart < 0 ||
      !Number.isSafeInteger(n.referenceStart) ||
      n.referenceStart < 0 ||
      !(n.mic instanceof window.Float32Array) ||
      n.mic.length !== (current ? 512 : Math.floor(n.sampleRate * 0.032)) ||
      !(n.reference instanceof window.Float32Array) ||
      n.reference.length > Math.floor(n.sampleRate * 0.5) ||
      n.reference.length < n.mic.length ||
      !Number.isSafeInteger(n.micStart + n.mic.length) ||
      !Number.isSafeInteger(n.referenceStart + n.reference.length) ||
      (current
        ? n.referenceStart + n.reference.length > n.micStart + n.mic.length
        : n.referenceStart + n.reference.length !== n.micStart + n.mic.length)
    )
      return false;
    for (let i = 0; i < n.mic.length; i++) if (!Number.isFinite(n.mic[i])) return false;
    for (let i = 0; i < n.reference.length; i++) if (!Number.isFinite(n.reference[i])) return false;
    return true;
  }
  function nativeFit(n, lag, energy) {
    const start = n.micStart - lag - n.referenceStart,
      ref = n.reference,
      y = n.mic,
      count = y.length;
    if (start - 1 < 0 || start + count >= ref.length) return null;
    let A00 = 0,
      A01 = 0,
      A02 = 0,
      A11 = 0,
      A12 = 0,
      A22 = 0,
      b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < count; i++) {
      const x0 = ref[start + i + 1],
        x1 = ref[start + i],
        x2 = ref[start + i - 1],
        v = y[i];
      A00 += x0 * x0;
      A01 += x0 * x1;
      A02 += x0 * x2;
      A11 += x1 * x1;
      A12 += x1 * x2;
      A22 += x2 * x2;
      b0 += x0 * v;
      b1 += x1 * v;
      b2 += x2 * v;
    }
    if (A00 < 1e-8) return null;
    const l00 = Math.sqrt(A00),
      l10 = A01 / l00,
      l20 = A02 / l00,
      p11 = A11 - l10 * l10;
    if (p11 < 1e-8) return null;
    const l11 = Math.sqrt(p11),
      l21 = (A12 - l20 * l10) / l11,
      p22 = A22 - l20 * l20 - l21 * l21;
    if (p22 < 1e-8) return null;
    const l22 = Math.sqrt(p22),
      z0 = b0 / l00,
      z1 = (b1 - l10 * z0) / l11,
      z2 = (b2 - l20 * z0 - l21 * z1) / l22,
      t2 = z2 / l22,
      t1 = (z1 - l21 * t2) / l11,
      t0 = (z0 - l10 * t1 - l20 * t2) / l00;
    if (
      !Number.isFinite(t0) ||
      !Number.isFinite(t1) ||
      !Number.isFinite(t2) ||
      Math.max(Math.abs(t0), Math.abs(t1), Math.abs(t2)) > 4
    )
      return null;
    const residual = Math.max(
      0,
      energy -
        2 * (t0 * b0 + t1 * b1 + t2 * b2) +
        t0 * t0 * A00 +
        t1 * t1 * A11 +
        t2 * t2 * A22 +
        2 * (t0 * t1 * A01 + t0 * t2 * A02 + t1 * t2 * A12),
    );
    return { lag, t0, t1, t2, residual };
  }
  function safeThirdPath(fit) {
    if (fit.thirdLag === undefined) return true;
    const separation = Math.round(fit.nativeRate * 0.002);
    return (
      fit.secondLag !== undefined &&
      Number.isSafeInteger(fit.thirdLag) &&
      fit.thirdLag > 0 &&
      fit.thirdLag <= Math.floor(fit.nativeRate * 0.3) &&
      Math.abs(fit.thirdLag - fit.nativeLag) <= Math.round(fit.nativeRate * 0.08) &&
      Math.abs(fit.thirdLag - fit.nativeLag) >= separation &&
      Math.abs(fit.thirdLag - fit.secondLag) >= separation &&
      [fit.u0, fit.u1, fit.u2].every(Number.isFinite) &&
      [fit.t0, fit.t1, fit.t2, fit.s0, fit.s1, fit.s2, fit.u0, fit.u1, fit.u2].reduce(
        (sum, value) => sum + Math.abs(value),
        0,
      ) <= 4
    );
  }
  function safeFit(fit, input) {
    return (
      fit &&
      input &&
      fit.owner === input.owner &&
      fit.epoch === input.epoch &&
      fit.candidate === input.candidate &&
      typeof input.owner === 'string' &&
      input.owner.length > 0 &&
      input.owner.length <= 128 &&
      Number.isSafeInteger(input.epoch) &&
      input.epoch >= 0 &&
      Number.isSafeInteger(input.candidate) &&
      input.candidate >= 0 &&
      [44100, 48000].includes(fit.nativeRate) &&
      fit.nativeN === Math.floor(fit.nativeRate * 0.032) &&
      Number.isSafeInteger(fit.nativeTrainStart) &&
      fit.nativeTrainStart >= 0 &&
      Number.isSafeInteger(fit.nativeLag) &&
      fit.nativeLag > 0 &&
      fit.nativeLag <= Math.floor(fit.nativeRate * 0.3) &&
      [
        fit.t0,
        fit.t1,
        fit.t2,
        fit.trainEnergy,
        fit.trainResidual,
        fit.correlation,
        fit.alternative,
      ].every(Number.isFinite) &&
      Math.max(Math.abs(fit.t0), Math.abs(fit.t1), Math.abs(fit.t2)) <= 4 &&
      (fit.secondLag === undefined ||
        (Number.isSafeInteger(fit.secondLag) &&
          fit.secondLag > 0 &&
          fit.secondLag <= Math.floor(fit.nativeRate * 0.3) &&
          Math.abs(fit.secondLag - fit.nativeLag) >= Math.round(fit.nativeRate * 0.002) &&
          [fit.s0, fit.s1, fit.s2].every(Number.isFinite) &&
          [fit.t0, fit.t1, fit.t2, fit.s0, fit.s1, fit.s2].reduce(
            (sum, value) => sum + Math.abs(value),
            0,
          ) <= 4)) &&
      safeThirdPath(fit) &&
      fit.trainEnergy > 0 &&
      fit.trainResidual >= 0 &&
      Math.sqrt(fit.trainResidual / fit.nativeN) < 0.003 &&
      fit.correlation >= 0.75 &&
      fit.alternative >= 0 &&
      fit.alternative <= fit.correlation * 0.85
    );
  }
  function pathReference(native, current, lag, compact, compactStart) {
    const reference = current ? compact : native.reference;
    const origin = current ? compactStart : native.referenceStart;
    if (
      !(reference instanceof window.Float32Array) ||
      !Number.isSafeInteger(origin) ||
      origin < 0 ||
      (current &&
        (reference.length !== 514 ||
          origin + reference.length > native.micStart + native.mic.length ||
          reference.some((value) => !Number.isFinite(value))))
    )
      return null;
    const start = native.micStart - lag - origin;
    return start - 1 >= 0 && start + native.mic.length < reference.length
      ? { reference, start }
      : null;
  }
  function check(fit, input, current) {
    const at = clock();
    if (
      !safeFit(fit, input) ||
      !validNative(input.native, false, current) ||
      input.native.sampleRate !== fit.nativeRate
    )
      return unknown('missing-or-stale-native-fit');
    const n = input.native,
      heldoutStart = fit.nativeTrainStart + fit.nativeN;
    if (
      (!current && n.micStart !== heldoutStart) ||
      (current &&
        (n.micStart < heldoutStart || n.micStart + n.mic.length < heldoutStart + fit.nativeN))
    )
      return unknown('native-window-index');
    const start = n.micStart - fit.nativeLag - n.referenceStart;
    if (start - 1 < 0 || start + n.mic.length >= n.reference.length)
      return unknown('missing-native-reference');
    let second, third;
    if (fit.secondLag !== undefined) {
      second = pathReference(n, current, fit.secondLag, n.referenceSecond, n.referenceSecondStart);
      if (!second) return unknown('missing-native-reference');
    }
    if (fit.thirdLag !== undefined) {
      third = pathReference(n, current, fit.thirdLag, n.referenceThird, n.referenceThirdStart);
      if (!third) return unknown('missing-native-reference');
    }
    let energy = 0,
      residual = 0;
    for (let i = 0; i < n.mic.length; i++) {
      const q = start + i;
      let predicted =
        fit.t0 * n.reference[q + 1] + fit.t1 * n.reference[q] + fit.t2 * n.reference[q - 1];
      if (second) {
        const { reference, start } = second;
        const s = start + i;
        predicted += fit.s0 * reference[s + 1] + fit.s1 * reference[s] + fit.s2 * reference[s - 1];
      }
      if (third) {
        const { reference, start } = third;
        const u = start + i;
        predicted += fit.u0 * reference[u + 1] + fit.u1 * reference[u] + fit.u2 * reference[u - 1];
      }
      const d = n.mic[i] - predicted;
      residual += d * d;
      energy += n.mic[i] * n.mic[i];
    }
    const rms = Math.sqrt(residual / n.mic.length),
      relative = current
        ? residual / Math.max(energy, 1e-20)
        : (fit.trainResidual + residual) / (fit.trainEnergy + energy);
    return {
      status: rms < 0.003 && relative < 0.02 ? 'ECHO' : 'UNKNOWN',
      reason: rms < 0.003 && relative < 0.02 ? 'native-heldout-proof' : 'native-heldout-residual',
      residualRms: rms,
      relativeResidual: relative,
      validateCpuMs: clock() - at,
    };
  }
  function validate(fit, input) {
    return check(fit, input, false);
  }
  function validateCurrent(fit, input) {
    return check(fit, input, true);
  }
  const api = Object.freeze({ train, validate, validateCurrent });
  return { assistantEchoMath: () => api };
}

const echoMath = createAssistantEchoMath(null, createAssistantEchoReflection()).assistantEchoMath();
self.onmessage = ({ data }) => {
  if (data?.type !== 'train' || !Number.isSafeInteger(data.request) || data.request < 0) return;
  let result;
  try {
    result = echoMath.train(data.input);
  } catch {
    result = { status: 'UNKNOWN' };
  }
  self.postMessage({ type: 'fit', request: data.request, result });
};
self.postMessage({ type: 'ready', protocol: 1 });
