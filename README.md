# Tab Tape · 标签页录音

一个轻量、开源、本机运行的 Chrome 扩展：录下当前网页的声音，导出可以直接放进 Ableton Live 的 WAV。

**v0.1.1**：精简录音面板和录音库。弹窗宽度 340px，显示最近一条录音；使用说明折叠收起。更新本目录后，在 Chrome 扩展管理页刷新 Tab Tape 即可（先停止正在进行的录音）。

## 安装（不需要 npm）

1. 使用 **Chrome 116 或更新版本**。
2. 在地址栏输入 `chrome://extensions`，开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目的 **tab-tape 文件夹**（包含 `manifest.json` 的这一层）。如果使用 ZIP，先解压，再选择解压后的文件夹。
4. 在 Chrome 工具栏的扩展程序菜单中，把 **Tab Tape · 标签页录音** 固定到工具栏。

可以通过 GitHub 的 **Code → Download ZIP** 下载源码并解压，也可以克隆仓库：

```bash
git clone https://github.com/clxgame/tab-tape.git
```

## 使用

1. 打开要录音的普通网页并播放声音。
2. 在该网页上点击工具栏的 Tab Tape 图标，再点「开始录音」。
3. 正常收听，查看时长和左右声道电平。可以关闭弹窗、切换标签页，录音始终跟随最初选择的标签页。
4. 再次点击插件图标，点击「停止并保存」。录音先保存在浏览器的本机录音库。
5. 在最近录音或录音库中点击下载，选择位置保存 WAV。默认 **32-bit Float**，也可选择 **24-bit PCM**。

同一时间只能录制一个标签页。下载和删除历史片段也需等录音停止后操作，避免大文件处理影响录音写入。其他应用、其他标签页和麦克风的声音不会混入。录音页面内部的广告、提示音和播放器音量变化会被录进去。

## 音质

音频路径是 `chrome.tabCapture → AudioContext → AudioWorklet → Float32 PCM → WAV`。全程没有 MediaRecorder、Opus、AAC、MP3 或 WebM 中间编码。

- **32-bit Float WAV**：直接保存音频处理器收到的浮点样本，适合导入 DAW 后继续编辑。
- **24-bit PCM WAV**：导出时将浮点样本量化为 24 位整数；超出 ±1 的样本会截幅，不添加抖动。若电平超过 0 dBFS，优先使用浮点格式。
- 立体声双通道；单声道输入复制到左右声道，多声道输入由 Web Audio 混合为立体声。
- 使用实际 `AudioContext.sampleRate` 写入 WAV，不伪造或单独提高导出采样率。

这里的「无损」指不再经过有损音频编码，不保证与网站原始文件逐位一致。浏览器解码、播放器音量、混音及采样率转换已经发生；将有损音源录为 WAV 不会恢复缺失的信息。

## 本机存储和第一版边界

- 音频以小块写入 **IndexedDB**，录制过程不把完整录音累计在内存中。停止时等待最后一块音频和磁盘写入完成。
- 已写入的片段保留在录音库。浏览器或扩展意外退出后，再打开扩展会把未完成录音标为「已恢复片段」，可以导出保存下来的部分。尚未提交的尾部数据不能保证恢复。
- 单次上限 **1 GiB**；48 kHz / 立体声 / Float32 下约 **46 分 36 秒**。达到上限自动停止，需手动开始下一段。容量还受可用磁盘和浏览器配额限制。
- 48 kHz 时，每分钟原始录音约 23 MB；24 位导出约 17 MB。导出逐块构建 Blob，仍会占用额外内存或临时磁盘空间。
- 删除前会确认；卸载扩展或清除浏览器扩展数据也会清除录音库。重要录音请下载为文件。
- Chrome 内部页面、Chrome 扩展商店不能录制。受保护内容可能无法捕获。电脑休眠、关闭目标标签页或设备中断会结束或中断录音，不承诺休眠期间连续记录。
- 第一版没有暂停、剪辑、云同步或多标签同时录制。Edge/其他 Chromium 浏览器尚未作为正式兼容目标验证。

## 隐私与权限

没有账号、服务器、统计、远程脚本或上传功能。录音及网页标题只保存在本机；不保存网页 URL。

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点击扩展后识别目标标签页和标题 |
| `tabCapture` | 捕获用户主动选定标签页的音频 |
| `offscreen` | 弹窗关闭后继续录音、维护 WAV 下载对象 |
| `downloads` | 将用户选择的录音保存为 WAV |
| `storage` | 临时记录下载任务，完成后释放 WAV 对象 |

不申请麦克风权限、全站访问权限或网页脚本注入权限。

## 开发与验证

没有生产依赖，也没有构建步骤。安装后修改源码，在 `chrome://extensions` 点击此扩展的刷新按钮即可；请先停止并下载正在录制的内容。

```bash
cd tab-tape
npm test            # WAV 数据、工作线程分块及服务调度测试
npm run check       # 清单、权限、文件引用和 JS 语法
npm run package     # 输出 releases/tab-tape-0.1.1.zip；需系统 zip 命令
```

手动端到端检查：

1. 在本目录运行 `python3 -m http.server 8765 --bind 127.0.0.1`。
2. 用 Chrome 打开 `http://127.0.0.1:8765/tests/tone.html`，点击播放测试音（左 440 Hz，右 880 Hz）。
3. 通过工具栏录音 5–10 秒，中途关闭弹窗、切换标签页，再回来停止。
4. 下载两种 WAV，导入 Ableton，确认约定的时长、左右声道频率、采样率和位深。
5. 录音时关闭测试标签页，确认已录部分仍能从录音库下载。

具体自动化验证结果见 [docs/VALIDATION.md](docs/VALIDATION.md)，规划与后续范围见 [docs/PLAN.md](docs/PLAN.md)。

## 技术依据

- [Chrome：标签页后台录音](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)
- [Chrome：tabCapture 与恢复监听](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
- [Chrome：offscreen 生命周期与权限](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [MDN：AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)

MIT 许可证，见 [LICENSE](LICENSE)。
