#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""local-tts-server-cosyvoice.py — 本地中文 TTS 合成服务（Fun-CosyVoice3-0.5B，OpenAI 兼容子集）。

与 scripts/local-tts-server.py（Kokoro，英文，端口 8880）同协议，本服务专供中文，默认端口 8882：
  POST /v1/audio/speech
    请求 JSON：{ "model": "fun-cosyvoice3", "input": "<文本>", "voice": "dsh_default",
                 "speed": 1.0, "response_format": "wav" | "pcm16", "instruct": "<情绪指令，可选>",
                 "flow_steps": 4 }   # 可选：覆盖流匹配 ODE 步数（越小越快、音质越平）
    响应：带 X-Sample-Rate 头；response_format=pcm16 → 裸 PCM 16bit 小端 mono 流式分块返回；
          wav → 完整 WAV 容器（整段合成完再返回）。
  GET /health → { "ok": true, "model": "fun-cosyvoice3", "speakers": [...], "perf": {...} }

情绪/风格：请求体多带一个 instruct 字段（OpenAI 协议的向后兼容扩展），例如
"请用开心的、惊喜的语气说"。带 instruct 走 inference_instruct2（情绪可控），不带则走
inference_zero_shot（默认播报腔）。speed≠1 时透传给推理（模型原生支持语速参数）。

性能（CPU 实测，8 秒中文音频，Intel Core Ultra 9 285H）——"0.5B"只是 AR-LLM 那一段，
真正吃时间的是 ① AR-LLM 每秒音频 25 步 ② flow 流匹配 DiT（22 层、每 chunk 10 步 ODE，
且每步含 CFG 两次前向）。默认配置按"能听优先"取值：
  - flow_steps=4（源码默认 10）：flow 时间约减半；首声从 ~21s 降到 ~14s
  - flow 估计器走官方 fp32 ONNX + onnxruntime(CPU)：单次前向 502ms → 280ms（1.8x）
  - 线程预算分离：torch 只留给 AR-LLM/vocoder，onnxruntime 自带线程池跑 flow，两者不再抢核
    （合计实测：RTF 4.56 → 2.78，首声 21.4s → 5.0s）
这些旋钮都可用 CLI 覆盖（--flow-steps/--torch-threads/--ort-threads/--no-ort/--flow-ort）；
关掉 ONNX（--no-ort）时纯 PyTorch 也能跑，只是慢。

音色：启动时把仓库自带 asset/zero_shot_prompt.wav 注册为固定音色 dsh_default；
模型目录下若有 spkinfo（曾保存过 add_zero_shot_spk 的结果）会一并自动加载。

模型：FunAudioLLM/Fun-CosyVoice3-0.5B-2512（Apache-2.0），CPU 推理（torch CPU 版），
文件由部署脚本下载到 <仓库>/local/cosyvoice-model/（不入库）；
flow 估计器的 ONNX（可选，1.33GB）放 <仓库>/local/onnx/（同样不入库）。

用法：local\\venv-cosyvoice\\Scripts\\python.exe scripts\\local-tts-server-cosyvoice.py [--port 8882]
依赖：见 scripts/setup-local-tts-cosyvoice.ps1
"""
import argparse
import asyncio
import io
import os
import sys
import time
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "local" / "cosyvoice-src"
for p in (str(SRC), str(SRC / "third_party" / "Matcha-TTS")):
    if p not in sys.path:
        sys.path.insert(0, p)
os.chdir(SRC)  # cosyvoice 内部按相对路径找资产，必须以源码目录为工作目录
_mpl = REPO_ROOT / "local" / "tmp" / "matplotlib"
_mpl.mkdir(parents=True, exist_ok=True)
os.environ["MPLCONFIGDIR"] = str(_mpl)  # 受限沙箱下用户目录 .matplotlib 不可写，指到仓库内

import numpy as np  # noqa: E402
import torch  # noqa: E402

DEFAULT_VOICE = "dsh_default"
# 注册音色的 prompt 文本必须带 <|endofprompt|>：CosyVoice3 的 LLM 硬性断言文本里含该标记
# （token 151646，yaml 里 allowed_special='all' 时才会被编码成特化 token）。
DEFAULT_PROMPT_TEXT = "You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。"
DEFAULT_PROMPT_WAV = SRC / "asset" / "zero_shot_prompt.wav"
SPEED_MIN, SPEED_MAX = 0.5, 2.0

# instruct 指令的前后缀：CosyVoice3 的 instruct 文本约定以 <|endofprompt|> 结尾，
# 前缀 system 提示按官方 example.py 的写法保留
INSTRUCT_PREFIX = "You are a helpful assistant. "
INSTRUCT_SUFFIX = "<|endofprompt|>"


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


def build_model(model_dir: Path):
    from cosyvoice.cli.cosyvoice import AutoModel

    print(f"[cv3-tts] 加载模型：{model_dir}（CPU，首次加载需 1-2 分钟）", flush=True)
    t0 = time.time()
    model = AutoModel(model_dir=str(model_dir))
    speakers = set(model.list_available_spks())
    # 旧版注册的 dsh_default 缺 <|endofprompt|> 标记（曾用不带前缀的 prompt 文本），
    # 走 spk_id 推理会触发 llm.py 的断言失败；检测到就重注册
    if DEFAULT_VOICE in speakers and "prompt_text" in model.frontend.spk2info[DEFAULT_VOICE]:
        pt = model.frontend.spk2info[DEFAULT_VOICE]["prompt_text"]
        if bool((pt == 151646).any().item()) is False:
            print(f"[cv3-tts] 旧注册音色 {DEFAULT_VOICE} 缺 <|endofprompt|>，重注册", flush=True)
            model.frontend.spk2info.pop(DEFAULT_VOICE)
            speakers.discard(DEFAULT_VOICE)
    if DEFAULT_VOICE not in speakers:
        assert model.add_zero_shot_spk(DEFAULT_PROMPT_TEXT, str(DEFAULT_PROMPT_WAV), DEFAULT_VOICE) is True
        model.save_spkinfo()
        speakers.add(DEFAULT_VOICE)
    print(f"[cv3-tts] 模型就绪（{time.time() - t0:.0f}s），音色：{sorted(speakers)}", flush=True)
    return model, speakers


class OrtFlowEstimator(torch.nn.Module):
    """用官方 fp32 ONNX + onnxruntime(CPU) 跑 flow 的 DiT 估计器（单次前向实测 1.8x 于 PyTorch eager）。

    必须继承 nn.Module：cosyvoice 的 CausalConditionalCFM.forward_estimator 用
    isinstance(self.estimator, nn.Module) 分流，普通对象会被当成 TensorRT 包装器。
    ONNX 无 cache 输入（cache 由 CausalConditionalCFM 在外层处理），流式/整段两条路径通用。
    """

    def __init__(self, onnx_path, threads):
        super().__init__()
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        so.intra_op_num_threads = max(1, threads)
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(str(onnx_path), sess_options=so, providers=["CPUExecutionProvider"])

    def forward(self, x, mask, mu, t, spks, cond, streaming=False):
        out = self.sess.run(None, {
            "x": x.detach().cpu().numpy(), "mask": mask.detach().cpu().numpy(),
            "mu": mu.detach().cpu().numpy(), "t": t.detach().cpu().numpy(),
            "spks": spks.detach().cpu().numpy(), "cond": cond.detach().cpu().numpy(),
        })[0]
        return torch.from_numpy(out)


def install_perf_hooks(model, args):
    """装上性能档：flow 估计器（ONNX/PyTorch）+ flow ODE 步数覆盖。返回 (步数holder, 说明)。"""
    core = model.model
    decoder = core.flow.decoder
    notes = []
    onnx_path = Path(args.flow_ort) if args.flow_ort else (REPO_ROOT / "local" / "onnx" / "flow.decoder.estimator.fp32.onnx")
    if not args.no_ort and onnx_path.exists():
        decoder.__dict__["estimator"] = OrtFlowEstimator(onnx_path, args.ort_threads)
        notes.append(f"flow 估计器=ONNX/onnxruntime({args.ort_threads} 线程)")
    else:
        reason = "已禁用(--no-ort)" if args.no_ort else f"未找到 {onnx_path}"
        notes.append(f"flow 估计器=PyTorch eager（{reason}）")
    # steps 是可变 holder：请求级 flow_steps 只影响当次（每次请求开头重设，不残留）
    steps = {"n": int(args.flow_steps), "default": int(args.flow_steps)}
    # nn.Module 只接受 Module，绕过 __setattr__ 写实例字典即可让 self.decoder(...) 走包装
    core.flow.__dict__["decoder"] = lambda *a, **k: decoder(*a, **{**k, "n_timesteps": steps["n"]})
    notes.append(f"flow 步数={steps['n']}（请求体 flow_steps 可覆盖当次）")
    return steps, notes


def create_app(model, speakers, args, flow_steps, perf_notes):
    import anyio
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.concurrency import run_in_threadpool
    from fastapi.responses import StreamingResponse
    from pydantic import BaseModel

    synth_lock = asyncio.Lock()  # 推理全程串行化：CPU 上并发只会互相拖慢（异步锁：取消时不会漏放）
    _DONE = object()  # 线程池里 next() 用尽的哨兵（StopIteration 不能穿过 Future）

    class SpeechRequest(BaseModel):
        model: str = "fun-cosyvoice3"
        input: str
        voice: str = DEFAULT_VOICE
        speed: float = 1.0
        response_format: str = "wav"
        instruct: str = ""
        flow_steps: int = 0  # >0 时覆盖本次合成的 flow ODE 步数（0=用启动参数）

    app = FastAPI(title="dsh-plugin-voice local TTS (cosyvoice3)")

    @app.get("/health")
    def health():
        return {"ok": True, "model": "fun-cosyvoice3", "speakers": sorted(speakers),
                "perf": {"flow_steps": flow_steps.get("default", flow_steps["n"]), "flow_estimator": perf_notes[0],
                         "torch_threads": args.torch_threads, "ort_threads": args.ort_threads}}

    def model_chunks(text: str, voice: str, speed: float, instruct: str):
        """同步生成器：带 instruct → 情绪指令合成，否则零样本克隆固定音色（惰性，首次 next 才开算）。"""
        if instruct.strip():
            prompt = INSTRUCT_PREFIX + instruct.strip() + INSTRUCT_SUFFIX
            gen = model.inference_instruct2(text, prompt, "", zero_shot_spk_id=voice,
                                            stream=True, speed=speed)
        else:
            gen = model.inference_zero_shot(text, "", "", zero_shot_spk_id=voice,
                                            stream=True, speed=speed)
        for out in gen:
            yield np.asarray(out["tts_speech"]).squeeze(0).astype(np.float32)

    def next_chunk(gen):
        try:
            return next(gen)
        except StopIteration:
            return _DONE

    async def infer(text: str, voice: str, speed: float, instruct: str, request: Request, steps: int = 0):
        """异步生成器：逐块让出推理结果，并在每块之间检查客户端是否已断开。

        同步生成器 + StreamingResponse 时 Starlette 不检查断连：客户端超时/点停止只断掉
        HTTP，服务端会把整段（甚至整篇）算完并一直占着 synth_lock，后续请求全部排队超时。
        改成 async 生成器后，断连（含 uvicorn 取消任务）会在下一个检查点退出，锁立刻释放。
        """
        if synth_lock.locked():
            print("[cv3-tts] 推理锁被占用，本次请求排队等待", flush=True)
        acquired = False
        gen = None
        try:
            # 异步锁在事件循环里 await（可能长时间排队，但取消是安全的：没拿到锁就不会走到 release）
            await synth_lock.acquire()
            acquired = True
            # 每次请求都重设步数：带 flow_steps 用请求值，否则回到启动默认（不残留上一次的覆盖）
            flow_steps["n"] = max(1, min(50, int(steps))) if steps else flow_steps["default"]
            gen = model_chunks(text, voice, speed, instruct)
            while True:
                if await request.is_disconnected():
                    print("[cv3-tts] 客户端已断开，中止本次合成", flush=True)
                    return
                chunk = await run_in_threadpool(next_chunk, gen)
                if chunk is _DONE:
                    return
                yield chunk
        finally:
            # ⚠️ 取消（客户端断开）时 finally 里的 await 会立刻再次抛 CancelledError，
            # 后面的 release 就被跳过 → 锁泄漏 → 之后所有请求永远排队。故这里必须：
            # ① 关闭生成器的 await 放进屏蔽取消的作用域；② release 放在最后且不依赖任何 await。
            if gen is not None:
                try:
                    with anyio.CancelScope(shield=True):
                        await run_in_threadpool(gen.close)  # 触发 GeneratorExit，让模型在下一个产出点停下
                except Exception:
                    pass
            if acquired:
                synth_lock.release()
            # 请求结束回到启动默认，避免"上一次的覆盖"被下次无参请求继承
            flow_steps["n"] = flow_steps.get("default", flow_steps["n"])

    @app.post("/v1/audio/speech")
    async def speech(req: SpeechRequest, request: Request):
        text = (req.input or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="input is empty")
        if req.voice not in speakers:
            # 音色校验放在端点里（生成器内部抛 HTTPException 不会被转成 400）
            raise HTTPException(status_code=400, detail=f"unknown voice: {req.voice} (available: {sorted(speakers)})")
        fmt = (req.response_format or "wav").lower()
        if fmt not in ("wav", "pcm16"):
            raise HTTPException(status_code=400, detail=f"unsupported response_format: {fmt} (wav | pcm16)")
        speed = min(max(float(req.speed or 1.0), SPEED_MIN), SPEED_MAX)
        sample_rate = int(model.sample_rate)
        headers = {"X-Sample-Rate": str(sample_rate)}

        if fmt == "pcm16":
            # 裸 PCM 流式：模型边生成边推块，客户端首块到达即可开播
            async def pcm_stream():
                agen = infer(text, req.voice, speed, req.instruct, request, req.flow_steps)
                try:
                    async for chunk in agen:
                        yield samples_to_pcm_bytes(chunk)
                except Exception as e:
                    print(f"[cv3-tts] 合成失败：{e}", flush=True)
                finally:
                    # 显式收尾：断连时靠 GC 触发异步生成器的 finally 不可靠，锁会泄漏
                    with anyio.CancelScope(shield=True):
                        await agen.aclose()
            return StreamingResponse(pcm_stream(), media_type="audio/pcm", headers=headers)

        # wav（整段）：仍整段返回，但逐块累积期间检查断连——客户端 120s 超时后不再白烧 CPU
        parts = []
        agen = infer(text, req.voice, speed, req.instruct, request, req.flow_steps)
        try:
            async for chunk in agen:
                parts.append(chunk)
        finally:
            with anyio.CancelScope(shield=True):
                await agen.aclose()
        if not parts:
            raise HTTPException(status_code=500, detail="synthesis produced no audio")
        audio = np.concatenate(parts) if len(parts) > 1 else parts[0]
        return StreamingResponse(iter([samples_to_wav_bytes(audio, sample_rate)]),
                                 media_type="audio/wav", headers=headers)

    return app


def main():
    parser = argparse.ArgumentParser(description="本地中文 TTS 合成服务（Fun-CosyVoice3，OpenAI 兼容子集）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8882)
    parser.add_argument("--model-dir", default=str(REPO_ROOT / "local" / "cosyvoice-model"))
    parser.add_argument("--flow-steps", type=int, default=4,
                        help="flow 流匹配 ODE 步数（源码默认 10；越小越快、音质越平，实测 2-4 可用）")
    parser.add_argument("--torch-threads", type=int, default=10,
                        help="torch 线程数（留给 AR-LLM 与声码器；与 ORT 线程数之和建议 ≤ 15）")
    parser.add_argument("--ort-threads", type=int, default=6,
                        help="onnxruntime 线程数（跑 flow 估计器；自带线程池，与 torch 分离）")
    parser.add_argument("--flow-ort", default="", help="flow 估计器 ONNX 路径（默认 <仓库>/local/onnx/flow.decoder.estimator.fp32.onnx）")
    parser.add_argument("--no-ort", action="store_true", help="强制用 PyTorch eager 跑 flow 估计器（排查用）")
    args = parser.parse_args()

    if not torch.cuda.is_available():
        # CPU 推理：线程预算分离——torch 只给 AR-LLM/vocoder，flow 交给 onnxruntime 自己的线程池，
        # 两者不再抢同一批核（实测合计 RTF 3.63→2.78、首声 13.9s→5.0s）
        torch.set_num_threads(max(1, args.torch_threads))
        try:
            torch.set_num_interop_threads(1)
        except Exception:
            pass  # 已在别处初始化过互操作线程池时不可再改

    model, speakers = build_model(Path(args.model_dir))
    flow_steps, perf_notes = install_perf_hooks(model, args)

    import uvicorn
    app = create_app(model, speakers, args, flow_steps, perf_notes)
    print("[cv3-tts] 性能档：" + "；".join(perf_notes), flush=True)
    print(f"[cv3-tts] 监听 http://{args.host}:{args.port}  （自检：GET /health）", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
