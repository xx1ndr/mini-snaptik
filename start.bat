@echo off
chcp 65001 >nul
title MyTTDownloader Server
echo ============================================
echo   MyTTDownloader - TikTok Video Downloader
echo ============================================
echo.
cd /d "%~dp0backend"

echo [1/2] Memeriksa dependencies...
if not exist "node_modules" (
    echo Menginstall dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] Gagal install dependencies. Pastikan Node.js terinstall.
        pause
        exit /b 1
    )
)

echo [2/2] Menjalankan server...
echo.
echo Server akan terbuka otomatis di browser...
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"

node server.js

echo.
echo Server berhenti.
pause