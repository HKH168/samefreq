@echo off
chcp 65001 >nul
cd /d "%~dp0backend"
set PORT=3001
echo.
echo   正在启动「乐遇同频」登录服务...
echo   启动后浏览器会自动打开 http://localhost:3001
echo   关闭这个黑窗口 = 停止服务
echo.
start "" http://localhost:3001/#settings
node server.js
pause
