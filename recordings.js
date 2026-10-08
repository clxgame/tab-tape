import { STATUS_LABELS, hasExtensionRuntime, request, duration, bytes, recordingCard, showNotice, isCancellation } from './lib/ui.js';

const $ = id => document.getElementById(id);
let state = { status: 'idle', id: null };
let recordings = [];
let polling = false;
let lastListAt = 0;
let stopping = false;
let actionVersion = 0;
let connectionError = '';
const pending = new Set();
const formats = new Map();
const runtimeAvailable = hasExtensionRuntime();

function active() { return ['starting', 'recording', 'stopping'].includes(state.status); }

function renderState() {
  $('live-session').hidden = !active();
  $('live-title').textContent = state.title || '标签页音频';
  $('live-status').textContent = STATUS_LABELS[state.status] || '';
  $('live-timer').textContent = duration(state.frames, state.sampleRate);
  $('stop-recording').disabled = stopping || state.status !== 'recording';
  $('stop-recording').textContent = stopping || state.status === 'stopping' ? '正在保存…' : '停止并保存';
  showNotice($('state-notice'), state.error || state.warning || '', state.error ? 'error' : 'warning');
}

function renderRecordings() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const visible = recordings.filter(record => (record.title || '未命名标签页').toLocaleLowerCase().includes(query));
  const totalSize = bytes(recordings.reduce((sum, record) => sum + (Number(record.bytes) || 0), 0));
  $('visible-count').textContent = active() ? '停止录音后可下载' : query ? `${visible.length} / ${recordings.length} 段` : `${recordings.length} 段 · ${totalSize}`;
  const focused = document.activeElement;
  const focusedId = focused?.closest('.recording-card')?.dataset.id;
  const focusedClass = focused?.className;
  $('recordings-list').replaceChildren(...visible.map(record => recordingCard(record, {
    active: record.id === state.id && active(), exportBlocked: active(), pending: pending.has(record.id),
    format: formats.get(record.id) || 'float32', getFormat: id => formats.get(id),
    onFormat: (id, format) => formats.set(id, format), onExport: exportTake, onDelete: deleteTake,
  })));
  if (focusedId && focusedClass) {
    const card = Array.from($('recordings-list').children).find(node => node.dataset.id === focusedId);
    const replacement = card && Array.from(card.querySelectorAll('button, select')).find(node => node.className === focusedClass);
    replacement?.focus({ preventScroll: true });
  }
  $('library-empty').hidden = visible.length > 0;
  $('empty-title').textContent = query ? '没有匹配的录音' : '还没有录音';
  $('empty-copy').textContent = query ? '试试其他关键词。' : '播放网页声音，从工具栏打开 Tab Tape 开始录音。';
}

async function refresh(forceList = false) {
  if (polling || !runtimeAvailable) return;
  polling = true;
  const version = actionVersion;
  const includeRecordings = forceList || Date.now() - lastListAt >= 3000;
  try {
    const result = await request('GET_STATE', { includeRecordings });
    if (version !== actionVersion) return;
    const changed = result.state.status !== state.status || result.state.id !== state.id;
    state = result.state;
    if (connectionError && $('library-notice').textContent === connectionError) showNotice($('library-notice'));
    connectionError = '';
    if (result.recordings) {
      const different = JSON.stringify(recordings) !== JSON.stringify(result.recordings);
      recordings = result.recordings;
      lastListAt = Date.now();
      if (different || forceList) renderRecordings();
    }
    if (changed) {
      renderRecordings();
      if (!includeRecordings) lastListAt = 0;
    }
    renderState();
  } catch (error) {
    connectionError = error.message;
    showNotice($('library-notice'), error.message);
  } finally {
    polling = false;
  }
}

async function exportTake(id, format) {
  if (pending.has(id) || active()) return;
  pending.add(id);
  renderRecordings();
  showNotice($('library-notice'), '正在准备 WAV 文件…', 'info');
  try {
    await request('EXPORT', { id, format });
    showNotice($('library-notice'), '已交给浏览器下载。请在下载列表中查看文件。', 'success');
  } catch (error) {
    showNotice($('library-notice'), isCancellation(error) ? '已取消下载，录音仍保存在本地。' : error.message, isCancellation(error) ? 'info' : 'error');
  } finally {
    pending.delete(id);
    renderRecordings();
  }
}

async function deleteTake(record) {
  if (pending.has(record.id) || active()) return;
  if (!confirm(`删除“${record.title || '未命名标签页'}”？\n\n本地录音删除后无法恢复。已下载的 WAV 文件不受影响。`)) return;
  pending.add(record.id);
  actionVersion += 1;
  renderRecordings();
  try {
    await request('DELETE', { id: record.id });
    recordings = recordings.filter(item => item.id !== record.id);
    formats.delete(record.id);
    lastListAt = 0;
    showNotice($('library-notice'), '已删除本地录音。', 'success');
  } catch (error) {
    showNotice($('library-notice'), error.message);
  } finally {
    actionVersion += 1;
    pending.delete(record.id);
    renderRecordings();
    await refresh(true);
  }
}

$('stop-recording').addEventListener('click', async () => {
  if (stopping || state.status !== 'recording') return;
  stopping = true;
  actionVersion += 1;
  renderState();
  try {
    const result = await request('STOP');
    state = result.state;
    lastListAt = 0;
    showNotice($('library-notice'), '录音已保存，可选择格式并下载。', 'success');
  } catch (error) {
    showNotice($('library-notice'), error.message);
  } finally {
    stopping = false;
    renderState();
    await refresh(true);
  }
});

$('search').addEventListener('input', renderRecordings);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(true); });

if (runtimeAvailable) {
  await refresh(true);
  setInterval(() => { if (!document.hidden && !stopping) void refresh(); }, 300);
} else {
  $('search').disabled = true;
  showNotice($('library-notice'), '请在 chrome://extensions 加载 Tab Tape 文件夹，再从扩展程序的「录音库」打开。', 'info');
  renderRecordings();
}
