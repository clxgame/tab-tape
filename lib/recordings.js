import { encodePCM24, makeWavHeader, wavLayout } from './wav.js';

const DB_NAME = 'tab-tape';
const DB_VERSION = 1;
let databasePromise;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('createdAt', 'createdAt');
      const chunks = db.createObjectStore('chunks', { keyPath: ['id', 'sequence'] });
      chunks.createIndex('sessionId', 'id');
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => {
        db.close();
        databasePromise = undefined;
      };
      resolve(db);
    };
    request.onerror = () => { databasePromise = undefined; reject(request.error); };
    request.onblocked = () => { blocked = true; databasePromise = undefined; reject(new Error('录音数据库被其他窗口占用，请关闭其他录音窗口后重试')); };
  });
  return databasePromise;
}

function transact(db, stores, mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let result;
    let failure;
    const fail = error => {
      failure = error;
      transaction.abort();
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure || transaction.error || new Error('录音数据库操作已中断'));
    transaction.onerror = () => {}; // The abort event carries the final failure.
    try { run(transaction, value => { result = value; }, fail); }
    catch (error) { fail(error); }
  });
}

function withSession(transaction, id, callback, fail) {
  const store = transaction.objectStore('sessions');
  const request = store.get(id);
  request.onsuccess = () => {
    try {
      if (!request.result) throw new Error('找不到这段录音');
      callback(request.result, store);
    } catch (error) { fail(error); }
  };
}

export async function createSession(metadata) {
  if (!metadata || typeof metadata.id !== 'string' || !metadata.id) throw new Error('无效的录音 ID');
  if (metadata.channels !== 2) throw new Error('录音需要立体声双通道');
  wavLayout({ sampleRate: metadata.sampleRate, channels: 2, frames: 0 });
  const session = {
    id: metadata.id,
    title: String(metadata.title || '标签页录音'),
    createdAt: Number.isFinite(metadata.createdAt) ? metadata.createdAt : Date.now(),
    sampleRate: metadata.sampleRate,
    channels: 2,
    status: 'recording',
    frames: 0,
    bytes: 0,
    chunkCount: 0,
  };
  return transact(await openDatabase(), ['sessions'], 'readwrite', (tx, done) => {
    tx.objectStore('sessions').add(session);
    done(session);
  });
}

export async function appendChunk(id, sequence, buffer) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('无效的音频块序号');
  if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength % 8 !== 0) {
    throw new Error('音频块必须是完整的 Float32 立体声采样帧');
  }
  return transact(await openDatabase(), ['sessions', 'chunks'], 'readwrite', (tx, done, fail) => {
    withSession(tx, id, (session, sessions) => {
      if (session.status !== 'recording') throw new Error('这段录音已经结束');
      if (sequence !== session.chunkCount) throw new Error('音频块顺序不连续，录音已停止以保护现有数据');
      const updated = { ...session, frames: session.frames + buffer.byteLength / 8, bytes: session.bytes + buffer.byteLength, chunkCount: session.chunkCount + 1 };
      wavLayout({ ...updated, format: 'float32' });
      tx.objectStore('chunks').add({ id, sequence, buffer });
      sessions.put(updated);
      done(updated);
    }, fail);
  });
}

export async function finishSession(id, status, error) {
  if (!['complete', 'interrupted'].includes(status)) throw new Error('无效的录音完成状态');
  return transact(await openDatabase(), ['sessions'], 'readwrite', (tx, done, fail) => {
    withSession(tx, id, (session, store) => {
      const updated = { ...session, status };
      if (error) updated.error = String(error);
      else delete updated.error;
      store.put(updated);
      done(updated);
    }, fail);
  });
}

export async function listSessions() {
  return transact(await openDatabase(), ['sessions'], 'readonly', (tx, done) => {
    const request = tx.objectStore('sessions').getAll();
    request.onsuccess = () => done(request.result.sort((a, b) => b.createdAt - a.createdAt));
  });
}

export async function getSession(id) {
  return transact(await openDatabase(), ['sessions'], 'readonly', (tx, done) => {
    const request = tx.objectStore('sessions').get(id);
    request.onsuccess = () => done(request.result || null);
  });
}

export async function deleteSession(id) {
  return transact(await openDatabase(), ['sessions', 'chunks'], 'readwrite', (tx, done, fail) => {
    const sessions = tx.objectStore('sessions');
    const request = sessions.get(id);
    request.onsuccess = () => {
      if (request.result?.status === 'recording') { fail(new Error('请先停止录音再删除')); return; }
      sessions.delete(id);
      const cursorRequest = tx.objectStore('chunks').index('sessionId').openCursor(IDBKeyRange.only(id));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      done();
    };
  });
}

export async function recoverSessions(activeId = null) {
  return transact(await openDatabase(), ['sessions'], 'readwrite', (tx, done) => {
    const recovered = [];
    const request = tx.objectStore('sessions').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { done(recovered); return; }
      const session = cursor.value;
      if (session.status === 'recording' && session.id !== activeId) {
        const updated = { ...session, status: 'interrupted', error: '录音意外中断；已保留成功保存的音频' };
        cursor.update(updated);
        recovered.push(updated);
      }
      cursor.continue();
    };
  });
}

export async function buildWavBlob(id, format = 'float32') {
  // The read transaction also prevents deletion of this recording during export.
  // Blob parts avoid flattening a whole recording into a second large ArrayBuffer.
  return transact(await openDatabase(), ['sessions', 'chunks'], 'readonly', (tx, done, fail) => {
    withSession(tx, id, session => {
      if (session.status === 'recording') throw new Error('请先停止录音再导出');
      if (!session.frames) throw new Error('这段录音还没有音频数据');
      const options = { ...session, format };
      const layout = wavLayout(options);
      const parts = [new Blob([makeWavHeader(options)])];
      let nextSequence = 0;
      let bytes = 0;
      const request = tx.objectStore('chunks').index('sessionId').openCursor(IDBKeyRange.only(id));
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) {
            if (bytes !== session.bytes || bytes !== session.frames * 8 || nextSequence !== session.chunkCount) {
              throw new Error('录音数据不完整，无法导出');
            }
            if (layout.paddingBytes) parts.push(new Uint8Array(layout.paddingBytes));
            done(new Blob(parts, { type: 'audio/wav' }));
            return;
          }
          const { sequence, buffer } = cursor.value;
          if (sequence !== nextSequence++ || !(buffer instanceof ArrayBuffer) || buffer.byteLength % 8 !== 0) {
            throw new Error('录音数据块损坏，无法导出');
          }
          bytes += buffer.byteLength;
          parts.push(new Blob([format === 'pcm24' ? encodePCM24(buffer) : buffer]));
          cursor.continue();
        } catch (error) { fail(error); }
      };
    }, fail);
  });
}
