const CHUNK_FRAMES = 4096;
const CHANNELS = 2;

class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.stopped = false;
    this.chunk = new Float32Array(CHUNK_FRAMES * CHANNELS);
    this.offset = 0;
    this.peaks = [0, 0];
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'start' && !this.stopped) this.active = true;
      if (data?.type === 'stop' && !this.stopped) {
        this.active = false;
        this.stopped = true;
        this.flush();
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (!this.offset) return;
    const frames = this.offset;
    const buffer = frames === CHUNK_FRAMES
      ? this.chunk.buffer
      : this.chunk.buffer.slice(0, frames * CHANNELS * 4);
    this.port.postMessage({ type: 'chunk', buffer, frames, peaks: this.peaks }, [buffer]);
    this.chunk = new Float32Array(CHUNK_FRAMES * CHANNELS);
    this.offset = 0;
    this.peaks = [0, 0];
  }

  process(inputs, outputs) {
    // Monitoring goes directly from source to destination, never through this node.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (!this.active) return !this.stopped;
    const input = inputs[0] || [];
    const count = outputs[0]?.[0]?.length || input[0]?.length || 128;
    const left = input[0];
    const right = input[1] || left;
    for (let frame = 0; frame < count; frame++) {
      const l = Number.isFinite(left?.[frame]) ? left[frame] : 0;
      const r = Number.isFinite(right?.[frame]) ? right[frame] : 0;
      this.chunk[this.offset * CHANNELS] = l;
      this.chunk[this.offset * CHANNELS + 1] = r;
      this.peaks[0] = Math.max(this.peaks[0], Math.abs(l));
      this.peaks[1] = Math.max(this.peaks[1], Math.abs(r));
      this.offset++;
      if (this.offset === CHUNK_FRAMES) this.flush();
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PCMRecorder);
