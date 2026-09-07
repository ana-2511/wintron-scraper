@echo off
setlocal

set "SCRIPT_DIR=%~dp0.."
cd /d "%SCRIPT_DIR%"

if not exist logs mkdir logs

echo [%DATE% %TIME%] Starting daily Sale products scrape... >> logs\scheduler_daily_sale.log
node scripts/scrape-sale-products.js >> logs\scheduler_daily_sale.log 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

if %EXIT_CODE% EQU 0 (
    echo [%DATE% %TIME%] Daily Sale scrape completed successfully. >> logs\scheduler_daily_sale.log
) else (
    echo [%DATE% %TIME%] Daily Sale scrape failed with exit code %EXIT_CODE%. >> logs\scheduler_daily_sale.log
)

exit /b %EXIT_CODE%
