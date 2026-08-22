//#region dsh-plugin-voice — Client half (browser, formal bundle)
/**
 * 语音朗读插件 Client 半（正式 bundle，ModuleLoader 格式）。
 *
 *  - 每条助手消息 IconActions 行："🔊 朗读"按钮（转写→播报/停止）
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
      "read.read": "🔊 朗读", "read.stop": "⏹ 停止", "read.busy": "转写中…", "read.retry": "⚠ 重试",
      "read.title": "转写并朗读此条消息", "read.busyTitle": "正在转写，请稍候", "read.stopTitle": "停止播报",
      "read.regenerate": "↻ 重新生成", "read.regenerateTitle": "用当前配置重新生成（清除旧缓存）",
      "read.failPrefix": "上次失败：", "read.degraded": "转写失败，已直读原文",
      "auto.on": "🔊 自动朗读·开", "auto.off": "🔇 自动朗读·关",
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
      "row.ttsEngine": "播报方式", "row.transcribeEnabled": "需要转写模型",
      "tts.engine.browser": "Windows 系统 TTS（免费）", "tts.engine.volcengine": "豆包 TTS（火山方舟）",
      "tts.section.browser": "播报引擎 · Windows 系统 TTS（免费）", "tts.section.volcengine": "播报引擎 · 豆包 TTS",
      "transcribe.hint.on": "开=LLM 口语化转写（风格/情绪/自动跳过代码与表格）",
      "transcribe.hint.off": "关=不调模型，输出什么直接读；表格和代码块自动跳过",
      "group.auth": "鉴权", "group.pronounce": "发音", "group.audio": "音频", "group.stream": "双向流（高级）",
      "row.autoSpeak": "自动播报", "row.autoSpeakCloudTts": "云 TTS 自动播报", "row.language": "语种/方言",
      "row.provider": "Provider", "row.model": "模型", "row.effort": "思考档位", "row.maxTokens": "maxTokens",
      "row.temperature": "temperature", "row.contextTurns": "引用上文",
      "row.stylePreset": "风格预设", "row.prompt": "转写 prompt",
      "row.rate": "语速 rate", "row.pitch": "音调 pitch", "row.voiceName": "语音名 voice",
      "row.apiKey": "apiKey", "row.resourceId": "resourceId", "row.speaker": "音色 speaker",
      "row.sampleRate": "sampleRate", "row.rateLevel": "语速", "row.pitchLevel": "音调",
      "row.streaming": "流式播放", "row.emotionGranularity": "情感粒度",
      "row.bitRate": "比特率",
      "row.loudness": "音量", "row.sectionId": "会话连续",
      "row.expressive": "表现力增强", "row.wsUrl": "WS 地址",
      "streaming.degraded": "双向流不可用，已回退整段合成",
      "emoVoices.title": "情感控制：LLM 按内容动态生成自然语言语音指令，经 context_texts 对所有豆包 2.0 音色生效（无需额外资源/Key）",
      "emoVoices.hint2": "情感粒度：paragraph=按段动态生成情感指令；message=整条一条指令；off=仅预设机械指令",
      "dialect.hint": "方言：8 种方言均走 vv 音色 + explicit_dialect（实测生效）；音色/语种会自动互相适配（不锁定）",
    };
    var en = {
      "read.read": "🔊 Read", "read.stop": "⏹ Stop", "read.busy": "Transcribing…", "read.retry": "⚠ Retry",
      "read.title": "Transcribe and read this message aloud", "read.busyTitle": "Transcribing, please wait",
      "read.stopTitle": "Stop playback", "read.regenerate": "↻ Regenerate",
      "read.regenerateTitle": "Regenerate with current settings (clears old cache)",
      "read.failPrefix": "Last failure: ",
      "read.degraded": "Transcription failed; read the raw text",
      "auto.on": "🔊 Auto-read on", "auto.off": "🔇 Auto-read off",
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
      "row.ttsEngine": "TTS engine", "row.transcribeEnabled": "Use transcription model",
      "tts.engine.browser": "Windows system TTS (free)", "tts.engine.volcengine": "Doubao TTS (Volcano Ark)",
      "tts.section.browser": "Engine · Windows system TTS (free)", "tts.section.volcengine": "Engine · Doubao TTS",
      "transcribe.hint.on": "On = LLM spoken-style rewrite (style/emotion, code & tables auto-skipped)",
      "transcribe.hint.off": "Off = read the text as-is; tables and code blocks are skipped",
      "group.auth": "Auth", "group.pronounce": "Pronunciation", "group.audio": "Audio", "group.stream": "Streaming (advanced)",
      "row.autoSpeak": "Auto-read", "row.autoSpeakCloudTts": "Cloud TTS auto", "row.language": "Language/Dialect",
      "row.provider": "Provider", "row.model": "Model", "row.effort": "Reasoning effort", "row.maxTokens": "maxTokens",
      "row.temperature": "temperature", "row.contextTurns": "Context turns",
      "row.stylePreset": "Style preset", "row.prompt": "Transcribe prompt",
      "row.rate": "Rate", "row.pitch": "Pitch", "row.voiceName": "Voice name",
      "row.apiKey": "apiKey", "row.resourceId": "resourceId", "row.speaker": "Speaker",
      "row.sampleRate": "sampleRate", "row.rateLevel": "Speech rate", "row.pitchLevel": "Pitch",
      "row.streaming": "Streaming", "row.emotionGranularity": "Emotion granularity",
      "row.bitRate": "Bitrate",
      "row.loudness": "Loudness", "row.sectionId": "Section continuity",
      "row.expressive": "Expressive", "row.wsUrl": "WS URL",
      "streaming.degraded": "Bidirection unavailable; fell back to one-shot synthesis",
      "emoVoices.title": "Emotion: LLM generates a natural-language voice instruction per content, delivered via context_texts on all Doubao 2.0 voices (no extra resource/key needed)",
      "emoVoices.hint2": "Emotion granularity: paragraph=dynamic instruction per paragraph; message=one instruction for whole message; off=preset mechanical instruction only",
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
      pitchStops: ["很低", "稍低", "正常", "稍高", "很高"],
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

      let label = t("read.read");
      let title = t("read.title");
      if (status === "busy") { label = t("read.busy"); title = t("read.busyTitle"); }
      else if (status === "speaking") { label = t("read.stop"); title = t("read.stopTitle"); }
      else if (status === "error") { label = t("read.retry"); title = t("read.failPrefix") + (lastError || "unknown"); }

      // 重新生成按钮：仅在该消息完整朗读过一次（spokenState=done）后出现；busy 时禁用
      const regenShown = spokenState[String(props.messageId)] === "done";

      return React.createElement(React.Fragment, null,
        React.createElement("button", {
          className: "dsh-voice-read-btn",
          onClick,
          title,
          disabled: status === "busy",
        }, label),
        regenShown ? React.createElement("button", {
          className: "dsh-voice-read-btn",
          onClick: onRegen,
          title: t("read.regenerateTitle"),
          disabled: status === "busy",
        }, t("read.regenerate")) : null);
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
      }, enabled ? t("auto.on") : t("auto.off"));
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
      const pitchStops = m.pitchStops || [];
      const effortOptions = [{ id: "", name: "跟随适配器默认" }].concat(info && info.efforts ? info.efforts : []);
      const effortKnown = effortOptions.some((e) => e.id === cfg.transcribe.reasoningEffort);
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

      // TTS 引擎归一：只有 volcengine 视为豆包，其余（含旧值 openai-compatible）按 Windows
      const ttsEngine = cfg.tts.provider === "volcengine" ? "volcengine" : "browser";

      return React.createElement("div", { className: "dsh-voice-settings" },
        React.createElement("h2", null, t("settings.title")),
        React.createElement("p", { className: "dsh-voice-dim" }, t("settings.intro")),

        // —— 基本配置（通用 · 主 → 次）：先选引擎，再决定要不要转写 ——
        React.createElement("h3", null, t("sec.basic")),
        React.createElement(Row, { label: t("row.ttsEngine") },
          React.createElement(SelectInput, { value: ttsEngine, onChange: (v) => setField("tts.provider", v) },
            React.createElement("option", { value: "browser" }, t("tts.engine.browser")),
            React.createElement("option", { value: "volcengine" }, t("tts.engine.volcengine"))),
          React.createElement("span", { className: "dsh-voice-dim" }, " 选哪个引擎，下面只展开它的专属配置 / pick an engine below")),
        React.createElement(Row, { label: t("row.transcribeEnabled") },
          React.createElement(CheckInput, { value: cfg.transcribe.enabled, onChange: (v) => setField("transcribe.enabled", v) }),
          React.createElement("span", { className: "dsh-voice-dim" }, t("transcribe.hint.on"))),
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
          React.createElement(Row, { label: t("row.effort") },
            React.createElement(SelectInput, { value: cfg.transcribe.reasoningEffort, onChange: (v) => setField("transcribe.reasoningEffort", v) },
              effortOptions.map((e) => React.createElement("option", { key: e.id || "_default", value: e.id }, e.id ? e.name + "（" + e.id + "）" : e.name)),
              effortKnown ? null : React.createElement("option", { value: cfg.transcribe.reasoningEffort }, cfg.transcribe.reasoningEffort)),
            React.createElement("span", { className: "dsh-voice-dim" }, " off = 关闭思考；模型不支持的档位自动降级（如 minimal/low）")),
          info && !effortKnown && cfg.transcribe.reasoningEffort ? React.createElement("p", { className: "dsh-voice-warn" },
            "当前模型不支持思考档位 \"" + cfg.transcribe.reasoningEffort + "\"，播报时将自动降级到最接近的档位（如 minimal/low）") : null,
          React.createElement(Row, { label: t("row.maxTokens") },
            React.createElement(TextInput, { type: "number", value: cfg.transcribe.maxTokens, onChange: (v) => setField("transcribe.maxTokens", v), min: 256, step: 256 }),
            React.createElement("span", { className: "dsh-voice-dim" }, " 撞顶无正文自动 4 倍重试 / 4x retry on max-tokens")),
          React.createElement(Row, { label: t("row.temperature") },
            React.createElement(SliderInput, { value: cfg.transcribe.temperature, onChange: (v) => setField("transcribe.temperature", v), min: 0, max: 2, step: 0.05 })),
          React.createElement(Row, { label: t("row.contextTurns") },
            React.createElement(TextInput, { type: "number", value: cfg.transcribe.contextTurns, onChange: (v) => setField("transcribe.contextTurns", v), min: 0, max: 4, step: 1 }),
            React.createElement("span", { className: "dsh-voice-dim" }, " 转写携带最近 N 轮上下文（情绪捕捉用）/ context turns (0=off)")),
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
        ) : React.createElement("p", { className: "dsh-voice-dim" }, t("transcribe.hint.off")),

        React.createElement(Row, { label: t("row.autoSpeak") },
          React.createElement(CheckInput, { value: cfg.autoSpeak, onChange: (v) => setField("autoSpeak", v) }),
          React.createElement("span", { className: "dsh-voice-dim" }, " 每轮结束自动转写并朗读 / auto read each turn")),
        React.createElement(Row, { label: t("row.autoSpeakCloudTts") },
          React.createElement(CheckInput, { value: cfg.autoSpeakCloudTts, onChange: (v) => setField("autoSpeakCloudTts", v) }),
          React.createElement("span", { className: "dsh-voice-dim" }, " 云 TTS 按字符计费：默认仅手动触发 / cloud TTS billed per char")),

        // —— 播报引擎 · Windows 系统 TTS（免费）——
        ttsEngine === "browser" ? React.createElement(React.Fragment, null,
          React.createElement("h3", null, t("tts.section.browser")),
          React.createElement(Row, { label: t("row.rate") },
            React.createElement(SliderInput, { value: cfg.tts.browser.rate, onChange: (v) => setField("tts.browser.rate", v), min: 0.5, max: 2, step: 0.05, format: (v) => v.toFixed(2) + "x" })),
          React.createElement(Row, { label: t("row.pitch") },
            React.createElement(SliderInput, { value: cfg.tts.browser.pitch, onChange: (v) => setField("tts.browser.pitch", v), min: 0.5, max: 2, step: 0.05, format: (v) => v.toFixed(2) })),
          React.createElement(Row, { label: t("row.voiceName") },
            React.createElement(TextInput, { value: cfg.tts.browser.voice, onChange: (v) => setField("tts.browser.voice", v), placeholder: "系统默认 / system default" }))) : null,

        // —— 播报引擎 · 豆包 TTS（专属配置，分组：鉴权 → 发音 → 音频 → 双向流）——
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
          React.createElement(Row, { label: t("row.pitchLevel") },
            React.createElement(SliderInput, { value: cfg.tts.volcengine.pitchLevel, onChange: (v) => setField("tts.volcengine.pitchLevel", v), min: 0, max: 4, step: 1, format: (v) => pitchStops[v] || String(v) }),
            React.createElement("span", { className: "dsh-voice-dim" }, " 半音 pitch 参数实现 / via pitch semitones")),
          React.createElement(Row, { label: t("row.loudness") },
            React.createElement(SliderInput, { value: cfg.tts.volcengine.loudness, onChange: (v) => setField("tts.volcengine.loudness", v), min: -50, max: 100, step: 5, format: (v) => String(v) }),
            React.createElement("span", { className: "dsh-voice-dim" }, " 音量 loudness_rate")),
          React.createElement("h4", null, t("group.audio")),
          React.createElement(Row, { label: t("row.sampleRate") },
            React.createElement(SelectInput, { value: String(cfg.tts.volcengine.sampleRate), onChange: (v) => setField("tts.volcengine.sampleRate", Number(v)) },
              [8000, 16000, 24000, 44100, 48000].map((s) => React.createElement("option", { key: s, value: String(s) }, String(s))))),
          React.createElement(Row, { label: t("row.bitRate") },
            React.createElement(TextInput, { type: "number", value: cfg.tts.volcengine.bitRate, onChange: (v) => setField("tts.volcengine.bitRate", v), min: 0, step: 1000 }),
            React.createElement("span", { className: "dsh-voice-dim" }, " MP3 专用（仅 HTTP 模式生效；双向流用 pcm）/ mp3-only (HTTP mode)")),
          React.createElement("h4", null, t("group.stream")),
          React.createElement(Row, { label: t("row.streaming") },
            React.createElement(CheckInput, { value: cfg.tts.volcengine.streaming, onChange: (v) => setField("tts.volcengine.streaming", v) }),
            React.createElement("span", { className: "dsh-voice-dim" }, " 边转写边合成边播（低延迟）/ stream while transcribing")),
          React.createElement(Row, { label: t("row.emotionGranularity") },
            React.createElement(SelectInput, { value: cfg.tts.volcengine.emotionGranularity, onChange: (v) => setField("tts.volcengine.emotionGranularity", v) },
              React.createElement("option", { value: "paragraph" }, "paragraph（按段动态情感 / per-paragraph）"),
              React.createElement("option", { value: "message" }, "message（整条单会话 / one session）"),
              React.createElement("option", { value: "off" }, "off（仅预设指令 / preset only）")),
            React.createElement("span", { className: "dsh-voice-dim" }, " " + t("emoVoices.hint2"))),
          React.createElement(Row, { label: t("row.sectionId") },
            React.createElement(CheckInput, { value: cfg.tts.volcengine.useSectionId, onChange: (v) => setField("tts.volcengine.useSectionId", v) }),
            React.createElement("span", { className: "dsh-voice-dim" }, " 跨次合成语气连续 / conversational continuity")),
          React.createElement(Row, { label: t("row.expressive") },
            React.createElement(CheckInput, { value: cfg.tts.volcengine.expressive, onChange: (v) => setField("tts.volcengine.expressive", v) }),
            React.createElement("span", { className: "dsh-voice-dim" }, " seed-tts-2.0-expressive（效果抽卡）")),
          React.createElement(Row, { label: t("row.wsUrl") },
            React.createElement(TextInput, { value: cfg.tts.volcengine.wsUrl, onChange: (v) => setField("tts.volcengine.wsUrl", v), placeholder: "空=plan 网关 / v3 网关需对应 Key" })),
          React.createElement("p", { className: "dsh-voice-dim" }, t("emoVoices.title")),
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

      console.log("[voice] client half applied (badge + i18n + resilience)");
    }

    const inject = ["slots", "locale", "conversationEvents"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
//#endregion
