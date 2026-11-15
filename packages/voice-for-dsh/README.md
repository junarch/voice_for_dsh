# voice for dsh

给 DeepSeek Harness 加"输出朗读"：每轮回答结束后，先把回答改写成口语稿（**转写**），
再交给 TTS 出声（**播报**）；关掉自动播报，每条助手消息上仍可手动点"**朗读**"。桌面版与 dsh web 都可用。

## 功能

- **自动播报开关**：开 = 每轮结束自动"转写 + 播报"；关 = 不自动，只留每条消息上的"朗读"按钮。
- **四个播报引擎**：系统朗读（浏览器语音，默认、开箱即用）／豆包（第三方 API，方言与情绪演绎）／
  DeepSeek 官方 TTS（第三方 API，WS 流式边转写边播）／本地 Kokoro（本地运行、离线，中英都读，合成在 dsh 进程内）。
- **播报长度可调**：详细（接近原文长度）／简单（约一半）／极简（约三成），按原文长短自动封顶。
- **提示音**：工作音／完成音／提问音，默认关闭，可换内置音色或上传自定义音；与朗读互不影响。
- **失败按因提示**：模型未安装／模型加载失败／合成失败／合成超时／服务报错各有自己的文案。

## 安装

需要 DSH 桌面版 `0.2.1-rc.3` 或更高的兼容版本（已在 `0.2.1-rc.5` 验证）。

```powershell
# 桌面端自带 CLI，版本随桌面端
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

& $dsh plugin --profile desktop add voice-for-dsh
```

重启桌面端，设置页里就有"语音播报"。插件依赖（含本地引擎的原生模块）由安装过程自己装，不用先 `npm install`。

从源码安装（开发用，改代码即生效）：

```powershell
cd packages/voice-for-dsh; npm install; cd ../..     # link: 不会代装依赖
& $dsh plugin --profile desktop add link:packages/voice-for-dsh
```

`link:` 的相对路径由 CLI 自己解析，锚定到哪个目录以 CLI 的实际行为为准；
解析失败（`cannot resolve profile bundle`）时改成绝对路径 `link:<仓库绝对路径>\packages\voice-for-dsh`。

## 配置

配置存在目标 profile 的 `cordis.patch.yml` 里 `voice` 条目的 `config:` 下（设置页可视化编辑，保存即写回该文件）。
字段含义见[管线与配置 schema](https://github.com/junarch/voice_for_dsh/blob/main/docs/pipeline.md)；
本地模型的安装与排障见[本地 TTS](https://github.com/junarch/voice_for_dsh/blob/main/docs/local-tts.md)；
开发循环见[开发手册](https://github.com/junarch/voice_for_dsh/blob/main/docs/development.md)。

API Key（豆包 / DeepSeek）明文存在同一个 profile 文件里，只在本机；设置页不回读原文，
输入框留空即不改，要清除点输入框旁的「清除」。

## 成本与隐私

- **转写**：每个消息的"首次朗读"调用一次你配置的 LLM，**花 token**；同一消息重复朗读不花（缓存命中），
  点「重新生成」才重新转写。转写会连带最近 `transcribe.contextTurns` 轮对话上下文（默认 2 轮，可调）。
- **播报**：系统朗读与本地 Kokoro 不产生调用费用（本地合成完全在本机进行）；豆包按字符/时长计费，
  同一消息 1 小时内重播命中服务端缓存；DeepSeek 官方 TTS 按计费字符收费（一个汉字折 2 个），
  插件自带音频重播缓存，重播不再计费（上限 20 篇 / 200MB，重启清空）。
- **本机留下什么**：转写稿缓存 `<DSH_HOME>/voice-transcript-cache.json`（明文，最多 200 条，可删）；
  自定义提示音 `<DSH_HOME>/voice/sounds/`（只存本机、不上传）；本地模型 407MB。
- **网络出口只有四个**：转写 LLM、豆包 TTS、DeepSeek TTS、本地模型下载（GitHub Releases，点下载才会发生）。
  没有埋点、没有遥测、没有第三方字体或 CDN。
- **接口只认本机**：插件自己的三条本地路由只接受从本机发起、Host 是本机名的请求，且不回传密钥原文。

## 协议

[MIT](https://github.com/junarch/voice_for_dsh/blob/main/LICENSE)
