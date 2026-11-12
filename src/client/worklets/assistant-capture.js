// PCM transport only. The existing main-thread state machine owns all decisions.
class AssistantCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frame = new Float32Array(512);
    this.reference =
      options?.processorOptions?.pairedReference === true ? new Float32Array(512) : null;
    this.offset = 0;
    this.pending = 0;
    this.active = true;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'ack') this.pending = Math.max(0, this.pending - 1);
      if (data?.type === 'stop') {
        this.active = false;
        this.frame.fill(0);
        this.reference?.fill(0);
        this.offset = 0;
      }
    };
  }
  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (!this.active) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    const reference = inputs[1]?.[0];
    // Render quantum sizes may vary. Keep the detector's original 512-sample frames.
    for (let index = 0; index < input.length; index++) {
      if (this.reference) this.reference[this.offset] = reference?.[index] ?? 0;
      this.frame[this.offset++] = input[index];
      if (this.offset !== 512) continue;
      if (this.pending >= 32) {
        this.active = false;
        this.frame.fill(0);
        this.port.postMessage({ type: 'overflow' });
        return false;
      }
      const samples = this.frame,
        paired = this.reference;
      this.frame = new Float32Array(512);
      if (paired) this.reference = new Float32Array(512);
      this.offset = 0;
      this.pending++;
      this.port.postMessage(
        {
          ...(paired ? { reference: paired } : {}),
          type: 'pcm',
          samples,
          time: currentTime + (index + 1) / sampleRate,
        },
        paired ? [samples.buffer, paired.buffer] : [samples.buffer],
      );
    }
    return true;
  }
}
registerProcessor('cartoteca-assistant-capture-v1', AssistantCaptureProcessor);
