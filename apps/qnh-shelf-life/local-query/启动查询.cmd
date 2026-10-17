@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
set "QNH_NODE_EXE="
for /f "delims=" %%N in ('where.exe node.exe 2^>nul') do if not defined QNH_NODE_EXE set "QNH_NODE_EXE=%%N"
if not defined QNH_NODE_EXE for /f "tokens=2,*" %%A in ('reg.exe query "HKLM\SOFTWARE\Node.js" /v InstallPath 2^>nul') do if /i "%%A"=="REG_SZ" if exist "%%B\node.exe" set "QNH_NODE_EXE=%%B\node.exe"
if not defined QNH_NODE_EXE for /f "tokens=2,*" %%A in ('reg.exe query "HKLM\SOFTWARE\WOW6432Node\Node.js" /v InstallPath 2^>nul') do if /i "%%A"=="REG_SZ" if exist "%%B\node.exe" set "QNH_NODE_EXE=%%B\node.exe"
if not defined QNH_NODE_EXE goto node_missing
if not exist "node_modules\playwright\package.json" goto dependencies_missing
if defined QNH_CONNECTOR_KEY goto run_agent
powershell.exe -NoProfile -Command "$qnhStatus = 1; $qnhSecret = Read-Host 'Enter QNH_CONNECTOR_KEY, not your QNH password' -AsSecureString; $qnhPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($qnhSecret); try { $env:QNH_CONNECTOR_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($qnhPointer); & $env:QNH_NODE_EXE 'agent.mjs'; $qnhStatus = $LASTEXITCODE } finally { $env:QNH_CONNECTOR_KEY = $null; [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($qnhPointer) }; exit $qnhStatus"
set "QNH_RESULT=%ERRORLEVEL%"
goto finish
:run_agent
"%QNH_NODE_EXE%" agent.mjs
set "QNH_RESULT=%ERRORLEVEL%"
goto finish
:node_missing
echo Node.js 20+ was not found. Install Node.js, then reopen this launcher.
set "QNH_RESULT=1"
goto finish
:dependencies_missing
echo Dependencies are missing. Follow local-query/README.md before running.
set "QNH_RESULT=1"
goto finish
:finish
echo.
pause
exit /b %QNH_RESULT%
