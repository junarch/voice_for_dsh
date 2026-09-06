#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""local-tts-server.py — 本地英文 TTS 合成服务（OpenAI 兼容子集）。

协议（docs/local-tts.md §4）：POST /v1/audio/speech
  请求 JSON：{ "model": "kokoro", "input": "<text>", "voice": "af_heart", "speed": 1.0, "response_format": "wav" }
  响应：完整 WAV 音频（audio/wav，PCM 16bit，模型输出采样率 24kHz，mono）。
另提供 GET /health 自检。

模型：Kokoro-82M v1.0（Apache-2.0），经 kokoro-onnx 推理；
模型文件由 scripts/setup-local-tts.ps1 下载到 <仓库>/local/models/（不入库）。
固定英文（lang=en-us）——本服务面向插件的"英文播报"provider（docs/pipeline.md §4.3）。

用法：local\\venv\\Scripts\\python.exe scripts\\local-tts-server.py [--port 8880]
依赖：pip install kokoro-onnx fastapi uvicorn（详见 setup 脚本）
"""
import argparse
import io
import sys
import threading
import wave
from pathlib import Path

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 控制台中文不乱码
except Exception:
    pass

MODEL_PREFERENCE = ["kokoro-v1.0.onnx", "kokoro-v1.0.fp16.onnx", "kokoro-v1.0.int8.onnx"]
DEFAULT_VOICE = "af_heart"
SPEED_MIN, SPEED_MAX = 0.5, 2.0


def find_model_file(models_dir: Path):
    for name in MODEL_PREFERENCE:
        p = models_dir / name
        if p.exists():
            return p
    return None


def build_kokoro(models_dir: Path):
    from kokoro_onnx import Kokoro

    model_path = find_model_file(models_dir)
    if not model_path:
        print(f"[local-tts] 找不到模型文件：{models_dir} 下应有 {' / '.join(MODEL_PREFERENCE)}")
        print('[local-tts] 请先运行：pwsh scripts/setup-local-tts.ps1')
        sys.exit(1)
    voices_path = models_dir / "voices-v1.0.bin"
    if not voices_path.exists():
        print(f"[local-tts] 找不到音色文件：{voices_path}")
        sys.exit(1)
    kwargs = {}
    try:
        from kokoro_onnx import EspeakConfig
        import espeakng_loader  # kokoro-onnx 的自带依赖：内置 espeak-ng 数据路径
        kwargs["espeak_config"] = EspeakConfig(data_path=espeakng_loader.get_data_path())
    except Exception as e:  # 缺 espeak 配置时 kokoro-onnx 会走默认行为，失败会暴露在首次合成
        print(f"[local-tts] espeakng_loader 不可用（{e}），使用 kokoro-onnx 默认配置")
    print(f"[local-tts] 加载模型：{model_path.name}（首次加载需数秒）")
    kokoro = Kokoro(str(model_path), str(voices_path), **kwargs)
    print("[local-tts] 模型就绪")
    return kokoro


def samples_to_wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    """float32 采样 → 16bit PCM mono WAV 字节（零第三方编码依赖）。"""
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def create_app(models_dir: Path):
    from fastapi import FastAPI, HTTPException, Response
    from pydantic import BaseModel

    kokoro = build_kokoro(models_dir)
    synth_lock = threading.Lock()  # onnxruntime 会话串行化，避免并发推理争用

    class SpeechRequest(BaseModel):
        model: str = "kokoro"
        input: str
        voice: str = DEFAULT_VOICE
        speed: float = 1.0
        response_format: str = "wav"

    app = FastAPI(title="dsh-plugin-voice local TTS")

    @app.get("/health")
    def health():
        model = find_model_file(models_dir)
        return {"ok": model is not None, "model": model.name if model else ""}

    @app.post("/v1/audio/speech")
    def speech(req: SpeechRequest):
        text = (req.input or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="input is empty")
        if req.response_format and req.response_format.lower() not in ("wav", "pcm16"):
            raise HTTPException(status_code=400,
                                detail=f"unsupported response_format: {req.response_format} (only wav)")
        speed = min(max(float(req.speed or 1.0), SPEED_MIN), SPEED_MAX)
        try:
            with synth_lock:
                samples, sample_rate = kokoro.create(text, voice=req.voice, speed=speed, lang="en-us")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"synthesis failed: {e}")
        wav = samples_to_wav_bytes(np.asarray(samples, dtype=np.float32), int(sample_rate))
        return Response(content=wav, media_type="audio/wav")

    return app


def main():
    parser = argparse.ArgumentParser(description="本地英文 TTS 合成服务（Kokoro-82M v1.0，OpenAI 兼容子集）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8880)
    repo_root = Path(__file__).resolve().parent.parent
    parser.add_argument("--models-dir", default=str(repo_root / "local" / "models"))
    args = parser.parse_args()

    import uvicorn
    app = create_app(Path(args.models_dir))
    print(f"[local-tts] 监听 http://{args.host}:{args.port}  （自检：GET /health）")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
