// The offscreen document owns the session. No recording state depends on this
// service worker staying awake, or on the popup staying open.
let creating;
let commands = Promise.resolve();
let exports = Promise.resolve();

async function ensureOffscreen() {
  if (creating) return creating;
  creating = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'BLOBS'],
        justification: 'Capture tab audio, persist PCM locally, and prepare WAV downloads after the popup closes.',
      });
    }
  })();
  try { await creating; } finally { creating = null; }
}

async function recorder(type, fields = {}) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...fields });
  if (!response?.ok) throw new Error(response?.error || '录音后台没有响应，请重新打开插件。');
  return response;
}

async function setBadge(state) {
  const text = state.status === 'recording' ? 'REC'
    : ['starting', 'stopping'].includes(state.status) ? '…'
      : state.status === 'error' ? '!' : '';
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color: state.status === 'error' ? '#b87524' : '#d54d50' }),
    chrome.action.setTitle({ title: state.status === 'recording' ? `正在录音 · ${state.title}` : 'Tab Tape · 标签页录音' }),
  ]);
}

async function dispatch(message) {
  switch (message.type) {
    case 'GET_STATE': {
      const result = await recorder('STATE', { includeRecordings: Boolean(message.includeRecordings) });
      await setBadge(result.state);
      return result;
    }
    case 'START': {
      if (!Number.isInteger(message.tabId)) throw new Error('请先打开要录音的网页，再点击插件图标。');
      const { state } = await recorder('STATE');
      if (['starting', 'recording', 'stopping'].includes(state.status)) throw new Error('已有录音进行中，请先停止。');
      const tab = await chrome.tabs.get(message.tabId);
      if (!/^https?:\/\//i.test(tab.url || '') || /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i.test(tab.url || '')) {
        throw new Error('此页面不能录音。请切换到普通网页（http 或 https），再点击插件图标。');
      }
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const result = await recorder('START', { streamId, tabId: tab.id, title: tab.title || '标签页录音' });
      await setBadge(result.state);
      return result;
    }
    case 'STOP': {
      const result = await recorder('STOP');
      await setBadge(result.state);
      return result;
    }
    case 'EXPORT': {
      const result = await recorder('EXPORT', { id: message.id, format: message.format });
      try {
        const downloadId = await chrome.downloads.download({
          url: result.url, filename: result.filename, saveAs: true, conflictAction: 'uniquify',
        });
        await chrome.storage.session.set({ [`download-${downloadId}`]: result.url });
        // A very small download can finish before the session mapping is written.
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (item && item.state !== 'in_progress') await releaseDownload(downloadId);
        return { ok: true, downloadId };
      } catch (error) {
        await recorder('RELEASE', { url: result.url }).catch(() => {});
        throw error;
      }
    }
    case 'DELETE': return recorder('DELETE', { id: message.id });
    default: throw new Error('不支持的操作。');
  }
}

async function releaseDownload(id) {
  const key = `download-${id}`;
  const values = await chrome.storage.session.get(key);
  if (values[key]) {
    await recorder('RELEASE', { url: values[key] });
    await chrome.storage.session.remove(key);
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (['complete', 'interrupted'].includes(delta.state?.current)) {
    void releaseDownload(delta.id).catch(console.error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'background') return;
  if (message.type === 'EVENT') {
    void setBadge(message.state).catch(console.error);
    return;
  }
  // Reads remain responsive during capture setup, flush, and WAV export.
  // The Save As dialog must never prevent an ongoing recording from stopping.
  const operation = message.type === 'GET_STATE' ? dispatch(message)
    : message.type === 'EXPORT' ? exports.then(() => dispatch(message))
      : commands.then(() => dispatch(message));
  if (message.type === 'EXPORT') exports = operation.catch(() => {});
  else if (message.type !== 'GET_STATE') commands = operation.catch(() => {});
  operation.then(sendResponse, (error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
