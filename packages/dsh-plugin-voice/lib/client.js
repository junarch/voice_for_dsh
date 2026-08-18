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
      "sec.basic": "基本", "sec.model": "转写模型", "sec.style": "播报风格", "sec.tts": "TTS 播报",
      "row.autoSpeak": "自动播报", "row.autoSpeakCloudTts": "云 TTS 自动播报", "row.language": "语种/方言",
      "row.provider": "Provider", "row.model": "模型", "row.effort": "思考档位", "row.maxTokens": "maxTokens",
      "row.temperature": "temperature", "row.contextTurns": "引用上文", "row.readMode": "转写模式",
      "row.stylePreset": "风格预设", "row.prompt": "转写 prompt", "row.ttsProvider": "Provider",
      "row.rate": "语速 rate", "row.pitch": "音调 pitch", "row.voiceName": "语音名 voice",
      "row.apiKey": "apiKey", "row.resourceId": "resourceId", "row.speaker": "音色 speaker",
      "row.sampleRate": "sampleRate", "row.rateLevel": "语速", "row.pitchLevel": "音调",
    };
    var en = {
      "read.read": "🔊 Read", "read.stop": "⏹ Stop", "read.busy": "Transcribing…", "read.retry": "⚠ Retry",
      "read.title": "Transcribe and read this message aloud", "read.busyTitle": "Transcribing, please wait",
      "read.stopTitle": "Stop playback", "read.failPrefix": "Last failure: ",
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
      "sec.basic": "General", "sec.model": "Transcription Model", "sec.style": "Broadcast Style", "sec.tts": "TTS",
      "row.autoSpeak": "Auto-read", "row.autoSpeakCloudTts": "Cloud TTS auto", "row.language": "Language/Dialect",
      "row.provider": "Provider", "row.model": "Model", "row.effort": "Reasoning effort", "row.maxTokens": "maxTokens",
      "row.temperature": "temperature", "row.contextTurns": "Context turns", "row.readMode": "Read mode",
      "row.stylePreset": "Style preset", "row.prompt": "Transcribe prompt", "row.ttsProvider": "Provider",
      "row.rate": "Rate", "row.pitch": "Pitch", "row.voiceName": "Voice name",
      "row.apiKey": "apiKey", "row.resourceId": "resourceId", "row.speaker": "Speaker",
      "row.sampleRate": "sampleRate", "row.rateLevel": "Speech rate", "row.pitchLevel": "Pitch",
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
    var FALLBACK_META = {
      voices: [
        { id: "zh_female_vv_uranus_bigtts", name: "Vivi 2.0" },
        { id: "zh_female_linjianvhai_uranus_bigtts", name: "邻家女孩 2.0" },
        { id: "zh_female_sajiaoxuemei_uranus_bigtts", name: "撒娇学妹 2.0" },
        { id: "zh_female_gaolengyujie_uranus_bigtts", name: "高冷御姐 2.0" },
      ],
      languages: [
        { id: "auto", label: "自动（跟随原文）" }, { id: "zh", label: "中文（普通话）" }, { id: "en", label: "English" },
        { id: "yue", label: "粤语" }, { id: "shanghai", label: "上海话" }, { id: "henan", label: "河南话" },
        { id: "beijing", label: "北京话" }, { id: "tianjin", label: "天津话" }, { id: "sichuan", label: "四川话" },
        { id: "shaanxi", label: "陕西话" }, { id: "dongbei", label: "东北话" },
      ],
      stylePresets: [
        { id: "default", name: "默认模式", prompt: "" },
        { id: "playful", name: "俏皮", prompt: "" },
        { id: "ambiguous", name: "暧昧", prompt: "" },
        { id: "energetic", name: "活力", prompt: "" },
      ],
      readModes: [
        { id: "default", name: "默认模式（完整转写）" },
        { id: "brief", name: "简报模式（简明扼要）" },
      ],
      briefPrompt: "",
      rateStops: ["很慢", "稍慢", "正常", "稍快", "很快"],
      pitchStops: ["很低", "稍低", "正常", "稍高", "很高"],
    };

    // ---------- 播放管理（全局单播）----------
    var currentAudio = null;
    /** 播报状态（messageId → 'speaking' | 'done'）：turnTail 徽标读取 */
    var spokenState = {};
    function markSpoken(messageId, state) { spokenState[String(messageId)] = state; }
    function stopPlaybackOnly() {
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
      if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
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
    /** 统一播报入口：云 TTS 音频优先，否则浏览器 speechSynthesis；ttsError/degraded 降级告警。 */
    function playResult(res, hooks) {
      stopPlaybackOnly();
      if (res && res.ttsError) console.warn("[voice] cloud tts failed, fallback to browser speech:", res.ttsError);
      if (res && res.degraded) console.warn("[voice]", t("read.degraded"));
      if (res && res.messageId) markSpoken(res.messageId, "speaking");
      const done = hooks && hooks.onEnd;
      const wrapped = {
        onEnd: () => { if (res && res.messageId) markSpoken(res.messageId, "done"); if (done) done(); },
        onError: hooks && hooks.onError,
      };
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

      async function onClick() {
        if (status === "speaking") { stopAll(); setStatus("idle"); return; }
        if (status === "busy") return;
        setLastError("");
        setStatus("busy");
        try {
          const res = await rpc("speak", { sessionId: String(props.sessionId), messageId: String(props.messageId) });
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

      let label = t("read.read");
      let title = t("read.title");
      if (status === "busy") { label = t("read.busy"); title = t("read.busyTitle"); }
      else if (status === "speaking") { label = t("read.stop"); title = t("read.stopTitle"); }
      else if (status === "error") { label = t("read.retry"); title = t("read.failPrefix") + (lastError || "unknown"); }

      return React.createElement("button", {
        className: "dsh-voice-read-btn",
        onClick,
        title,
        disabled: status === "busy",
      }, label);
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
      const rateStops = m.rateStops || [];
      const pitchStops = m.pitchStops || [];
      const readModes = m.readModes || FALLBACK_META.readModes;
      const effortOptions = [{ id: "", name: "跟随适配器默认" }].concat(info && info.efforts ? info.efforts : []);
      const effortKnown = effortOptions.some((e) => e.id === cfg.transcribe.reasoningEffort);
      const isBrief = cfg.transcribe.readMode === "brief";
      const isCustom = cfg.transcribe.stylePreset === "custom";
      const presetHit = presets.find((p) => p.id === cfg.transcribe.stylePreset);
      const promptShown = isBrief
        ? (m.briefPrompt || "（简报模式使用内置简报 prompt / built-in brief prompt）")
        : isCustom ? cfg.transcribe.prompt : (presetHit && presetHit.prompt ? presetHit.prompt : cfg.transcribe.prompt);

      return React.createElement("div", { className: "dsh-voice-settings" },
        React.createElement("h2", null, t("settings.title")),
        React.createElement("p", { className: "dsh-voice-dim" }, t("settings.intro")),

        React.createElement("h3", null, t("sec.basic")),
        React.createElement(Row, { label: t("row.autoSpeak") },
          React.createElement(CheckInput, { value: cfg.autoSpeak, onChange: (v) => setField("autoSpeak", v) }),
          React.createElement("span", { className: "dsh-voice-dim" }, " 每轮结束自动转写并朗读 / auto read each turn")),
        React.createElement(Row, { label: t("row.autoSpeakCloudTts") },
          React.createElement(CheckInput, { value: cfg.autoSpeakCloudTts, onChange: (v) => setField("autoSpeakCloudTts", v) }),
          React.createElement("span", { className: "dsh-voice-dim" }, " 云 TTS 按字符计费：默认仅手动触发 / cloud TTS billed per char")),
        React.createElement(Row, { label: t("row.language") },
          React.createElement(SelectInput, { value: cfg.language, onChange: (v) => setField("language", v) },
            languages.map((l) => React.createElement("option", { key: l.id, value: l.id }, l.label))),
          React.createElement("span", { className: "dsh-voice-dim" }, " 固定语种/方言时无论原文语言都按所选播报 / fixed language overrides source")),

        React.createElement("h3", null, t("sec.model")),
        React.createElement(Row, { label: t("row.provider") },
          React.createElement(TextInput, { value: cfg.provider, onChange: (v) => setField("provider", v), placeholder: "deepseek-official" }),
          info && info.providers ? React.createElement("span", { className: "dsh-voice-dim" }, " " + info.providers.join(" / ")) : null),
        React.createElement(Row, { label: t("row.model") },
          React.createElement(TextInput, { value: cfg.model, onChange: (v) => setField("model", v), placeholder: "deepseek-v4-flash" }),
          info && info.models && info.models.length ? React.createElement("span", { className: "dsh-voice-dim" }, " " + info.models.slice(0, 6).join(" / ") + (info.models.length > 6 ? " …" : "")) : null),
        React.createElement(Row, { label: t("row.effort") },
          React.createElement(SelectInput, { value: cfg.transcribe.reasoningEffort, onChange: (v) => setField("transcribe.reasoningEffort", v) },
            effortOptions.map((e) => React.createElement("option", { key: e.id || "_default", value: e.id }, e.id ? e.name + "（" + e.id + "）" : e.name)),
            effortKnown ? null : React.createElement("option", { value: cfg.transcribe.reasoningEffort }, cfg.transcribe.reasoningEffort)),
          React.createElement("span", { className: "dsh-voice-dim" }, " deepseek: off = 思考关闭 / thinking off")),
        React.createElement(Row, { label: t("row.maxTokens") },
          React.createElement(TextInput, { type: "number", value: cfg.transcribe.maxTokens, onChange: (v) => setField("transcribe.maxTokens", v), min: 256, step: 256 }),
          React.createElement("span", { className: "dsh-voice-dim" }, " 撞顶无正文自动 4 倍重试 / 4x retry on max-tokens")),
        React.createElement(Row, { label: t("row.temperature") },
          React.createElement(SliderInput, { value: cfg.transcribe.temperature, onChange: (v) => setField("transcribe.temperature", v), min: 0, max: 2, step: 0.05 })),
        React.createElement(Row, { label: t("row.contextTurns") },
          React.createElement(TextInput, { type: "number", value: cfg.transcribe.contextTurns, onChange: (v) => setField("transcribe.contextTurns", v), min: 0, max: 4, step: 1 }),
          React.createElement("span", { className: "dsh-voice-dim" }, " 转写携带最近 N 轮上下文 / context turns (0=off)")),

        React.createElement("h3", null, t("sec.style")),
        React.createElement(Row, { label: t("row.readMode") },
          React.createElement(SelectInput, { value: cfg.transcribe.readMode, onChange: (v) => setField("transcribe.readMode", v) },
            readModes.map((r) => React.createElement("option", { key: r.id, value: r.id }, r.name))),
          React.createElement("span", { className: "dsh-voice-dim" }, " 简报 = 一两句话说清结论 / brief = conclusions only")),
        !isBrief ? React.createElement(Row, { label: t("row.stylePreset") },
          React.createElement(SelectInput, { value: cfg.transcribe.stylePreset, onChange: (v) => setField("transcribe.stylePreset", v) },
            presets.map((p) => React.createElement("option", { key: p.id, value: p.id }, p.name)),
            React.createElement("option", { value: "custom" }, "自定义 / Custom")),
          React.createElement("span", { className: "dsh-voice-dim" }, " 预设追加语气与 [#语音指令] 标签 / presets add tone & tags")) : null,
        React.createElement(Row, { label: t("row.prompt") },
          React.createElement("textarea", {
            className: "dsh-voice-textarea",
            value: promptShown,
            readOnly: isBrief || !isCustom,
            placeholder: "自定义模式下在此编辑 / editable in Custom mode",
            onChange: (e) => isCustom && !isBrief && setField("transcribe.prompt", e.target.value),
          })),

        React.createElement("h3", null, t("sec.tts")),
        React.createElement(Row, { label: t("row.ttsProvider") },
          React.createElement(SelectInput, { value: cfg.tts.provider, onChange: (v) => setField("tts.provider", v) },
            React.createElement("option", { value: "browser" }, "browser（浏览器语音 / browser voice）"),
            React.createElement("option", { value: "openai-compatible" }, "openai-compatible（/audio/speech）"),
            React.createElement("option", { value: "volcengine" }, "volcengine（火山 doubao-seed-tts-2.0）"))),

        cfg.tts.provider === "browser" ? React.createElement(React.Fragment, null,
          React.createElement(Row, { label: t("row.rate") },
            React.createElement(SliderInput, { value: cfg.tts.browser.rate, onChange: (v) => setField("tts.browser.rate", v), min: 0.5, max: 2, step: 0.05, format: (v) => v.toFixed(2) + "x" })),
          React.createElement(Row, { label: t("row.pitch") },
            React.createElement(SliderInput, { value: cfg.tts.browser.pitch, onChange: (v) => setField("tts.browser.pitch", v), min: 0.5, max: 2, step: 0.05, format: (v) => v.toFixed(2) })),
          React.createElement(Row, { label: t("row.voiceName") },
            React.createElement(TextInput, { value: cfg.tts.browser.voice, onChange: (v) => setField("tts.browser.voice", v), placeholder: "系统默认 / system default" }))) : null,

        cfg.tts.provider === "openai-compatible" ? React.createElement(React.Fragment, null,
          React.createElement(Row, { label: "baseUrl" },
            React.createElement(TextInput, { value: cfg.tts.openaiCompatible.baseUrl, onChange: (v) => setField("tts.openaiCompatible.baseUrl", v), placeholder: "https://your-gateway/v1" })),
          React.createElement(Row, { label: t("row.apiKey") },
            React.createElement(TextInput, { type: "password", value: cfg.tts.openaiCompatible.apiKey, onChange: (v) => setField("tts.openaiCompatible.apiKey", v) })),
          React.createElement(Row, { label: "model" },
            React.createElement(TextInput, { value: cfg.tts.openaiCompatible.model, onChange: (v) => setField("tts.openaiCompatible.model", v), placeholder: "tts-1" })),
          React.createElement(Row, { label: "voice" },
            React.createElement(TextInput, { value: cfg.tts.openaiCompatible.voice, onChange: (v) => setField("tts.openaiCompatible.voice", v) })),
          React.createElement(Row, { label: "format" },
            React.createElement(TextInput, { value: cfg.tts.openaiCompatible.format, onChange: (v) => setField("tts.openaiCompatible.format", v), placeholder: "mp3" }))) : null,

        cfg.tts.provider === "volcengine" ? React.createElement(React.Fragment, null,
          React.createElement(Row, { label: t("row.apiKey") },
            React.createElement(TextInput, { type: "password", value: cfg.tts.volcengine.apiKey, onChange: (v) => setField("tts.volcengine.apiKey", v), placeholder: "方舟专属 API Key" })),
          React.createElement(Row, { label: t("row.resourceId") },
            React.createElement(TextInput, { value: cfg.tts.volcengine.resourceId, onChange: (v) => setField("tts.volcengine.resourceId", v), placeholder: "seed-tts-2.0" })),
          React.createElement(Row, { label: t("row.speaker") },
            React.createElement(TextInput, { value: cfg.tts.volcengine.speaker, onChange: (v) => setField("tts.volcengine.speaker", v), list: "dsh-voice-speakers", placeholder: "zh_female_vv_uranus_bigtts" }),
            React.createElement("datalist", { id: "dsh-voice-speakers" },
              voices.map((v) => React.createElement("option", { key: v.id, value: v.id }, v.name)))),
          React.createElement(Row, { label: t("row.sampleRate") },
            React.createElement(SelectInput, { value: String(cfg.tts.volcengine.sampleRate), onChange: (v) => setField("tts.volcengine.sampleRate", Number(v)) },
              [8000, 16000, 24000, 44100, 48000].map((s) => React.createElement("option", { key: s, value: String(s) }, String(s))))),
          React.createElement(Row, { label: t("row.rateLevel") },
            React.createElement(SliderInput, { value: cfg.tts.volcengine.rateLevel, onChange: (v) => setField("tts.volcengine.rateLevel", v), min: 0, max: 4, step: 1, format: (v) => rateStops[v] || String(v) }),
            React.createElement("span", { className: "dsh-voice-dim" }, " 经 [#语音指令] 实现 / via voice instruction")),
          React.createElement(Row, { label: t("row.pitchLevel") },
            React.createElement(SliderInput, { value: cfg.tts.volcengine.pitchLevel, onChange: (v) => setField("tts.volcengine.pitchLevel", v), min: 0, max: 4, step: 1, format: (v) => pitchStops[v] || String(v) }))) : null,

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
