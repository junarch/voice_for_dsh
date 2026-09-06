#requires -Version 7
<#
.SYNOPSIS
  本地英文 TTS（Kokoro-82M v1.0）一键部署：建 venv → 装依赖 → 下载模型 → 打印启动命令。
.DESCRIPTION
  遵循依赖管理约定：模型/venv 只落到 local/（.gitignore 已排除），git 仓库只存"清单和方法"。
  详见 docs/local-tts.md。
.PARAMETER Variant
  模型精度：f32（默认，325MB，质量基准）| fp16（169MB）| int8（88MB，CPU 提速明显、音质略降）。
.EXAMPLE
  pwsh scripts/setup-local-tts.ps1
  pwsh scripts/setup-local-tts.ps1 -Variant fp16
#>
param(
  [ValidateSet('f32', 'fp16', 'int8')]
  [string]$Variant = 'f32'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest 大文件时大幅提速

$repoRoot = Split-Path -Parent $PSScriptRoot
$localDir = Join-Path $repoRoot 'local'
$venvDir = Join-Path $localDir 'venv'
$modelsDir = Join-Path $localDir 'models'
$releaseBase = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'

# ---- 0. Python 检查（kokoro-onnx 需要 3.10+，onnxruntime 轮子覆盖 3.10–3.12）----
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { Write-Error '未找到 python，请先安装 Python 3.10–3.12 并勾选 "Add to PATH"（https://www.python.org/downloads/）' }
$ver = (& python --version) 2>&1
Write-Host "Python: $ver"
if ($ver -notmatch '3\.1[0-2]') {
  Write-Warning "建议 Python 3.10–3.12（当前：$ver）；若后续 pip 安装失败请换版本重试"
}

# ---- 1. venv + 依赖 ----
if (-not (Test-Path (Join-Path $venvDir 'Scripts' 'python.exe'))) {
  Write-Host '创建虚拟环境 local\venv …'
  & python -m venv $venvDir
  if ($LASTEXITCODE -ne 0) { Write-Error 'venv 创建失败' }
}
$pip = Join-Path $venvDir 'Scripts' 'python.exe'
Write-Host '安装依赖：kokoro-onnx / fastapi / uvicorn …'
& $pip -m pip install --upgrade pip --quiet
& $pip -m pip install --quiet kokoro-onnx fastapi 'uvicorn[standard]'
if ($LASTEXITCODE -ne 0) { Write-Error 'pip 安装失败（见上方输出）' }

# ---- 2. 模型下载（已存在则跳过）----
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
$modelName = switch ($Variant) {
  'f32' { 'kokoro-v1.0.onnx' }
  'fp16' { 'kokoro-v1.0.fp16.onnx' }
  'int8' { 'kokoro-v1.0.int8.onnx' }
}
$targets = @(
  @{ Url = "$releaseBase/voices-v1.0.bin"; File = Join-Path $modelsDir 'voices-v1.0.bin' }
  @{ Url = "$releaseBase/$modelName";      File = Join-Path $modelsDir $modelName }
)
foreach ($t in $targets) {
  if (Test-Path $t.File) {
    Write-Host "已存在，跳过：$(Split-Path -Leaf $t.File)"
  } else {
    Write-Host "下载（约 350MB 总量，视网络数分钟）：$(Split-Path -Leaf $t.File) …"
    Invoke-WebRequest -Uri $t.Url -OutFile $t.File
  }
}

# ---- 3. 完成：打印启动命令 ----
Write-Host ''
Write-Host '✅ 部署完成。启动服务（保持窗口开着）：' -ForegroundColor Green
Write-Host "  $venvDir\Scripts\python.exe scripts\local-tts-server.py"
Write-Host '自检：浏览器打开 http://127.0.0.1:8880/health 返回 {"ok":true} 即就绪。'
Write-Host '然后在 dsh 设置页 → 语音播报 → 播报引擎选"本地 Kokoro（英文）"。'
