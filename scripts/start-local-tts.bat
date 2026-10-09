@echo off
rem 双击本文件即可启动本地 Kokoro TTS 服务（127.0.0.1:8880）。
rem 保持这个黑窗口开着 = 服务在跑；关掉窗口 = 服务停止（插件会提示"local tts 服务不可达"）。
rem 关闭窗口前先在 dsh 里停止播报，或直接关（服务端无状态，重启即可）。
chcp 65001 >nul
cd /d "%~dp0.."

if not exist "local\venv\Scripts\python.exe" (
  echo [错误] 未找到 local\venv\Scripts\python.exe
  echo 请先部署：pwsh scripts\setup-local-tts.ps1
  pause
  exit /b 1
)

echo 启动本地 TTS 服务（首次加载模型需数秒）…
"local\venv\Scripts\python.exe" "scripts\local-tts-server.py" %*
echo.
echo [服务已退出] 上面是退出前的输出。按任意键关闭窗口。
pause >nul
