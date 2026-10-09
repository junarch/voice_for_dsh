#!/usr/bin/env pwsh
# setup-local-tts-cosyvoice.ps1 — 部署本地中文 TTS（Fun-CosyVoice3-0.5B，Apache-2.0）
#
# 与 setup-local-tts.ps1（Kokoro 英文）并列的第二个本地 provider：
#   venv:   local\venv-cosyvoice（Python 3.10-3.12，torch CPU 版）
#   源码:   local\cosyvoice-src（QwenAudio/CosyVoice，含 third_party/Matcha-TTS 子模块）
#   模型:   local\cosyvoice-model（约 4.4GB，ModelScope 国内源，不入库）
#   服务:   scripts\local-tts-server-cosyvoice.py（OpenAI 兼容子集，默认端口 8882）
#
# 用法：pwsh scripts/setup-local-tts-cosyvoice.ps1
# 之后：local\venv-cosyvoice\Scripts\python.exe scripts\local-tts-server-cosyvoice.py

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot | Split-Path
$VenvPy = Join-Path $Root 'local\venv-cosyvoice\Scripts\python.exe'
$Src = Join-Path $Root 'local\cosyvoice-src'
$ModelDir = Join-Path $Root 'local\cosyvoice-model'
$Log = Join-Path $Root 'local\setup-cosyvoice.log'
# 注意：tuna 镜像的 torch 索引不完整（查不到 torch 2.3.1），阿里云镜像全量
$Index = 'https://mirrors.aliyun.com/pypi/simple/'

# ---- 1. Python 3.10-3.12（torch 2.3.1 的支持范围）----
$py = $null
foreach ($cmd in @('py', 'python')) {
  try {
    $v = & $cmd -V 2>&1
    if ($v -match 'Python 3\.(10|11|12)') { $py = $cmd; break }
    if ($cmd -eq 'py') {
      foreach ($ver in @('3.12', '3.11', '3.10')) {
        if (& $cmd -$ver -V 2>$null) { $py = "$cmd -$ver"; break }
      }
      if ($py) { break }
    }
  } catch { }
}
if (-not $py) { throw '未找到 Python 3.10-3.12，请先安装（python.org，勾选 Add to PATH）' }
Write-Host "[1/5] 使用 Python：$py"

# ---- 2. venv ----
if (-not (Test-Path $VenvPy)) {
  Write-Host '[2/5] 创建 venv local\venv-cosyvoice'
  $pyParts = $py -split ' '
  & $pyParts[0] @($pyParts[1..($pyParts.Count - 1)] | Where-Object { $_ }) -m venv (Join-Path $Root 'local\venv-cosyvoice')
} else {
  Write-Host '[2/5] venv 已存在，跳过'
}
& $VenvPy -m pip install --upgrade pip -q -i $Index

# ---- 3. 源码（含 Matcha-TTS 子模块）----
if (-not (Test-Path (Join-Path $Src 'cosyvoice'))) {
  Write-Host '[3/5] 克隆 CosyVoice 源码'
  git clone --recurse-submodules --depth 1 https://github.com/QwenAudio/CosyVoice.git $Src
} else {
  Write-Host '[3/5] 源码已存在，跳过'
}

# ---- 4. 依赖 ----
Write-Host '[4/5] 安装依赖（torch CPU 版 + CosyVoice requirements，日志：local\setup-cosyvoice.log）'
& $VenvPy -m pip install torch==2.3.1 torchaudio==2.3.1 -i $Index --progress-bar off *>> $Log
if ($LASTEXITCODE -ne 0) { throw 'torch 安装失败，见日志' }
& $VenvPy -m pip install -r (Join-Path $Src 'requirements.txt') -i $Index --progress-bar off *>> $Log
if ($LASTEXITCODE -ne 0) { throw 'requirements 安装失败，见日志' }
# openai-whisper 是老 sdist，构建隔离下缺 pkg_resources；推理实际用不到它，
# 但 cosyvoice 顶层 import 它，需装上（--no-build-isolation 用 venv 内 setuptools 构建）
& $VenvPy -m pip install openai-whisper==20231117 -i $Index --no-build-isolation --progress-bar off *>> $Log
if ($LASTEXITCODE -ne 0) { Write-Host '  [警告] openai-whisper 安装失败（不影响核心推理，仅 cosyvoice 顶层 import 需要）' }
& $VenvPy -m pip install modelscope -q -i $Index

# ---- 5. 模型 ----
if (-not (Test-Path (Join-Path $ModelDir 'llm.pt'))) {
  Write-Host '[5/5] 下载模型（约 4.4GB，ModelScope 国内源）'
  # 下载 RL 版权重 llm.rl.pt 后改名为 llm.pt（RL 版指标更好；代码固定加载 llm.pt）
  & $VenvPy -X utf8 -c "from modelscope import snapshot_download; snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512', local_dir=r'$ModelDir', allow_patterns=['*.yaml','*.json','campplus.onnx','speech_tokenizer_v3.onnx','llm.rl.pt','flow.pt','hift.pt','CosyVoice-BlankEN/*'])"
  if ($LASTEXITCODE -ne 0) { throw '模型下载失败' }
  Rename-Item (Join-Path $ModelDir 'llm.rl.pt') llm.pt
} else {
  Write-Host '[5/5] 模型已存在，跳过'
}

Write-Host ''
Write-Host '部署完成。启动服务试听：'
Write-Host '  local\venv-cosyvoice\Scripts\python.exe scripts\local-tts-server-cosyvoice.py'
Write-Host '  自检：http://127.0.0.1:8882/health （模型加载约 10-60s；返回的 perf 字段会显示当前性能档）'
Write-Host ''
Write-Host '可选提速（默认 4 步 flow + PyTorch 估计器）：'
Write-Host '  # 下载 flow 估计器的官方 ONNX（约 1.3GB，ModelScope；下完自动启用 onnxruntime，单次前向约 1.8x）'
Write-Host '  local\venv-cosyvoice\Scripts\python.exe -c "from modelscope import snapshot_download; snapshot_download(''FunAudioLLM/Fun-CosyVoice3-0.5B-2512'', local_dir=r''local\onnx-cache'', allow_patterns=[''flow.decoder.estimator.fp32.onnx''])"'
Write-Host '  # 或直接放到 local\onnx\flow.decoder.estimator.fp32.onnx（服务启动时自动探测）'
