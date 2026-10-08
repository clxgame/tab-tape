import { createSession, appendChunk, finishSession, listSessions, getSession, deleteSession, recoverSessions, buildWavBlob } from '../lib/recordings.js';

const results = [];
function assert(condition, message) { if (!condition) throw new Error(message); }
async function rejects(fn, pattern) {
  try { await fn(); } catch (error) {
    assert(pattern.test(error.message), `Wrong rejection: ${error.message}`);
    return;
  }
  throw new Error('Expected rejection');
}
function equalSamples(actual, expected, label) {
  assert(actual.length === expected.length, `${label} length differs`);
  for (let i = 0; i < actual.length; i++) assert(actual[i] === expected[i], `${label} sample ${i}: ${actual[i]} ≠ ${expected[i]}`);
}
function nativeDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tab-tape', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function nativeWrite(db, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    action(tx.objectStore('chunks'));
  });
}

async function run() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Run on an isolated localhost test origin');
  const id = `test-${crypto.randomUUID()}`;
  const second = `${id}-second`;
  const third = `${id}-third`;
  let db;
  try {
    const empty = await createSession({ id, title: 'Native DB test', sampleRate: 48000, channels: 2, createdAt: 1 });
    assert(empty.frames === 0 && empty.bytes === 0 && empty.chunkCount === 0, 'Creation totals');
    await rejects(() => buildWavBlob(id), /停止/);
    const source = new Float32Array([0.5, -0.25, 1.25, -1.25]);
    const first = await appendChunk(id, 0, source.buffer);
    assert(first.frames === 2 && first.bytes === 16 && first.chunkCount === 1, 'Atomic append totals');
    await rejects(() => appendChunk(id, 0, source.buffer), /顺序/);
    await rejects(() => appendChunk(id, 2, source.buffer), /顺序/);
    await rejects(() => appendChunk(id, 1, new ArrayBuffer(4)), /完整/);
    assert((await getSession(id)).frames === 2, 'Rejected appends changed stored frames');
    results.push('ordered append and input validation');

    // Force a conflict after appendChunk has already enqueued its metadata write.
    // IndexedDB must roll the entire transaction back on the chunk constraint error.
    db = await nativeDatabase();
    await nativeWrite(db, store => store.add({ id, sequence: 1, buffer: new Float32Array([0, 0]).buffer }));
    await rejects(() => appendChunk(id, 1, source.buffer), /already|constraint|exists/i);
    const afterRollback = await getSession(id);
    assert(afterRollback.frames === 2 && afterRollback.bytes === 16 && afterRollback.chunkCount === 1, 'Failed chunk write did not roll back metadata');
    await nativeWrite(db, store => store.delete([id, 1]));
    results.push('transaction rollback after storage failure');

    const tail = new Float32Array([0, -1, 1, 2 ** -23]);
    await appendChunk(id, 1, tail.buffer);
    await finishSession(id, 'complete');
    await rejects(() => appendChunk(id, 2, source.buffer), /结束/);
    const float = await buildWavBlob(id);
    const floatBuffer = await float.arrayBuffer();
    const fv = new DataView(floatBuffer);
    assert(float.type === 'audio/wav' && float.size === 90, 'Float WAV size/type');
    assert(fv.getUint16(20, true) === 3 && fv.getUint32(46, true) === 4 && fv.getUint32(54, true) === 32, 'Float WAV headers');
    const decoded = Array.from({ length: 8 }, (_, i) => fv.getFloat32(58 + i * 4, true));
    equalSamples(decoded, [...source, ...tail], 'float');
    const pcmBuffer = await (await buildWavBlob(id, 'pcm24')).arrayBuffer();
    const pcm = new DataView(pcmBuffer);
    assert(pcm.byteLength === 68 && pcm.getUint16(20, true) === 1 && pcm.getUint32(40, true) === 24, 'PCM24 WAV headers');
    const integers = Array.from({ length: 8 }, (_, i) => {
      const offset = 44 + i * 3;
      const raw = pcm.getUint8(offset) | pcm.getUint8(offset + 1) << 8 | pcm.getUint8(offset + 2) << 16;
      return raw & 0x800000 ? raw - 0x1000000 : raw;
    });
    equalSamples(integers, [4194304, -2097152, 8388607, -8388608, 0, -8388608, 8388607, 1], 'PCM24');
    const decoder = new OfflineAudioContext(2, 4, 48000);
    const decodedFloat = await decoder.decodeAudioData(floatBuffer.slice(0));
    const decodedPCM = await decoder.decodeAudioData(pcmBuffer.slice(0));
    assert(decodedFloat.numberOfChannels === 2 && decodedFloat.length === 4 && decodedFloat.sampleRate === 48000, 'Browser decoder rejected float WAV layout');
    equalSamples([...decodedFloat.getChannelData(0)], [0.5, 1.25, 0, 1], 'decoded float left');
    equalSamples([...decodedFloat.getChannelData(1)], [-0.25, -1.25, -1, 2 ** -23], 'decoded float right');
    assert(decodedPCM.numberOfChannels === 2 && decodedPCM.length === 4, 'Browser decoder rejected PCM24 WAV layout');
    equalSamples([...decodedPCM.getChannelData(0)], [0.5, 8388607 / 8388608, 0, 8388607 / 8388608], 'decoded PCM24 left');
    results.push('multi-chunk WAV export preserves samples and clips PCM24');

    await createSession({ id: second, title: 'Interrupted', sampleRate: 44100, channels: 2, createdAt: 2 });
    await createSession({ id: third, title: 'Active', sampleRate: 44100, channels: 2, createdAt: 3 });
    await appendChunk(second, 0, source.buffer);
    await rejects(() => deleteSession(third), /停止/);
    const recovered = await recoverSessions(third);
    assert(recovered.some(session => session.id === second), 'Recovery omitted interrupted session');
    assert((await getSession(second)).status === 'interrupted', 'Recovery status');
    assert((await getSession(second)).frames === 2, 'Recovery lost committed frames');
    assert((await getSession(third)).status === 'recording', 'Recovery interrupted the active session');
    assert((await buildWavBlob(second)).size === 74, 'Interrupted audio is not exportable');
    const listed = (await listSessions()).filter(session => [id, second, third].includes(session.id));
    assert(listed.map(session => session.id).join(',') === [third, second, id].join(','), 'Newest-first listing');
    await finishSession(third, 'complete');
    await rejects(() => buildWavBlob(third), /没有音频/);
    results.push('recovery retains committed audio and protects active session');

    await deleteSession(id);
    assert(await getSession(id) === null, 'Delete left session metadata');
    const remainingChunks = await new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const request = tx.objectStore('chunks').index('sessionId').count(IDBKeyRange.only(id));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    assert(remainingChunks === 0, 'Delete left audio chunks');
    results.push('deletion removes metadata and all audio chunks');
  } finally {
    for (const key of [id, second, third]) {
      const session = await getSession(key);
      if (session?.status === 'recording') await finishSession(key, 'interrupted');
      await deleteSession(key);
    }
    db?.close();
  }
}

try {
  await run();
  window.storageTestResult = { ok: true, tests: results };
} catch (error) {
  window.storageTestResult = { ok: false, tests: results, error: error.stack || String(error) };
}
document.querySelector('#result').textContent = JSON.stringify(window.storageTestResult, null, 2);
