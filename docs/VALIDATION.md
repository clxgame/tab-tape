# 验证记录

日期：2026-10-08。当前版本：v0.1.1（界面精简）。

## 自动化单元与控制流程

命令：`npm test`。25 项通过。

- AudioWorklet：真实左右样本次序、完整块与尾块、单声道复制、静音时长、可变 render quantum、停止确认、非有限样本处理。
- WAV：IEEE Float + fact 头、24 位 PCM 头、交错声道、量化误差上限、越界截幅、RIFF 大小和对齐。
- Offscreen 控制：停止等待所有写入、最终尾段入库、写盘失败、目标流结束、启动失败后释放音频资源、导出与录制互斥、达到容量上限自动保存（用小容量模拟）。
- Service Worker：并发开始只采集一次、启动期间状态查询、offscreen 单例、受限页面拒绝、另存为不阻塞停止、下载完成／中断／取消时释放 Blob。

命令：`npm run check`。检查 Manifest V3、最低 Chrome 版本、最小权限集合、入口文件、资源引用和 JavaScript 语法。

## 浏览器与音频验收

环境：macOS，安装于本机的 **Chrome 154.0.8037.98**，Playwright 1.62.1，独立临时浏览器配置，headless 模式。使用 Chrome DevTools Protocol 加载本地扩展并触发工具栏授权；启动／停止命令走真实扩展消息链路。没有修改用户日常浏览器配置。

已通过：

- Chrome 成功加载 MV3 扩展，真实 `tabCapture → Offscreen → AudioWorklet → IndexedDB` 采集成功。
- 通过网页真实播放左 440 Hz、右 880 Hz 测试音；捕获峰值约 0.25，左右频谱正确。
- 关闭模拟弹窗页面后，后台采样帧继续增长。
- 实际采样率 **44,100 Hz**；停止保存 **73,984 帧**，原始 PCM 为 **591,872 字节**。
- 32-bit Float WAV：**591,930 字节**，24-bit PCM WAV：**443,948 字节**。头部采样率、解码后的精确帧数、两声道频率均与记录一致。
- Chrome Downloads API 实际写出 WAV，文件头为 RIFF，下载完成。
- 浏览器原生 IndexedDB 的 5 组检查：有序写入和输入验证、事务失败回滚、分块导出和双格式解码、中断恢复与活跃录音保护、元数据及所有音频块删除。
- UI 截图人工检查：340px 宽录音面板、精简后的录音库。停止按钮可用、双声道电平正常、无横向溢出；使用说明默认折叠。

完整机器结果见 [browser-results.json](browser-results.json)，截图见 [录音面板](screenshots/popup-recording.png) 和 [录音库](screenshots/library-complete.png)。

自动化截图将 popup.html 作为同尺寸扩展页面打开，关闭的是这个页面；未自动化检查 Chrome 原生弹窗外框。下载路径由 CDP 设置；交互式「另存为」窗口仍需手动验收。手动流程见项目 README，测试音源位于 `tests/tone.html`。

复现命令（需本机 Playwright 和支持 Extensions CDP 域的新版 Chrome；不属于用户安装所需步骤）：

```bash
PLAYWRIGHT_PATH=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chrome node tests/browser-smoke.mjs
```

测试会短暂播放测试音。不要使用 Playwright 默认的 `--mute-audio`，否则标签页捕获只能得到静音；测试脚本已去除此参数。脚本将测试配置和结果放入系统临时目录并打印路径。

## 尚未覆盖的边界

- 数十分钟持续捕获、1 GiB 大文件导出的真实压力测试。
- Mac 实际休眠／唤醒、硬件输出设备热插拔、真实磁盘耗尽。
- 不同网站的播放器、受保护媒体、所有 Chrome 116+ 版本，以及 Edge。
- 浏览器存储被系统回收或扩展数据被人为清除后无法恢复音频。

通过自动化和短时浏览器验证不代表上述边界都已实测。
