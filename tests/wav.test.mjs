import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePCM24, makeWavHeader, wavLayout } from '../lib/wav.js';

const ascii = (view, offset, length) => String.fromCharCode(...new Uint8Array(view.buffer, offset, length));
const int24 = (bytes, sample) => {
  const i = sample * 3;
  const unsigned = bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16;
  return unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned;
};

test('float WAV declares IEEE float, extended fmt, fact frame count and stereo data size', () => {
  const header = makeWavHeader({ sampleRate: 48000, channels: 2, frames: 12345 });
  const v = new DataView(header);
  assert.equal(header.byteLength, 58);
  assert.equal(ascii(v, 0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), 50 + 12345 * 8);
  assert.equal(ascii(v, 8, 4), 'WAVE');
  assert.equal(ascii(v, 12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 18);
  assert.equal(v.getUint16(20, true), 3);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(28, true), 384000);
  assert.equal(v.getUint16(32, true), 8);
  assert.equal(v.getUint16(34, true), 32);
  assert.equal(v.getUint16(36, true), 0);
  assert.equal(ascii(v, 38, 4), 'fact');
  assert.equal(v.getUint32(42, true), 4);
  assert.equal(v.getUint32(46, true), 12345);
  assert.equal(ascii(v, 50, 4), 'data');
  assert.equal(v.getUint32(54, true), 12345 * 8);
});

test('24-bit WAV describes signed PCM with correct stereo sample stride', () => {
  const header = makeWavHeader({ sampleRate: 44100, channels: 2, frames: 3, format: 'pcm24' });
  const v = new DataView(header);
  assert.equal(header.byteLength, 44);
  assert.equal(v.getUint32(4, true), 54);
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(28, true), 264600);
  assert.equal(v.getUint16(32, true), 6);
  assert.equal(v.getUint16(34, true), 24);
  assert.equal(ascii(v, 36, 4), 'data');
  assert.equal(v.getUint32(40, true), 18);
});

test('PCM24 quantization is little-endian, preserves interleaving, clips only at boundaries', () => {
  const values = [-1, 1, -0.5, 0.5, -2, 2, 0, 2 ** -23, -(2 ** -23), NaN, Infinity, -Infinity];
  const bytes = encodePCM24(new Float32Array(values).buffer);
  const actual = values.map((_, index) => int24(bytes, index));
  assert.deepEqual(actual, [-8388608, 8388607, -4194304, 4194304, -8388608, 8388607, 0, 1, -1, 0, 0, 0]);
  assert.deepEqual([...bytes.subarray(0, 6)], [0, 0, 128, 255, 255, 127]);
});

test('PCM24 has at most half a least-significant-bit error for in-range Float32 samples', () => {
  const input = Float32Array.from({ length: 10001 }, (_, i) => -0.99 + i / 10000 * 1.98);
  const bytes = encodePCM24(input.buffer);
  for (let i = 0; i < input.length; i++) {
    assert.ok(Math.abs(int24(bytes, i) / 8388608 - input[i]) <= 0.5 / 8388608);
  }
});

test('layout counts RIFF padding for odd mono PCM data without counting it as audio', () => {
  const layout = wavLayout({ sampleRate: 8000, channels: 1, frames: 1, format: 'pcm24' });
  assert.equal(layout.dataBytes, 3);
  assert.equal(layout.paddingBytes, 1);
  assert.equal(layout.riffBytes, 40);
});

test('RIFF limit and invalid audio descriptions are rejected before allocation', () => {
  assert.throws(() => makeWavHeader({ sampleRate: 48000, frames: 0x20000000 }), /RIFF/);
  assert.throws(() => makeWavHeader({ sampleRate: 48000, frames: -1 }), /采样帧/);
  assert.throws(() => makeWavHeader({ sampleRate: 0, frames: 1 }), /采样率/);
  assert.throws(() => makeWavHeader({ sampleRate: 48000, channels: 0, frames: 1 }), /声道/);
  assert.throws(() => makeWavHeader({ sampleRate: 48000, frames: 1, format: 'mp3' }), /格式/);
  assert.throws(() => makeWavHeader({ sampleRate: 48000, frames: 1, format: 'constructor' }), /格式/);
  assert.throws(() => encodePCM24(new ArrayBuffer(3)), /Float32/);
});
