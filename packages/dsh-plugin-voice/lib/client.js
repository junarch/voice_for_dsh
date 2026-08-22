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
    var zh = {
      "read.title": "转写并朗读此条消息", "read.busyTitle": "正在转写，请稍候", "read.stopTitle": "停止播报",
      "read.regenerate": "重新生成",
      "read.failPrefix": "上次失败：", "read.degraded": "转写失败，已直读原文",
      "auto.on": "自动·开", "auto.off": "自动·关",
      "auto.title": "打开后，每轮回答结束自动转写并朗读",
      "badge.speaking": "朗读中…", "badge.done": "已朗读 ✓", "badge.replay": "点击重播此轮播报",
      "settings.title": "语音播报",
      "settings.intro": "每轮回答结束后先做口语化转写再播报；配置写入 settings.yaml 的 voice: 节，保存即热生效。",
      "settings.save": "保存", "settings.saved": "✅ 已保存到 settings.yaml",
      "settings.saveFail": "❌ 保存失败：", "settings.loadFail": "读取配置失败",
      "settings.refresh": "刷新模型/档位列表", "settings.refreshed": "已拉取 provider/model/思考档位列表",
      "settings.preview": "▶ 试听", "settings.stopAll": "⏹ 停止播报",
      "settings.previewFail": "❌ 试听失败：", "settings.previewBrowser": "▶ 试听中（浏览器语音）…", "settings.previewCloud": "▶ 试听中（云 TTS）…",
      "sec.basic": "基本配置", "sec.transcribe": "转写（口语化）",
      "row.transcribeEnabled": "需要转写模型",
      "tts.section.browser": "播报引擎 · Windows 系统 TTS（免费）", "tts.section.volcengine": "播报引擎 · 豆包 TTS",
      "transcribe.hint.on": "开=LLM 口语化转写（风格/情绪/自动跳过代码与表格）",
      "transcribe.hint.off": "关=不调模型，输出什么直接读；表格和代码块自动跳过",
      "group.auth": "鉴权", "group.pronounce": "发音",
      "row.autoSpeak": "自动播报", "row.cloudTts": "云TTS", "row.language": "语种/方言",
      "row.provider": "Provider", "row.model": "模型",
      "row.temperature": "temperature",
      "temperature.hint": " 值越大，转写越有创意、越发散，但准确度越低；越小越忠实原文（默认 0.3）/ higher = more varied & creative but less accurate; lower = more faithful (default 0.3)",
      "cloudTts.hint": " 勾选=用豆包云 TTS（按字符计费，付费 API Key 生效）；取消=免费 Windows TTS，豆包配置隐藏 / checked = Doubao cloud TTS (per-char billing); unchecked = free Windows TTS, Doubao config hidden",
      "row.stylePreset": "风格预设", "row.prompt": "转写 prompt",
      "row.rate": "语速 rate", "row.pitch": "音调 pitch", "row.voiceName": "语音名 voice",
      "row.apiKey": "apiKey", "row.resourceId": "resourceId", "row.speaker": "音色 speaker",
      "row.rateLevel": "语速", "row.pitchSemitone": "音调（半音）",
      "row.loudness": "音量",
      "streaming.degraded": "双向流不可用，已回退整段合成",
      "dialect.hint": "方言：8 种方言均走 vv 音色 + explicit_dialect（实测生效）；音色/语种会自动互相适配（不锁定）",
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
      "settings.intro": "Each finished turn is transcribed into spoken-style text and read aloud. Settings persist to the voice: section of settings.yaml and take effect on save.",
      "settings.save": "Save", "settings.saved": "✅ Saved to settings.yaml",
      "settings.saveFail": "❌ Save failed: ", "settings.loadFail": "Failed to load config",
      "settings.refresh": "Refresh models/efforts", "settings.refreshed": "Provider/model/effort lists refreshed",
      "settings.preview": "▶ Preview", "settings.stopAll": "⏹ Stop playback",
      "settings.previewFail": "❌ Preview failed: ", "settings.previewBrowser": "▶ Previewing (browser voice)…", "settings.previewCloud": "▶ Previewing (cloud TTS)…",
      "sec.basic": "General", "sec.transcribe": "Transcription",
      "row.transcribeEnabled": "Use transcription model",
      "tts.section.browser": "Engine · Windows system TTS (free)", "tts.section.volcengine": "Engine · Doubao TTS",
      "transcribe.hint.on": "On = LLM spoken-style rewrite (style/emotion, code & tables auto-skipped)",
      "transcribe.hint.off": "Off = read the text as-is; tables and code blocks are skipped",
      "group.auth": "Auth", "group.pronounce": "Pronunciation",
      "row.autoSpeak": "Auto-read", "row.cloudTts": "Cloud TTS", "row.language": "Language/Dialect",
      "row.provider": "Provider", "row.model": "Model",
      "row.temperature": "temperature",
      "temperature.hint": " Higher = more varied & creative but less accurate; lower = more faithful (default 0.3)",
      "cloudTts.hint": " Checked = Doubao cloud TTS (per-char billing, paid API key active); unchecked = free Windows TTS, Doubao config hidden",
      "row.stylePreset": "Style preset", "row.prompt": "Transcribe prompt",
      "row.rate": "Rate", "row.pitch": "Pitch", "row.voiceName": "Voice name",
      "row.apiKey": "apiKey", "row.resourceId": "resourceId", "row.speaker": "Speaker",
      "row.rateLevel": "Speech rate", "row.pitchSemitone": "Pitch (semitones)",
      "row.loudness": "Loudness",
      "streaming.degraded": "Bidirection unavailable; fell back to one-shot synthesis",
      "dialect.hint": "Dialects: all 8 dialects use vv speaker + explicit_dialect (tested working); voice & language auto-adapt to each other (never locked)",
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
    /** 播报状态（messageId → 'speaking' | 'done'）：turnTail 徽标读取 */
    var spokenState = {};
    function markSpoken(messageId, state) { spokenState[String(messageId)] = state; }
    function stopPlaybackOnly() {
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
      if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
      stopStream();
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
        audio.onended = () => { if (currentAudio === audio) currentAudio = null; if (hooks && hooks.onEnd) hooks.onEnd(); };
        audio.onerror = () => { if (currentAudio === audio) currentAudio = null; if (hooks && hooks.onError) hooks.onError("audio playback failed"); };
        const p = audio.play();
        if (p && p.catch) p.catch((e) => { if (hooks && hooks.onError) hooks.onError(String(e && e.message || e)); });
        return true;
      } catch (e) {
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
    // legacy 状态（兜底路径）
    var streamPlaying = false;
    var streamAudio = null;
    // gapless 状态
    var gapless = null;               // { queue, sources, inflight, scheduledEnd, fetchDone }
    var AC = (typeof window !== "undefined") && (window.AudioContext || window.webkitAudioContext);
    var audioCtx = null;
    function ensureAudioContext() {
      if (!AC) return null;
      if (!audioCtx) { try { audioCtx = new AC(); } catch (e) { return null; } }
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
      // 停掉 gapless 已调度源
      if (gapless) {
        for (var i = 0; i < gapless.sources.length; i++) { try { gapless.sources[i].stop(); } catch (e) {} }
        gapless.sources.length = 0;
        gapless.queue.length = 0;
        gapless = null;
      }
      streamHooks = null;
      streamMode = "legacy";
    }
    function startStreamPlayer(runId, hooks, sampleRate) {
      stopStream();
      streamRunId = runId;
      streamHooks = hooks;
      if (typeof sampleRate === "number" && sampleRate > 0) streamSampleRate = sampleRate;
      if (ensureAudioContext()) {
        streamMode = "gapless";
        gapless = { ctx: audioCtx, queue: [], sources: [], inflight: 0, scheduledEnd: 0, fetchDone: false };
        pollStreamOnce();
        streamPollTimer = setInterval(pollStreamOnce, 300);
      } else {
        // 兜底：顺序 <audio>
        streamMode = "legacy";
        streamPlaying = false;
        pollStreamOnce();
        streamPollTimer = setInterval(pollStreamOnce, 400);
      }
    }
    async function pollStreamOnce() {
      if (!streamRunId || streamBusy) return;
      if (streamMode === "gapless") {
        if (gapless && gapless.fetchDone) { pumpQueue(); return; }
        if (gapless && gapless.queue.length >= 3) return; // 预取够 3 段即可，避免堆积
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
        if (streamMode === "gapless") { enqueueSegment(res.url, res.format || "pcm"); return; }
        playStreamSegment(res.url);
        return;
      }
      if (res.done) {
        if (res.warn) console.warn("[voice]", res.warn);
        if (res.effortMapped) console.warn("[voice]", res.effortNote || "configured reasoning effort not applied");
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
    /** 裸 PCM（16bit 小端）→ AudioBuffer：无解码延迟，切在哪都无缝（主路径）。 */
    function buildAudioBufferFromPcm(arrayBuffer, sampleRate) {
      const int16 = new Int16Array(arrayBuffer);
      const frames = int16.length;
      const buf = audioCtx.createBuffer(1, frames, sampleRate || streamSampleRate || 24000);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = int16[i] / 32768;
      return buf;
    }
    /** 取一段音频并解码入队：pcm 裸采样直接建 AudioBuffer；mp3 兜底段走 decodeAudioData。 */
    function enqueueSegment(url, format) {
      if (!gapless) return;
      gapless.inflight++;
      fetch(url)
        .then(function (r) { if (!r.ok) throw new Error("fetch " + r.status); return r.arrayBuffer(); })
        .then(function (buf) {
          if (format === "mp3") return audioCtx.decodeAudioData(buf);
          return buildAudioBufferFromPcm(buf, streamSampleRate);
        })
        .then(function (buffer) {
          if (!gapless) return;
          gapless.inflight--;
          gapless.queue.push(buffer);
          pumpQueue();
        })
        .catch(function (e) {
          if (gapless) gapless.inflight--;
          console.warn("[voice] segment decode failed:", e && e.message || e);
          failStream("stream segment decode failed");
        });
    }
    /** Web Audio lookahead 调度：把队列里的缓冲按上一个结束时刻无缝接上。 */
    function pumpQueue() {
      if (!gapless || !gapless.queue.length) return;
      const ctx = gapless.ctx;
      let t = Math.max(ctx.currentTime + 0.03, gapless.scheduledEnd);
      while (gapless.queue.length) {
        const buf = gapless.queue.shift();
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(t);
        gapless.sources.push(src);
        src.onended = function () {
          if (!gapless) return;
          const idx = gapless.sources.indexOf(src);
          if (idx >= 0) gapless.sources.splice(idx, 1);
          checkStreamEnd();
        };
        t += buf.duration;
        gapless.scheduledEnd = t;
      }
      pollStreamOnce(); // 队列空了，继续取段（填充 ≤3 预取）
    }
    function checkStreamEnd() {
      if (!gapless) return;
      if (gapless.fetchDone && !gapless.inflight && !gapless.queue.length && !gapless.sources.length) {
        endStreamNormally();
      }
    }
    function endStreamNormally() {
      const h = streamHooks;
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
      stopStream();
      if (h && h.onError) h.onError(reason);
    }

    /** 统一播报入口：双向流流式 > 云 TTS 音频 > 浏览器 speechSynthesis；ttsError/degraded/warn 降级告警。 */
    function playResult(res, hooks) {
      stopPlaybackOnly();
      if (res && res.ttsError) console.warn("[voice] cloud tts failed, fallback to browser speech:", res.ttsError);
      if (res && res.degraded) console.warn("[voice]", t("read.degraded"));
      if (res && res.effortMapped) console.warn("[voice]", res.effortNote || "configured reasoning effort not applied");
      if (res && res.warn) console.warn("[voice]", res.warn);
      if (res && res.messageId) markSpoken(res.messageId, "speaking");
      const done = hooks && hooks.onEnd;
      const wrapped = {
        onEnd: () => { if (res && res.messageId) markSpoken(res.messageId, "done"); if (done) done(); },
        onError: hooks && hooks.onError,
      };
      if (res && res.mode === "stream" && res.runId) { startStreamPlayer(res.runId, wrapped, res.sampleRate); return true; }
      if (res && res.audioUrl) return playAudio(res.audioUrl, wrapped);
      return speakText(res && res.transcript, res && res.speech, wrapped);
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

      React.useEffect(() => () => stopPlaybackOnly(), []);

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
    function VoiceTurnBadge(props) {
      const m = props.matched || {};
      async function onReplay() {
        try {
          const res = await rpc("speak", { sessionId: String(props.sessionId), messageId: String(m.messageId) });
          if (res && res.ok) playResult(res, {});
        } catch (e) {}
      }
      return React.createElement("button", {
        className: "dsh-voice-badge",
        onClick: onReplay,
        title: t("badge.replay"),
      }, m.state === "speaking" ? t("badge.speaking") : t("badge.done"));
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

      React.useEffect(() => {
        rpc("meta").then((m) => { if (m && m.ok) setMeta(m); }).catch(() => {});
        rpc("getConfig").then((res) => {
          if (res && res.ok) {
            setCfg(res.config);
            rpc("routeInfo", { provider: res.config.provider, model: res.config.model }).then((ri) => { if (ri && ri.ok) setInfo(ri); }).catch(() => {});
          } else setMsg(t("settings.loadFail") + (res && res.error ? "：" + String(res.error) : ""));
        }).catch((e) => setMsg(t("settings.loadFail") + "：" + String(e && e.message || e)));
      }, []);

      if (!cfg) return React.createElement("div", { className: "dsh-voice-settings" }, msg || "…");

      function setField(path, value) {
        const next = JSON.parse(JSON.stringify(cfg));
        const keys = path.split(".");
        let o = next;
        for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
        o[keys[keys.length - 1]] = value;
        setCfg(next);
        setMsg("");
      }
      async function onSave() {
        setBusy(true); setMsg("");
        try {
          const res = await rpc("setConfig", { patch: cfg });
          if (res && res.ok) { setCfg(res.config); setMsg(t("settings.saved")); }
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
          else if (res.audioUrl) { playAudio(res.audioUrl, {}); setMsg(t("settings.previewCloud")); }
        } catch (e) { setMsg(t("settings.previewFail") + String(e && e.message || e)); }
        setBusy(false);
      }

      const m = meta || FALLBACK_META; // 裂脑兜底
      const presets = m.stylePresets || [];
      const languages = m.languages || [];
      const voices = m.voices || [];
      const speakerKnown = voices.some((v) => v.id === cfg.tts.volcengine.speaker);
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
      /** 云TTS 复选框 = 引擎总开关（父配置）：勾选→豆包（付费 API Key 生效）、取消→免费 Windows TTS；
       * autoSpeakCloudTts 同步写入，保持 Host 成本门控与 UI 一致；取消勾选时豆包子配置不再显示。 */
      function onCloudTtsChange(v) {
        const next = JSON.parse(JSON.stringify(cfg));
        next.tts.provider = v ? "volcengine" : "browser";
        next.autoSpeakCloudTts = !!v;
        setCfg(next);
        setMsg("");
      }

      // TTS 引擎归一：只有 volcengine 视为豆包，其余（含旧值 openai-compatible）按 Windows
      const ttsEngine = cfg.tts.provider === "volcengine" ? "volcengine" : "browser";

      return React.createElement("div", { className: "dsh-voice-settings" },
        React.createElement("h2", null, t("settings.title")),
        React.createElement("p", { className: "dsh-voice-dim" }, t("settings.intro")),

        // —— 基本配置（通用 · 主 → 次）：先决定要不要转写，播报引擎由下方"云TTS"复选框切换 ——
        React.createElement("h3", null, t("sec.basic")),
        React.createElement(Row, { label: t("row.transcribeEnabled") },
          React.createElement(CheckInput, { value: cfg.transcribe.enabled, onChange: (v) => setField("transcribe.enabled", v) }),
          React.createElement("span", { className: "dsh-voice-dim" }, cfg.transcribe.enabled ? t("transcribe.hint.on") : t("transcribe.hint.off"))),
        cfg.transcribe.enabled ? React.createElement("div", { className: "dsh-voice-sub" },
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
            }))
        ) : null,

        React.createElement(Row, { label: t("row.autoSpeak") },
          React.createElement(CheckInput, { value: cfg.autoSpeak, onChange: (v) => setField("autoSpeak", v) }),
          React.createElement("span", { className: "dsh-voice-dim" }, " 每轮结束自动转写并朗读 / auto read each turn")),
        React.createElement(Row, { label: t("row.cloudTts") },
          React.createElement(CheckInput, { value: ttsEngine === "volcengine", onChange: onCloudTtsChange }),
          React.createElement("span", { className: "dsh-voice-dim" }, t("cloudTts.hint"))),

        // —— 播报引擎 · Windows 系统 TTS（免费）——
        ttsEngine === "browser" ? React.createElement(React.Fragment, null,
          React.createElement("h3", null, t("tts.section.browser")),
          React.createElement(Row, { label: t("row.rate") },
            React.createElement(SliderInput, { value: cfg.tts.browser.rate, onChange: (v) => setField("tts.browser.rate", v), min: 0.5, max: 2, step: 0.05, format: (v) => v.toFixed(2) + "x" })),
          React.createElement(Row, { label: t("row.pitch") },
            React.createElement(SliderInput, { value: cfg.tts.browser.pitch, onChange: (v) => setField("tts.browser.pitch", v), min: 0.5, max: 2, step: 0.05, format: (v) => v.toFixed(2) })),
          React.createElement(Row, { label: t("row.voiceName") },
            React.createElement(TextInput, { value: cfg.tts.browser.voice, onChange: (v) => setField("tts.browser.voice", v), placeholder: "系统默认 / system default" }))) : null,

        // —— 播报引擎 · 豆包 TTS（专属配置，分组：鉴权 → 发音；仅有"云TTS"勾选时显示）——
        ttsEngine === "volcengine" ? React.createElement(React.Fragment, null,
          React.createElement("h3", null, t("tts.section.volcengine")),
          React.createElement("h4", null, t("group.auth")),
          React.createElement(Row, { label: t("row.apiKey") },
            React.createElement(TextInput, { type: "password", value: cfg.tts.volcengine.apiKey, onChange: (v) => setField("tts.volcengine.apiKey", v), placeholder: "方舟专属 API Key" })),
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
          React.createElement("p", { className: "dsh-voice-dim" }, t("dialect.hint"))) : null,

        React.createElement("div", { className: "dsh-voice-actions" },
          React.createElement("button", { className: "dsh-voice-read-btn on", onClick: onSave, disabled: busy }, t("settings.save")),
          React.createElement("button", { className: "dsh-voice-read-btn", onClick: onRefreshRoute, disabled: busy }, t("settings.refresh")),
          React.createElement("button", { className: "dsh-voice-read-btn", onClick: onPreview, disabled: busy }, t("settings.preview")),
          React.createElement("button", { className: "dsh-voice-read-btn", onClick: () => stopAll() }, t("settings.stopAll"))),
        msg ? React.createElement("div", { className: "dsh-voice-msg" }, msg) : null);
    }

    // ---------- apply ----------
    function apply(ctx) {
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
          ".dsh-voice-settings h3{margin:14px 0 4px;font-size:14px;border-bottom:1px solid rgba(127,127,127,.2);padding-bottom:4px;}",
          ".dsh-voice-settings h4{margin:10px 0 2px 110px;font-size:12px;color:rgba(127,127,127,.9);letter-spacing:.5px;}",
          ".dsh-voice-sub{margin-left:120px;padding-left:10px;border-left:1px solid rgba(127,127,127,.18);}",
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
          ".dsh-voice-actions{display:flex;gap:8px;margin-top:14px;}",
          ".dsh-voice-msg{margin-top:8px;font-size:12px;}",
        ].join("\n");
        document.head.append(tag);
        return () => tag.remove();
      }, "voice: styles");

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
              stopPlaybackOnly(); // 新 turn 开始，停旧播报
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
      if (ctx.conversationEvents && ctx.conversationEvents.register) {
        ctx.conversationEvents.register(voiceDefinition);
      }

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
        {
          name: "conversation.chat.turnTail",
          select: (owner) => {
            const v = owner.turn && owner.turn.data && owner.turn.data.get ? owner.turn.data.get("voice") : undefined;
            if (!v || !v.messageId) return null;
            const st = spokenState[v.messageId];
            if (!st) return null; // 只 claim 读过的轮次
            return { messageId: v.messageId, state: st };
          },
        },
        VoiceTurnBadge,
      ));
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "voice", order: 30, label: "语音播报" },
        VoiceSettingsSection,
      ));

      console.log("[voice] client half applied (icons + badge + i18n + resilience)");
    }

    const inject = ["slots", "locale", "conversationEvents"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
//#endregion
