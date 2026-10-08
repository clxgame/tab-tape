// Optional real-browser integration test. Uses a disposable profile only.
// PLAYWRIGHT_PATH may be a package directory or its index.mjs file.
// CHROME_PATH overrides the installed Chrome executable; no browser is downloaded.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = process.env.PLAYWRIGHT_PATH || resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(modulePath.endsWith('.mjs') ? modulePath : resolve(modulePath, 'index.mjs')).href);
const profile = await mkdtemp(resolve(tmpdir(), 'tab-tape-test-'));
const artifacts = resolve(profile, 'artifacts');
await mkdir(artifacts);
const result = { profile, artifacts, checks: [], errors: [] };
let context;
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw new Error('Not found');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
    response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise, label, ms = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}
function record(label, value = true) {
  result.checks.push({ label, value });
  console.log(JSON.stringify({ label, value }));
}
async function message(page, type, fields = {}, target = 'background') {
  const response = await within(page.evaluate(message => chrome.runtime.sendMessage(message), { target, type, ...fields }), type);
  assert.equal(response?.ok, true, `${type}: ${response?.error}`);
  return response;
}
async function until(probe, predicate, label, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (predicate(value)) return value;
    await pause(200);
  }
  throw new Error(`${label} timed out`);
}

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    viewport: { width: 1200, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: ['--enable-unsafe-extension-debugging'],
    timeout: 20_000,
  });
  context.setDefaultTimeout(10_000);
  context.on('page', page => page.on('pageerror', error => result.errors.push(error.message)));
  const cdp = await context.browser().newBrowserCDPSession();
  record('browser', await cdp.send('Browser.getVersion'));

  const storage = await context.newPage();
  await storage.goto(`${origin}/tests/storage-browser.html`);
  await storage.waitForFunction(() => window.storageTestResult, { timeout: 10_000 });
  const storageResult = await storage.evaluate(() => window.storageTestResult);
  assert.equal(storageResult.ok, true, storageResult.error);
  record('native IndexedDB and browser WAV decode', storageResult);
  await storage.close();

  const extension = await cdp.send('Extensions.loadUnpacked', { path: root, enableInIncognito: false });
  record('extension loaded', extension.id);
  const extensionOrigin = `chrome-extension://${extension.id}`;
  const library = await context.newPage();
  await library.goto(`${extensionOrigin}/recordings.html`);
  await message(library, 'GET_STATE', { includeRecordings: true });
  await library.screenshot({ path: resolve(artifacts, 'library-empty.png'), fullPage: true });

  const tone = await context.newPage();
  await tone.goto(`${origin}/tests/tone.html`);
  await tone.locator('#start').click();
  await tone.waitForFunction(() => window.toneFixture?.state.playing);
  record('test tone', await tone.evaluate(() => window.toneFixture.state));
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const targetInfo = targetInfos.find(target => target.url === tone.url());
  assert.ok(targetInfo, 'Missing browser tab target for audio fixture');
  await cdp.send('Extensions.triggerAction', { id: extension.id, targetId: targetInfo.targetId });
  record('toolbar action invoked');

  const toneTab = await library.evaluate(async url => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => tab.url === url);
  }, tone.url());
  assert.ok(toneTab?.id, 'Action did not grant access to source tab');
  await message(library, 'START', { tabId: toneTab.id });
  let current = await until(() => message(library, 'GET_STATE'), x => x.state.status === 'recording' && x.state.frames > 20_000 && x.state.peaks.every(peak => peak > 0.1), 'capture with audible input');
  assert.ok(current.state.peaks.every(peak => peak > 0.20 && peak < 0.30), `Unexpected peaks ${current.state.peaks}`);
  record('real tab capture', current.state);

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 340, height: 600 });
  await popup.goto(`${extensionOrigin}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('#status-pill').dataset.status === 'recording');
  assert.equal(await popup.locator('#record-button').isEnabled(), true);
  await popup.locator('.recorder').screenshot({ path: resolve(artifacts, 'popup-recording.png'), animations: 'disabled' });
  record('popup dimensions', await popup.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })));
  await popup.close();
  const previousFrames = current.state.frames;
  current = await until(() => message(library, 'GET_STATE'), x => x.state.frames > previousFrames + x.state.sampleRate, 'recording after popup closure');
  record('capture survives popup closure', current.state.frames);
  await library.screenshot({ path: resolve(artifacts, 'library-recording.png'), fullPage: true });
  await message(library, 'STOP');
  const finished = await message(library, 'GET_STATE', { includeRecordings: true });
  const take = finished.recordings[0];
  assert.equal(take.status, 'complete');
  assert.ok(take.frames > take.sampleRate);
  record('completed recording', take);

  for (const format of ['float32', 'pcm24']) {
    const exported = await message(library, 'EXPORT', { id: take.id, format }, 'offscreen');
    const audio = await library.evaluate(async ({ url, format, sampleRate }) => {
      const buffer = await (await fetch(url)).arrayBuffer();
      const byteLength = buffer.byteLength;
      const rawSampleRate = new DataView(buffer).getUint32(24, true);
      const context = new OfflineAudioContext(2, 1, sampleRate);
      const audio = await context.decodeAudioData(buffer);
      const frames = Math.min(8192, audio.length);
      const start = Math.floor((audio.length - frames) / 2);
      const channels = [0, 1].map(channel => {
        const samples = audio.getChannelData(channel).subarray(start, start + frames);
        const amplitude = frequency => {
          let real = 0, imaginary = 0;
          for (let i = 0; i < samples.length; i++) {
            const phase = 2 * Math.PI * frequency * i / audio.sampleRate;
            real += samples[i] * Math.cos(phase);
            imaginary += samples[i] * Math.sin(phase);
          }
          return 2 * Math.hypot(real, imaginary) / samples.length;
        };
        return { at440: amplitude(440), at880: amplitude(880), peak: Math.max(...samples.map(Math.abs)) };
      });
      return { format, bytes: byteLength, rawSampleRate, sampleRate: audio.sampleRate, frames: audio.length, channelCount: audio.numberOfChannels, channels };
    }, { url: exported.url, format, sampleRate: take.sampleRate });
    assert.equal(audio.channelCount, 2);
    assert.equal(audio.rawSampleRate, take.sampleRate);
    assert.equal(audio.frames, take.frames);
    assert.equal(audio.bytes, take.frames * (format === 'float32' ? 8 : 6) + (format === 'float32' ? 58 : 44));
    assert.ok(audio.channels[0].at440 > 0.20 && audio.channels[0].at880 < 0.02, 'Left channel spectrum');
    assert.ok(audio.channels[1].at880 > 0.20 && audio.channels[1].at440 < 0.02, 'Right channel spectrum');
    await message(library, 'RELEASE', { url: exported.url }, 'offscreen');
    record(`WAV spectrum ${format}`, audio);
  }

  await library.reload();
  await library.locator('#recordings-list .recording-card').first().waitFor();
  await library.screenshot({ path: resolve(artifacts, 'library-complete.png'), fullPage: true });
  const completePopup = await context.newPage();
  await completePopup.setViewportSize({ width: 340, height: 600 });
  await completePopup.goto(`${extensionOrigin}/popup.html`);
  await completePopup.locator('#recent-recordings .recording-card').first().waitFor();
  await completePopup.locator('.recorder').screenshot({ path: resolve(artifacts, 'popup-complete.png'), animations: 'disabled' });
  await completePopup.close();

  if (process.env.TEST_DOWNLOADS !== '0') {
    const downloads = resolve(artifacts, 'downloads');
    await mkdir(downloads);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    const exported = await message(library, 'EXPORT', { id: take.id, format: 'float32' });
    const download = await until(() => library.evaluate(id => chrome.downloads.search({ id }), exported.downloadId), rows => rows[0]?.state === 'complete', 'Chrome download');
    const wav = await readFile(download[0].filename);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    record('Chrome download', { bytes: wav.byteLength, filename: download[0].filename });
  }
  await tone.locator('#stop').click();
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = error.stack || String(error);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await context?.close().catch(error => { result.errors.push(error.message); });
  await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, results: resolve(artifacts, 'results.json'), artifacts }));
}
