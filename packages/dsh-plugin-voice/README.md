# dsh-plugin-voice

给 DeepSeek Harness Web（dsh web）加"输出朗读"：每轮回答结束后，先把回答改写成口语稿（**转写**），
再交给 TTS 出声（**播报**）；关掉自动播报，每条助手消息上仍可手动点"**朗读**"。

## 功能

- **自动播报开关**：开 = 每轮结束自动"转写 + 播报"；关 = 不自动，只留每条消息上的"朗读"按钮。
- **三个播报引擎**：系统 TTS（浏览器语音，默认、开箱即用）／豆包（需配置第三方 API，方言与多音色）／
  本地 Kokoro（本地运行、离线，中英都读，合成在 dsh 进程内）。
- **提示音**：工作音／完成音／提问音，默认关闭，可上传自定义音；与朗读互不影响。
- **失败按因提示**：模型未安装／模型加载失败／合成失败／合成超时／服务报错各有自己的文案。

## 安装

需要 DSH 桌面版 `0.2.1-rc.3` 或更高的兼容版本（已在 `0.2.1-rc.5` 验证）；从源码装包还要 Node.js 22+。

```powershell
# 在仓库根目录执行（桌面端自带 CLI，版本随桌面端）
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 1) 先装插件自身依赖（link: 只是链接，不会代装依赖）
#    依赖一律装在插件包内（npm 口径，package-lock.json 已入库，勿删）
cd packages/dsh-plugin-voice; npm install; cd ../..

# 2) 装进 desktop profile
& $dsh plugin --profile desktop add link:packages/dsh-plugin-voice
```

重启桌面端，设置页里就有"语音播报"。`link:` 的相对路径由 CLI 自己解析，锚定到哪个目录以 CLI 的实际行为为准；
解析失败（`cannot resolve profile bundle`）时改成绝对路径 `link:<仓库绝对路径>\packages\dsh-plugin-voice`。

## 配置

配置存在目标 profile 的 `cordis.patch.yml` 里 `voice` 条目的 `config:` 下（设置页可视化编辑，保存即写回该文件）。
字段含义见[管线与配置 schema](https://github.com/junarch/voice_for_dsh/blob/main/docs/pipeline.md)；
本地模型的安装与排障见[本地 TTS](https://github.com/junarch/voice_for_dsh/blob/main/docs/local-tts.md)；
开发循环见[开发手册](https://github.com/junarch/voice_for_dsh/blob/main/docs/development.md)。

## 协议

[MIT](https://github.com/junarch/voice_for_dsh/blob/main/LICENSE)
