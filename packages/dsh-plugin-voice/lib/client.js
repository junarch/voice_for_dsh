//#region dsh-plugin-voice — Client half (browser, formal bundle)
/**
 * 语音朗读插件 Client 半（正式 bundle，ModuleLoader 格式）。
 *
 *  - 每条助手消息 IconActions 行：喇叭图标"朗读"按钮（转写→播报/停止）+ ↻ 重新生成（纯图标）
 *  - 输入框左下角："自动朗读"开关（持久化 voice.autoSpeak）
 *  - turnTail 徽标：本轮已朗读 ✓ / 朗读中…（点击重播；只 claim 读过的轮次，不抢 deliverables 产物链）
 *  - 设置页（settings.section id=voice）：全配置可视化 + 试听
 *  - 播报：browser = speechSynthesis（自动剥离 [#...] 语音指令标签）；云 TTS = <audio src="/voice/audio/<id>">
 *  - i18n：locale 命名空间 voice（zh/en）；与 Host 半走 /voice/api/* JSON RPC
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-voice",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    // ---------- i18n ----------
    var NS = "voice";
    var VOLC_APIKEY_DOC = "https://www.volcengine.com/docs/6561/2119699?lang=zh"; // 新版控制台快速入门（API Key 获取）
    var zh = {
      "read.title": "转写并朗读此条消息", "read.busyTitle": "正在转写，请稍候", "read.stopTitle": "停止播报",
      "read.regenerate": "重新生成",
      "read.failPrefix": "上次失败：", "read.degraded": "转写失败，已直读原文",
      "auto.on": "自动·开", "auto.off": "自动·关",
      "auto.title": "打开后，每轮回答结束自动转写并朗读",
      "badge.speaking": "朗读中…", "badge.done": "已朗读 ✓", "badge.replay": "点击重播此轮播报",
      "settings.title": "语音播报",
      "settings.intro": "每轮回答结束后，先把回答改写成口语稿再念出来。设置存在本机 DSH 的 profile 配置里（cordis.patch.yml），保存后立刻生效。",
      "settings.save": "保存", "settings.saved": "✅ 已保存，立刻生效",
      "settings.saveFail": "❌ 保存失败：", "settings.loadFail": "读取配置失败",
      "settings.refresh": "刷新模型/档位列表", "settings.refreshed": "已拉取 provider/model/思考档位列表",
      "settings.preview": "▶ 试听", "settings.stopAll": "⏹ 停止播报",
      "settings.previewFail": "❌ 试听失败：", "settings.previewBrowser": "▶ 试听中（浏览器语音）…", "settings.previewCloud": "▶ 试听中（云 TTS）…", "settings.previewAudio": "▶ 试听中…",
      "layer.l1.title": "常用", "layer.l2.title": "当前引擎的声音", "layer.l3.title": "转写", "layer.l4.title": "高级",
      "layer.l2.summary.browser": "系统 TTS · 语速 {rate}",
      "layer.l2.summary.local": "本地 Kokoro · 音色 {sid} · 语速 {rate}",
      "layer.l2.summary.volcengine": "豆包 · {speaker}",
      "layer.l3.summary.on": "开：先改写成口语稿", "layer.l3.summary.off": "关：直接念原文",
      "layer.l4.summary": "分句={seg} · 线程={threads} · 目录={dir}",
      "layer.value.on": "开", "layer.value.off": "关", "layer.value.auto": "自动", "layer.value.custom": "自定义",
      "status.browser": "浏览器自带语音：免费，不用装东西",
      "status.volcengine.ok": "豆包云 TTS：按量计费，试听会真的调用",
      "status.volcengine.noKey": "豆包云 TTS：还没填 API Key，试听会失败",
      "status.local.installed": "本地模型已装好，可以直接播报",
      "status.local.missing": "本地模型还没装，先下载才能出声",
      "status.local.busy": "正在装本地模型：{percent}%",
      "cta.install": "去安装",
      "hint.engine": "系统 TTS 免费、离线；豆包按量计费、要填 API Key；本地 Kokoro 免费，先下模型",
      "hint.autoSpeak": "每轮回答结束自动念一遍",
      "hint.transcribe": "开：模型先把回答改写成口语稿，更顺耳，但多一次模型调用。关：直接念原文，表格和代码自动跳过。",
      "row.transcribeEnabled": "开启转写",
      "group.auth": "鉴权", "group.pronounce": "发音",
      "row.autoSpeak": "自动播报", "row.engine": "播报引擎", "row.language": "语种/方言",
      "row.provider": "Provider", "row.model": "模型",
      "row.temperature": "temperature",
      "temperature.hint": "越高越自由、越容易跑偏；越低越贴原文（默认 0.3）",
      "engine.browser": "系统 TTS（免费）", "engine.volcengine": "豆包云 TTS（付费）", "engine.local": "本地 Kokoro（中英·免费）",
      "row.localVoice": "音色 sid", "row.localSpeed": "语速 speed",
      "row.localNumThreads": "合成线程数",
      "local.hint": "中英文都能念，音频不出本机；先点上面的「下载模型」把模型装好。",
      "local.sidHint": " 模型只有数字音色编号（0–102），没有官方名字；下拉是精选几档，想换音色直接手填 sid 试听",
      "local.customSid": "手填 sid（0–102）",
      "local.numThreadsHint": " 多线程更吃 CPU；线程多首声更快，默认 4",
      "local.streaming": "分句流式播报",
      "local.streamingHint": " 开=按句切段逐段合成，约 1 秒出声、长稿边算边播（推荐）；关=整段合成完才播，长稿要等 / on = segment-by-segment, first sound ~1s",
      "local.modelDir": "模型目录",
      "local.modelDirHint": " 空=自动找（用户目录 → 仓库 local/models）；也可在这里指定自己解包的目录",
      "local.notInstalled": "⚠ 本地模型还没装：点上面的「下载模型」直接装；也可以把已解包的目录填到「模型目录」",
      "local.deploy.hint": "来源：{source} · 下载 {download} · 解包后 {extract} · 含声学模型、103 个音色、中英词典和 espeak 数据",
      "local.deploy.checking": "正在检查模型状态…",
      "local.deploy.notInstalled": "还没装模型，本地引擎现在不能出声",
      "local.deploy.start": "下载模型",
      "local.deploy.retry": "重试",
      "local.deploy.cancel": "取消",
      "local.deploy.downloading": "正在下载：{received} / {total}（{percent}%）",
      "local.deploy.verifying": "正在核对文件完整性…",
      "local.deploy.extracting": "正在解包（约 20–35 秒，别关窗口）…",
      "local.deploy.installed": "已安装 · 占用 {size} · 版本 {version}",
      "local.deploy.installedDir": "装在这里：{dir}",
      "local.deploy.fail": "安装失败：",
      "local.deploy.errNetwork": "下载中断：网络连不上（已自动重试 2 次）。检查网络后点「重试」，已下好的部分会接着下。",
      "local.deploy.errChecksum": "校验没通过：上游文件已更新，请升级插件。",
      "local.deploy.errDisk": "磁盘空间不够，清理一些文件后再试。",
      "local.deploy.errExtract": "解包失败。",
      "local.deploy.errUnknown": "未知错误。",
      "local.deploy.cancelled": "已取消安装，临时文件已清掉",
      "local.deploy.remove": "删除模型",
      "local.deploy.removeBlocked": "不在可删范围",
      "local.deploy.removeTitle": "删掉下载的模型，释放约 407MB",
      "local.deploy.removeConfirm": "再点一次确认删除（只删下载的这份模型，不动你的配置）",
      "local.deploy.removeConfirmBtn": "确认删除？",
      "local.deploy.removed": "✅ 已删除本地模型",
      "local.deploy.removeFail": "删除失败：",
      "settings.localCheck": "🔌 运行时自检", "settings.localCheckRunning": "✅ 运行时就绪：", "settings.localCheckFail": "❌ 运行时不可用：",
      "settings.localCheckInstalled": "⚠ 模型未安装：",
      "toast.fallback": "TTS 失败，已回退系统朗读",
      "toast.ttsUnavailable": "本地 TTS 不可用",
      "toast.ttsModelMissing": "本地模型未安装",
      "toast.ttsLoadFailed": "本地模型加载失败",
      "toast.ttsSynthFailed": "本地合成失败",
      "toast.ttsTimeout": "TTS 合成超时",
      "toast.ttsHttp": "TTS 合成失败（服务返回错误）",
      "row.stylePreset": "风格预设", "row.prompt": "转写 prompt",
      "row.rate": "语速 rate", "row.pitch": "音调 pitch", "row.voiceName": "语音名 voice",
      "row.apiKey": "apiKey", "row.resourceId": "resourceId", "row.speaker": "音色 speaker",
      "apiKey.hint": "豆包 TTS 需在火山引擎控制台开通“语音合成”服务后，在「API 管理」页获取 API Key（X-Api-Key）；plan=智能体套餐 Key、standard=标准付费 Key：", "apiKey.hintLink": "新版控制台快速入门",
      "row.gateway": "网关", "row.httpUrl": "HTTP 端点（自定义）",
      "gateway.hint": " plan=智能体套餐（默认）；standard=标准付费（新版控制台 API Key，格式同 plan）；custom=自定义/转接端点（填 URL）/ plan=agent-plan(default); standard=pay-as-you-go (new-console key, same format); custom=relay (set URL)",
      "row.rateLevel": "语速", "row.pitchSemitone": "音调（半音）",
      "row.loudness": "音量",
      "streaming.degraded": "双向流不可用，已回退整段合成",
      "dialect.hint": "方言：8 种方言均走 vv 音色 + explicit_dialect（实测生效）；音色/语种会自动互相适配（不锁定）",
      "layer.l5.title": "提示音",
      "layer.l5.summary.on": "开 · {n}/3 种 · 音量 {volume}%", "layer.l5.summary.off": "关",
      "row.chimeEnabled": "开启提示音", "row.chimeVolume": "总音量",
      "hint.chime": "有会话在跑就循环工作音，会话结束响一次完成音，DSH 弹出提问等你回答响一次提问音；与朗读互不影响。",
      "chime.work": "工作音", "chime.done": "完成音", "chime.ask": "提问音",
      "chime.source.default": "默认音（程序合成）", "chime.source.custom": "自定义",
      "chime.upload": "上传", "chime.uploading": "上传中…", "chime.uploaded": "✅ 已上传：{file}（记得保存）",
      "chime.uploadFail": "❌ 上传失败：", "chime.uploadFailUnknown": "未知错误",
      "chime.tooLarge": "文件超过 10MB，换个小一点的",
      "chime.tooLong": "音频超过 60 秒（{seconds} 秒），换短一点的",
      "chime.undecodable": "这个格式浏览器解不了",
      "chime.noFile": "还没上传文件",
      "chime.missing": "⚠ 这个音源读不到或解不了，已回落到默认音",
      "chime.preview": "▶ 试听", "chime.previewFail": "试听失败",
      "chime.audioUnavailable": "当前浏览器不支持 Web Audio，提示音用不了",
      "chime.rowToggle": "开关{name}",
    };
    var en = {
      "read.title": "Transcribe and read this message aloud", "read.busyTitle": "Transcribing, please wait",
      "read.stopTitle": "Stop playback", "read.regenerate": "Regenerate",
      "read.failPrefix": "Last failure: ",
      "read.degraded": "Transcription failed; read the raw text",
      "auto.on": "Auto · On", "auto.off": "Auto · Off",
      "auto.title": "When on, each finished turn is transcribed and read aloud",
      "badge.speaking": "Reading…", "badge.done": "Read ✓", "badge.replay": "Click to replay this turn",
      "settings.title": "Voice Readout",
      "settings.intro": "Each finished turn is rewritten into spoken style, then read aloud. Settings live in this machine's DSH profile config (cordis.patch.yml) and take effect on save.",
      "settings.save": "Save", "settings.saved": "✅ Saved; takes effect now",
      "settings.saveFail": "❌ Save failed: ", "settings.loadFail": "Failed to load config",
      "settings.refresh": "Refresh models/efforts", "settings.refreshed": "Provider/model/effort lists refreshed",
      "settings.preview": "▶ Preview", "settings.stopAll": "⏹ Stop playback",
      "settings.previewFail": "❌ Preview failed: ", "settings.previewBrowser": "▶ Previewing (browser voice)…", "settings.previewCloud": "▶ Previewing (cloud TTS)…", "settings.previewAudio": "▶ Previewing…",
      "layer.l1.title": "Basics", "layer.l2.title": "Current engine voice", "layer.l3.title": "Transcription", "layer.l4.title": "Advanced",
      "layer.l2.summary.browser": "System TTS · rate {rate}",
      "layer.l2.summary.local": "Local Kokoro · voice {sid} · rate {rate}",
      "layer.l2.summary.volcengine": "Doubao · {speaker}",
      "layer.l3.summary.on": "On: rewritten into speech", "layer.l3.summary.off": "Off: read as written",
      "layer.l4.summary": "segments={seg} · threads={threads} · dir={dir}",
      "layer.value.on": "on", "layer.value.off": "off", "layer.value.auto": "auto", "layer.value.custom": "custom",
      "status.browser": "Built-in browser voice: free, nothing to install",
      "status.volcengine.ok": "Doubao cloud TTS: pay per use; preview calls the real API",
      "status.volcengine.noKey": "Doubao cloud TTS: no API Key yet; preview will fail",
      "status.local.installed": "Local model installed - ready to speak",
      "status.local.missing": "Local model not installed - download it first",
      "status.local.busy": "Installing local model: {percent}%",
      "cta.install": "Install",
      "hint.engine": "System TTS is free and offline; Doubao is pay-per-use and needs an API Key; local Kokoro is free but needs the model",
      "hint.autoSpeak": "Read each finished turn aloud automatically",
      "hint.transcribe": "On: the model rewrites the answer into spoken style first (nicer, one extra model call). Off: read as written; tables and code are skipped.",
      "row.transcribeEnabled": "Enable transcription",
      "group.auth": "Auth", "group.pronounce": "Pronunciation",
      "row.autoSpeak": "Auto-read", "row.engine": "TTS engine", "row.language": "Language/Dialect",
      "row.provider": "Provider", "row.model": "Model",
      "row.temperature": "temperature",
      "temperature.hint": "Higher = freer and more likely to drift; lower = closer to the original (default 0.3)",
      "engine.browser": "System TTS (free)", "engine.volcengine": "Doubao cloud TTS (paid)", "engine.local": "Local Kokoro (CN+EN · free)",
      "row.localVoice": "Voice sid", "row.localSpeed": "Speed",
      "row.localNumThreads": "Synthesis threads",
      "local.hint": "Reads Chinese and English; audio never leaves this machine. Click Download model above to install it first.",
      "local.sidHint": " The model only exposes numeric voice ids (0-102) with no official names; the dropdown lists a few picks, type any sid to audition more",
      "local.customSid": "Custom sid (0-102)",
      "local.numThreadsHint": " More threads use more CPU; more threads start speaking sooner. Default 4",
      "local.streaming": "Segmented streaming",
      "local.streamingHint": " on = sentence-by-sentence synthesis, first sound in ~1s, long texts play while still synthesizing (recommended); off = wait for the whole text",
      "local.modelDir": "Model directory",
      "local.modelDirHint": " empty = auto (user dir, then repo local/models); you can also point it at your own unpacked directory",
      "local.notInstalled": "⚠ Local model not installed: click Download model above, or point Model directory at an unpacked copy",
      "local.deploy.hint": "Source: {source} · download {download} · {extract} unpacked · acoustic model, 103 voices, CN/EN lexicons and espeak data",
      "local.deploy.checking": "Checking model status…",
      "local.deploy.notInstalled": "Model not installed yet - the local engine cannot speak",
      "local.deploy.start": "Download model",
      "local.deploy.retry": "Retry",
      "local.deploy.cancel": "Cancel",
      "local.deploy.downloading": "Downloading: {received} / {total} ({percent}%)",
      "local.deploy.verifying": "Verifying file integrity…",
      "local.deploy.extracting": "Unpacking (~20-35s, keep this window open)…",
      "local.deploy.installed": "Installed · {size} · {version}",
      "local.deploy.installedDir": "Installed at: {dir}",
      "local.deploy.fail": "Install failed: ",
      "local.deploy.errNetwork": "Download interrupted: network unreachable (retried twice). Check the network and click Retry - finished bytes are kept.",
      "local.deploy.errChecksum": "Checksum mismatch: upstream files changed, please update the plugin.",
      "local.deploy.errDisk": "Not enough disk space. Free some space and try again.",
      "local.deploy.errExtract": "Unpacking failed.",
      "local.deploy.errUnknown": "Unknown error.",
      "local.deploy.cancelled": "Install cancelled; temporary files removed",
      "local.deploy.remove": "Delete model",
      "local.deploy.removeBlocked": "Not removable",
      "local.deploy.removeTitle": "Delete the downloaded model, freeing ~407MB",
      "local.deploy.removeConfirm": "Click again to confirm (only the downloaded model is deleted; your settings stay)",
      "local.deploy.removeConfirmBtn": "Confirm delete?",
      "local.deploy.removed": "✅ Local model deleted",
      "local.deploy.removeFail": "Delete failed: ",
      "settings.localCheck": "🔌 Runtime self-check", "settings.localCheckRunning": "✅ Runtime ready: ", "settings.localCheckFail": "❌ Runtime unavailable: ",
      "settings.localCheckInstalled": "⚠ Model not installed: ",
      "toast.fallback": "TTS failed; fell back to system voice",
      "toast.ttsUnavailable": "Local TTS unavailable",
      "toast.ttsModelMissing": "Local model not installed",
      "toast.ttsLoadFailed": "Local model failed to load",
      "toast.ttsSynthFailed": "Local synthesis failed",
      "toast.ttsTimeout": "TTS synthesis timed out",
      "toast.ttsHttp": "TTS synthesis failed (service error)",
      "row.stylePreset": "Style preset", "row.prompt": "Transcribe prompt",
      "row.rate": "Rate", "row.pitch": "Pitch", "row.voiceName": "Voice name",
      "row.apiKey": "apiKey", "row.resourceId": "resourceId", "row.speaker": "Speaker",
      "apiKey.hint": "Doubao TTS: enable the speech service in the Volcengine console, then get an API Key (X-Api-Key) in \"API management\"; plan = agent-plan key, standard = pay-as-you-go key: ", "apiKey.hintLink": "Quick start (new console)",
      "row.gateway": "Gateway", "row.httpUrl": "HTTP endpoint (custom)",
      "gateway.hint": " plan=agent-plan (default); standard=pay-as-you-go (new-console key, same format); custom=relay (set URL)",
      "row.rateLevel": "Speech rate", "row.pitchSemitone": "Pitch (semitones)",
      "row.loudness": "Loudness",
      "streaming.degraded": "Bidirection unavailable; fell back to one-shot synthesis",
      "dialect.hint": "Dialects: all 8 dialects use vv speaker + explicit_dialect (tested working); voice & language auto-adapt to each other (never locked)",
      "layer.l5.title": "Chimes",
      "layer.l5.summary.on": "On · {n}/3 sounds · volume {volume}%", "layer.l5.summary.off": "Off",
      "row.chimeEnabled": "Enable chimes", "row.chimeVolume": "Master volume",
      "hint.chime": "Loop a work sound while sessions run, a done sound when one finishes, and an ask sound when DSH is waiting on your answer. Independent of readout.",
      "chime.work": "Work", "chime.done": "Done", "chime.ask": "Question",
      "chime.source.default": "Default (synthesized)", "chime.source.custom": "Custom",
      "chime.upload": "Upload", "chime.uploading": "Uploading…", "chime.uploaded": "✅ Uploaded: {file} (remember to save)",
      "chime.uploadFail": "❌ Upload failed: ", "chime.uploadFailUnknown": "Unknown error",
      "chime.tooLarge": "File is over 10MB - pick a smaller one",
      "chime.tooLong": "Audio is over 60 seconds ({seconds}s) - pick a shorter one",
      "chime.undecodable": "This browser cannot decode that format",
      "chime.noFile": "No file uploaded yet",
      "chime.missing": "⚠ This sound file is unreadable or undecodable; falling back to the default sound",
      "chime.preview": "▶ Preview", "chime.previewFail": "Preview failed",
      "chime.audioUnavailable": "This browser has no Web Audio support; chimes are unavailable",
      "chime.rowToggle": "Toggle {name}",
    };
    var T = (k) => k; // apply 时绑定 locale
    function t(k) { return T(k); }

    // ---------- 基础 ----------
    async function rpc(method, args) {
      const res = await fetch("/voice/api/" + method, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args || {}),
      });
      return res.json();
    }
    /** 浏览器语音前剥掉豆包语音指令标签（[#...]），防止被逐字读出来。 */
    function stripTags(text) {
      return String(text || "").replace(/\[#[^\]]*\]/g, "").trim();
    }

    /** Host /meta 不可用（旧 Host 裂脑）时的兜底清单，保证下拉不空。 */
    var VOICE_CUSTOM = "__voice_custom__"; // speaker 下拉的「自定义」占位值（非真实音色 id）
    var ROUTE_CUSTOM = "__route_custom__"; // provider/model 下拉的「自定义」占位值
    var FALLBACK_META = {
      voices: [
        { id: "zh_female_vv_uranus_bigtts", name: "Vivi 2.0（女）" },
        { id: "zh_female_xiaohe_uranus_bigtts", name: "小何（女）" },
        { id: "zh_female_linjianvhai_uranus_bigtts", name: "邻家女孩 2.0（女）" },
        { id: "zh_female_gaolengyujie_uranus_bigtts", name: "高冷御姐 2.0（女）" },
        { id: "zh_female_sajiaoxuemei_uranus_bigtts", name: "撒娇学妹 2.0（女）" },
        { id: "zh_male_m191_uranus_bigtts", name: "云舟 2.0（男）" },
        { id: "zh_male_taocheng_uranus_bigtts", name: "小天 2.0（男）" },
        { id: "zh_male_liufei_uranus_bigtts", name: "刘飞 2.0（男）" },
        { id: "zh_male_yangguangqingnian_uranus_bigtts", name: "阳光青年 2.0（男）" },
        { id: "en_male_tim_uranus_bigtts", name: "Tim（英·男）" },
        { id: "en_female_dacey_uranus_bigtts", name: "Dacey（英·女）" },
        { id: "en_female_stokie_uranus_bigtts", name: "Stokie（英·女）" },
      ],
      languages: [
        { id: "auto", label: "自动（跟随原文）" }, { id: "zh", label: "中文（普通话）" }, { id: "en", label: "English" },
        { id: "yue", label: "粤语" }, { id: "shanghai", label: "上海话" }, { id: "henan", label: "河南话" },
        { id: "beijing", label: "北京话" }, { id: "tianjin", label: "天津话" }, { id: "sichuan", label: "四川话" },
        { id: "shaanxi", label: "陕西话" }, { id: "dongbei", label: "东北话" },
      ],
      stylePresets: [
        { id: "standard", name: "标准", prompt: "" },
        { id: "companion", name: "陪伴", prompt: "" },
        { id: "playful", name: "俏皮", prompt: "" },
      ],
      rateStops: ["很慢", "稍慢", "正常", "稍快", "很快"],
      kokoroVoices: [
        { id: "48", name: "中文女声 · 中高（sid 48）" }, { id: "40", name: "中文女声 · 高（sid 40）" },
        { id: "14", name: "中文女声 · 中（sid 14）" }, { id: "8", name: "中文女声 · 低（sid 8）" },
        { id: "66", name: "中文男声 · 高（sid 66）" }, { id: "75", name: "中文男声 · 中（sid 75）" },
        { id: "81", name: "中文男声 · 低（sid 81）" }, { id: "0", name: "英文女声 · Maple（sid 0）" },
        { id: "2", name: "英文女声 · Vale（sid 2）" },
      ],
    };

    // ---------- 音色 ↔ 语种/方言 兼容矩阵（与 Host lib/voice-compat.js 同步的内联镜像，client 无 import） ----------
    // 不变式：方言 ⟺ vv；English ⟺ 英文音色；中文/自动 配中文音色（含 vv）。
    // 交互 = 后改的字段胜出：改语言→纠音色；改音色→纠语言。
    var VV_SPEAKER = "zh_female_vv_uranus_bigtts";
    var EN_DEFAULT_SPEAKER = "en_male_tim_uranus_bigtts";
    var EN_VOICE_PREFIXES = ["en_", "ICL_uranus_en_"];
    var DIALECT_IDS = ["yue", "shanghai", "henan", "beijing", "tianjin", "sichuan", "shaanxi", "dongbei"];
    function isEnVoice(sp) { return !!sp && EN_VOICE_PREFIXES.some(function (p) { return sp.indexOf(p) === 0; }); }
    function isVvVoice(sp) { return sp === VV_SPEAKER; }
    function voiceCategory(sp) { return isEnVoice(sp) ? "en" : isVvVoice(sp) ? "vv" : "zh"; }
    function isDialectLanguage(l) { return DIALECT_IDS.indexOf(l) >= 0; }
    /** 改音色后让语种适配（en 音色→en；vv→除 en 外保持，en 改 zh；中文音色→方言/en 改 zh）。 */
    function correctLanguageForSpeaker(language, speaker) {
      var cat = voiceCategory(speaker);
      if (cat === "en") return language === "en" ? language : "en";
      if (cat === "vv") return language === "en" ? "zh" : language;
      if (isDialectLanguage(language) || language === "en") return "zh";
      return language;
    }
    /** 改语种后让音色适配（方言→vv；en→英文音色；zh/auto 保持，如实反映用户选择）。 */
    function correctSpeakerForLanguage(language, speaker) {
      if (isDialectLanguage(language)) return VV_SPEAKER;
      if (language === "en" && !isEnVoice(speaker)) return EN_DEFAULT_SPEAKER;
      return speaker;
    }

    // ---------- 播放管理（全局单播）----------
    var currentAudio = null;
    /** 播放链路诊断：把每一步推给 Host（Host 侧 /voice/api/clientDiagDump 读回）。
     *  慢引擎首声几十秒，"没声音"到底是没算完、解码失败，还是浏览器没排上播放，必须可区分。 */
    function diag(ev, data) {
      try { rpc("clientDiag", { entry: Object.assign({ ev: ev }, data || {}) }).catch(function () {}); } catch (e) {}
    }
    /** 播报状态（messageId → 'speaking' | 'done'）：turnTail 徽标读取。
     *  变更必须通知订阅者：徽标/按钮靠订阅重渲染，否则"已朗读/已停止"永远显示不出来。 */
    var spokenState = {};
    var spokenListeners = new Set();
    var playingMessageId = null;
    function markSpoken(messageId, state) {
      var id = String(messageId);
      if (state) spokenState[id] = state; else delete spokenState[id];
      spokenListeners.forEach(function (f) { f(); });
    }
    function beginPlayback(messageId) {
      playingMessageId = messageId ? String(messageId) : null;
      if (playingMessageId) markSpoken(playingMessageId, "speaking");
    }
    function finishPlayback(messageId, state) {
      var id = messageId ? String(messageId) : playingMessageId;
      if (playingMessageId === id) playingMessageId = null;
      if (id) markSpoken(id, state || null);
    }
    /** 停止播放：必须同时清掉"朗读中"状态。播放被中断时浏览器不会回调 onend/onended，
     *  只停音频不清状态 → 徽标永远停在"朗读中"（且会诱导用户重复点播、重复烧 token）。 */
    function stopPlaybackOnly(opts) {
      var wasPlaying = !!(playingMessageId || currentAudio || streamRunId);
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
      if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
      stopStream();
      if (playingMessageId) finishPlayback(playingMessageId, null);
      // 只有确实有播报在跑时才通知 Host 中止：避免"新 turn 开始"无脑打断别的会话正在跑的管线。
      if (wasPlaying && opts && opts.notifyHost) { try { rpc("stop").catch(function () {}); } catch (e) {} }
    }
    function stopAll() {
      stopPlaybackOnly();
      rpc("stop").catch(() => {});
    }
    function speakText(text, speech, hooks) {
      if (typeof speechSynthesis === "undefined") {
        if (hooks && hooks.onError) hooks.onError("browser speechSynthesis unavailable");
        return false;
      }
      const utterance = new SpeechSynthesisUtterance(stripTags(text));
      utterance.lang = "zh-CN";
      if (speech) {
        if (typeof speech.rate === "number") utterance.rate = speech.rate;
        if (typeof speech.pitch === "number") utterance.pitch = speech.pitch;
        if (speech.voice) {
          const v = speechSynthesis.getVoices().find((x) => x.name === speech.voice);
          if (v) utterance.voice = v;
        }
      }
      utterance.onend = () => { if (hooks && hooks.onEnd) hooks.onEnd(); };
      utterance.onerror = (e) => { if (hooks && hooks.onError) hooks.onError("speechSynthesis: " + String(e && e.error || "unknown")); };
      speechSynthesis.speak(utterance);
      return true;
    }
    function playAudio(url, hooks) {
      try {
        const audio = new Audio(url);
        currentAudio = audio;
        diag("play-audio", { url: String(url).slice(0, 80) });
        audio.onended = () => { if (currentAudio === audio) currentAudio = null; diag("audio-ended", {}); if (hooks && hooks.onEnd) hooks.onEnd(); };
        audio.onerror = () => { if (currentAudio === audio) currentAudio = null; diag("audio-error", {}); if (hooks && hooks.onError) hooks.onError("audio playback failed"); };
        const p = audio.play();
        if (p && p.catch) p.catch((e) => { diag("audio-play-rejected", { msg: String(e && e.message || e).slice(0, 120) }); if (hooks && hooks.onError) hooks.onError(String(e && e.message || e)); });
        return true;
      } catch (e) {
        diag("audio-play-throw", { msg: String(e && e.message || e).slice(0, 120) });
        if (hooks && hooks.onError) hooks.onError(String(e && e.message || e));
        return false;
      }
    }
    // ---------- 双向流流式播放 ----------
    // 优先 Web Audio 无缝调度（段与段零缝隙，消除"一顿一顿"）；无 AudioContext 或被
    // 浏览器策略挂起时回退顺序 <audio>（功能不丢）。配合 Host 端 pcm 段（裸采样切在
    // 任意字节位都无缝），段与段由 lookahead 无缝调度、无停顿。
    var streamRunId = null;
    var streamPollTimer = null;
    var streamHooks = null;
    var streamBusy = false;
    var streamMode = "legacy";        // legacy=顺序 <audio>（兜底）| gapless=Web Audio
    var streamSampleRate = 24000;     // pcm 段建 AudioBuffer 用（来自 speak 响应）
    var LOOKAHEAD_SEC = 5;            // 预排上限：只把未来 5 秒内的段排进 AudioContext，其余留在队列
    // legacy 状态（兜底路径）
    var streamPlaying = false;
    var streamAudio = null;
    // gapless 状态
    var gapless = null;               // { queue, sources, inflight, scheduledEnd, fetchDone, ended }
    var streamFetched = 0;            // 已取回的音频段数（诊断用）
    var AC = (typeof window !== "undefined") && (window.AudioContext || window.webkitAudioContext);
    var audioCtx = null;
    var audioCtxRate = 0;
    /** 采样率必须跟音频段一致：AudioBufferSourceNode 对每个 buffer 单独做采样率转换，
     *  24k 的段在 48k 上下文里会在 12k 以上留下约 -28dB 的镜像（持续“滋滋”声的来源）。
     *  固定成段采样率后 buffer 不转换，整条输出由 Chromium 的输出重采样器一次性完成。 */
    function ensureAudioContext(rate) {
      if (!AC) return null;
      var want = (typeof rate === "number" && rate > 0) ? rate : 24000;
      if (audioCtx && audioCtxRate && Math.abs(audioCtxRate - want) > 1) {
        try { audioCtx.close(); } catch (e) {}
        audioCtx = null;
      }
      if (!audioCtx) {
        try { audioCtx = new AC({ sampleRate: want }); audioCtxRate = audioCtx.sampleRate; }
        catch (e) {
          // 老浏览器不支持 sampleRate 选项：退回默认（有镜像也比没声音强）
          try { audioCtx = new AC(); audioCtxRate = audioCtx.sampleRate; } catch (e2) { return null; }
        }
      }
      if (audioCtx.state === "suspended") { try { var p = audioCtx.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
      return audioCtx;
    }
    // 首次用户交互即预热 AudioContext（自动播报无手势时也能出声）
    if (typeof document !== "undefined" && AC) {
      document.addEventListener("pointerdown", function onFirstDown() {
        ensureAudioContext();
        document.removeEventListener("pointerdown", onFirstDown);
      });
    }
    function stopStream() {
      streamRunId = null;
      if (streamPollTimer) { clearInterval(streamPollTimer); streamPollTimer = null; }
      // 停掉 legacy 正在播的段
      if (streamAudio) { try { streamAudio.pause(); } catch (e) {} streamAudio = null; }
      streamPlaying = false;
      // 停掉 gapless 已调度源：先摘掉引用再 stop，避免 stop() 触发的 onended 重入
      var g = gapless;
      gapless = null;
      if (g) {
        for (var i = 0; i < g.sources.length; i++) { try { g.sources[i].stop(); } catch (e) {} }
        g.sources.length = 0;
        g.queue.length = 0;
        if (g.ready) g.ready.clear();
      }
      streamHooks = null;
      streamMode = "legacy";
    }
    function startStreamPlayer(runId, hooks, sampleRate) {
      stopStream();
      streamRunId = runId;
      streamHooks = hooks;
      if (typeof sampleRate === "number" && sampleRate > 0) streamSampleRate = sampleRate;
      streamFetched = 0;
      if (ensureAudioContext(streamSampleRate)) {
        streamMode = "gapless";
        gapless = { ctx: audioCtx, queue: [], sources: [], inflight: 0, scheduledEnd: 0, fetchDone: false, ended: 0,
          fetchSeq: 0, playSeq: 0, ready: new Map() };
        diag("stream-start", { mode: "gapless", runId: runId, sampleRate: streamSampleRate, ctxRate: audioCtxRate, ctx: audioCtx.state });
        pollStreamOnce();
        streamPollTimer = setInterval(pollStreamOnce, 300);
      } else {
        // 兜底：顺序 <audio>
        streamMode = "legacy";
        streamPlaying = false;
        diag("stream-start", { mode: "legacy", runId: runId, sampleRate: streamSampleRate });
        pollStreamOnce();
        streamPollTimer = setInterval(pollStreamOnce, 400);
      }
    }
    async function pollStreamOnce() {
      if (!streamRunId || streamBusy) return;
      if (streamMode === "gapless") {
        pumpQueue();                                // 先补上未来 5 秒内空出来的位置
        if (!gapless || gapless.fetchDone) return;
        if (gapless.queue.length + gapless.ready.size >= 3) return; // 预取够 3 段即可，避免堆积
      } else {
        if (streamPlaying) return; // 播放中不拉新段（防多音轨叠加）
      }
      streamBusy = true;
      let res = null;
      try { res = await rpc("streamNext", { runId: streamRunId }); } catch (e) { streamBusy = false; return; }
      streamBusy = false;
      if (!res || res.ok !== true) {
        // run 已结束被回收 → 视为正常结束，不误报错误
        if (res && res.error === "stream run not found") { endStreamNormally(); return; }
        failStream(res && res.error ? String(res.error) : "stream error");
        return;
      }
      if (res.url) {
        diag("seg-url", { format: res.format || "pcm", segments: res.segments });
        if (streamMode === "gapless") { enqueueSegment(res.url, res.format || "pcm", gapless ? gapless.fetchSeq++ : 0); return; }
        playStreamSegment(res.url);
        return;
      }
      if (res.done) {
        if (res.warn) console.warn("[voice]", res.warn);
        if (res.effortMapped) console.warn("[voice]", res.effortNote || "configured reasoning effort not applied");
        diag("stream-done", { error: res.error || "", warn: res.warn || "", fetched: streamFetched });
        if (res.error) { failStream(String(res.error)); return; }
        if (streamMode === "gapless") {
          if (gapless) gapless.fetchDone = true;
          pumpQueue();
          checkStreamEnd();
        } else {
          endStreamNormally();
        }
        return;
      }
      // pending：等下一拍
    }
    /** 裸 PCM（16bit 小端）→ AudioBuffer：无解码延迟，切在哪都无缝（主路径）。
     *  先做内容校验：长度必须为正偶数（16bit），且不能是容器头——
     *  非音频内容被当 PCM 播就是一片噪声，宁可走失败降级。
     *  只认 ID3/RIFF/OggS 这类 4 字节魔数：裸 PCM 碰巧撞上的概率可忽略。
     *  不要用 MP3 帧同步字（0xFF 0xEx）判断——PCM 段任意起点约有 3% 会撞上，会误杀正常段。 */
    function buildAudioBufferFromPcm(arrayBuffer, sampleRate) {
      const bytes = new Uint8Array(arrayBuffer);
      if (!bytes.length || (bytes.length & 1)) throw new Error("bad pcm length " + bytes.length);
      if (bytes.length >= 4) {
        const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;             // ID3
        const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46; // RIFF
        const ogg = bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;  // OggS
        if (id3 || riff || ogg) throw new Error("segment is not raw pcm");
      }
      const int16 = new Int16Array(arrayBuffer);
      const frames = int16.length;
      const buf = audioCtx.createBuffer(1, frames, sampleRate || streamSampleRate || 24000);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = int16[i] / 32768;
      return buf;
    }
    /** 取一段音频并按序入队：pcm 裸采样直接建 AudioBuffer；mp3/wav 容器段走 decodeAudioData
     * （wav 是本地引擎整段兜底段的格式——按裸 PCM 解码会出静音/杂音）。
     * 回调绑定发起时的播放轮次（g）：停止后立刻重播时，上一轮在飞的段不会漏进新一轮；
     * 解码结果按请求顺序放行（ready → queue），两个请求完成顺序颠倒也不会跳段。 */
    function enqueueSegment(url, format, seq) {
      var g = gapless;
      if (!g) return;
      g.inflight++;
      fetch(url)
        .then(function (r) { if (!r.ok) throw new Error("fetch " + r.status); return r.arrayBuffer(); })
        .then(function (buf) {
          if (format === "mp3" || format === "wav") return g.ctx.decodeAudioData(buf);
          return buildAudioBufferFromPcm(buf, streamSampleRate);
        })
        .then(function (buffer) {
          if (gapless !== g) return; // 已换轮次：丢弃，不动新一轮的计数
          g.inflight--;
          streamFetched++;
          g.ready.set(seq, buffer);
          drainReady(g);
          diag("seg-decoded", {
            n: streamFetched, seq: seq,
            seconds: Number((buffer.duration || 0).toFixed(2)),
            ahead: Number((g.scheduledEnd - g.ctx.currentTime).toFixed(2)),
            ctx: g.ctx.state,
          });
          pumpQueue();
        })
        .catch(function (e) {
          if (gapless === g) g.inflight--;
          console.warn("[voice] segment decode failed:", e && e.message || e);
          diag("seg-decode-fail", { msg: String(e && e.message || e).slice(0, 120), format: format, seq: seq });
          failStream("stream segment decode failed");
        });
    }
    /** 按序号把已解码的段放行到队列：缺号就等，保证播放顺序 = 请求顺序。 */
    function drainReady(g) {
      while (g.ready.has(g.playSeq)) {
        g.queue.push(g.ready.get(g.playSeq));
        g.ready.delete(g.playSeq);
        g.playSeq++;
      }
    }
    /** Web Audio lookahead 调度：只排未来 LOOKAHEAD_SEC 秒内的缓冲，其余留在队列，
     *  由 300ms 轮询与 onended 继续补；段与段按上一个结束时刻无缝接上。 */
    function pumpQueue() {
      if (!gapless || !gapless.queue.length) return;
      const ctx = gapless.ctx;
      const limit = ctx.currentTime + LOOKAHEAD_SEC;
      let t = Math.max(ctx.currentTime + 0.03, gapless.scheduledEnd);
      while (gapless.queue.length && t < limit) {
        const buf = gapless.queue.shift();
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(t);
        gapless.sources.push(src);
        src.onended = function () {
          if (!gapless) return;
          gapless.ended++;
          const idx = gapless.sources.indexOf(src);
          if (idx >= 0) gapless.sources.splice(idx, 1);
          checkStreamEnd();
          pumpQueue(); // 腾出位置，补下一段
        };
        t += buf.duration;
        gapless.scheduledEnd = t;
      }
    }
    function checkStreamEnd() {
      if (!gapless) return;
      if (gapless.fetchDone && !gapless.inflight && !gapless.queue.length && !gapless.ready.size && !gapless.sources.length) {
        endStreamNormally();
      }
    }
    function endStreamNormally() {
      const h = streamHooks;
      const played = gapless ? gapless.ended : 0;
      diag("stream-end", { played: played, fetched: streamFetched });
      stopStream();
      if (h && h.onEnd) h.onEnd();
    }
    function playStreamSegment(url) {
      streamPlaying = true;
      const audio = new Audio(url);
      streamAudio = audio;
      const next = () => {
        if (streamAudio === audio) streamAudio = null;
        streamPlaying = false;
        pollStreamOnce(); // 立即拉下一段
      };
      audio.onended = next;
      audio.onerror = () => {
        if (streamAudio === audio) streamAudio = null;
        streamPlaying = false;
        failStream("stream audio segment failed");
      };
      const p = audio.play();
      if (p && p.catch) p.catch(() => { if (streamAudio === audio) streamAudio = null; streamPlaying = false; failStream("stream playback blocked"); });
    }
    function failStream(reason) {
      const h = streamHooks;
      diag("stream-fail", { reason: String(reason || "").slice(0, 160), fetched: streamFetched });
      stopStream();
      if (h && h.onError) h.onError(reason);
    }

    // ---------- shell.overlay toast（回退/降级提示：不打断，6s 自动消失） ----------
    var toastState = { msg: null };
    var toastListeners = new Set();
    var toastTimer = null;
    function showToast(msg) {
      if (!msg) return;
      toastState.msg = String(msg);
      toastListeners.forEach((f) => f());
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastState.msg = null; toastListeners.forEach((f) => f()); }, 6000);
    }
    function VoiceToast() {
      const pair = React.useState(toastState.msg);
      const setMsg = pair[1];
      React.useEffect(() => {
        const refresh = () => setMsg(toastState.msg);
        toastListeners.add(refresh);
        return () => { toastListeners.delete(refresh); };
      }, []);
      if (!pair[0]) return null;
      return React.createElement("div", { className: "dsh-voice-toast", role: "status" }, pair[0]);
    }

    /** TTS 失败原因分类（Host 的 ttsErrorKind）→ 可读标签；无 kind（旧响应）退回通用文案。 */
    function ttsFailLabel(kind) {
      if (kind === "model-missing") return t("toast.ttsModelMissing");
      if (kind === "load-failed") return t("toast.ttsLoadFailed");
      if (kind === "synth-failed") return t("toast.ttsSynthFailed");
      if (kind === "unavailable") return t("toast.ttsUnavailable");
      if (kind === "timeout") return t("toast.ttsTimeout");
      if (kind === "http") return t("toast.ttsHttp");
      return t("toast.fallback");
    }

    /** 统一播报入口：双向流流式 > 云 TTS 音频 > 浏览器 speechSynthesis；ttsError/degraded/warn 降级告警。 */
    function playResult(res, hooks) {
      stopPlaybackOnly();
      if (res && res.notice) { console.warn("[voice]", res.notice); showToast(res.notice); }
      if (res && res.ttsError) {
        console.warn("[voice] tts failed, fallback to browser speech:", res.ttsErrorKind || "", res.ttsError);
        var hint = (res.ttsErrorKind === "model-missing" || res.ttsErrorKind === "load-failed") ? "（见 docs/local-tts.md）" : "";
        showToast(ttsFailLabel(res.ttsErrorKind) + "：" + String(res.ttsError).slice(0, 140) + hint);
      }
      if (res && res.degraded) { console.warn("[voice]", t("read.degraded")); showToast(t("read.degraded")); }
      if (res && res.effortMapped) console.warn("[voice]", res.effortNote || "configured reasoning effort not applied");
      if (res && res.warn) console.warn("[voice]", res.warn);
      if (res && res.messageId) beginPlayback(res.messageId);
      diag("play-result", { mode: res && res.mode || "", engine: res && res.engine || "", ttsError: (res && res.ttsError ? String(res.ttsError).slice(0, 100) : ""), degraded: !!(res && res.degraded), notice: (res && res.notice ? String(res.notice).slice(0, 100) : "") });
      const done = hooks && hooks.onEnd;
      const wrapped = {
        onEnd: () => { if (res && res.messageId) finishPlayback(res.messageId, "done"); if (done) done(); },
        onError: (reason) => {
          // 出错/被打断时同样要收尾状态：否则徽标会停在"朗读中"
          if (res && res.messageId) finishPlayback(res.messageId, null);
          if (hooks && hooks.onError) hooks.onError(reason);
        },
      };
      if (res && res.mode === "stream" && res.runId) { startStreamPlayer(res.runId, wrapped, res.sampleRate); return true; }
      var started = res && res.audioUrl ? playAudio(res.audioUrl, wrapped) : speakText(res && res.transcript, res && res.speech, wrapped);
      if (!started && res && res.messageId) finishPlayback(res.messageId, null);
      return started;
    }

    // ---------- 共享开关状态 ----------
    var autoState = { enabled: false };
    var autoListeners = new Set();
    function setAutoEnabled(v) {
      autoState.enabled = !!v;
      autoListeners.forEach((f) => f());
    }
    function refreshAutoFromHost() {
      rpc("getState").then((res) => { if (res && res.ok) setAutoEnabled(res.autoSpeak); }).catch(() => {});
    }

    // ---------- 原生风格图标（对齐 ic_ds_*：16×16、currentColor、strokeWidth 1.3、圆角圆头） ----------
    // 原生图标集无喇叭/停止；喇叭按 ic_ds_* 的 Outline 风格手绘（与刷新/停止同族权重），
    // refresh/stop 直接内联原生 IconRefreshOutline16 / IconStopFill16 路径。
    // 喇叭几何常量是唯一来源：React 组件与设置页 CSS 遮罩共用，重画图标时不会两处漂移。
    // 经典喇叭口造型：左箱体 + 向右扩张的喇叭口（外缘圆角竖边）+ 双声波弧；所有角用 Q 圆化。
    var SPEAKER_D = "M2.9 6.2 L4.4 6.2 Q5 6.2 5.5 5.87 L9.22 3.42 Q10.3 2.7 10.3 4 L10.3 12 Q10.3 13.3 9.22 12.58 L5.5 10.13 Q5 9.8 4.4 9.8 L2.9 9.8 Q1.9 9.8 1.9 8.8 L1.9 7.2 Q1.9 6.2 2.9 6.2 Z";
    var SPEAKER_WAVE1_D = "M12.55 5.95 A2.9 2.9 0 0 1 12.55 10.05";
    var SPEAKER_WAVE2_D = "M13.89 4.61 A4.8 4.8 0 0 1 13.89 11.39";
    var SPEAKER_MUTE_D = "M2 2.9 L10.8 13.1";
    /** 喇叭：Outline 主体 + 两段声波弧；muted=true 主体 + 斜杠（静音）。 */
    function IconSpeaker(props) {
      const size = props && props.size || 16;
      const muted = !!(props && props.muted);
      return React.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true },
        React.createElement("path", { d: SPEAKER_D, stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" }),
        React.createElement("path", { d: muted ? SPEAKER_MUTE_D : SPEAKER_WAVE1_D, stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
        muted ? null : React.createElement("path", { d: SPEAKER_WAVE2_D, stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }));
    }
    /** 停止方块（播放中，点击即停）——内联原生 IconStopFill16。 */
    function IconStop(props) {
      const size = props && props.size || 16;
      return React.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true },
        React.createElement("path", { d: "M2 4.88C2 3.68009 2 3.08013 2.30557 2.65954C2.40426 2.52371 2.52371 2.40426 2.65954 2.30557C3.08013 2 3.68009 2 4.88 2H11.12C12.3199 2 12.9199 2 13.3405 2.30557C13.4763 2.40426 13.5957 2.52371 13.6944 2.65954C14 3.08013 14 3.68009 14 4.88V11.12C14 12.3199 14 12.9199 13.6944 13.3405C13.5957 13.4763 13.4763 13.5957 13.3405 13.6944C12.9199 14 12.3199 14 11.12 14H4.88C3.68009 14 3.08013 14 2.65954 13.6944C2.52371 13.5957 2.40426 13.4763 2.30557 13.3405C2 12.9199 2 12.3199 2 11.12V4.88Z", fill: "currentColor" }));
    }
    /** 重新生成（一个圈）——内联原生 IconRefreshOutline16。 */
    function IconRegen(props) {
      const size = props && props.size || 16;
      return React.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true },
        React.createElement("path", { d: "M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z", fill: "currentColor" }));
    }

    // ---------- 设置页导航图标补丁 ----------
    // shell 的 navIcon(id) 只识别 models/agent-presets/plugins，voice 回退为齿轮（源码硬编码，无扩展点）；
    // settings.section 槽位注册不支持自定义 icon，故在设置面板挂载后给语音行加类名，
    // 由 CSS 隐藏齿轮 svg、以喇叭遮罩替身展示（不动 React 节点，避免被 reconcile 覆盖）。
    // 遮罩 URL 由喇叭几何常量生成（与 React 组件同源）：重画图标时只改常量一处即可。
    function speakerMaskBackground() {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">'
        + '<path d="' + SPEAKER_D + '" stroke="#000" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="' + SPEAKER_WAVE1_D + '" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>'
        + '<path d="' + SPEAKER_WAVE2_D + '" stroke="#000" stroke-width="1.3" stroke-linecap="round"/></svg>';
      const url = 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
      return 'background:currentColor;-webkit-mask:' + url + ' center/contain no-repeat;mask:' + url + ' center/contain no-repeat;';
    }
    function patchSettingsNavIcon() {
      const labels = ["语音播报", "Voice Readout"];
      document.querySelectorAll('[role="dialog"] nav button').forEach((btn) => {
        const span = btn.querySelector("span");
        if (!span || labels.indexOf((span.textContent || "").trim()) < 0) return;
        if (btn.classList.contains("dsh-voice-nav-speaker")) return;
        btn.classList.add("dsh-voice-nav-speaker");
      });
    }
    let navIconObserver = null;
    function startNavIconPatching() {
      patchSettingsNavIcon();
      if (navIconObserver || typeof MutationObserver === "undefined") return;
      navIconObserver = new MutationObserver(function () { patchSettingsNavIcon(); });
      navIconObserver.observe(document.body, { childList: true, subtree: true });
    }
    function stopNavIconPatching() {
      if (navIconObserver) { navIconObserver.disconnect(); navIconObserver = null; }
    }

    // ---------- 每条消息的"朗读"按钮 ----------
    function VoiceReadButton(props) {
      const statusPair = React.useState("idle"); // idle | busy | speaking | error
      const status = statusPair[0];
      const setStatus = statusPair[1];
      const errorPair = React.useState("");
      const lastError = errorPair[0];
      const setLastError = errorPair[1];

      // 不在这里做"卸载即停播"：消息行在滚动/重渲染时可能被卸载，会把正在播的音频
      // 静默掐掉并留下错误的"朗读中"状态；停播统一交给显式停止、换 turn、插件卸载三条路径。
      React.useEffect(() => {
        const sync = () => {
          const s = spokenState[String(props.messageId)];
          setStatus((prev) => {
            if (s === "speaking") return "speaking";
            return prev === "speaking" ? "idle" : prev;
          });
        };
        spokenListeners.add(sync);
        sync();
        return () => { spokenListeners.delete(sync); };
      }, [props.messageId]);

      async function runSpeak(regen) {
        if (status === "busy") return;
        setLastError("");
        setStatus("busy");
        try {
          const res = await rpc("speak", { sessionId: String(props.sessionId), messageId: String(props.messageId), regen: regen || false });
          if (!res || res.ok !== true) {
            setLastError(res && res.error ? String(res.error) : "unknown error");
            setStatus("error");
            return;
          }
          if (res.degraded) setLastError(t("read.degraded"));
          const started = playResult(res, {
            onEnd: () => setStatus("idle"),
            onError: (reason) => { setLastError(reason); setStatus("error"); },
          });
          if (!started) { setLastError("browser speechSynthesis unavailable"); setStatus("error"); return; }
          setStatus("speaking");
        } catch (error) {
          setLastError(String(error && error.message || error));
          setStatus("error");
        }
      }
      function onClick() {
        if (status === "speaking") { stopAll(); setStatus("idle"); return; }
        runSpeak(false);
      }
      function onRegen() {
        // 重新生成：跳过转写缓存、用当前配置全新转写+合成（覆盖旧缓存条目）
        if (status === "busy") return;
        if (status === "speaking") stopAll();
        runSpeak(true);
      }

      // 图标按钮（ic_ds_* 原生风格）：idle=喇叭 / busy=喇叭（禁用降透明）/
      // speaking=停止方块 / error=喇叭+错误色；文字进 title（hover 提示）+ aria-label
      let icon = React.createElement(IconSpeaker, { size: 16 });
      let title = t("read.title");
      let iconClass = "dsh-voice-icon-btn";
      if (status === "busy") { title = t("read.busyTitle"); }
      else if (status === "speaking") { icon = React.createElement(IconStop, { size: 16 }); title = t("read.stopTitle"); }
      else if (status === "error") { title = t("read.failPrefix") + (lastError || "unknown"); iconClass = "dsh-voice-icon-btn err"; }

      // 重新生成按钮：仅在该消息完整朗读过一次（spokenState=done）后出现；busy 时禁用
      const regenShown = spokenState[String(props.messageId)] === "done";

      return React.createElement(React.Fragment, null,
        React.createElement("button", {
          className: iconClass,
          onClick,
          title,
          "aria-label": title,
          disabled: status === "busy",
        }, icon),
        regenShown ? React.createElement("button", {
          className: "dsh-voice-icon-btn",
          onClick: onRegen,
          title: t("read.regenerate"),
          "aria-label": t("read.regenerate"),
          disabled: status === "busy",
        }, React.createElement(IconRegen, { size: 16 })) : null);
    }

    // ---------- 输入框左下角"自动朗读"开关 ----------
    function AutoToggle() {
      const pair = React.useState(autoState.enabled);
      const enabled = pair[0];
      const setEnabled = pair[1];
      React.useEffect(() => {
        const refresh = () => setEnabled(autoState.enabled);
        autoListeners.add(refresh);
        refreshAutoFromHost();
        return () => { autoListeners.delete(refresh); };
      }, []);
      async function onClick() {
        const next = !autoState.enabled;
        setAutoEnabled(next);
        try {
          const res = await rpc("setAuto", { enabled: next });
          if (res && res.ok) setAutoEnabled(res.autoSpeak);
        } catch (e) { /* 下轮刷新对齐 */ }
      }
      return React.createElement("button", {
        className: "dsh-voice-read-btn" + (enabled ? " on" : ""),
        onClick,
        title: t("auto.title"),
      },
        React.createElement(IconSpeaker, { size: 14, muted: !enabled }),
        React.createElement("span", null, enabled ? t("auto.on") : t("auto.off")));
    }

    // ---------- turnTail 徽标（只 claim 读过的轮次，不抢 deliverables 产物链） ----------
    // list 槽位没有 select：自己在渲染时读本轮的 voice 数据，读不到/没读过就返回 null（不占位）。
    function VoiceTurnBadge(props) {
      // 订阅播报状态变更：没有订阅时 React 不会因 spokenState 变化重渲染，
      // 徽标会永远停在上一次渲染的"朗读中…"（已结束、已停止都看不见）。
      const tickPair = React.useState(0);
      const setTick = tickPair[1];
      React.useEffect(() => {
        const refresh = () => setTick((n) => n + 1);
        spokenListeners.add(refresh);
        return () => { spokenListeners.delete(refresh); };
      }, []);
      const turn = props.turn;
      const v = turn && turn.data && turn.data.get ? turn.data.get("voice") : undefined;
      const messageId = v && v.messageId ? String(v.messageId) : "";
      const state = messageId ? spokenState[messageId] : undefined;
      if (!messageId || !state) return null;
      async function onReplay() {
        // "朗读中…"时点击 = 停止，而不是再起一条全新播报（每起一条都要重新转写 = 再烧一次 token）
        if (state === "speaking") { stopAll(); return; }
        try {
          const res = await rpc("speak", { sessionId: String(props.sessionId), messageId: messageId });
          if (res && res.ok) playResult(res, {});
        } catch (e) {}
      }
      return React.createElement("button", {
        className: "dsh-voice-badge",
        onClick: onReplay,
        title: state === "speaking" ? t("read.stopTitle") : t("badge.replay"),
      }, state === "speaking" ? t("badge.speaking") : t("badge.done"));
    }

    /** conversation Definition：把每轮最后一条含 text 的助手消息 id 写进 turn 数据（key 'voice'）。 */
    var voiceDefinition = {
      kind: "voice",
      match: (event) => {
        if (event.type === "turn/start") return { id: String(event.data.turn), role: "start" };
        if (event.type === "assistant/message") return { id: String(event.data.turn), role: "update" };
        return null;
      },
      start: (_context, match) => ({ turn: match.event.data.turn, messageId: null }),
      update: (context, match) => {
        if (match.event.type !== "assistant/message") return context.state;
        const d = match.event.data;
        const hasText = d && d.message && Array.isArray(d.message.content)
          && d.message.content.some((b) => b && b.type === "text" && typeof b.text === "string" && b.text.trim());
        if (!hasText) return context.state;
        return Object.assign({}, context.state, { messageId: String(d.message.id) });
      },
      buildLocationData: (context, scope) => scope !== "turn" || !context.state || !context.state.messageId ? null : {
        kind: "turn",
        turn: context.state.turn,
        key: "voice",
        value: { messageId: context.state.messageId },
      },
    };

    // ---------- 提示音（设置页第五层；独立 AudioContext，不碰播报链） ----------
    // 信号全部来自客户端 uiSession.sessionStatus（Map<sessionId, {running, pendingInteraction, completionUnread}>，
    // 有 getSnapshot/subscribe）：
    //  - 工作音：顶层会话 running 计数 0→>0 起、>0→0 停
    //  - 完成音：顶层会话 running 真→假（不用 turn/end——那个只服务自动播报）
    //  - 提问音：pendingInteraction.kind 为 question / plan-review；审批（kind=approval）不响
    // 子代理也会往同一个 store 写 status，必须 join ctx.sessions.list，按 origin/parentId 只认顶层会话。
    // 上下文必须独立：现有播报上下文固定 24kHz、且会被 stopPlaybackOnly 连坐（播报一停提示音跟着哑）。
    var CHIME_KINDS = ["work", "done", "ask"];
    var CHIME_VOLUME_DEFAULT = 0.3;
    var CHIME_MIN_LOOP_SEC = 2;         // 素材短于 2 秒时 loop 会变蜂鸣 → 改成每 2 秒一次
    var CHIME_DONE_SUPPRESS_MS = 1000;  // 完成音抑制窗：一段时间内多次结束只响一次
    var CHIME_MAX_BYTES = 10 * 1024 * 1024;
    var CHIME_MAX_SEC = 60;

    var pluginCtx = null;      // apply 时记下：uiSession / sessions 都是可选服务
    var chimeCfg = null;       // 归一化后的 chime 配置（Host 的 Config.chime 快照）
    var chimeCtx = null;       // 提示音专用 AudioContext
    var chimeMaster = null;    // 总音量 master gain
    var chimeNodes = {};       // slot → { src, gain }（正在响的实例；先停后起）
    var chimeBuffers = {};     // "kind|file" → AudioBuffer（默认音同样缓存）
    var chimeWorkTimer = null; // 短素材工作音的重复定时器
    var chimeWorkPending = false; // 工作音素材正在加载（防同一次状态变化叠两条）
    var chimeWorkGen = 0;      // 加载途中被停过 → 迟到的加载结果不许起播
    var chimeDoneAt = 0;       // 上一次完成音的时间（抑制窗）
    var chimePrevRunning = {}; // sessionId → 上一次 running（判真→假）
    var chimeAskKeys = {};     // interaction key → true（同一交互只响一次）
    var chimeMissing = {};     // kind → 配置里的文件名（读不到、已回落默认音）
    var chimePreheat = null;   // 首次交互预热用的监听器

    function chimeSupported() {
      return typeof window !== "undefined" && !!(window.AudioContext || window.webkitAudioContext);
    }
    /** 可选服务查找：没有该服务时返回 undefined（缺 uiSession 就静默降级，不影响播报）。 */
    function clientService(name) {
      var c = pluginCtx;
      if (!c) return undefined;
      try {
        if (typeof c.get === "function") {
          var hit = c.get(name);
          if (hit !== undefined) return hit;
        }
      } catch (e) { /* 服务未提供：按缺失处理 */ }
      try { return c[name]; } catch (e2) { return undefined; }
    }
    function normalizeChimeRow(row) {
      var r = row && typeof row === "object" ? row : {};
      return {
        enabled: !!r.enabled,
        source: r.source === "custom" ? "custom" : "default",
        file: typeof r.file === "string" ? r.file : "",
      };
    }
    function normalizeChimeCfg(chime) {
      var c = chime && typeof chime === "object" ? chime : {};
      var vol = typeof c.volume === "number" && isFinite(c.volume) ? c.volume : CHIME_VOLUME_DEFAULT;
      return {
        enabled: !!c.enabled,
        volume: Math.max(0, Math.min(1, vol)),
        work: normalizeChimeRow(c.work),
        done: normalizeChimeRow(c.done),
        ask: normalizeChimeRow(c.ask),
      };
    }
    function chimeRowEnabled(kind) {
      return !!(chimeCfg && chimeCfg.enabled && chimeCfg[kind] && chimeCfg[kind].enabled);
    }
    function chimeSourceOf(row) {
      return row && row.source === "custom" ? String(row.file || "") : "";
    }
    function ensureChimeCtx() {
      if (!chimeCtx) {
        if (!chimeSupported()) return null;
        try {
          var Ctor = window.AudioContext || window.webkitAudioContext;
          chimeCtx = new Ctor();
          chimeMaster = chimeCtx.createGain();
          chimeMaster.gain.value = chimeCfg ? chimeCfg.volume : CHIME_VOLUME_DEFAULT;
          chimeMaster.connect(chimeCtx.destination);
        } catch (e) {
          chimeCtx = null;
          chimeMaster = null;
          return null;
        }
      }
      if (chimeCtx.state === "suspended") {
        try { var p = chimeCtx.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
      }
      return chimeCtx;
    }
    function applyChimeVolume() {
      if (chimeMaster && chimeCfg) chimeMaster.gain.value = chimeCfg.volume;
    }
    /** 默认三音：程序合成（正弦振荡 + 指数衰减包络），不随包带音频文件。 */
    var CHIME_SYNTH = {
      work: { total: 2.4, notes: [{ f: 523.25, t: 0, d: 0.26, g: 0.45 }, { f: 392.0, t: 1.2, d: 0.4, g: 0.4 }] },
      done: { total: 0.7, notes: [{ f: 1046.5, t: 0, d: 0.18, g: 0.55 }, { f: 1318.51, t: 0.16, d: 0.44, g: 0.5 }] },
      ask: { total: 0.62, notes: [{ f: 880.0, t: 0, d: 0.2, g: 0.55 }, { f: 1108.73, t: 0.18, d: 0.36, g: 0.5 }] },
    };
    function synthChimeBuffer(ctx, kind) {
      var spec = CHIME_SYNTH[kind] || CHIME_SYNTH.done;
      var rate = ctx.sampleRate || 44100;
      var len = Math.max(1, Math.round(spec.total * rate));
      var buffer = ctx.createBuffer(1, len, rate);
      var data = buffer.getChannelData(0);
      for (var n = 0; n < spec.notes.length; n++) {
        var note = spec.notes[n];
        var start = Math.round(note.t * rate);
        var dur = Math.max(1, Math.round(note.d * rate));
        for (var i = 0; i < dur; i++) {
          var idx = start + i;
          if (idx >= len) break;
          var t = i / rate;
          var env = Math.exp(-4.5 * (i / dur));          // 衰减包络
          var attack = Math.min(1, t / 0.004);           // 4ms 起音，避免爆音
          data[idx] += Math.sin(2 * Math.PI * note.f * t) * env * attack * note.g;
        }
      }
      var peak = 0;
      var k;
      for (k = 0; k < len; k++) { var a = Math.abs(data[k]); if (a > peak) peak = a; }
      if (peak > 0.95) { var s = 0.95 / peak; for (k = 0; k < len; k++) data[k] *= s; }
      return buffer;
    }
    /** 取某类音的 AudioBuffer：默认音现场合成；自定义音 GET /voice/sounds/<file> 后解码。
     *  文件读不到/解不了 → 回落默认音（记进 chimeMissing 供设置页提示），不静默哑掉。 */
    function chimeBufferFor(kind, row) {
      var ctx = ensureChimeCtx();
      if (!ctx) return Promise.resolve(null);
      var file = chimeSourceOf(row);
      var key = kind + "|" + (file || "default");
      if (chimeBuffers[key]) {
        if (file) delete chimeMissing[kind];
        return Promise.resolve(chimeBuffers[key]);
      }
      if (!file) {
        chimeBuffers[key] = synthChimeBuffer(ctx, kind);
        return Promise.resolve(chimeBuffers[key]);
      }
      return fetch("/voice/sounds/" + encodeURIComponent(file), { cache: "no-store" }).then(function (res) {
        if (!res || !res.ok) throw new Error("sound not found: " + file);
        return res.arrayBuffer();
      }).then(function (raw) {
        return new Promise(function (resolve, reject) {
          var ret = ctx.decodeAudioData(raw, resolve, reject);
          if (ret && ret.then) ret.then(resolve, reject);
        });
      }).then(function (buffer) {
        chimeBuffers[key] = buffer;
        delete chimeMissing[kind];
        return buffer;
      }).catch(function () {
        chimeMissing[kind] = file;
        var fallback = synthChimeBuffer(ctx, kind);
        chimeBuffers[kind + "|default"] = fallback;
        return fallback;
      });
    }
    /** 停掉某 slot 正在响的实例（loop 与一次性共用这张表）。 */
    function stopChime(slot) {
      var node = chimeNodes[slot];
      if (!node) return;
      chimeNodes[slot] = null;
      try { node.src.onended = null; } catch (e) {}
      try { node.src.stop(); } catch (e) {}
      try { node.src.disconnect(); } catch (e) {}
      try { node.gain.disconnect(); } catch (e) {}
    }
    function stopWorkTimer() {
      if (!chimeWorkTimer) return;
      clearInterval(chimeWorkTimer);
      chimeWorkTimer = null;
    }
    function stopChimes() {
      stopWorkTimer();
      for (var i = 0; i < CHIME_KINDS.length; i++) stopChime(CHIME_KINDS[i]);
      // 试听走独立 slot（试听不打断正在响的工作音，但总开关关掉时要一起停）
      for (var slot in chimeNodes) { if (slot.indexOf("preview:") === 0) stopChime(slot); }
    }
    /** 播一次（loop=true 循环）；先停同类旧实例——重置时不许两条叠着。
     *  opts.buffer 已预载时直接播（工作音避免"加载途中又来一次状态变化"叠两条）；
     *  opts.slot 用于试听另开一条通道（不打断正在响的工作音）。 */
    function playChime(kind, opts) {
      var options = opts || {};
      var ctx = ensureChimeCtx();
      if (!ctx) return Promise.resolve(false);
      if (options.needsCfg !== false && !chimeRowEnabled(kind)) return Promise.resolve(false);
      var loading = options.buffer
        ? Promise.resolve(options.buffer)
        : chimeBufferFor(kind, options.row || (chimeCfg && chimeCfg[kind]));
      return loading.then(function (buffer) {
        if (!buffer || !chimeCtx) return false;
        if (options.needsCfg !== false && !chimeRowEnabled(kind)) return false;
        var slot = options.slot || kind;
        stopChime(slot);
        var src = chimeCtx.createBufferSource();
        src.buffer = buffer;
        src.loop = !!options.loop;
        var gain = chimeCtx.createGain();
        gain.gain.value = typeof options.gain === "number" ? Math.max(0, Math.min(1, options.gain)) : 1;
        src.connect(gain);
        gain.connect(options.destination || chimeMaster);
        var node = { src: src, gain: gain };
        chimeNodes[slot] = node;
        src.onended = function () { if (chimeNodes[slot] === node) chimeNodes[slot] = null; };
        try { src.start(0); } catch (e) { chimeNodes[slot] = null; return false; }
        return true;
      }).catch(function () { return false; });
    }
    /** 工作音：长素材 loop 单条；短素材（<2 秒）每 2 秒响一次。
     *  pending/gen 两道闸：加载途中又来一次状态变化不许叠第二条，停了以后也不许"迟到起播"。 */
    function startWorkChime() {
      if (!chimeRowEnabled("work")) return;
      if (chimeWorkTimer || chimeNodes.work || chimeWorkPending) return;
      if (!ensureChimeCtx()) return;
      chimeWorkPending = true;
      var gen = ++chimeWorkGen;
      chimeBufferFor("work", chimeCfg.work).then(function (buffer) {
        chimeWorkPending = false;
        if (gen !== chimeWorkGen) return;
        if (!buffer || chimeWorkTimer || chimeNodes.work) return;
        if (!chimeRowEnabled("work")) return;
        if (buffer.duration >= CHIME_MIN_LOOP_SEC) { playChime("work", { loop: true, buffer: buffer }); return; }
        playChime("work", { buffer: buffer });
        chimeWorkTimer = setInterval(function () {
          if (!chimeRowEnabled("work")) { stopWorkTimer(); stopChime("work"); return; }
          playChime("work", {});
        }, CHIME_MIN_LOOP_SEC * 1000);
      }, function () { chimeWorkPending = false; });
    }
    function stopWorkChime() {
      chimeWorkGen++;
      chimeWorkPending = false;
      stopWorkTimer();
      stopChime("work");
    }
    function triggerDoneChime() {
      if (!chimeRowEnabled("done")) return;
      var now = Date.now();
      if (now - chimeDoneAt < CHIME_DONE_SUPPRESS_MS) return;
      chimeDoneAt = now;
      stopChime("done");                 // 重置：先停旧的，再起新的
      playChime("done", {});
    }
    function triggerAskChime(key) {
      if (!chimeRowEnabled("ask")) return;
      if (chimeAskKeys[key]) return;     // 按 interaction key 去重
      chimeAskKeys[key] = true;
      stopChime("ask");
      playChime("ask", {});
    }
    /** 只认顶层会话：子代理也写同一个 status，不按 origin/parentId 过滤就会多响。 */
    function isTopLevelSession(id) {
      var sessions = clientService("sessions");
      var list = null;
      try {
        if (sessions && sessions.list && sessions.list.getSnapshot) list = sessions.list.getSnapshot();
      } catch (e) { return true; }
      if (!list || !list.byId) return true;      // 拿不到会话表：不因缺信息丢音
      var row = list.byId[id];
      if (!row) return true;                     // status 里可能有列表还没收到的 id
      if (row.origin === "subagent") return false;
      if (row.parentId !== undefined && row.parentId !== null) return false;
      return true;
    }
    /** 状态对账：work 计数、done 真→假、ask 按 key 去重。 */
    function chimeTick() {
      if (!chimeCfg || !chimeCfg.enabled) { stopChimes(); return; }
      var uiSession = clientService("uiSession");
      if (!uiSession || !uiSession.sessionStatus) return;   // 缺服务：静默，不影响播报
      var snap;
      try { snap = uiSession.sessionStatus.getSnapshot(); } catch (e) { return; }
      if (!snap || typeof snap.forEach !== "function") return;
      var runningCount = 0;
      var liveAsk = {};
      var seen = {};
      snap.forEach(function (st, id) {
        if (isTopLevelSession(id)) {
          seen[id] = true;
          var running = !!(st && st.running);
          if (running) runningCount += 1;
          if (running) chimePrevRunning[id] = true;
          else {
            if (chimePrevRunning[id] === true) triggerDoneChime();
            chimePrevRunning[id] = false;
          }
          var interaction = st && st.pendingInteraction;
          if (interaction && typeof interaction === "object") {
            var kind = interaction.kind;
            if (kind === "question" || kind === "plan-review") {
              var key = String(interaction.key || (id + ":pending"));
              liveAsk[key] = true;
              triggerAskChime(key);
            }
          }
        }
      });
      for (var sid in chimePrevRunning) { if (!seen[sid]) delete chimePrevRunning[sid]; }
      for (var k in chimeAskKeys) { if (!liveAsk[k]) delete chimeAskKeys[k]; }
      if (runningCount > 0) startWorkChime();
      else stopWorkChime();
    }
    /** 应用一份 chime 配置：关掉立即停；打开按当前状态立刻起（不用等下一次状态变化）。 */
    function applyChimeConfig(chime) {
      chimeCfg = normalizeChimeCfg(chime);
      if (chimeCfg.enabled) {
        ensureChimeCtx();       // 关着的时候不建上下文：不占声卡、不需要手势
        applyChimeVolume();
        chimeTick();
      } else {
        stopChimes();
      }
      if (!chimeRowEnabled("work")) stopWorkChime();
    }
    function loadChimeConfig() {
      return rpc("getConfig").then(function (res) {
        if (res && res.ok && res.config) applyChimeConfig(res.config.chime);
        return res;
      }).catch(function () { return null; });
    }
    /** 首次 pointerdown/keydown 预热并 resume 上下文（自动播报没有手势，提示音要提前拿到声卡）。 */
    function armChimePreheat() {
      if (typeof document === "undefined" || !chimeSupported()) return;
      chimePreheat = function () {
        ensureChimeCtx();
        if (!chimePreheat) return;
        document.removeEventListener("pointerdown", chimePreheat, true);
        document.removeEventListener("keydown", chimePreheat, true);
        chimePreheat = null;
      };
      document.addEventListener("pointerdown", chimePreheat, true);
      document.addEventListener("keydown", chimePreheat, true);
    }
    function disposeChime() {
      stopChimes();
      if (typeof document !== "undefined" && chimePreheat) {
        document.removeEventListener("pointerdown", chimePreheat, true);
        document.removeEventListener("keydown", chimePreheat, true);
      }
      chimePreheat = null;
      var ctx = chimeCtx;
      chimeCtx = null;
      chimeMaster = null;
      chimeBuffers = {};
      chimeNodes = {};
      if (ctx) { try { ctx.close(); } catch (e) {} }
    }
    /** 服务可用就订阅 sessionStatus；缺 uiSession 直接返回（静默降级）。 */
    function startChimeWatch() {
      var uiSession = clientService("uiSession");
      if (!uiSession || !uiSession.sessionStatus) return;
      var unsubscribe = null;
      try { unsubscribe = uiSession.sessionStatus.subscribe(chimeTick); } catch (e) { unsubscribe = null; }
      chimeTick();
      if (unsubscribe && pluginCtx && typeof pluginCtx.effect === "function") {
        pluginCtx.effect(function () { return function () { try { unsubscribe(); } catch (e) {} }; }, "voice: chime status");
      }
    }
    /** 探一个素材文件在不在（设置页提示用；HEAD 只问在不在，不下载整段音频）。 */
    function probeSoundFile(file) {
      if (!file) return Promise.resolve(true);
      return fetch("/voice/sounds/" + encodeURIComponent(file), { method: "HEAD", cache: "no-store" })
        .then(function (res) { return !!(res && res.ok); })
        .catch(function () { return false; });
    }
    /** 试听：按设置页当前的（可能还没保存的）音源与总音量播一次；另开 slot，不打断工作音。 */
    function previewChime(kind, row, volume) {
      var ctx = ensureChimeCtx();
      if (!ctx) return Promise.resolve(false);
      var vol = typeof volume === "number" && isFinite(volume) ? Math.max(0, Math.min(1, volume)) : (chimeCfg ? chimeCfg.volume : CHIME_VOLUME_DEFAULT);
      return playChime(kind, {
        row: normalizeChimeRow(row),
        needsCfg: false,
        slot: "preview:" + kind,
        gain: vol,
        destination: ctx.destination,
      });
    }
    /** 读时长（<audio> 元数据，不播）；读不到返回 null，由解码那一步给结论。 */
    function readAudioDuration(file) {
      return new Promise(function (resolve) {
        if (typeof Audio === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) { resolve(null); return; }
        var url = null;
        try { url = URL.createObjectURL(file); } catch (e) { resolve(null); return; }
        var audio = new Audio();
        var done = false;
        function finish(value) {
          if (done) return;
          done = true;
          try { audio.removeAttribute("src"); audio.load(); } catch (e) {}
          try { URL.revokeObjectURL(url); } catch (e) {}
          resolve(value);
        }
        audio.preload = "metadata";
        audio.onloadedmetadata = function () { finish(isFinite(audio.duration) ? audio.duration : null); };
        audio.onerror = function () { finish(null); };
        setTimeout(function () { finish(null); }, 5000);
        audio.src = url;
      });
    }
    /** decodeAudioData 试解一次：浏览器解不了的容器，传上去也播不出来。 */
    function decodeProbe(file) {
      var ctx = ensureChimeCtx();
      if (!ctx || typeof ctx.decodeAudioData !== "function") return Promise.resolve({ ok: true });
      return file.arrayBuffer().then(function (raw) {
        return new Promise(function (resolve) {
          var settled = false;
          function ok(buffer) { if (settled) return; settled = true; resolve({ ok: true, duration: buffer && buffer.duration || 0 }); }
          function bad() { if (settled) return; settled = true; resolve({ ok: false }); }
          try {
            var ret = ctx.decodeAudioData(raw, ok, bad);
            if (ret && ret.then) ret.then(ok, bad);
          } catch (e) { bad(); }
        });
      }).catch(function () { return { ok: false }; });
    }
    /** 上传体检 → POST：本地先看大小/时长/能不能解码，通过才发（Host 只管大小与魔数）。 */
    async function uploadChimeSound(kind, file) {
      if (!file) return { ok: false, error: "empty" };
      if (file.size > CHIME_MAX_BYTES) return { ok: false, error: "too-large" };
      var seconds = await readAudioDuration(file);
      if (typeof seconds === "number" && seconds > CHIME_MAX_SEC) return { ok: false, error: "too-long", seconds: seconds };
      var probed = await decodeProbe(file);
      if (!probed.ok) return { ok: false, error: "undecodable" };
      if (typeof seconds !== "number" && probed.duration > CHIME_MAX_SEC) {
        return { ok: false, error: "too-long", seconds: probed.duration };
      }
      var res = await fetch("/voice/sounds?kind=" + encodeURIComponent(kind) + "&name=" + encodeURIComponent(String(file.name || kind)), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      var body = null;
      try { body = await res.json(); } catch (e) {}
      if (!res.ok || !body || body.ok !== true) {
        return { ok: false, error: "upload-failed", detail: body && body.error };
      }
      return { ok: true, file: body.file };
    }
    function chimeErrorText(out) {
      if (!out) return t("chime.uploadFailUnknown");
      if (out.error === "too-large") return t("chime.tooLarge");
      if (out.error === "too-long") return t("chime.tooLong").replace("{seconds}", String(Math.round(out.seconds || 0)));
      if (out.error === "undecodable") return t("chime.undecodable");
      if (out.detail) return String(out.detail);
      return t("chime.uploadFailUnknown");
    }

    // ---------- 设置页（settings.section: voice）----------
    function Row(props) {
      return React.createElement("div", { className: "dsh-voice-row" },
        React.createElement("label", { className: "dsh-voice-label" }, props.label),
        React.createElement("div", { className: "dsh-voice-field" }, props.children));
    }
    function TextInput(props) {
      return React.createElement("input", {
        className: "dsh-voice-input",
        type: props.type || "text",
        value: props.value,
        placeholder: props.placeholder || "",
        step: props.step, min: props.min, max: props.max,
        list: props.list,
        onChange: (e) => props.onChange(props.type === "number" ? Number(e.target.value) : e.target.value),
      });
    }
    /** 滑块 + 当前值标签（有明确取值范围的配置用它） */
    function SliderInput(props) {
      return React.createElement("span", { className: "dsh-voice-slider" },
        React.createElement("input", {
          type: "range", min: props.min, max: props.max, step: props.step, value: props.value,
          onChange: (e) => props.onChange(Number(e.target.value)),
        }),
        React.createElement("span", { className: "dsh-voice-dim" }, props.format ? props.format(props.value) : String(props.value)));
    }
    function CheckInput(props) {
      return React.createElement("input", {
        type: "checkbox", checked: !!props.value,
        "aria-label": props.label,
        onChange: (e) => props.onChange(e.target.checked),
      });
    }
    function SelectInput(props) {
      return React.createElement("select", {
        className: "dsh-voice-input",
        value: props.value,
        onChange: (e) => props.onChange(e.target.value),
      }, props.children);
    }
    /**
     * 可折叠的一层：层头左侧是 <button>（带 aria-expanded，可 Tab 聚焦、Enter/Space 展开），
     * 右侧 extra 放主开关或 CTA（不在按钮里，避免点控件顺带折叠）；展开后才渲染 children。
     * 不传 open 时自己管状态（只存在组件内，不写 Config）；传 open 则由外部控制。
     */
    function Collapse(props) {
      var pair = React.useState(!!props.defaultOpen);
      var innerOpen = pair[0], setInnerOpen = pair[1];
      var controlled = typeof props.open === "boolean";
      var open = controlled ? props.open : innerOpen;
      var bodyId = "dsh-voice-layer-" + (props.id || "x");
      function onToggle() {
        if (controlled) { if (props.onToggle) props.onToggle(!open); }
        else setInnerOpen(!open);
      }
      return React.createElement("div", { className: "dsh-voice-layer" + (open ? " open" : "") },
        React.createElement("div", { className: "dsh-voice-layer-head" },
          React.createElement("button", {
            type: "button",
            className: "dsh-voice-layer-toggle",
            "aria-expanded": open,
            "aria-controls": bodyId,
            onClick: onToggle,
          },
            React.createElement("span", { className: "dsh-voice-layer-caret" }, "▸"),
            React.createElement("span", { className: "dsh-voice-layer-title" }, props.title),
            props.summary ? React.createElement("span", { className: "dsh-voice-layer-summary" }, props.summary) : null),
          props.extra ? React.createElement("div", { className: "dsh-voice-layer-extra" }, props.extra) : null),
        open ? React.createElement("div", { className: "dsh-voice-layer-body", id: bodyId }, props.children) : null);
    }

    // ---------- 本地模型安装（设置页：下载 / 进度 / 取消 / 删除）----------
    // 状态只认 Host 的 deployStatus（单任务在 Host），跑着的时候 400ms 轮询。
    var DEPLOY_POLL_MS = 400;
    var SIZE_MB = 1024 * 1024;
    function fmtDeploySize(bytes) {
      var n = Number(bytes) || 0;
      if (n <= 0) return "0MB";
      var mib = n / SIZE_MB;
      return (mib >= 100 ? String(Math.round(mib)) : mib.toFixed(1)) + "MB";
    }
    /** 失败分类 → 一句人话；Host 已给中文原句时优先原句。 */
    function deployErrorText(st) {
      var raw = String((st && st.error) || "");
      if (raw) return raw;
      var kind = (st && st.errorKind) || "";
      if (kind === "network") return t("local.deploy.errNetwork");
      if (kind === "checksum") return t("local.deploy.errChecksum");
      if (kind === "disk") return t("local.deploy.errDisk");
      if (kind === "extract") return t("local.deploy.errExtract");
      return t("local.deploy.errUnknown");
    }

    /**
     * 五态：未装 / 下载中 / 安装中 / 已装 / 失败。
     * 删除是两步：点第一次变「确认删除？」，再点才真删（防误触）。
     * 装完/删完都通知父组件刷 localStatus（界面即时变，不用重启 dsh）。
     */
    function LocalModelDeploy(props) {
      var stPair = React.useState(null);
      var st = stPair[0], setSt = stPair[1];
      var msgPair = React.useState("");
      var msg = msgPair[0], setMsg = msgPair[1];
      var confirmPair = React.useState(false);
      var confirmRemove = confirmPair[0], setConfirmRemove = confirmPair[1];
      var busyPair = React.useState(false);
      var busy = busyPair[0], setBusy = busyPair[1];
      var doneRef = React.useRef("");

      function refresh() {
        return rpc("deployStatus").then(function (res) {
          if (res && res.ok) setSt(res);
          return res;
        }).catch(function () { return null; });
      }
      React.useEffect(function () { refresh(); }, []);
      var phase = (st && st.phase) || "idle";
      var running = phase === "downloading" || phase === "verifying" || phase === "extracting";
      // 只在跑着的时候轮询；停下就清掉定时器（打开设置页不常驻请求）
      React.useEffect(function () {
        if (!running) return undefined;
        var timer = setInterval(refresh, DEPLOY_POLL_MS);
        return function () { clearInterval(timer); };
      }, [running]);
      React.useEffect(function () {
        if (phase === "done" && doneRef.current !== "done") {
          doneRef.current = "done";
          if (props.onChanged) props.onChanged();
        } else if (phase !== "done") {
          doneRef.current = "";
        }
      }, [phase]);

      async function onStart() {
        setBusy(true); setMsg(""); setConfirmRemove(false);
        try {
          var res = await rpc("deployStart");
          if (res && res.state) setSt(res.state);
          // 状态里已带失败原因（磁盘不足等）就不再重复写一遍
          if (res && res.ok === false && !(res.state && res.state.error)) setMsg(String(res.error || t("local.deploy.errUnknown")));
        } catch (e) { setMsg(String(e && e.message || e)); }
        setBusy(false);
      }
      async function onCancel() {
        setBusy(true);
        try {
          var res = await rpc("deployCancel");
          if (res && res.state) setSt(res.state);
          setMsg(t("local.deploy.cancelled"));
        } catch (e) { setMsg(String(e && e.message || e)); }
        setBusy(false);
      }
      async function onRemove() {
        if (!confirmRemove) { setConfirmRemove(true); setMsg(t("local.deploy.removeConfirm")); return; }
        setBusy(true); setConfirmRemove(false);
        try {
          var res = await rpc("deployRemove");
          if (res && res.state) setSt(res.state);
          if (res && res.ok) {
            setMsg(t("local.deploy.removed"));
            if (props.onChanged) props.onChanged();
          } else setMsg(t("local.deploy.removeFail") + String((res && res.error) || ""));
        } catch (e) { setMsg(t("local.deploy.removeFail") + String(e && e.message || e)); }
        setBusy(false);
      }

      var manifest = (st && st.manifest) || {};
      var hintLine = t("local.deploy.hint")
        .replace("{source}", manifest.sourceLabel || "GitHub k2-fsa/sherpa-onnx")
        .replace("{download}", manifest.archiveLabel || "348MB")
        .replace("{extract}", manifest.extractedLabel || "407MB");
      var installed = !!(st && st.installed);
      var line = t("local.deploy.checking");
      if (st) {
        if (installed && !running) {
          line = t("local.deploy.installed")
            .replace("{size}", fmtDeploySize(st.installedBytes || manifest.extractedBytes))
            .replace("{version}", manifest.displayVersion || "");
        } else if (phase === "downloading") {
          line = t("local.deploy.downloading")
            .replace("{received}", fmtDeploySize(st.received))
            .replace("{total}", fmtDeploySize(st.total || manifest.archiveBytes))
            .replace("{percent}", String(st.percent || 0));
        } else if (phase === "verifying") line = t("local.deploy.verifying");
        else if (phase === "extracting") line = t("local.deploy.extracting");
        else if (phase === "failed") line = t("local.deploy.fail") + deployErrorText(st);
        else line = t("local.deploy.notInstalled");
      }
      var button;
      if (installed && !running) {
        button = React.createElement("button", {
          className: "dsh-voice-read-btn" + (confirmRemove ? " danger" : ""),
          disabled: busy || !st.deletable,
          title: st.deletable ? t("local.deploy.removeTitle") : (st.deleteBlockedReason || ""),
          onClick: onRemove,
        }, confirmRemove ? t("local.deploy.removeConfirmBtn") : (st.deletable ? t("local.deploy.remove") : t("local.deploy.removeBlocked")));
      } else if (running) {
        button = React.createElement("button", { className: "dsh-voice-read-btn", onClick: onCancel, disabled: busy }, t("local.deploy.cancel"));
      } else {
        button = React.createElement("button", {
          className: "dsh-voice-read-btn on", onClick: onStart, disabled: busy || !st,
        }, phase === "failed" ? t("local.deploy.retry") : t("local.deploy.start"));
      }
      var note = msg || (installed && st
        ? (st.deletable ? t("local.deploy.installedDir").replace("{dir}", st.installDir || "") : String(st.deleteBlockedReason || ""))
        : hintLine);
      return React.createElement("div", { className: "dsh-voice-deploy" },
        React.createElement("div", { className: "dsh-voice-deploy-line" },
          React.createElement("span", null, line),
          button),
        running ? React.createElement("div", { className: "dsh-voice-progress" },
          React.createElement("div", {
            className: "dsh-voice-progress-bar",
            style: { width: Math.max(0, Math.min(100, st.percent || 0)) + "%" },
          })) : null,
        React.createElement("p", { className: "dsh-voice-deploy-note" }, note));
    }

    /** 提示音的一行（工作/完成/提问）：开关 + 音源 + 上传 + 试听。
     *  某行关着时只留开关——音源、上传、试听都不渲染（渐进显隐与上面四层一致）。 */
    function ChimeRow(props) {
      var kind = props.kind;
      var row = props.row || { enabled: false, source: "default", file: "" };
      var msgPair = React.useState("");
      var msg = msgPair[0], setMsg = msgPair[1];
      var busyPair = React.useState(false);
      var busy = busyPair[0], setBusy = busyPair[1];
      var missPair = React.useState(false);
      var missing = missPair[0], setMissing = missPair[1];
      var fileRef = React.useRef(null);
      var name = t("chime." + kind);
      var file = row.source === "custom" ? String(row.file || "") : "";

      // 播放端读不到/解不了会自动回落默认音；这里把"为什么不是你的音"说清楚
      React.useEffect(function () {
        var alive = true;
        if (!file) { setMissing(false); return function () { alive = false; }; }
        if (chimeMissing[kind] === file) { setMissing(true); return function () { alive = false; }; }
        probeSoundFile(file).then(function (ok) { if (alive) setMissing(!ok); });
        return function () { alive = false; };
      }, [file]);

      async function onPick(e) {
        var picked = e && e.target && e.target.files ? e.target.files[0] : null;
        if (e && e.target) e.target.value = "";   // 清掉，同一个文件还能再选一次
        if (!picked) return;
        setBusy(true);
        setMsg("");
        var out = await uploadChimeSound(kind, picked);
        setBusy(false);
        if (!out.ok) { setMsg(t("chime.uploadFail") + chimeErrorText(out)); return; }
        props.onUploaded(out.file);
        setMsg(t("chime.uploaded").replace("{file}", out.file));
      }
      async function onPreview() {
        setMsg("");
        var played = await previewChime(kind, row, props.volume);
        if (!played) setMsg(t("chime.previewFail"));
      }

      return React.createElement("div", { className: "dsh-voice-chime-row", "data-chime-kind": kind },
        React.createElement("div", { className: "dsh-voice-chime-head" },
          React.createElement("span", { className: "dsh-voice-chime-name" }, name),
          React.createElement(CheckInput, {
            value: !!row.enabled,
            label: t("chime.rowToggle").replace("{name}", name),
            onChange: function (v) { props.onToggle(v); },
          }),
          row.enabled ? React.createElement(SelectInput, {
            value: row.source === "custom" ? "custom" : "default",
            onChange: function (v) { props.onSource(v); },
          },
            React.createElement("option", { value: "default" }, t("chime.source.default")),
            React.createElement("option", { value: "custom" }, t("chime.source.custom"))) : null,
          row.enabled ? React.createElement("button", {
            className: "dsh-voice-read-btn",
            onClick: function () { if (fileRef.current) fileRef.current.click(); },
            disabled: busy,
          }, busy ? t("chime.uploading") : t("chime.upload")) : null,
          row.enabled ? React.createElement("input", {
            ref: fileRef,
            type: "file",
            accept: "audio/*",
            style: { display: "none" },
            onChange: onPick,
          }) : null,
          row.enabled ? React.createElement("button", { className: "dsh-voice-read-btn", onClick: onPreview }, t("chime.preview")) : null),
        row.enabled && row.source === "custom"
          ? React.createElement("p", { className: "dsh-voice-chime-file" }, file || t("chime.noFile"))
          : null,
        missing ? React.createElement("p", { className: "dsh-voice-chime-warn" }, t("chime.missing")) : null,
        msg ? React.createElement("p", { className: "dsh-voice-msg" }, msg) : null);
    }

    function VoiceSettingsSection() {
      const cfgPair = React.useState(null);
      const cfg = cfgPair[0];
      const setCfg = cfgPair[1];
      const metaPair = React.useState(null);
      const meta = metaPair[0];
      const setMeta = metaPair[1];
      const infoPair = React.useState(null);
      const info = infoPair[0];
      const setInfo = infoPair[1];
      const msgPair = React.useState("");
      const msg = msgPair[0];
      const setMsg = msgPair[1];
      const busyPair = React.useState(false);
      const busy = busyPair[0];
      const setBusy = busyPair[1];
      const localMsgPair = React.useState("");
      const localCheckMsg = localMsgPair[0];
      const setLocalCheckMsg = localMsgPair[1];
      // 最近一次运行时自检结果（决定要不要提示"模型未安装"）。
      // 注意：不自动探测——localStatus 在模型已装时会真的加载模型，不能每次打开设置页就付这个代价。
      const localStatusPair = React.useState(null);
      const localStatus = localStatusPair[0];
      const setLocalStatus = localStatusPair[1];
      // 首屏状态行要知道本地模型装没装（deployStatus 只读目录状态，不加载模型）
      const deployPair = React.useState(null);
      const deployState = deployPair[0];
      const setDeployState = deployPair[1];
      // 折叠状态：只放组件内，不持久化、不写 Config（切引擎时自动展开 L2）
      const l2Pair = React.useState(false);
      const l2Open = l2Pair[0];
      const setL2Open = l2Pair[1];

      React.useEffect(() => {
        rpc("meta").then((m) => { if (m && m.ok) setMeta(m); }).catch(() => {});
        rpc("deployStatus").then((res) => { if (res && res.ok) setDeployState(res); }).catch(() => {});
        rpc("getConfig").then((res) => {
          if (res && res.ok) {
            setCfg(res.config);
            applyChimeConfig(res.config.chime);
            rpc("routeInfo", { provider: res.config.provider, model: res.config.model }).then((ri) => { if (ri && ri.ok) setInfo(ri); }).catch(() => {});
          } else setMsg(t("settings.loadFail") + (res && res.error ? "：" + String(res.error) : ""));
        }).catch((e) => setMsg(t("settings.loadFail") + "：" + String(e && e.message || e)));
      }, []);

      if (!cfg) return React.createElement("div", { className: "dsh-voice-settings" }, msg || "…");

      function setFields(entries) {
        const next = JSON.parse(JSON.stringify(cfg));
        for (const [path, value] of entries) {
          const keys = path.split(".");
          let o = next;
          for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
          o[keys[keys.length - 1]] = value;
        }
        setCfg(next);
        setMsg("");
      }
      function setField(path, value) {
        setFields([[path, value]]);
      }
      async function onSave() {
        setBusy(true); setMsg("");
        try {
          const res = await rpc("setConfig", { patch: cfg });
          if (res && res.ok) {
            setCfg(res.config);
            applyChimeConfig(res.config.chime);
            setMsg(t("settings.saved"));
          }
          else setMsg(t("settings.saveFail") + (res && res.error ? String(res.error) : "unknown"));
        } catch (e) { setMsg(t("settings.saveFail") + String(e && e.message || e)); }
        setBusy(false);
      }
      async function onSaveSilent() {
        const res = await rpc("setConfig", { patch: cfg });
        if (res && res.ok) setCfg(res.config);
      }
      async function onRefreshRoute() {
        setBusy(true);
        try {
          const ri = await rpc("routeInfo", { provider: cfg.provider, model: cfg.model });
          if (ri && ri.ok) { setInfo(ri); setMsg(t("settings.refreshed")); }
        } catch (e) {}
        setBusy(false);
      }
      async function onPreview() {
        setBusy(true); setMsg("");
        try {
          await onSaveSilent();
          const res = await rpc("preview");
          if (!res || !res.ok) setMsg(t("settings.previewFail") + (res && res.error ? String(res.error) : "unknown"));
          else if (res.mode === "browser") { speakText(res.text, res.speech, {}); setMsg(t("settings.previewBrowser")); }
          else if (res.audioUrl) { playAudio(res.audioUrl, {}); setMsg(ttsEngine === "volcengine" ? t("settings.previewCloud") : t("settings.previewAudio")); }
        } catch (e) { setMsg(t("settings.previewFail") + String(e && e.message || e)); }
        setBusy(false);
      }
      /** 本地运行时自检：报模型目录/是否已加载/音色数/采样率/线程数；模型没装就直说，不静默失败。 */
      async function onCheckLocal() {
        setBusy(true); setLocalCheckMsg("");
        try {
          const res = await rpc("localStatus");
          setLocalStatus(res && res.ok ? res : null);
          if (res && res.ok && res.installed === false) {
            setLocalCheckMsg(t("settings.localCheckInstalled") + (res.modelDir || "") + "（" + (res.error || "") + "）");
          } else if (res && res.ok && res.loaded) {
            setLocalCheckMsg(t("settings.localCheckRunning")
              + (res.modelDir || "") + " · " + (res.numSpeakers || 0) + " 音色 · " + (res.sampleRate || 0) + "Hz · "
              + (res.numThreads || 0) + " 线程" + (res.loadMs ? " · 加载 " + res.loadMs + "ms" : ""));
          } else if (res && res.ok) {
            setLocalCheckMsg(t("settings.localCheckFail") + (res.error || res.modelDir || "unknown"));
          } else {
            setLocalCheckMsg(t("settings.localCheckFail") + (res && res.error ? String(res.error) : "unknown"));
          }
        } catch (e) { setLocalCheckMsg(t("settings.localCheckFail") + String(e && e.message || e)); }
        setBusy(false);
      }
      /** 装完/删完模型后刷新运行时状态：模型已装时这一下会真的加载模型（约 3s），只在这两个时机做。 */
      function refreshLocalStatus() {
        rpc("deployStatus").then(function (res) { if (res && res.ok) setDeployState(res); }).catch(function () {});
        rpc("localStatus").then(function (res) { setLocalStatus(res && res.ok ? res : null); }).catch(function () {});
      }

      const m = meta || FALLBACK_META; // 裂脑兜底
      const presets = m.stylePresets || [];
      const languages = m.languages || [];
      const voices = m.voices || [];
      const kokoroVoices = m.kokoroVoices || [];
      const speakerKnown = voices.some((v) => v.id === cfg.tts.volcengine.speaker);
      // local 子配置（旧 Host/缓存无该对象时补默认，避免 UI 读空崩溃）
      if (!cfg.tts.local) cfg.tts.local = { sid: 48, speed: 1, numThreads: 4, modelDir: "", timeoutMs: 30000, streaming: true, segmentChars: 220, segmentTimeoutMs: 30000 };
      // 提示音子配置（旧 Host 没有 chime 时补默认：整层关着，不改变现有行为）
      if (!cfg.chime) cfg.chime = { enabled: false, volume: 0.3, work: null, done: null, ask: null };
      CHIME_KINDS.forEach((kind) => {
        if (!cfg.chime[kind] || typeof cfg.chime[kind] !== "object") cfg.chime[kind] = { enabled: false, source: "default", file: "" };
        if (typeof cfg.chime.volume !== "number") cfg.chime.volume = 0.3;
      });
      const kokoroVoiceKnown = kokoroVoices.some((v) => v.id === String(cfg.tts.local.sid));
      // 转写模型路由下拉数据（Host routeInfo 提供；未就绪时退化为文本输入）
      const providerList = info && Array.isArray(info.providers) && info.providers.length ? info.providers : null;
      const modelList = info && Array.isArray(info.models) && info.models.length ? info.models : null;
      const providerKnown = !providerList || providerList.some((p) => p.id === cfg.provider);
      const modelKnown = !modelList || modelList.some((m2) => m2.id === cfg.model);
      /** 切 provider/model 后联动刷新可选模型与思考档位（不经保存按钮，立即读 Host）。 */
      async function onRouteChange(provider, model) {
        try {
          const ri = await rpc("routeInfo", { provider: provider, model: model });
          if (ri && ri.ok) setInfo(ri);
        } catch (e) { /* 静默失败，保留旧列表 */ }
      }
      const rateStops = m.rateStops || [];
      const isCustom = cfg.transcribe.stylePreset === "custom";
      // 旧预设值（ambiguous/default/energetic）回退到"标准"，避免下拉空值
      const styleShown = ["standard", "companion", "playful", "custom"].indexOf(cfg.transcribe.stylePreset) >= 0
        ? cfg.transcribe.stylePreset : "standard";
      const presetHit = presets.find((p) => p.id === styleShown);
      const promptShown = isCustom
        ? cfg.transcribe.prompt
        : (presetHit && presetHit.prompt ? presetHit.prompt : cfg.transcribe.prompt);
      // 音色↔语种配对（voice-compat 不变式）：后改的字段胜出，另一个自动适配，不锁定/不禁用
      const curDialect = isDialectLanguage(cfg.language);
      const curEn = cfg.language === "en";
      /** 语种/方言联动（改语言→纠音色）：方言→vv；English→英文音色；zh/auto 且音色为英文→vv。 */
      function onLanguageChange(v) {
        const next = JSON.parse(JSON.stringify(cfg));
        next.language = v;
        next.tts.volcengine.speaker = correctSpeakerForLanguage(v, next.tts.volcengine.speaker);
        setCfg(next);
        setMsg("");
      }
      /** 音色联动（改音色→纠语种）：en 音色→English；vv→保持（en 改 zh）；中文音色→方言/en 改中文（普通话）。 */
      function onSpeakerChange(sp) {
        const next = JSON.parse(JSON.stringify(cfg));
        next.language = correctLanguageForSpeaker(next.language, sp);
        next.tts.volcengine.speaker = sp;
        setCfg(next);
        setMsg("");
      }
      /** 播报引擎三选一（引擎总开关）：browser=免费系统 TTS；volcengine=豆包（付费 API Key 生效）；
       * local=本地 Kokoro 中英（免费，进程内合成）。切到豆包时 autoSpeakCloudTts 同步写入 true
       * （Host 成本门控与 UI 一致）；切到免费引擎写 false。 */
      function onEngineChange(v) {
        const next = JSON.parse(JSON.stringify(cfg));
        next.tts.provider = v;
        next.autoSpeakCloudTts = v === "volcengine";
        setCfg(next);
        setMsg("");
        setL2Open(true); // 换引擎就把"当前引擎的声音"展开，省一次点击
      }

      // TTS 引擎归一（voice-compat 镜像）：volcengine=豆包、local=本地 Kokoro（进程内）；
      // 已退役的 local-cosyvoice 归一到 local（旧配置是"想用本地引擎"）；
      // 其余（含旧值 openai-compatible）按系统 TTS 处理
      const ttsEngine = cfg.tts.provider === "volcengine"
        ? "volcengine"
        : (cfg.tts.provider === "local" || cfg.tts.provider === "local-cosyvoice" ? "local" : "browser");

      // 层头摘要：收起时也能一眼看到当前值（不展开就不用进去找）
      const l2Summary = ttsEngine === "browser"
        ? t("layer.l2.summary.browser").replace("{rate}", Number(cfg.tts.browser.rate).toFixed(2) + "x")
        : ttsEngine === "local"
          ? t("layer.l2.summary.local")
              .replace("{sid}", String(cfg.tts.local.sid))
              .replace("{rate}", Number(cfg.tts.local.speed).toFixed(2) + "x")
          : t("layer.l2.summary.volcengine").replace("{speaker}",
              (voices.find((v) => v.id === cfg.tts.volcengine.speaker) || {}).name || String(cfg.tts.volcengine.speaker || ""));
      const l4Summary = t("layer.l4.summary")
        .replace("{seg}", cfg.tts.local.streaming !== false ? t("layer.value.on") : t("layer.value.off"))
        .replace("{threads}", String(cfg.tts.local.numThreads))
        .replace("{dir}", cfg.tts.local.modelDir ? t("layer.value.custom") : t("layer.value.auto"));
      const chimeRowsOn = CHIME_KINDS.filter((kind) => cfg.chime[kind] && cfg.chime[kind].enabled).length;
      const l5Summary = cfg.chime.enabled
        ? t("layer.l5.summary.on")
            .replace("{n}", String(chimeRowsOn))
            .replace("{volume}", String(Math.round(Number(cfg.chime.volume) * 100)))
        : t("layer.l5.summary.off");
      // 首屏一行状态：只报当前引擎最关键的一件事；本地没装时给下载入口（点开 L2，安装行在层头）
      let statusLine = "";
      let statusCta = false;
      if (ttsEngine === "browser") {
        statusLine = t("status.browser");
      } else if (ttsEngine === "volcengine") {
        statusLine = cfg.tts.volcengine.apiKey ? t("status.volcengine.ok") : t("status.volcengine.noKey");
      } else if (deployState) {
        const phase = deployState.phase || "idle";
        if (deployState.installed) statusLine = t("status.local.installed");
        else if (phase === "downloading" || phase === "verifying" || phase === "extracting") {
          statusLine = t("status.local.busy").replace("{percent}", String(deployState.percent || 0));
        } else {
          statusLine = t("status.local.missing");
          statusCta = true;
        }
      }

      return React.createElement("div", { className: "dsh-voice-settings" },
        React.createElement("h2", null, t("settings.title")),
        React.createElement("p", { className: "dsh-voice-dim" }, t("settings.intro")),

        // —— L1 常用：首屏只留引擎与自动播报，外加至多一行引擎/模型状态 ——
        React.createElement("div", { className: "dsh-voice-layer open" },
          React.createElement("div", { className: "dsh-voice-layer-head" },
            React.createElement("span", { className: "dsh-voice-layer-caret" }),
            React.createElement("span", { className: "dsh-voice-layer-title" }, t("layer.l1.title"))),
          React.createElement("div", { className: "dsh-voice-layer-body" },
            React.createElement(Row, { label: t("row.engine") },
              React.createElement(SelectInput, { value: ttsEngine, onChange: onEngineChange },
                React.createElement("option", { value: "browser" }, t("engine.browser")),
                React.createElement("option", { value: "volcengine" }, t("engine.volcengine")),
                React.createElement("option", { value: "local" }, t("engine.local"))),
              React.createElement("span", { className: "dsh-voice-dim" }, t("hint.engine"))),
            React.createElement(Row, { label: t("row.autoSpeak") },
              React.createElement(CheckInput, { value: cfg.autoSpeak, onChange: (v) => setField("autoSpeak", v) }),
              React.createElement("span", { className: "dsh-voice-dim" }, t("hint.autoSpeak"))),
            statusLine ? React.createElement("p", { className: "dsh-voice-status" },
              React.createElement("span", null, statusLine),
              statusCta ? React.createElement("button", { className: "dsh-voice-read-btn", onClick: () => setL2Open(true) }, t("cta.install")) : null) : null)),

        // —— L2 当前引擎的声音：默认收起，切引擎自动展开；本地安装行常驻层头（收起也不卸载轮询）——
        React.createElement(Collapse, {
          id: "l2",
          title: t("layer.l2.title"),
          summary: l2Summary,
          open: l2Open,
          onToggle: setL2Open,
          extra: ttsEngine === "local" ? React.createElement(LocalModelDeploy, { onChanged: refreshLocalStatus }) : null,
        },

            // —— 系统 TTS（免费）——
            ttsEngine === "browser" ? React.createElement(React.Fragment, null,
              React.createElement(Row, { label: t("row.rate") },
                React.createElement(SliderInput, { value: cfg.tts.browser.rate, onChange: (v) => setField("tts.browser.rate", v), min: 0.5, max: 2, step: 0.05, format: (v) => v.toFixed(2) + "x" })),
              React.createElement(Row, { label: t("row.pitch") },
                React.createElement(SliderInput, { value: cfg.tts.browser.pitch, onChange: (v) => setField("tts.browser.pitch", v), min: 0.5, max: 2, step: 0.05, format: (v) => v.toFixed(2) })),
              React.createElement(Row, { label: t("row.voiceName") },
                React.createElement(TextInput, { value: cfg.tts.browser.voice, onChange: (v) => setField("tts.browser.voice", v), placeholder: "系统默认 / system default" }))) : null,

            // —— 本地 Kokoro（中英，免费；安装行在层头，收起也不卸载轮询）——
            ttsEngine === "local" ? React.createElement(React.Fragment, null,
              React.createElement("p", { className: "dsh-voice-dim" }, t("local.hint")),

              React.createElement(Row, { label: t("row.localVoice") },
                React.createElement(SelectInput, {
                  value: kokoroVoiceKnown ? String(cfg.tts.local.sid) : VOICE_CUSTOM,
                  onChange: (v) => { if (v !== VOICE_CUSTOM) setField("tts.local.sid", Number(v)); },
                },
                  kokoroVoices.map((v) => React.createElement("option", { key: v.id, value: v.id }, v.name)),
                  React.createElement("option", { value: VOICE_CUSTOM }, "自定义 / Custom")),
                (kokoroVoiceKnown ? null : React.createElement(TextInput, {
                  value: String(cfg.tts.local.sid),
                  onChange: (v) => { const n = Number(v); if (Number.isInteger(n) && n >= 0) setField("tts.local.sid", n); },
                  placeholder: t("local.customSid"),
                })),
                React.createElement("span", { className: "dsh-voice-dim" }, t("local.sidHint"))),
              React.createElement(Row, { label: t("row.localSpeed") },
                React.createElement(SliderInput, { value: cfg.tts.local.speed, onChange: (v) => setField("tts.local.speed", v), min: 0.5, max: 2, step: 0.05, format: (v) => v.toFixed(2) + "x" })),
              (localStatus && localStatus.installed === false ? React.createElement("p", { className: "dsh-voice-warn" }, t("local.notInstalled")) : null),
              React.createElement(Row, { label: t("settings.localCheck") },
                React.createElement("button", { className: "dsh-voice-read-btn", onClick: onCheckLocal, disabled: busy }, t("settings.localCheck")),
                React.createElement("span", { className: "dsh-voice-dim" }, localCheckMsg))) : null,

          // —— 豆包 TTS（专属配置，分组：鉴权 → 发音；仅选择豆包时显示）——
          ttsEngine === "volcengine" ? React.createElement(React.Fragment, null,
            React.createElement("h4", null, t("group.auth")),
            React.createElement(Row, { label: t("row.gateway") },
              React.createElement(SelectInput, { value: cfg.tts.volcengine.gateway || "plan", onChange: (v) => setField("tts.volcengine.gateway", v) },
                React.createElement("option", { value: "plan" }, "plan · 智能体套餐"),
                React.createElement("option", { value: "standard" }, "standard · 标准付费"),
                React.createElement("option", { value: "custom" }, "custom · 自定义端点")),
              React.createElement("span", { className: "dsh-voice-dim" }, t("gateway.hint"))),
            (cfg.tts.volcengine.gateway === "custom" ? React.createElement(Row, { label: t("row.httpUrl") },
              React.createElement(TextInput, { value: cfg.tts.volcengine.httpUrl || "", onChange: (v) => setField("tts.volcengine.httpUrl", v), placeholder: "https://…/api/v3/tts/unidirectional" })) : null),
            React.createElement(Row, { label: t("row.apiKey") },
              React.createElement(TextInput, { type: "password", value: cfg.tts.volcengine.apiKey, onChange: (v) => setField("tts.volcengine.apiKey", v), placeholder: "火山引擎 API Key" })),
            React.createElement("p", { className: "dsh-voice-dim" }, t("apiKey.hint"), " ",
              React.createElement("a", { href: VOLC_APIKEY_DOC, target: "_blank", rel: "noreferrer" }, t("apiKey.hintLink"))),
            React.createElement(Row, { label: t("row.resourceId") },
              React.createElement(TextInput, { value: cfg.tts.volcengine.resourceId, onChange: (v) => setField("tts.volcengine.resourceId", v), placeholder: "seed-tts-2.0" })),
            React.createElement("h4", null, t("group.pronounce")),
            React.createElement(Row, { label: t("row.speaker") },
              React.createElement(SelectInput, {
                value: (speakerKnown ? cfg.tts.volcengine.speaker : VOICE_CUSTOM),
                onChange: (v) => { if (v !== VOICE_CUSTOM) onSpeakerChange(v); },
              },
                voices.map((v) => React.createElement("option", { key: v.id, value: v.id }, v.name)),
                React.createElement("option", { value: VOICE_CUSTOM }, "自定义 / Custom")),
              (speakerKnown ? null : React.createElement(TextInput, {
                value: cfg.tts.volcengine.speaker,
                onChange: (v) => onSpeakerChange(v),
                placeholder: "zh_female_vv_uranus_bigtts",
              })),
              React.createElement("span", { className: "dsh-voice-dim" }, " 精选已实测；自定义可输入任意音色 ID（未实测不保证） / curated & tested; custom id allowed (untested)")),
            React.createElement(Row, { label: t("row.language") },
              React.createElement(SelectInput, { value: cfg.language, onChange: onLanguageChange },
                languages.map((l) => React.createElement("option", { key: l.id, value: l.id }, l.label))),
              React.createElement("span", { className: "dsh-voice-dim" }, " 固定语种/方言时无论原文语言都按所选播报 / fixed language overrides source")),
            (curDialect
              ? React.createElement("p", { className: "dsh-voice-warn" },
                  "方言需 vv 音色 + explicit_dialect（8 种方言实测生效）；选其他音色时语种会自动改为普通话 / dialect uses vv; picking another voice switches language to Mandarin")
              : null),
            (curEn
              ? React.createElement("p", { className: "dsh-voice-warn" },
                  "English 已自动切换英文音色（explicit_language=en）/ speaker auto-corrected to an EN voice")
              : null),
            React.createElement(Row, { label: t("row.rateLevel") },
              React.createElement(SliderInput, { value: cfg.tts.volcengine.rateLevel, onChange: (v) => setField("tts.volcengine.rateLevel", v), min: 0, max: 4, step: 1, format: (v) => rateStops[v] || String(v) }),
              React.createElement("span", { className: "dsh-voice-dim" }, " 数值 speech_rate 参数实现 / via numeric speech_rate")),
            React.createElement(Row, { label: t("row.pitchSemitone") },
              React.createElement(SliderInput, { value: cfg.tts.volcengine.pitch, onChange: (v) => setField("tts.volcengine.pitch", v), min: -12, max: 12, step: 0.1, format: (v) => String(Number(v).toFixed(1)) }),
              React.createElement("span", { className: "dsh-voice-dim" }, " 半音（0=正常，可调 0.1 细粒度）/ semitones (0=normal)")),
            React.createElement(Row, { label: t("row.loudness") },
              React.createElement(SliderInput, { value: cfg.tts.volcengine.loudness, onChange: (v) => setField("tts.volcengine.loudness", v), min: -50, max: 100, step: 5, format: (v) => String(v) }),
              React.createElement("span", { className: "dsh-voice-dim" }, " 音量 loudness_rate")),
            React.createElement("p", { className: "dsh-voice-dim" }, t("dialect.hint"))) : null),

        // —— L3 转写：开关在层头（收起也能直接开关），体内只在开启时渲染 ——
        React.createElement(Collapse, {
          id: "l3",
          title: t("layer.l3.title"),
          summary: cfg.transcribe.enabled ? t("layer.l3.summary.on") : t("layer.l3.summary.off"),
          defaultOpen: false,
          extra: React.createElement(CheckInput, {
            value: cfg.transcribe.enabled,
            label: t("row.transcribeEnabled"),
            onChange: (v) => setField("transcribe.enabled", v),
          }),
        },
          cfg.transcribe.enabled ? React.createElement(React.Fragment, null,
            React.createElement("p", { className: "dsh-voice-dim" }, t("hint.transcribe")),
            React.createElement("div", { className: "dsh-voice-sub" },
              React.createElement(Row, { label: t("row.provider") },
                providerList
                  ? React.createElement(SelectInput, {
                      value: providerKnown ? cfg.provider : ROUTE_CUSTOM,
                      onChange: (v) => { if (v !== ROUTE_CUSTOM) { setField("provider", v); onRouteChange(v, ""); } },
                    },
                      providerList.map((p) => React.createElement("option", { key: p.id, value: p.id }, p.name && p.name !== p.id ? p.name + "（" + p.id + "）" : p.id)),
                      React.createElement("option", { value: ROUTE_CUSTOM }, "自定义 / Custom"))
                  : React.createElement(TextInput, { value: cfg.provider, onChange: (v) => setField("provider", v), placeholder: "deepseek-official" }),
                providerList ? null : React.createElement("span", { className: "dsh-voice-dim" }, " 路由列表加载中… / loading…")),
              React.createElement(Row, { label: t("row.model") },
                modelList
                  ? React.createElement(SelectInput, {
                      value: modelKnown ? cfg.model : ROUTE_CUSTOM,
                      onChange: (v) => { if (v !== ROUTE_CUSTOM) { setField("model", v); onRouteChange(cfg.provider, v); } },
                    },
                      modelList.map((m2) => React.createElement("option", { key: m2.id, value: m2.id }, m2.name && m2.name !== m2.id ? m2.name + "（" + m2.id + "）" : m2.id)),
                      React.createElement("option", { value: ROUTE_CUSTOM }, "自定义 / Custom"))
                  : React.createElement(TextInput, { value: cfg.model, onChange: (v) => setField("model", v), placeholder: "deepseek-v4-flash" }),
                modelList && !modelKnown ? React.createElement(TextInput, { value: cfg.model, onChange: (v) => setField("model", v), placeholder: "模型 ID" }) : null,
                modelList ? null : React.createElement("span", { className: "dsh-voice-dim" }, " 模型列表加载中… / loading…")),
              React.createElement(Row, { label: t("row.temperature") },
                React.createElement(SliderInput, { value: cfg.transcribe.temperature, onChange: (v) => setField("transcribe.temperature", v), min: 0, max: 2, step: 0.05 }),
                React.createElement("span", { className: "dsh-voice-dim" }, t("temperature.hint"))),
              React.createElement(Row, { label: t("row.stylePreset") },
                React.createElement(SelectInput, { value: styleShown, onChange: (v) => setField("transcribe.stylePreset", v) },
                  presets.map((p) => React.createElement("option", { key: p.id, value: p.id }, p.name)),
                  React.createElement("option", { value: "custom" }, "自定义 / Custom")),
                React.createElement("span", { className: "dsh-voice-dim" }, " 标准=高还原；陪伴/俏皮=摘要+情绪个性化 / standard=fidelity; companion/playful=summary+emotion")),
              React.createElement(Row, { label: t("row.prompt") },
                React.createElement("textarea", {
                  className: "dsh-voice-textarea",
                  value: promptShown,
                  readOnly: !isCustom,
                  placeholder: "自定义模式下在此编辑 / editable in Custom mode",
                  onChange: (e) => isCustom && setField("transcribe.prompt", e.target.value),
                })))) : null),

        // —— L4 高级：本地合成细节（标题带当前值摘要）——
        React.createElement(Collapse, {
          id: "l4",
          title: t("layer.l4.title"),
          summary: l4Summary,
          defaultOpen: false,
        },
          React.createElement(React.Fragment, null,
            React.createElement(Row, { label: t("row.localNumThreads") },
              React.createElement(SliderInput, { value: cfg.tts.local.numThreads, onChange: (v) => setField("tts.local.numThreads", v), min: 1, max: 16, step: 1, format: (v) => String(v) }),
              React.createElement("span", { className: "dsh-voice-dim" }, t("local.numThreadsHint"))),
            React.createElement(Row, { label: t("local.streaming") },
              React.createElement(CheckInput, { value: cfg.tts.local.streaming !== false, onChange: (v) => setField("tts.local.streaming", v) }),
              React.createElement("span", { className: "dsh-voice-dim" }, t("local.streamingHint"))),
            React.createElement(Row, { label: t("local.modelDir") },
              React.createElement(TextInput, { value: cfg.tts.local.modelDir || "", onChange: (v) => setField("tts.local.modelDir", v), placeholder: "自动 / auto" }),
              React.createElement("span", { className: "dsh-voice-dim" }, t("local.modelDirHint"))))),

        // —— L5 提示音：总开关在层头（收起也能开关）；体内 = 总音量 + 三种音各一行 ——
        React.createElement(Collapse, {
          id: "l5",
          title: t("layer.l5.title"),
          summary: l5Summary,
          defaultOpen: false,
          extra: React.createElement(CheckInput, {
            value: !!cfg.chime.enabled,
            label: t("row.chimeEnabled"),
            onChange: (v) => setField("chime.enabled", v),
          }),
        },
          cfg.chime.enabled ? React.createElement(React.Fragment, null,
            React.createElement("p", { className: "dsh-voice-dim" }, t("hint.chime")),
            chimeSupported() ? null : React.createElement("p", { className: "dsh-voice-warn" }, t("chime.audioUnavailable")),
            React.createElement(Row, { label: t("row.chimeVolume") },
              React.createElement(SliderInput, {
                value: Number(cfg.chime.volume),
                onChange: (v) => setField("chime.volume", v),
                min: 0, max: 1, step: 0.05,
                format: (v) => Math.round(v * 100) + "%",
              })),
            CHIME_KINDS.map((kind) => React.createElement(ChimeRow, {
              key: kind,
              kind: kind,
              row: cfg.chime[kind],
              volume: Number(cfg.chime.volume),
              onToggle: (v) => setField("chime." + kind + ".enabled", v),
              onSource: (v) => setField("chime." + kind + ".source", v),
              onUploaded: (file) => setFields([
                ["chime." + kind + ".file", file],
                ["chime." + kind + ".source", "custom"],
              ]),
            }))) : null),

        React.createElement("div", { className: "dsh-voice-actions" },
          React.createElement("button", { className: "dsh-voice-read-btn on", onClick: onSave, disabled: busy }, t("settings.save")),
          React.createElement("button", { className: "dsh-voice-read-btn", onClick: onRefreshRoute, disabled: busy }, t("settings.refresh")),
          React.createElement("button", { className: "dsh-voice-read-btn", onClick: onPreview, disabled: busy }, t("settings.preview")),
          React.createElement("button", { className: "dsh-voice-read-btn", onClick: () => stopAll() }, t("settings.stopAll"))),
        msg ? React.createElement("div", { className: "dsh-voice-msg" }, msg) : null);
    }

    // ---------- apply ----------
    function apply(ctx) {
      pluginCtx = ctx;
      // i18n 词典
      if (ctx.locale && ctx.locale.register && ctx.locale.bind) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "voice: dictionaries");
        T = ctx.locale.bind(NS);
      }

      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.dataset.voice = "dsh-plugin-voice";
        tag.textContent = [
          ".dsh-voice-read-btn{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:1px solid rgba(127,127,127,.4);border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}",
          ".dsh-voice-read-btn:hover{background:rgba(127,127,127,.12);}",
          ".dsh-voice-read-btn:disabled{opacity:.6;cursor:default;}",
          ".dsh-voice-read-btn.on{border-color:rgba(46,139,87,.7);background:rgba(46,139,87,.12);}",
          ".dsh-voice-icon-btn{width:28px;height:28px;color:var(--dsw-alias-label-tertiary, rgba(127,127,127,.85));cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex;}",
          ".dsh-voice-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary, rgba(127,127,127,.95));}",
          ".dsh-voice-icon-btn:disabled{cursor:default;opacity:.4;}",
          ".dsh-voice-icon-btn.err{color:var(--dsw-alias-state-error-primary, #d97706);}",
          ".dsh-voice-nav-speaker svg{display:none;}",
          ".dsh-voice-nav-speaker::before{content:\"\";width:16px;height:16px;flex:none;" + speakerMaskBackground() + "}",
          ".dsh-voice-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border:none;border-radius:6px;background:transparent;color:inherit;opacity:.65;font-size:12px;cursor:pointer;}",
          ".dsh-voice-badge:hover{opacity:1;background:rgba(127,127,127,.12);}",
          ".dsh-voice-settings{max-width:680px;display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:1.6;}",
          ".dsh-voice-settings h2{margin:0 0 4px;font-size:17px;}",
          ".dsh-voice-settings h4{margin:10px 0 2px 110px;font-size:12px;color:rgba(127,127,127,.9);letter-spacing:.5px;}",
          // 分层：层头（按钮 + 摘要 + 右侧主开关/CTA）+ 展开后的层体
          ".dsh-voice-layer{display:flex;flex-direction:column;gap:2px;}",
          ".dsh-voice-layer-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;padding:6px 0 4px;border-bottom:1px solid rgba(127,127,127,.2);}",
          ".dsh-voice-layer-title{font-size:14px;font-weight:600;}",
          ".dsh-voice-layer-caret{flex:none;display:inline-block;width:10px;line-height:1.6;opacity:.55;transition:transform .15s;}",
          ".dsh-voice-layer.open .dsh-voice-layer-caret{transform:rotate(90deg);}",
          ".dsh-voice-layer-toggle{display:flex;align-items:center;gap:8px;flex:1 1 220px;min-width:0;padding:2px 0;background:none;border:none;color:inherit;font:inherit;text-align:left;cursor:pointer;}",
          ".dsh-voice-layer-toggle:focus-visible{outline:2px solid rgba(46,139,87,.75);outline-offset:2px;border-radius:4px;}",
          ".dsh-voice-layer-summary{font-size:12px;font-weight:400;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
          ".dsh-voice-layer-extra{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-left:auto;max-width:100%;}",
          ".dsh-voice-layer-extra .dsh-voice-deploy{width:100%;min-width:260px;max-width:360px;}",
          ".dsh-voice-layer-body{display:flex;flex-direction:column;gap:2px;padding:2px 0 4px;}",
          ".dsh-voice-status{margin:2px 0 0 120px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;opacity:.75;}",
          ".dsh-voice-sub{margin-left:120px;padding-left:10px;border-left:1px solid rgba(127,127,127,.18);}",
          // 提示音三行：行内开关 + 音源 + 上传 + 试听（关着时整行只剩开关）
          ".dsh-voice-chime-row{display:flex;flex-direction:column;gap:2px;padding:2px 0 2px 120px;}",
          ".dsh-voice-chime-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
          ".dsh-voice-chime-name{flex:none;min-width:58px;opacity:.8;}",
          ".dsh-voice-chime-file{margin:0;max-width:420px;font-size:12px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
          ".dsh-voice-chime-warn{margin:0;font-size:12px;color:#d97706;}",
          ".dsh-voice-row{display:flex;align-items:flex-start;gap:10px;padding:4px 0;}",
          ".dsh-voice-label{flex:none;width:110px;text-align:right;padding-top:4px;opacity:.8;}",
          ".dsh-voice-field{flex:1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
          ".dsh-voice-input{min-width:220px;padding:4px 8px;border:1px solid rgba(127,127,127,.4);border-radius:6px;background:transparent;color:inherit;font:inherit;}",
          "select.dsh-voice-input{background-color:Canvas;color:CanvasText;}",
          ".dsh-voice-slider{display:inline-flex;align-items:center;gap:8px;}",
          ".dsh-voice-slider input[type=range]{width:170px;accent-color:#2e8b57;}",
          ".dsh-voice-textarea{width:100%;min-height:120px;padding:6px 8px;border:1px solid rgba(127,127,127,.4);border-radius:6px;background:transparent;color:inherit;font:inherit;resize:vertical;}",
          ".dsh-voice-textarea[readonly]{opacity:.7;}",
          ".dsh-voice-dim{opacity:.6;font-size:12px;}",
          ".dsh-voice-warn{margin:2px 0 0 120px;font-size:12px;color:#d97706;}",
          // 本地模型安装块：状态行 + 按钮 + 进度条 + 一行说明（来源/体积）
          ".dsh-voice-deploy{display:flex;flex-direction:column;gap:5px;width:100%;min-width:260px;}",
          ".dsh-voice-deploy-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
          ".dsh-voice-deploy-note{margin:0;font-size:12px;opacity:.6;line-height:1.5;}",
          ".dsh-voice-progress{height:4px;border-radius:2px;background:rgba(127,127,127,.2);overflow:hidden;}",
          ".dsh-voice-progress-bar{height:100%;background:rgba(46,139,87,.8);transition:width .2s linear;}",
          ".dsh-voice-read-btn.danger{border-color:rgba(220,38,38,.7);background:rgba(220,38,38,.12);}",
          ".dsh-voice-actions{display:flex;gap:8px;margin-top:14px;}",
          ".dsh-voice-msg{margin-top:8px;font-size:12px;}",
          // shell.overlay 层默认点击穿透（click-through），toast 自己收回指针事件
          ".dsh-voice-toast{pointer-events:auto;max-width:380px;padding:8px 12px;border-radius:8px;background:rgba(24,26,28,.94);color:#f3f4f6;font-size:12px;line-height:1.5;box-shadow:0 6px 18px rgba(0,0,0,.3);border:1px solid rgba(127,127,127,.35);}",
        ].join("\n");
        document.head.append(tag);
        return () => tag.remove();
      }, "voice: styles");

      // 插件卸载/应用关闭时统一停播（替代原先挂在每个消息按钮上的卸载即停）：
      // 只在这一个全局入口停音频并通知 Host 收尾，消息行重渲染/滚动不会误杀播放。
      ctx.effect(() => () => { try { stopAll(); } catch (e) {} }, "voice: stop playback on dispose");

      // 设置页导航图标：把语音行的齿轮换成喇叭（面板挂载/React 重渲染后由 observer 补丁）
      ctx.effect(() => {
        startNavIconPatching();
        return () => stopNavIconPatching();
      }, "voice: settings nav icon");

      // 自动播报轮询 + stopOnNewTurn（gen 变化 → 停旧播报）
      let pollBusy = false;
      let lastGen = null;
      async function pollAutoSpeak() {
        if (pollBusy) return;
        pollBusy = true;
        try {
          const res = await rpc("pollSpeak");
          if (res && res.ok) {
            if (lastGen !== null && typeof res.gen === "number" && res.gen !== lastGen && res.stopOnNewTurn !== false) {
              // 新 turn 开始：停旧播报，并让 Host 中止后台管线（否则被放弃的播报还会继续跑
              // 段落指令 LLM / 合成，白烧 token 与 TTS）
              stopPlaybackOnly({ notifyHost: true });
            }
            if (typeof res.gen === "number") lastGen = res.gen;
            if (res.pending) {
              const p = res.pending;
              const r = await rpc("speak", { sessionId: p.sessionId, messageId: p.messageId });
              if (r && r.ok) playResult(r, {});
            }
          }
        } catch (e) { /* 下一拍重试 */ }
        pollBusy = false;
      }
      ctx.effect(() => {
        const id = setInterval(() => { pollAutoSpeak(); }, 2000);
        return () => clearInterval(id);
      }, "voice: auto-speak poller");

      // conversation Definition：turn 数据写入 voice.messageId（供 turnTail 徽标定位）
      ctx.uiConversation.events.register(voiceDefinition);

      // 槽位注册
      ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register(
        { name: "conversation.chat.assistant-actions", id: "voice-read", order: 20, label: "朗读" },
        VoiceReadButton,
      ));
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
        { name: "conversation.input.left", id: "voice-auto", order: 30, label: "自动朗读" },
        AutoToggle,
      ));
      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register(
        // list 槽位：按 id/order 排序渲染，没有 select（那是 chain 槽位的机制）。
        // "只 claim 读过的轮次"的判断放在 VoiceTurnBadge 里（返回 null 即不渲染）。
        { name: "conversation.chat.turnTail", id: "voice-badge", order: 20, label: "朗读状态" },
        VoiceTurnBadge,
      ));
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "voice", order: 30, label: "语音播报" },
        VoiceSettingsSection,
      ));
      // overlay toast：TTS 失败回退/转写关闭直读等降级事件对用户可见（不再只写 console）
      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "voice-toast", order: 40, label: "语音提示" },
        VoiceToast,
      ));

      // 提示音：独立 AudioContext + sessionStatus 订阅。
      // uiSession / sessions 都是可选服务：缺了就静默不发提示音，播报链完全不受影响。
      ctx.effect(() => () => { try { disposeChime(); } catch (e) {} }, "voice: chime dispose");
      armChimePreheat();
      loadChimeConfig();
      startChimeWatch();

      console.log("[voice] client half applied (icons + badge + i18n + resilience)");
    }

    const inject = ["slots", "locale", "uiConversation"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
//#endregion
