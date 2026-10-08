export const STATUS_LABELS = {
  idle: '准备就绪', starting: '正在连接', recording: '正在录音',
  stopping: '正在保存', error: '需要重试',
};

export function hasExtensionRuntime() {
  return Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.runtime?.sendMessage);
}

export async function request(type, fields = {}) {
  if (!hasExtensionRuntime()) throw new Error('请通过 Chrome 扩展程序打开 Tab Tape。');
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...fields });
  if (!response?.ok) throw new Error(response?.error || '暂时无法连接录音服务，请重新打开扩展程序。');
  return response;
}

export function duration(frames = 0, sampleRate = 48000) {
  const seconds = Math.max(0, Math.floor((Number(frames) || 0) / (Number(sampleRate) || 48000)));
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60];
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
  return parts.map(value => String(value).padStart(2, '0')).join(':');
}

export function bytes(value = 0) {
  const size = Math.max(0, Number(value) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

export function dateLabel(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(Number(timestamp)));
}

export function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function showNotice(node, text = '', kind = 'error') {
  if (node.textContent !== text) node.textContent = text;
  node.hidden = !text;
  node.dataset.kind = kind;
}

export function isCancellation(error) {
  return /cancel|取消|USER_CANCELED|USER_CANCELLED/i.test(error?.message || String(error));
}

export function updateMeter(node, peak = 0) {
  const amplitude = Math.max(0, Number(peak) || 0);
  const db = amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
  const level = Math.min(1, Math.max(0, (db + 60) / 60));
  node.style.setProperty('--level', String(level));
  node.setAttribute('aria-valuenow', String(Math.max(-60, Math.min(0, Math.round(db)))));
  node.setAttribute('aria-valuetext', Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : '静音');
  node.dataset.clip = String(amplitude > 1);
}

export function recordingCard(record, options = {}) {
  const { compact = false, active = false, exportBlocked = false, pending = false, format = 'float32', onFormat, onExport, onDelete } = options;
  const item = element('article', `recording-card${compact ? ' recording-card--compact' : ''}`);
  item.dataset.id = record.id;
  const info = element('div', 'take-info');
  const heading = element('div', 'take-heading');
  const title = element('h3', 'take-title', record.title || '未命名标签页');
  title.title = record.title || '未命名标签页';
  heading.append(title);
  const interrupted = record.status === 'interrupted';
  if (active || interrupted) {
    const badge = element('span', `take-badge ${active ? 'is-active' : 'is-interrupted'}`, active ? '录音中' : '已恢复片段');
    heading.append(badge);
  }
  const rate = record.sampleRate ? `${(record.sampleRate / 1000).toFixed(1).replace('.0', '')} kHz` : '';
  info.append(heading, element('p', 'take-meta', [dateLabel(record.createdAt), duration(record.frames, record.sampleRate), compact ? '' : rate, compact ? '' : bytes(record.bytes)].filter(Boolean).join(' · ')));
  if (interrupted && !compact) {
    info.append(element('p', 'take-recovery', '录音曾意外中断；已写入的音频仍可导出。'));
  }
  if (record.error && !compact) info.append(element('p', 'take-error', record.error));
  const actions = element('div', 'take-actions');
  if (!compact) {
    const select = element('select', 'format-select');
    select.setAttribute('aria-label', `“${record.title || '未命名标签页'}”的导出格式`);
    for (const [value, label] of [['float32', '32 位浮点'], ['pcm24', '24 位 PCM']]) {
      const option = element('option', '', label);
      option.value = value;
      select.append(option);
    }
    select.value = format;
    select.disabled = active || exportBlocked || pending || record.status === 'recording';
    select.addEventListener('change', () => onFormat?.(record.id, select.value));
    actions.append(select);
  }
  const download = element('button', compact ? 'button button--small' : 'button button--download', pending ? '处理中…' : compact ? '下载' : '下载 WAV');
  download.type = 'button';
  download.disabled = active || exportBlocked || pending || record.status === 'recording' || !record.frames;
  download.setAttribute('aria-label', `下载“${record.title || '未命名标签页'}”`);
  download.title = exportBlocked ? '停止录音后可下载' : record.frames ? '将本地音频导出为 WAV 文件' : '没有可导出的音频';
  download.addEventListener('click', () => onExport?.(record.id, compact ? 'float32' : (options.getFormat?.(record.id) || format)));
  actions.append(download);
  if (!compact) {
    const remove = element('button', 'button button--delete', '删除');
    remove.type = 'button';
    remove.disabled = active || exportBlocked || pending || record.status === 'recording';
    remove.setAttribute('aria-label', `删除“${record.title || '未命名标签页'}”`);
    remove.title = exportBlocked ? '停止录音后可删除' : '删除此条本地录音';
    remove.addEventListener('click', () => onDelete?.(record));
    actions.append(remove);
  }
  item.append(info, actions);
  return item;
}
