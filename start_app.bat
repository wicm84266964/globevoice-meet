@echo off
echo Starting GlobeVoice Meet...

:: 1. Backend is started by the Electron app itself.
:: The following lines are disabled to prevent duplicate processes.
:: echo Starting Backend...
:: start /min "Translation Backend" cmd /k "python backend/main.py"

:: :: 2. Wait for backend to initialize (3 seconds)
:: timeout /t 3 /nobreak >nul

:: 3. Start Frontend (Electron)
echo Starting Frontend...
cd frontend
call npm run electron

:: If frontend closes, kill backend (optional, but good for cleanup)
taskkill /FI "WINDOWTITLE eq Translation Backend" /F
