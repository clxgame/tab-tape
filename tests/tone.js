const startButton = document.querySelector('#start');
const muteButton = document.querySelector('#mute');
const stopButton = document.querySelector('#stop');
const status = document.querySelector('#status');

let context = null;
let oscillatorNodes = [];
let level = null;
let startedAt = 0;
let muted = false;
let timer = null;
let timeout = null;

function updateStatus() {
  if (!context) return;
  const elapsed = Math.max(0, context.currentTime - startedAt).toFixed(1);
  status.textContent = `${muted ? '静音中' : '播放中'} · ${elapsed} 秒 · ${context.sampleRate} Hz · 左 440 Hz / 右 880 Hz`;
}

async function stop() {
  clearInterval(timer);
  clearTimeout(timeout);
  timer = null;
  timeout = null;
  const previous = context;
  if (!previous) return;
  context = null;
  for (const oscillator of oscillatorNodes) oscillator.stop();
  oscillatorNodes = [];
  level = null;
  await previous.close();
  startButton.disabled = false;
  stopButton.disabled = true;
  muteButton.disabled = true;
  muteButton.textContent = '静音';
  status.textContent = '已停止 · 可以重新播放。';
}

async function start() {
  if (context) return;
  startButton.disabled = true;
  try {
    context = new AudioContext();
    await context.resume();
    const merger = context.createChannelMerger(2);
    level = context.createGain();
    level.gain.value = 0.25;
    merger.connect(level);
    level.connect(context.destination);
    oscillatorNodes = [440, 880].map((frequency, channel) => {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      oscillator.connect(merger, 0, channel);
      return oscillator;
    });
    startedAt = context.currentTime;
    muted = false;
    for (const oscillator of oscillatorNodes) oscillator.start(startedAt);
    stopButton.disabled = false;
    muteButton.disabled = false;
    updateStatus();
    timer = setInterval(updateStatus, 100);
    timeout = setTimeout(() => void stop(), 60_000);
  } catch (error) {
    if (context) await stop();
    startButton.disabled = false;
    status.textContent = `无法播放测试音：${error.message}`;
  }
}

startButton.addEventListener('click', () => void start());
stopButton.addEventListener('click', () => void stop());
muteButton.addEventListener('click', () => {
  if (!context || !level) return;
  muted = !muted;
  level.gain.setTargetAtTime(muted ? 0 : 0.25, context.currentTime, 0.005);
  muteButton.textContent = muted ? '恢复声音' : '静音';
  updateStatus();
});

// Read-only inspection for browser integration tests; playback still needs a click.
window.toneFixture = Object.freeze({
  get state() {
    return {
      playing: Boolean(context),
      muted,
      sampleRate: context?.sampleRate ?? null,
      elapsed: context ? context.currentTime - startedAt : 0,
      frequencies: [440, 880],
      peak: 0.25,
    };
  },
});
