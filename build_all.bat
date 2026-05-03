@echo off
chcp 65001 >nul
echo ========================================
echo   GlobeVoice Meet - 完整打包程序
echo ========================================
echo.

set "PROJECT_ROOT=%~dp0"
set "BACKEND_DIR=%PROJECT_ROOT%backend"
set "FRONTEND_DIR=%PROJECT_ROOT%frontend"
set "DIST_DIR=%PROJECT_ROOT%dist"
set "RELEASE_DIR=%PROJECT_ROOT%release"

echo 检查环境...

python --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 未找到 Python
    exit /b 1
)
echo   Python: 已找到

node --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 未找到 Node.js
    exit /b 1
)
echo   Node.js: 已找到

echo.
echo ========================================
echo.

REM 步骤 1: 打包后端
echo 步骤 1/3: 打包后端服务...
echo ----------------------------------------

cd /d "%BACKEND_DIR%"

if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"

echo 正在打包 Python 后端...

python "%BACKEND_DIR%\build_backend.py"

if errorlevel 1 (
    echo 错误: 后端打包失败！
    exit /b 1
)

echo   后端打包成功！
echo   输出: %DIST_DIR%\backend_engine.exe
echo.

REM 步骤 2: 构建前端
echo 步骤 2/3: 构建前端...
echo ----------------------------------------

cd /d "%FRONTEND_DIR%"

echo 检查前端依赖...
if not exist "%FRONTEND_DIR%\node_modules" (
    call npm install
) else (
    echo   已检测到 node_modules，跳过 npm install
)

echo 构建前端项目...
call npm run build

if errorlevel 1 (
    echo 错误: 前端构建失败！
    exit /b 1
)

echo   前端构建成功！
echo.

REM 步骤 3: 打包 Electron
echo 步骤 3/3: 打包 Electron 应用...
echo ----------------------------------------

if not exist "%DIST_DIR%\backend_engine.exe" (
    echo 错误: 后端程序不存在！
    exit /b 1
)

echo 打包 Electron 应用...
set "ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES=true"
call npm run electron:build -- --publish=never

if errorlevel 1 (
    echo 错误: Electron 打包失败！
    exit /b 1
)

echo   Electron 打包成功！
echo.

REM 完成
echo ========================================
echo   打包完成！
echo ========================================
echo.
echo 输出文件位置: %RELEASE_DIR%
echo.

if exist "%RELEASE_DIR%" (
    echo 生成的文件:
    dir /b /s "%RELEASE_DIR%\*.exe" 2>nul
)

echo.
echo 安装程序可以直接在其他 Windows 电脑上运行安装
echo 便携版可以直接复制到其他电脑使用，无需安装
echo.

cd /d "%PROJECT_ROOT%"
pause
