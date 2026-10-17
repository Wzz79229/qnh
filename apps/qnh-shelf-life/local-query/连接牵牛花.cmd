@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 20 或更新版本，再运行此程序。
  pause
  exit /b 1
)
if not exist "node_modules\playwright\package.json" (
  echo 尚未安装依赖。请按本目录 README.md 的首次安装步骤操作。
  pause
  exit /b 1
)
echo 此入口只连接本机牵牛花，不需要 GitHub 或 Cloudflare 密钥。
node connect.mjs
pause
