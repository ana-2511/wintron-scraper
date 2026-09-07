@echo off
setlocal

set "SCRIPT_DIR=%~dp0.."
cd /d "%SCRIPT_DIR%"

if not exist logs mkdir logs

echo [%DATE% %TIME%] Starting scheduled Wintron Electronics scrape... >> logs\scheduler_runner.log
node scripts/scrape-new-products.js >> logs\scheduler_runner.log 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

if %EXIT_CODE% EQU 0 (
    echo [%DATE% %TIME%] Scrape completed successfully. >> logs\scheduler_runner.log
) else (
    echo [%DATE% %TIME%] Scrape failed with exit code %EXIT_CODE%. >> logs\scheduler_runner.log
)

exit /b %EXIT_CODE%
