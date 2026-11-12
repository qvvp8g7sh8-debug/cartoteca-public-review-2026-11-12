class AssistantPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(48000);
    this.reset(0);
    this.port.onmessage = ({ data }) => this.receive(data);
  }
  receive(data, transport = false) {
    if (transport && !['buffer', 'end', 'error'].includes(data?.type)) return;
    if (data?.type === 'begin') {
      if (Number.isSafeInteger(data.id) && data.id > this.id)
        this.reset(data.id, data.startupSamples, data.coldStart === true);
      return;
    }
    if (data?.id !== this.id) return;
    if (!transport && data.type === 'transport-cancel') {
      this.dataPort?.close();
      this.dataPort = null;
      return;
    }
    if (!transport && data.type === 'transport') {
      if (data.protocol !== 1) return;
      this.dataPort?.close();
      this.dataPort = null;
      const port = data.port;
      if (!port || typeof port.postMessage !== 'function') return;
      this.dataPort = port;
      port.onmessage = ({ data }) => {
        if (this.dataPort === port) this.receive(data, true);
      };
      port.start?.();
      port.postMessage({ type: 'ready', id: this.id, protocol: 1 });
      return;
    }
    if (transport && data.type === 'error') {
      this.port.postMessage({ type: 'error', id: this.id });
      this.reset(this.id);
      return;
    }
    if (data.type === 'buffer') {
      if (
        !(data.samples instanceof Int16Array) ||
        !data.samples.length ||
        data.samples.length > this.samples.length - this.length
      ) {
        this.port.postMessage({ type: 'error', id: this.id });
        this.reset(this.id);
        return;
      }

      if (
        !this.started &&
        this.coldStart &&
        Number.isSafeInteger(data.arrivalGroup) &&
        data.arrivalGroup > this.networkGroup
      ) {
        if (this.networkGroup) this.networkLaterSamples += data.samples.length;
        if (this.networkAt === null || this.clockFrames > this.networkAt) this.networkGroups++;
        this.networkGroup = data.arrivalGroup;
        this.networkAt = this.clockFrames;
      }
      if (!this.started && this.coldStart) {
        if (
          this.lastBufferFrame !== null &&
          this.clockFrames - this.lastBufferFrame > sampleRate * 0.12
        ) {
          this.coldTarget = 7200;
          this.coldWaitSeconds = 0.18;
        }
        this.lastBufferFrame = this.clockFrames;
      }
      this.receivedSamples += data.samples.length;
      for (const value of data.samples) {
        this.samples[(this.head + this.length) % this.samples.length] = value / 32768;
        this.length++;
      }
    } else if (data.type === 'pause') {
      this.paused = true;
      this.port.postMessage({ type: 'paused', id: this.id });
    } else if (data.type === 'probe') {
      if (!this.paused && !this.finished) {
        this.rampGain(0.125);
        this.port.postMessage({ type: 'probed', id: this.id });
      }
    } else if (data.type === 'resume') {
      this.paused = false;
      this.rampGain(1);
    } else if (data.type === 'end') {
      this.ended = true;
      if (transport)
        this.port.postMessage({ type: 'eof', id: this.id, received: this.receivedSamples });
    }
  }
  rampGain(target) {
    this.gainTarget = target;
    this.gainFrames = this.gain === target ? 0 : Math.max(1, Math.ceil(sampleRate * 0.012));
    this.gainStep = this.gainFrames ? (target - this.gain) / this.gainFrames : 0;
  }
  reset(id, startupSamples, coldStart = false) {
    this.dataPort?.close();
    this.dataPort = null;
    this.receivedSamples = 0;
    this.id = id;
    this.head = this.length = this.consumed = this.reported = this.position = 0;
    this.paused = true;
    this.gain = this.gainTarget = 1;
    this.gainFrames = this.gainStep = 0;
    this.started = this.ended = this.finished = false;
    // 120 ms initially; an underrun raises the target up to one second.
    // EOF bypasses the threshold so short replies and the final tail drain.
    this.buffering = true;
    this.startupTarget = Number.isSafeInteger(startupSamples)
      ? Math.max(2880, Math.min(7200, startupSamples))
      : 2880;
    this.bufferTarget = 2880;
    this.startupWaitFrames = 0;
    this.coldStart = coldStart;
    this.clockFrames = 0;
    this.lastBufferFrame = null;
    this.networkGroup = 0;
    this.networkGroups = 0;
    this.networkAt = null;
    this.networkLaterSamples = 0;
    this.coldTarget = 5760;
    this.coldWaitSeconds = 0.06;
    this.stableSamples = 0;
    this.refillFrames = 0;
  }
  process(_, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    this.clockFrames += output.length;
    if (this.paused) return true;

    if (this.buffering && !this.started && this.coldStart && !this.ended && this.length >= 2880) {
      const ready =
        this.length >= 5760 || (this.networkGroups >= 2 && this.networkLaterSamples >= 2880);
      if (!ready && this.startupWaitFrames + output.length <= Math.floor(sampleRate * 0.18)) {
        this.startupWaitFrames += output.length;
        return true;
      }
      // This one gate owns the TOTAL eligible cold wait; do not add old60/180ms.
      this.coldTarget = 2880;
      this.coldWaitSeconds = 0;
    }
    if (this.buffering) {
      const target = this.started
        ? this.bufferTarget
        : Math.max(this.startupTarget, this.coldStart ? this.coldTarget : 0);
      if (!this.ended && this.length < target) {
        if (!this.started && this.length >= 2880 && target > 2880) {
          // A new voice first stages60ms; an observed early stall or warm carry
          // may add at most180ms after the minimum reserve is available.
          // Use rendered audio frames, not main-thread timers or network time.
          if (
            this.startupWaitFrames <
            sampleRate * (this.coldStart ? this.coldWaitSeconds : 0.18)
          ) {
            this.startupWaitFrames += output.length;
            return true;
          }
        } else {
          if (this.started)
            this.refillFrames = Math.min(sampleRate * 150, this.refillFrames + output.length);
          return true;
        }
      }
      if (this.started) {
        this.port.postMessage({
          type: 'diagnostic',
          id: this.id,
          event: 'refill',
          waitMs: Math.min(150000, (this.refillFrames * 1000) / sampleRate),
        });
        this.refillFrames = 0;
      }
      this.buffering = false;
    }
    const ratio = 24000 / sampleRate,
      before = this.consumed;
    let rendered = 0;
    for (let i = 0; i < output.length; i++) {
      if (!this.length) break;
      if (!this.started) {
        this.started = true;
        this.port.postMessage({ type: 'started', id: this.id });
      }
      const a = this.samples[this.head],
        b = this.samples[(this.head + Math.min(1, this.length - 1)) % this.samples.length];
      if (this.gainFrames) {
        this.gain += this.gainStep;
        if (--this.gainFrames === 0) this.gain = this.gainTarget;
      }
      output[i] = (a + (b - a) * this.position) * this.gain;
      rendered++;
      this.position += ratio;
      while (this.position >= 1 && this.length) {
        this.position--;
        this.head = (this.head + 1) % this.samples.length;
        this.length--;
        this.consumed++;
      }
    }
    // An exactly filled block may empty the queue without missing any output.
    // Only a real shortage justifies muting later timely packets for a refill.
    if (rendered < output.length && !this.ended) {
      this.buffering = true;
      this.port.postMessage({ type: 'diagnostic', id: this.id, event: 'underrun' });
      this.refillFrames = 0;
      this.stableSamples = 0;
      this.bufferTarget = Math.min(24000, Math.max(7200, this.bufferTarget * 2));
    } else {
      this.stableSamples += this.consumed - before;
      // A stable stream gradually sheds the extra recovery reserve. There is
      // no audio dropping, time stretching or wall-clock startup timeout.
      if (this.stableSamples >= 48000) {
        this.stableSamples = 0;
        this.bufferTarget = Math.max(2880, Math.ceil(this.bufferTarget * 0.75));
      }
    }
    if (this.consumed - this.reported >= 2048 || !this.length) {
      if (this.consumed !== this.reported) {
        this.reported = this.consumed;
        this.port.postMessage({
          type: 'progress',
          id: this.id,
          consumed: this.consumed,
          ...(this.dataPort ? { received: this.receivedSamples } : {}),
        });
        this.dataPort?.postMessage({ type: 'progress', id: this.id, consumed: this.consumed });
      }
    }
    if (this.ended && !this.length && !this.finished) {
      this.finished = true;
      this.port.postMessage({ type: 'ended', id: this.id });
    }
    return true;
  }
}
registerProcessor('assistant-playback', AssistantPlaybackProcessor);
