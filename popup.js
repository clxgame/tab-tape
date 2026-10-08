import { STATUS_LABELS, hasExtensionRuntime, request, duration, updateMeter, recordingCard, showNotice, isCancellation } from './lib/ui.js';

const $ = id => document.getElementById(id);
let state = { status: 'idle', frames: 0, sampleRate: 48000, peaks: [0, 0] };
let currentTab = null;
let recordings = [];
let busy = false;
let polling = false;
let lastListAt = 0;
let ready = false;
let actionVersion = 0;
let connectionError = '';
const pending = new Set();
const runtimeAvailable = hasExtensionRuntime();

function isActive() {
  return ['starting', 'recording', 'stopping'].includes(state.status);
}

function renderState() {
  const active = isActive();
  const sourceTitle = active ? state.title : currentTab?.title;
  $('source-title').textContent = sourceTitle || (runtimeAvailable ? '请在有声音的网页中打开扩展程序' : '请在 Chrome 扩展程序中打开');
  $('source-title').title = sourceTitle || '';
  $('status-pill').dataset.status = state.status;
  $('status-label').textContent = ready ? (STATUS_LABELS[state.status] || '准备就绪') : runtimeAvailable ? '正在连接' : '未连接';
  $('timer').textContent = duration(state.frames, state.sampleRate);
  updateMeter($('meter-left'), state.status === 'recording' ? state.peaks?.[0] : 0);
  updateMeter($('meter-right'), state.status === 'recording' ? state.peaks?.[1] : 0);
  $('record-button').dataset.recording = String(state.status === 'recording');
  $('record-button').disabled = !ready || busy || ['starting', 'stopping'].includes(state.status) || (!active && !currentTab?.id);
  $('record-button').setAttribute('aria-busy', String(busy || ['starting', 'stopping'].includes(state.status)));
  $('record-button-label').textContent = busy
    ? (state.status === 'recording' ? '正在保存录音…' : '正在连接音频…')
    : ({ starting: '正在连接音频…', recording: '停止并保存', stopping: '正在保存录音…' })[state.status] || '开始录音';
  $('capture-hint').textContent = active ? '关闭弹窗后仍会继续录音' : '仅录制当前标签页';
  showNotice($('state-notice'), state.error || state.warning || '', state.error ? 'error' : 'warning');
}

function renderRecordings() {
  const recent = recordings.slice(0, 1);
  $('recent-recordings').replaceChildren(...recent.map(record => recordingCard(record, {
    compact: true, active: record.id === state.id && isActive(), exportBlocked: isActive(), pending: pending.has(record.id), onExport: exportTake,
  })));
  $('recent-section').hidden = recent.length === 0;
}

async function readCurrentTab() {
  if (!runtimeAvailable) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0] || null;
  } catch (error) {
    showNotice($('action-notice'), error.message);
  }
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
    ready = true;
    if (connectionError && $('action-notice').textContent === connectionError) showNotice($('action-notice'));
    connectionError = '';
    if (result.recordings) {
      const different = JSON.stringify(recordings) !== JSON.stringify(result.recordings);
      recordings = result.recordings;
      lastListAt = Date.now();
      if (different || forceList) renderRecordings();
    }
    if (changed && !includeRecordings) lastListAt = 0;
    if (changed) renderRecordings();
    renderState();
  } catch (error) {
    ready = false;
    renderState();
    connectionError = error.message;
    showNotice($('action-notice'), error.message);
  } finally {
    polling = false;
  }
}

async function exportTake(id, format) {
  if (pending.has(id) || isActive()) return;
  pending.add(id);
  renderRecordings();
  showNotice($('action-notice'));
  try {
    await request('EXPORT', { id, format });
    showNotice($('action-notice'), '已交给浏览器下载，请在下载列表中查看。', 'success');
  } catch (error) {
    showNotice($('action-notice'), isCancellation(error) ? '已取消下载，录音仍保存在本地。' : error.message, isCancellation(error) ? 'info' : 'error');
  } finally {
    pending.delete(id);
    renderRecordings();
  }
}

$('record-button').addEventListener('click', async () => {
  if (busy || !ready) return;
  const stopping = state.status === 'recording';
  busy = true;
  actionVersion += 1;
  showNotice($('action-notice'));
  renderState();
  try {
    if (!stopping) await readCurrentTab();
    const result = await request(stopping ? 'STOP' : 'START', stopping ? {} : { tabId: currentTab?.id });
    state = result.state;
    lastListAt = 0;
    if (stopping) showNotice($('action-notice'), '录音已保存在本地，点击「下载」保存 WAV。', 'success');
  } catch (error) {
    showNotice($('action-notice'), error.message);
  } finally {
    busy = false;
    renderState();
    await refresh(true);
  }
});

$('open-library').addEventListener('click', async () => {
  if (!runtimeAvailable) return;
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('recordings.html') });
  } catch (error) {
    showNotice($('action-notice'), error.message);
  }
});

if (runtimeAvailable) {
  await readCurrentTab();
  renderState();
  await refresh(true);
  setInterval(() => { if (!busy) void refresh(); }, 300);
} else {
  $('open-library').disabled = true;
  showNotice($('action-notice'), '这是 Chrome 扩展程序界面。请在 chrome://extensions 加载 Tab Tape 文件夹，再从工具栏打开。', 'info');
  renderState();
}
