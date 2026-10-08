import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = (await readFile(new URL('../offscreen.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function engine(options = {}) {
  let listener;
  let node;
  const records = new Map();
  const events = [];
  let resumed = false;
  let closed = false;
  let trackStopped = false;
  let ended;
  const track = { readyState: 'live', stop() { trackStopped = true; }, addEventListener(type, fn) { if (type === 'ended') ended = fn; } };
  class Context {
    state = 'running'; sampleRate = 48000; destination = {};
    audioWorklet = { addModule: async () => { if (options.moduleFailure) throw new Error('module failed'); } };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() { resumed = true; }
    async close() { closed = true; this.state = 'closed'; }
    addEventListener() {}
  }
  class Worklet {
    constructor() {
      node = this;
      this.port = { postMessage: message => {
        if (message.type === 'stop') queueMicrotask(() => {
          if (options.finalChunk) this.emit(options.finalChunk);
          this.port.onmessage({ data: { type: 'stopped' } });
        });
      } };
    }
    emit(values) {
      const buffer = new Float32Array(values).buffer;
      this.port.onmessage({ data: { type: 'chunk', buffer, frames: values.length / 2, peaks: [0.2, 0.4] } });
    }
    connect() {} disconnect() {}
  }
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, crypto: webcrypto,
    AudioContext: Context, AudioWorkletNode: Worklet,
    navigator: { storage: { estimate: async () => ({ quota: 2 ** 32, usage: 0 }) }, mediaDevices: {
      getUserMedia: async () => {
        if (options.mediaFailure) throw new Error('capture denied');
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      },
    } },
    chrome: { runtime: { id: 'test', sendMessage: async message => events.push(message), onMessage: { addListener: fn => { listener = fn; } } } },
    URL: { createObjectURL: () => 'blob:test/file', revokeObjectURL() {} },
    recoverSessions: async () => [],
    createSession: async record => { records.set(record.id, { ...record }); },
    appendChunk: async (id, sequence, buffer) => {
      if (options.writeGate) await options.writeGate.promise;
      if (options.writeFailure) throw new Error('disk full');
      const record = records.get(id);
      record.bytes += buffer.byteLength;
      record.frames += buffer.byteLength / 8;
      return { ...record };
    },
    finishSession: async (id, status, error) => { Object.assign(records.get(id), { status, error }); },
    listSessions: async () => [...records.values()],
    getSession: async id => records.get(id),
    deleteSession: async id => records.delete(id),
    buildWavBlob: async () => { if (options.exportGate) await options.exportGate.promise; return {}; },
  };
  const testSource = options.maxBytes ? source.replace('const MAX_BYTES = 1024 ** 3;', `const MAX_BYTES = ${options.maxBytes};`) : source;
  vm.runInNewContext(testSource, sandbox);
  const call = (type, fields = {}) => new Promise(resolve => listener({ target: 'offscreen', type, ...fields }, { id: 'test' }, resolve));
  return { call, records, events, emit: samples => node.emit(samples), end: () => ended(), state: () => ({ resumed, closed, trackStopped }) };
}

test('stop waits for persisted full and final partial chunks before releasing the session', async () => {
  const gate = deferred();
  const env = engine({ writeGate: gate, finalChunk: [0.5, -0.5] });
  assert.equal((await env.call('START', { tabId: 1, title: 'test', streamId: 'stream' })).state.status, 'recording');
  env.emit([0.1, 0.2, 0.3, 0.4]);
  let finished = false;
  const stopping = env.call('STOP').then(result => { finished = true; return result; });
  await tick();
  assert.equal(finished, false);
  assert.equal((await env.call('STATE')).state.status, 'stopping');
  gate.resolve();
  assert.equal((await stopping).state.status, 'idle');
  const [record] = env.records.values();
  assert.equal(record.frames, 3);
  assert.equal(record.bytes, 24);
  assert.equal(record.status, 'complete');
  assert.deepEqual(env.state(), { resumed: true, closed: true, trackStopped: true });
});

test('write failure stops capture and marks the committed recording interrupted', async () => {
  const env = engine({ writeFailure: true });
  await env.call('START', { tabId: 1, title: 'test', streamId: 'stream' });
  env.emit([0.1, 0.2]);
  await tick(); await tick();
  const result = await env.call('STATE');
  assert.equal(result.state.status, 'idle');
  assert.match(result.state.warning, /disk full/);
  assert.equal([...env.records.values()][0].status, 'interrupted');
  assert.equal(env.state().trackStopped, true);
});

test('closing the source retains prior audio as an interrupted recording', async () => {
  const env = engine();
  await env.call('START', { tabId: 1, title: 'test', streamId: 'stream' });
  env.emit([0.1, 0.2]); await tick();
  env.end(); await tick();
  const [record] = env.records.values();
  assert.equal(record.frames, 1);
  assert.equal(record.status, 'interrupted');
  assert.match(record.error, /标签页/);
  assert.equal((await env.call('STATE')).state.status, 'idle');
});

test('setup failures restore the tab by releasing capture and expose a retryable error', async () => {
  const env = engine({ moduleFailure: true });
  const response = await env.call('START', { tabId: 1, title: 'test', streamId: 'stream' });
  assert.equal(response.ok, false);
  assert.equal((await env.call('STATE')).state.status, 'error');
  assert.equal(env.state().trackStopped, true);
  assert.equal(env.state().closed, true);
  assert.equal(env.records.size, 0);
});

test('export and capture cannot contend for the database write path', async () => {
  const gate = deferred();
  const env = engine({ exportGate: gate });
  env.records.set('old', { id: 'old', status: 'complete', title: 'Old', createdAt: Date.now() });
  const exporting = env.call('EXPORT', { id: 'old', format: 'float32' });
  await tick();
  assert.equal((await env.call('START', { tabId: 1, title: 'test' })).ok, false);
  gate.resolve();
  assert.equal((await exporting).ok, true);
  await env.call('START', { tabId: 1, title: 'test', streamId: 'stream' });
  assert.equal((await env.call('EXPORT', { id: 'old', format: 'pcm24' })).ok, false);
  await env.call('STOP');
});

test('the recording size guard saves accepted PCM and stops before exceeding the limit', async () => {
  const env = engine({ maxBytes: 16 });
  await env.call('START', { tabId: 1, title: 'test', streamId: 'stream' });
  env.emit([0.1, 0.2, 0.3, 0.4]);
  env.emit([0.5, 0.6]);
  await tick(); await tick();
  const result = await env.call('STATE');
  assert.equal(result.state.status, 'idle');
  assert.match(result.state.warning, /上限/);
  const [record] = env.records.values();
  assert.equal(record.bytes, 16);
  assert.equal(record.frames, 2);
  assert.equal(record.status, 'complete');
  assert.equal(env.state().closed, true);
});
