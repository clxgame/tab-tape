import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../audio/pcm-worklet.js', import.meta.url), 'utf8');

function recorder() {
  let Processor;
  const messages = [];
  const context = {
    Float32Array,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage(message, transfer = []) {
          // Model the real MessagePort transfer, including detached source buffers.
          messages.push(structuredClone(message, { transfer }));
        } };
      }
    },
    registerProcessor(name, implementation) {
      assert.equal(name, 'pcm-recorder');
      Processor = implementation;
    },
  };
  vm.runInNewContext(source, context);
  const node = new Processor();
  return { node, messages, send: type => node.port.onmessage({ data: { type } }) };
}

function quantum(node, left, right, count = 128) {
  const inputs = left ? [[left, ...(right ? [right] : [])]] : [[]];
  const outputs = [[new Float32Array(count).fill(9), new Float32Array(count).fill(9)]];
  const alive = node.process(inputs, outputs);
  assert.ok(outputs[0].every(channel => channel.every(sample => sample === 0)), 'worklet output must always be silent');
  return alive;
}

test('captures stereo in sample order, emits exact chunks and flushes final audio before stopped', () => {
  const { node, messages, send } = recorder();
  quantum(node, new Float32Array(128).fill(1));
  assert.equal(messages.length, 0);
  send('start');
  for (let i = 0; i < 33; i++) quantum(node, new Float32Array(128).fill(i / 32), new Float32Array(128).fill(-i / 32));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].frames, 4096);
  assert.deepEqual(messages[0].peaks, [31 / 32, 31 / 32]);
  const first = new Float32Array(messages[0].buffer);
  assert.equal(first.length, 8192);
  for (let i = 0; i < first.length; i += 2) {
    assert.equal(first[i], Math.floor(i / 256) / 32);
    assert.equal(first[i + 1], -Math.floor(i / 256) / 32);
  }
  send('stop');
  assert.deepEqual(messages.map(message => message.type), ['chunk', 'chunk', 'stopped']);
  assert.equal(messages[1].frames, 128);
  assert.equal(messages[1].buffer.byteLength, 1024);
  assert.deepEqual([...new Float32Array(messages[1].buffer).slice(0, 4)], [1, -1, 1, -1]);
  assert.deepEqual(messages[1].peaks, [1, 1]);
  assert.equal(quantum(node, new Float32Array(128).fill(1)), false);
  send('start');
  send('stop');
  assert.equal(messages.length, 3);
});

test('mono duplicates into stereo and missing input preserves elapsed silence', () => {
  const { node, messages, send } = recorder();
  send('start');
  quantum(node, new Float32Array([0.25, -0.5, 2, -3]), undefined, 4);
  quantum(node, undefined, undefined, 4);
  send('stop');
  assert.equal(messages[0].frames, 8);
  assert.deepEqual([...new Float32Array(messages[0].buffer)], [0.25, 0.25, -0.5, -0.5, 2, 2, -3, -3, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(messages[0].peaks, [3, 3]);
});

test('non-finite samples become silence and over-range finite samples retain float precision', () => {
  const { node, messages, send } = recorder();
  send('start');
  quantum(node, new Float32Array([NaN, Infinity, -Infinity, 1.25]), new Float32Array([-0.25, 2, 0, NaN]), 4);
  send('stop');
  assert.deepEqual([...new Float32Array(messages[0].buffer)], [0, -0.25, 0, 2, 0, 0, 1.25, 0]);
  assert.deepEqual(messages[0].peaks, [1.25, 2]);
});

test('stop after a chunk boundary does not create an empty chunk', () => {
  const { node, messages, send } = recorder();
  send('start');
  for (let i = 0; i < 32; i++) quantum(node, undefined);
  send('stop');
  assert.deepEqual(messages.map(message => message.type), ['chunk', 'stopped']);
  assert.equal(messages[0].frames, 4096);
  assert.deepEqual(messages[0].peaks, [0, 0]);
});

test('empty stop acknowledges once without audio, and varying render quantum sizes chunk correctly', () => {
  const empty = recorder();
  empty.send('stop');
  empty.send('stop');
  assert.deepEqual(empty.messages, [{ type: 'stopped' }]);
  const { node, messages, send } = recorder();
  send('start');
  quantum(node, new Float32Array(5000).fill(0.1), undefined, 5000);
  send('stop');
  assert.deepEqual(messages.map(message => message.frames).filter(Boolean), [4096, 904]);
  assert.equal(messages.slice(0, -1).reduce((sum, chunk) => sum + chunk.frames, 0), 5000);
});
