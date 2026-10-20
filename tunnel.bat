@echo off
title MyTTDownloader - Public Tunnel
echo ==================================================
echo  MyTTDownloader - Cloudflare Public Tunnel
echo ==================================================
echo.

REM cek server lokal sudah jalan
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://localhost:3000/' -UseBasicParsing -TimeoutSec 5).StatusCode | Out-Null; 'OK' } catch { 'FAIL' }" > "%TEMP%\ttcheck.txt" 2>&1
set /p TTSTATUS=<"%TEMP%\ttcheck.txt"
del "%TEMP%\ttcheck.txt" >nul 2>&1

if "%TTSTATUS%"=="FAIL" (
    echo [!] Server lokal belum jalan.
    echo     Jalankan dulu start.bat, lalu jalankan file ini lagi.
    echo.
    pause
    exit /b
)

echo [i] Menghubungkan ke Cloudflare...
echo [i] Server sudah berjalan di http://localhost:3000
echo [i] Tunggu sampai muncul URL https://xxxx.trycloudflare.com
echo [i] Bagikan URL itu ke orang lain - jangan tutup jendela ini!
echo.
echo --------------------------------------------------
echo  URL Publik: akan muncul di bawah ini
echo --------------------------------------------------

"%CD%\backend\bin\cloudflared.exe" tunnel --url http://localhost:3000 --no-autoupdate

echo.
echo [i] Tunnel ditutup.
pause