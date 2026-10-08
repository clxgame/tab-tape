import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function eventually(predicate, message) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

function harness(options = {}) {
  const calls = { capture: [], recorder: [], create: [], contexts: [], badge: [], titles: [], downloads: [], releases: [], errors: [] };
  let listener;
  let downloadChanged;
  let exists = false;
  let state = { status: 'idle', title: '' };
  const sessionStorage = {};
  let downloadId = 10;
  const tabs = new Map([[1, { id: 1, title: 'Tone fixture', url: 'http://localhost:8080/tone' }], [2, { id: 2, title: 'Other fixture', url: 'https://example.com/audio' }]]);
  const chrome = {
    runtime: {
      id: 'test-extension',
      getURL: path => `chrome-extension://test-extension/${path}`,
      getContexts: async query => {
        calls.contexts.push(query);
        return exists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [];
      },
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async message => {
        assert.equal(message.target, 'offscreen');
        calls.recorder.push(structuredClone(message));
        switch (message.type) {
          case 'STATE': return { ok: true, state: { ...state }, ...(message.includeRecordings ? { recordings: [] } : {}) };
          case 'START':
            state = { status: 'starting', title: message.title };
            await options.startGate?.promise;
            state = { status: 'recording', title: message.title, tabId: message.tabId };
            return { ok: true, state: { ...state } };
          case 'STOP':
            state = { status: 'idle', title: '' };
            return { ok: true, state: { ...state } };
          case 'EXPORT':
            if (['starting', 'recording', 'stopping'].includes(state.status)) return { ok: false, error: '请先停止录音' };
            return { ok: true, url: `blob:chrome-extension://test-extension/${message.id}`, filename: 'Tab Tape/test.wav' };
          case 'RELEASE':
            calls.releases.push(message.url);
            return { ok: true };
          case 'DELETE': return { ok: true };
          default: throw new Error(`Unexpected recorder command ${message.type}`);
        }
      },
    },
    offscreen: {
      createDocument: async details => {
        calls.create.push(details);
        await options.createGate?.promise;
        assert.equal(exists, false, 'A second offscreen document must never be created');
        exists = true;
      },
    },
    action: {
      setBadgeText: async value => { calls.badge.push(value.text); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async value => { calls.titles.push(value.title); },
    },
    tabs: {
      get: async id => {
        if (!tabs.has(id)) throw new Error('No tab with id');
        return tabs.get(id);
      },
    },
    tabCapture: {
      getMediaStreamId: async details => {
        calls.capture.push(details);
        return `stream-${details.targetTabId}`;
      },
    },
    downloads: {
      onChanged: { addListener: fn => { downloadChanged = fn; } },
      download: async details => {
        calls.downloads.push(details);
        await options.downloadGate?.promise;
        return downloadId++;
      },
      search: async ({ id }) => [{ id, state: options.downloadState || 'in_progress' }],
    },
    storage: {
      session: {
        set: async entries => { Object.assign(sessionStorage, entries); },
        get: async key => ({ [key]: sessionStorage[key] }),
        remove: async key => { delete sessionStorage[key]; },
      },
    },
  };
  vm.runInNewContext(source, { chrome, console: { error: error => calls.errors.push(error) } });
  return {
    calls,
    tabs,
    sessionStorage,
    send(message, sender = { id: 'test-extension' }) {
      return new Promise(resolve => {
        const keepChannel = listener({ target: 'background', ...message }, sender, resolve);
        if (keepChannel !== true) resolve({ ignored: true });
      });
    },
    downloadChanged: delta => downloadChanged(delta),
  };
}

test('simultaneous START requests capture once, while state reads remain responsive during setup', async () => {
  const startGate = deferred();
  const h = harness({ startGate });
  let started = false;
  const first = h.send({ type: 'START', tabId: 1 }).then(result => { started = true; return result; });
  const second = h.send({ type: 'START', tabId: 2 });
  await eventually(() => h.calls.recorder.some(call => call.type === 'START'), 'Capture setup did not begin');
  let stateResult;
  const read = h.send({ type: 'GET_STATE', includeRecordings: true }).then(result => { stateResult = result; });
  await eventually(() => stateResult, 'GET_STATE was blocked behind capture setup');
  assert.equal(stateResult.state.status, 'starting');
  assert.ok(Array.isArray(stateResult.recordings));
  assert.equal(started, false, 'Setup should still be waiting');
  assert.equal(h.calls.capture.length, 1);
  startGate.resolve();
  assert.equal((await first).state.status, 'recording');
  const duplicate = await second;
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /已有录音/);
  assert.equal(h.calls.capture.length, 1, 'Duplicate start captured a second tab');
  assert.equal(h.calls.recorder.filter(call => call.type === 'START').length, 1);
  await read;
  assert.equal((await h.send({ type: 'STOP' })).state.status, 'idle');
});

test('offscreen setup is shared by concurrent clients and existing document is reused', async () => {
  const createGate = deferred();
  const h = harness({ createGate });
  const first = h.send({ type: 'GET_STATE' });
  const second = h.send({ type: 'GET_STATE' });
  await eventually(() => h.calls.create.length === 1, 'Offscreen creation did not begin');
  assert.equal(h.calls.contexts.length, 1);
  createGate.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal((await h.send({ type: 'GET_STATE' })).ok, true);
  assert.equal(h.calls.create.length, 1);
  assert.deepEqual([...h.calls.create[0].reasons], ['USER_MEDIA', 'BLOBS']);
});

test('invalid tab ids and restricted pages cannot request audio capture', async () => {
  const h = harness();
  for (const tabId of [undefined, '1', NaN, 1.5, -9]) {
    const result = await h.send({ type: 'START', tabId });
    assert.equal(result.ok, false, `Accepted invalid tab ${tabId}`);
  }
  const restricted = [
    'chrome://settings/',
    'chrome-extension://another/options.html',
    'file:///tmp/sound.html',
    'about:blank',
    'data:text/html,test',
    'https://chromewebstore.google.com/detail/example',
    'https://chrome.google.com/webstore/category/extensions',
  ];
  for (const [i, url] of restricted.entries()) {
    const tabId = 30 + i;
    h.tabs.set(tabId, { id: tabId, title: 'Restricted', url });
    const result = await h.send({ type: 'START', tabId });
    assert.equal(result.ok, false, `Accepted restricted page ${url}`);
    assert.match(result.error, /不能录音/);
  }
  assert.equal(h.calls.capture.length, 0);
  assert.equal((await h.send({ type: 'START', tabId: 1 })).ok, true, 'Earlier rejected commands poisoned the command queue');
});

test('Save As waiting does not block starting or stopping a subsequent recording', async () => {
  const downloadGate = deferred();
  const h = harness({ downloadGate });
  let exported = false;
  const exporting = h.send({ type: 'EXPORT', id: 'older-take', format: 'float32' }).then(result => { exported = true; return result; });
  await eventually(() => h.calls.downloads.length === 1, 'Save As did not open');
  assert.equal(h.calls.downloads[0].saveAs, true);
  const start = h.send({ type: 'START', tabId: 1 });
  let stopResult;
  const stop = h.send({ type: 'STOP' }).then(result => { stopResult = result; });
  await eventually(() => stopResult, 'STOP was blocked by the pending Save As dialog');
  assert.equal((await start).state.status, 'recording');
  assert.equal(stopResult.state.status, 'idle');
  assert.equal(exported, false);
  downloadGate.resolve();
  assert.equal((await exporting).downloadId, 10);
  await stop;
});

test('completed and interrupted downloads release Blob URLs and session bookkeeping', async () => {
  for (const state of ['complete', 'interrupted']) {
    const h = harness();
    const result = await h.send({ type: 'EXPORT', id: state, format: 'pcm24' });
    assert.equal(result.ok, true);
    const key = `download-${result.downloadId}`;
    const url = h.sessionStorage[key];
    assert.ok(url, 'Pending download has no recovery mapping');
    h.downloadChanged({ id: result.downloadId, state: { current: state } });
    await eventually(() => h.calls.releases.includes(url) && !(key in h.sessionStorage), `${state} download did not clean up`);
    assert.deepEqual(h.calls.errors, []);
    h.downloadChanged({ id: result.downloadId, state: { current: state } });
    await tick();
    assert.equal(h.calls.releases.length, 1, 'Duplicate completion released an already removed URL');
  }
});

test('canceling Save As releases its prepared Blob without leaving a download mapping', async () => {
  const downloadGate = deferred();
  const h = harness({ downloadGate });
  const result = h.send({ type: 'EXPORT', id: 'cancelled', format: 'float32' });
  await eventually(() => h.calls.downloads.length === 1, 'Save As did not open');
  downloadGate.reject(new Error('User canceled download'));
  const canceled = await result;
  assert.equal(canceled.ok, false);
  assert.match(canceled.error, /canceled/);
  assert.deepEqual(h.calls.releases, ['blob:chrome-extension://test-extension/cancelled']);
  assert.deepEqual(h.sessionStorage, {});
});

test('downloads that finish before bookkeeping still release their Blob URL', async () => {
  const h = harness({ downloadState: 'complete' });
  const result = await h.send({ type: 'EXPORT', id: 'tiny', format: 'float32' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.releases, ['blob:chrome-extension://test-extension/tiny']);
  assert.deepEqual(h.sessionStorage, {});
});

test('unrelated senders and targets cannot trigger commands or badge events', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'START', tabId: 1 }, { id: 'other-extension' })).ignored, true);
  assert.equal((await h.send({ type: 'EVENT', state: { status: 'recording', title: 'Forged' } }, {})).ignored, true);
  assert.equal((await h.send({ target: 'offscreen', type: 'EVENT', state: { status: 'recording', title: 'Wrong target' } })).ignored, true);
  assert.equal(h.calls.contexts.length, 0);
  assert.equal(h.calls.capture.length, 0);
  assert.deepEqual(h.calls.badge, []);
  assert.equal((await h.send({ type: 'EVENT', state: { status: 'recording', title: 'Trusted title' } })).ignored, true);
  await tick();
  assert.deepEqual(h.calls.badge, ['REC']);
  assert.match(h.calls.titles[0], /Trusted title/);
});
