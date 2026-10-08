// Pure WAV helpers. Input samples are little-endian Float32 interleaved PCM.
export const WAV_FORMATS = Object.freeze({
  float32: Object.freeze({ formatTag: 3, bitsPerSample: 32, headerBytes: 58 }),
  pcm24: Object.freeze({ formatTag: 1, bitsPerSample: 24, headerBytes: 44 }),
});

export function wavLayout({ sampleRate, channels = 2, frames, format = 'float32' }) {
  const encoding = Object.hasOwn(WAV_FORMATS, format) ? WAV_FORMATS[format] : null;
  if (!encoding) throw new Error('不支持的 WAV 格式');
  if (!Number.isInteger(channels) || channels < 1 || channels > 32) throw new Error('无效的声道数');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('无效的采样率');
  if (!Number.isSafeInteger(frames) || frames < 0) throw new Error('无效的采样帧数');
  const blockAlign = channels * encoding.bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = frames * blockAlign;
  const paddingBytes = dataBytes % 2;
  const riffBytes = encoding.headerBytes - 8 + dataBytes + paddingBytes;
  if (byteRate > 0xffffffff || riffBytes > 0xffffffff || frames > 0xffffffff) {
    throw new Error('录音超过标准 RIFF WAV 的大小限制');
  }
  return { ...encoding, channels, sampleRate, frames, blockAlign, byteRate, dataBytes, paddingBytes, riffBytes };
}

function writeASCII(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function makeWavHeader(options) {
  const layout = wavLayout(options);
  const { headerBytes, formatTag, channels, sampleRate, byteRate, blockAlign, bitsPerSample, frames, dataBytes, riffBytes } = layout;
  const buffer = new ArrayBuffer(headerBytes);
  const view = new DataView(buffer);
  writeASCII(view, 0, 'RIFF');
  view.setUint32(4, riffBytes, true);
  writeASCII(view, 8, 'WAVE');
  writeASCII(view, 12, 'fmt ');
  view.setUint32(16, formatTag === 3 ? 18 : 16, true);
  view.setUint16(20, formatTag, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  if (formatTag === 3) {
    view.setUint16(36, 0, true); // WAVEFORMATEX cbSize.
    writeASCII(view, 38, 'fact');
    view.setUint32(42, 4, true);
    view.setUint32(46, frames, true);
  }
  writeASCII(view, headerBytes - 8, 'data');
  view.setUint32(headerBytes - 4, dataBytes, true);
  return buffer;
}

export function encodePCM24(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength % 4 !== 0) {
    throw new Error('PCM 数据必须是 Float32 ArrayBuffer');
  }
  const source = new DataView(buffer);
  const output = new Uint8Array(buffer.byteLength / 4 * 3);
  for (let i = 0, dest = 0; i < buffer.byteLength; i += 4, dest += 3) {
    const sample = source.getFloat32(i, true);
    const finite = Number.isFinite(sample) ? sample : 0;
    const clamped = Math.max(-1, Math.min(1, finite));
    const quantized = Math.round(clamped * 0x800000);
    const value = Math.max(-0x800000, Math.min(0x7fffff, quantized));
    output[dest] = value & 0xff;
    output[dest + 1] = (value >> 8) & 0xff;
    output[dest + 2] = (value >> 16) & 0xff;
  }
  return output;
}
