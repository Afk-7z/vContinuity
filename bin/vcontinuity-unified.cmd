@echo off
setlocal
cd /d "%~dp0.."
if not defined VCONTINUITY_PORT set "VCONTINUITY_PORT=7781"
node src\vcontinuity\unified-http.mjs
exit /b %ERRORLEVEL%
