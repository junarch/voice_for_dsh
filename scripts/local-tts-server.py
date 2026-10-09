#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""local-tts-server.py — 本地英文 TTS 合成服务（OpenAI 兼容子集）。

协议（docs/local-tts.md §4）：POST /v1/audio/speech
  请求 JSON：{ "model": "kokoro", "input": "<text>", "voice": "af_heart", "speed": 1.0, "response_format": "wav" }
  响应：response_format=wav → 完整 WAV 容器（audio/wav）；response_format=pcm16 → 裸 PCM
        （audio/pcm，16bit 小端 mono，无容器头）。两者都带 X-Sample-Rate 响应头（模型输出采样率）。
  插件分句流式播报用的就是 pcm16：一句一请求，客户端零解码延迟直接建 AudioBuffer。
另提供 GET /health 自检。

模型：Kokoro-82M v1.0（Apache-2.0），经 kokoro-onnx 推理；
模型文件由 scripts/setup-local-tts.ps1 下载到 <仓库>/local/models/（不入库）。
固定英文（lang=en-us）——本服务面向插件的"英文播报"provider（docs/pipeline.md §4.3）。

用法：local\\venv\\Scripts\\python.exe scripts\\local-tts-server.py [--port 8880]
依赖：pip install kokoro-onnx fastapi uvicorn（详见 setup 脚本）
"""
import argparse
import io
import os
import shutil
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 控制台中文不乱码
except Exception:
    pass


def _prepare_scratch_dir(scratch_dir: Path):
    """把临时目录固定到肯定可写的位置，并清掉上次留下的 espeak 库副本。

    为什么需要：espeak 后端（phonemizer）每建一个实例都调 tempfile.mkdtemp() 造子目录，
    再把 espeak-ng.dll 复制进去后加载——这是它的硬编码行为，没有配置项可绕开。
    在受限环境（如 dsh 的 workspace-write 文件沙箱，TTS 服务由 dsh 启动时继承该限制）下，
    进程新建的子目录写不进去，合成会以 PermissionError 失败（HTTP 500：
    "synthesis failed: [Errno 13] Permission denied: ...\\Temp\\dsh-*\\tmp*\\espeak-ng.dll"）。
    这里的兜底：先试系统临时目录，不可写则退到仓库内 local/tmp/（随仓库可写），
    再清空 espeak-ng.dll 残留，保证 phonemizer 的 mkdtemp 有可写的父目录。
    """
    candidates = [Path(tempfile.gettempdir()), scratch_dir]
    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / ".write-probe"
            probe.write_bytes(b"ok")
            probe.unlink()
        except Exception:
            continue
        for leftover in candidate.glob("**/espeak-ng.dll"):
            try:
                shutil.rmtree(leftover.parent, ignore_errors=True)
            except Exception:
                pass
        if candidate != Path(tempfile.gettempdir()):
            os.environ["TMPDIR"] = str(candidate)
            os.environ["TEMP"] = str(candidate)
            os.environ["TMP"] = str(candidate)
            tempfile.tempdir = str(candidate)
        return candidate
    raise RuntimeError(f"没有可写的临时目录（已试：{', '.join(str(c) for c in candidates)}）")


def _patch_phonemizer_mkdtemp():
    """让 phonemizer 用普通 os.mkdir 代替 tempfile.mkdtemp 造 espeak 库副本目录。

    mkdtemp 会以 0o700 建目录，受限文件沙箱下该目录对进程自身都不可写；
    普通 os.mkdir 建出的目录正常可写（已实测）。仅在 phonemizer 存在时生效。
    """
    try:
        from phonemizer.backend.espeak import api as espeak_api
    except Exception as e:
        print(f"[local-tts] phonemizer 不可用（{e}），跳过临时目录补丁")
        return

    def _mkdtemp(suffix=None, prefix=None, dir=None):
        base = Path(dir or tempfile.gettempdir())
        base.mkdir(parents=True, exist_ok=True)
        stem = f"{prefix or 'tmp'}{os.getpid()}-{int(time.time() * 1000)}"
        for i in range(1000):
            candidate = base / (f"{stem}-{i}{suffix or ''}")
            try:
                candidate.mkdir()  # 不用 mkdtemp：0o700 在受限沙箱下不可写
                return str(candidate)
            except FileExistsError:
                continue
        raise RuntimeError(f"无法在 {base} 下创建临时目录")

    espeak_api.tempfile.mkdtemp = _mkdtemp

MODEL_PREFERENCE = ["kokoro-v1.0.onnx", "kokoro-v1.0.fp16.onnx", "kokoro-v1.0.int8.onnx"]
DEFAULT_VOICE = "af_heart"
SPEED_MIN, SPEED_MAX = 0.5, 2.0


def find_model_file(models_dir: Path):
    for name in MODEL_PREFERENCE:
        p = models_dir / name
        if p.exists():
            return p
    return None


def build_kokoro(models_dir: Path, scratch_dir: Path):
    from kokoro_onnx import Kokoro

    scratch = _prepare_scratch_dir(scratch_dir)
    print(f"[local-tts] 临时目录：{scratch}（espeak 库副本落在此处）")
    _patch_phonemizer_mkdtemp()

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


def samples_to_pcm_bytes(samples: np.ndarray) -> bytes:
    """float32 采样 → 16bit 小端 mono 裸 PCM 字节（无容器头；客户端零解码延迟）。"""
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    return pcm.tobytes()


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


def create_app(models_dir: Path, scratch_dir: Path):
    from fastapi import FastAPI, HTTPException, Response
    from pydantic import BaseModel

    kokoro = build_kokoro(models_dir, scratch_dir)
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
                                detail=f"unsupported response_format: {req.response_format} (wav | pcm16)")
        speed = min(max(float(req.speed or 1.0), SPEED_MIN), SPEED_MAX)
        try:
            with synth_lock:
                samples, sample_rate = kokoro.create(text, voice=req.voice, speed=speed, lang="en-us")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"synthesis failed: {e}")
        arr = np.asarray(samples, dtype=np.float32)
        # response_format=pcm16 → 裸 PCM（16bit 小端 mono），供插件分句流式：客户端直接
        # Int16→Float32 建 AudioBuffer，无容器解析；wav → 完整 WAV 容器（默认，兼容其它调用方）。
        # X-Sample-Rate 让采样率只有一个事实源（模型输出），调用方无需写死。
        headers = {"X-Sample-Rate": str(int(sample_rate))}
        if (req.response_format or "wav").lower() == "pcm16":
            return Response(content=samples_to_pcm_bytes(arr), media_type="audio/pcm", headers=headers)
        return Response(content=samples_to_wav_bytes(arr, int(sample_rate)), media_type="audio/wav", headers=headers)

    return app


def main():
    parser = argparse.ArgumentParser(description="本地英文 TTS 合成服务（Kokoro-82M v1.0，OpenAI 兼容子集）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8880)
    repo_root = Path(__file__).resolve().parent.parent
    parser.add_argument("--models-dir", default=str(repo_root / "local" / "models"))
    parser.add_argument("--scratch-dir", default=str(repo_root / "local" / "tmp"),
                        help="临时目录兜底位置（系统临时目录不可写时使用，如 dsh 文件沙箱下启动）")
    args = parser.parse_args()

    import uvicorn
    app = create_app(Path(args.models_dir), Path(args.scratch_dir))
    print(f"[local-tts] 监听 http://{args.host}:{args.port}  （自检：GET /health）")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
