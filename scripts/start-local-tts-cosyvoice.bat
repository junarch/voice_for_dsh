@echo off
rem 手动启动本地中文 TTS（Fun-CosyVoice3，端口 8882）。
rem 等价于：local\venv-cosyvoice\Scripts\python.exe scripts\local-tts-server-cosyvoice.py
rem 关闭 autoStart 或排查时用；正常使用可交给 dsh 自动拉起（设置页「自动启动本地服务」）。
cd /d "%~dp0.."
"local\venv-cosyvoice\Scripts\python.exe" -X utf8 "scripts\local-tts-server-cosyvoice.py" --port 8882
pause
