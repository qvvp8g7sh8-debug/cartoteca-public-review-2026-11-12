function createAssistantBargeSignal(state, actions) {
  function assistantBargeSignal(rate) {
    let noise = 0.002,
      onset = 0;
    const history = [];
    let historySamples = 0,
      previousNoise = noise;
    function inspect(samples) {
      previousNoise = noise;
      let energy = 0,
        speechEnergy = 0,
        crossings = 0,
        previous = 0,
        low = 0,
        high = 0;
      const lowAlpha = Math.exp((-2 * Math.PI * 120) / rate),
        highAlpha = 1 - Math.exp((-2 * Math.PI * 3800) / rate);
      for (let i = 0; i < samples.length; i++) {
        const value = samples[i];
        energy += value * value;
        low = lowAlpha * (low + value - previous);
        high += highAlpha * (low - high);
        speechEnergy += high * high;
        if (i && value >= 0 !== previous >= 0) crossings++;
        previous = value;
      }
      const rms = Math.sqrt(energy / samples.length),
        band = energy ? speechEnergy / energy : 0,
        crossingRate = (crossings * rate) / samples.length;
      const voiced =
        rms >= Math.max(0.009, noise * 3.5) &&
        band >= 0.3 &&
        crossingRate >= 80 &&
        crossingRate <= 7000;
      if (!voiced) noise = Math.min(0.02, noise * 0.98 + rms * 0.02);
      const ms = (samples.length / rate) * 1000;
      onset = voiced ? onset + ms : 0;
      return { voiced, onsetMs: onset, ms, rms };
    }
    function remember(samples) {
      history.push(new window.Float32Array(samples));
      historySamples += samples.length;
      while (history.length > 1 && historySamples - history[0].length >= rate * 0.4)
        historySamples -= history.shift().length;
    }
    return {
      inspect,
      discardEchoDetectionUpdate() {
        noise = previousNoise;
        onset = 0;
      },
      remember,
      prebuffer: () => history.slice(),
      clear() {
        history.length = 0;
        historySamples = 0;
        onset = 0;
      },
    };
  }
  return { assistantBargeSignal };
}
