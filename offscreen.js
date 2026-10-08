import { createSession, appendChunk, finishSession, listSessions, getSession, deleteSession, recoverSessions, buildWavBlob } from './lib/recordings.js';

const MAX_BYTES = 1024 ** 3;
const MAX_PENDING_BYTES = 16 * 1024 ** 2;
const idle = () => ({ status: 'idle', id: null, tabId: null, title: '', sampleRate: 0, channels: 2, frames: 0, bytes: 0, peaks: [0, 0], error: null, warning: null });
let state = idle();
let session;
let stopping;
let exporting = false;
const exportUrls = new Set();
const ready = recoverSessions();
// A rejected storage initialization is surfaced through the UI, not left unhandled.
ready.catch(console.error);

function publish() {
  void chrome.runtime.sendMessage({ target: 'background', type: 'EVENT', state: { ...state } }).catch(() => {});
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function cleanup(current) {
  clearInterval(current.timer);
  current.source?.disconnect();
  current.node?.disconnect();
  current.stream?.getTracks().forEach(track => track.stop());
  if (current.context && current.context.state !== 'closed') await current.context.close().catch(() => {});
}

async function start(message) {
  if (session || stopping) throw new Error('已有录音进行中。');
  if (exporting) throw new Error('正在准备 WAV 文件，请等待下载开始后再录音。');
  state = { ...idle(), status: 'starting', tabId: message.tabId, title: message.title };
  publish();
  const current = { id: crypto.randomUUID(), sequence: 0, receivedBytes: 0, pendingBytes: 0, writes: Promise.resolve(), writeError: null, stopAck: null, created: false };
  session = current;
  try {
    const estimate = await navigator.storage.estimate();
    if (estimate.quota && estimate.quota - (estimate.usage || 0) < 32 * 1024 ** 2) throw new Error('本机录音存储空间不足，请下载并删除部分旧录音。');
    current.stream = await navigator.mediaDevices.getUserMedia({
      // Chromium's tab stream ID uses legacy constraints. Mixing these with
      // top-level modern constraints makes getUserMedia reject the whole request.
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId, echoCancellation: false } },
      video: false,
    });
    current.context = new AudioContext();
    current.source = current.context.createMediaStreamSource(current.stream);
    // tabCapture redirects playback: restore it once, without recording this output.
    current.source.connect(current.context.destination);
    await current.context.audioWorklet.addModule('audio/pcm-worklet.js');
    current.node = new AudioWorkletNode(current.context, 'pcm-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
    });
    await createSession({ id: current.id, title: message.title, createdAt: Date.now(), sampleRate: current.context.sampleRate, channels: 2, status: 'recording', frames: 0, bytes: 0 });
    current.created = true;
    current.node.port.onmessage = ({ data }) => {
      if (data.type === 'stopped') { current.stopAck?.(); return; }
      if (data.type !== 'chunk' || session !== current || current.writeError) return;
      if (current.receivedBytes + data.buffer.byteLength > MAX_BYTES) {
        void stop('complete', '已达到单次 1 GiB 上限，录音已自动保存。');
        return;
      }
      if (current.pendingBytes + data.buffer.byteLength > MAX_PENDING_BYTES) {
        current.writeError = new Error('磁盘写入跟不上录音，已停止并保留成功写入的片段。');
        void stop('interrupted', current.writeError.message);
        return;
      }
      const sequence = current.sequence++;
      const size = data.buffer.byteLength;
      current.receivedBytes += size;
      current.pendingBytes += size;
      state.peaks = data.peaks;
      current.lastChunkAt = Date.now();
      current.writes = current.writes.then(async () => {
        if (current.writeError) return;
        const meta = await appendChunk(current.id, sequence, data.buffer);
        state.frames = meta.frames;
        state.bytes = meta.bytes;
      }).catch((error) => {
        current.writeError = new Error(`录音写入失败：${error.message}。已保存的片段仍可导出。`);
        void stop('interrupted', current.writeError.message);
      }).finally(() => { current.pendingBytes -= size; });
    };
    current.node.onprocessorerror = () => {
      current.processorFailed = true;
      if (state.status === 'recording') void stop('interrupted', '音频处理器意外停止，已保留成功写入的片段。');
    };
    current.source.connect(current.node);
    current.node.connect(current.context.destination);
    await withTimeout(current.context.resume(), 5000, '浏览器未能启动音频，请先播放网页声音后重试。');
    if (current.processorFailed) throw new Error('音频处理器未能启动，请重新加载扩展后重试。');
    if (current.stream.getAudioTracks().every(track => track.readyState !== 'live')) throw new Error('目标标签页已停止提供音频。');
    state = { ...state, status: 'recording', id: current.id, sampleRate: current.context.sampleRate };
    current.node.port.postMessage({ type: 'start' });
    current.stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { void stop('interrupted', '目标标签页已关闭或停止共享，已保存录到的片段。'); }, { once: true }));
    current.context.addEventListener('statechange', () => {
      if (state.status === 'recording' && current.context.state !== 'running') void stop('interrupted', '音频设备或浏览器中断了录音，已保存录到的片段。');
    });
    current.timer = setInterval(() => {
      if (Date.now() - (current.lastChunkAt || 0) > 1000) state.peaks = [0, 0];
      publish();
    }, 1000);
    publish();
  } catch (error) {
    await cleanup(current);
    if (current.created) await finishSession(current.id, 'interrupted', error.message).catch(console.error);
    session = null;
    state = { ...idle(), status: 'error', error: error.message || String(error) };
    publish();
    throw error;
  }
}

async function finish(current, status, reason) {
  state.status = 'stopping';
  publish();
  let warning = reason;
  try {
    if (current.node) {
      try {
        const ack = new Promise(resolve => { current.stopAck = resolve; });
        current.node.port.postMessage({ type: 'stop' });
        await withTimeout(ack, 2000, '音频处理器未能完成最后一段，已保存此前的片段。');
      } catch (error) { status = 'interrupted'; warning = error.message; }
    }
    await cleanup(current);
    await current.writes;
    if (current.writeError) { status = 'interrupted'; warning = current.writeError.message; }
    if (current.created) await finishSession(current.id, status, warning || undefined);
    state = { ...idle(), warning: warning || null };
  } catch (error) {
    state = { ...idle(), status: 'error', error: `保存录音状态失败：${error.message}。重新打开浏览器后可尝试恢复已写入片段。` };
  } finally {
    session = null;
    publish();
  }
}

function stop(status = 'complete', reason = null) {
  if (stopping) return stopping;
  if (!session) return Promise.resolve();
  stopping = finish(session, status, reason).finally(() => { stopping = null; });
  return stopping;
}

function filename(meta, format) {
  const title = (meta.title || '标签页录音').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 70) || '录音';
  const stamp = new Date(meta.createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `Tab Tape/${title}_${stamp}_${format === 'pcm24' ? '24bit' : '32float'}.wav`;
}

async function handle(message) {
  await ready;
  switch (message.type) {
    case 'STATE': return { state: { ...state }, ...(message.includeRecordings ? { recordings: await listSessions() } : {}) };
    case 'START': await start(message); return { state: { ...state } };
    case 'STOP': await stop(); return { state: { ...state } };
    case 'EXPORT': {
      if (session || stopping) throw new Error('请先停止录音再下载，以免导出占用磁盘影响录音。');
      if (exporting) throw new Error('正在准备另一个 WAV 文件，请稍候。');
      if (!['float32', 'pcm24'].includes(message.format)) throw new Error('不支持的音频格式。');
      exporting = true;
      try {
        const meta = await getSession(message.id);
        if (!meta) throw new Error('找不到这段录音。');
        const blob = await buildWavBlob(message.id, message.format);
        const url = URL.createObjectURL(blob);
        exportUrls.add(url);
        return { url, filename: filename(meta, message.format) };
      } finally { exporting = false; }
    }
    case 'RELEASE': {
      if (exportUrls.has(message.url)) { URL.revokeObjectURL(message.url); exportUrls.delete(message.url); }
      return {};
    }
    case 'DELETE': {
      if (session || stopping) throw new Error('请先停止录音再删除，以免删除占用磁盘影响录音。');
      await deleteSession(message.id);
      return {};
    }
    default: throw new Error('不支持的录音命令。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen') return;
  handle(message).then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
