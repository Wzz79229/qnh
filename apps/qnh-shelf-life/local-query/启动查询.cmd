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
if defined QNH_CONNECTOR_KEY (
  node agent.mjs
) else (
  powershell -NoProfile -Command "$qnhSecret = Read-Host '请输入 Cloudflare 中配置的 QNH_CONNECTOR_KEY，不是牵牛花密码' -AsSecureString; $qnhPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($qnhSecret); try { $env:QNH_CONNECTOR_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($qnhPointer); node agent.mjs } finally { $env:QNH_CONNECTOR_KEY = $null; [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($qnhPointer) }"
)
pause
