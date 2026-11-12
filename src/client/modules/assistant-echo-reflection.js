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
