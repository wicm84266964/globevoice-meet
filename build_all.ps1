# GlobeVoice Meet - 完整打包脚本
# 此脚本会将前端和后端打包成独立的应用程序

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  GlobeVoice Meet - 完整打包程序" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 获取项目根目录
$ProjectRoot = $PSScriptRoot
if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$BackendDir = Join-Path $ProjectRoot "backend"
$FrontendDir = Join-Path $ProjectRoot "frontend"
$DistDir = Join-Path $ProjectRoot "dist"
$ReleaseDir = Join-Path $ProjectRoot "release"

# 检查必要的工具
Write-Host "检查环境..." -ForegroundColor Yellow

# 检查 Python
$PythonExists = Get-Command python -ErrorAction SilentlyContinue
if (-not $PythonExists) {
    Write-Error "未找到 Python，请确保 Python 已安装并添加到 PATH"
    exit 1
}
Write-Host "  Python: 已找到" -ForegroundColor Green

# 检查 Node.js
$NodeExists = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeExists) {
    Write-Error "未找到 Node.js，请确保 Node.js 已安装并添加到 PATH"
    exit 1
}
Write-Host "  Node.js: 已找到" -ForegroundColor Green

# 检查 PyInstaller
Write-Host "  检查 PyInstaller..." -ForegroundColor Yellow
python -c "import PyInstaller" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  PyInstaller: 已就绪" -ForegroundColor Green
} else {
    Write-Host "  安装 PyInstaller..." -ForegroundColor Yellow
    python -m pip install pyinstaller
    Write-Host "  PyInstaller: 安装完成" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 步骤 1: 打包后端
Write-Host "步骤 1/3: 打包后端服务..." -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Gray

Set-Location $BackendDir

# 确保 dist 目录存在
if (-not (Test-Path $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
}

# 执行 PyInstaller
Write-Host "正在打包 Python 后端..." -ForegroundColor Yellow
python (Join-Path $BackendDir "build_backend.py")

if ($LASTEXITCODE -ne 0) {
    Write-Error "后端打包失败！"
    exit 1
}

Write-Host "  后端打包成功！" -ForegroundColor Green
Write-Host "  输出: $DistDir\backend_engine.exe" -ForegroundColor Gray
Write-Host ""

# 步骤 2: 构建前端
Write-Host "步骤 2/3: 构建前端..." -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Gray

Set-Location $FrontendDir

# 安装依赖（如果需要）
Write-Host "检查前端依赖..." -ForegroundColor Yellow
if (-not (Test-Path (Join-Path $FrontendDir "node_modules"))) {
    npm install
} else {
    Write-Host "  已检测到 node_modules，跳过 npm install" -ForegroundColor Gray
}

# 构建前端
Write-Host "构建前端项目..." -ForegroundColor Yellow
npm run build

if ($LASTEXITCODE -ne 0) {
    Write-Error "前端构建失败！"
    exit 1
}

Write-Host "  前端构建成功！" -ForegroundColor Green
Write-Host ""

# 步骤 3: 打包 Electron
Write-Host "步骤 3/3: 打包 Electron 应用..." -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Gray

# 确保后端文件存在
if (-not (Test-Path (Join-Path $DistDir "backend_engine.exe"))) {
    Write-Error "后端程序不存在，打包失败！"
    exit 1
}

Write-Host "打包 Electron 应用..." -ForegroundColor Yellow
$env:ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES = "true"
npm run electron:build -- --publish=never

if ($LASTEXITCODE -ne 0) {
    Write-Error "Electron 打包失败！"
    exit 1
}

Write-Host "  Electron 打包成功！" -ForegroundColor Green
Write-Host ""

# 完成
Write-Host "========================================" -ForegroundColor Green
Write-Host "  打包完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "输出文件位置: $ReleaseDir" -ForegroundColor Cyan
Write-Host ""

# 列出输出文件
if (Test-Path $ReleaseDir) {
    Write-Host "生成的文件:" -ForegroundColor Yellow
    Get-ChildItem $ReleaseDir -Recurse | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
        $Size = [math]::Round($_.Length / 1MB, 2)
        Write-Host "  - $($_.Name) ($Size MB)" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "安装程序可以直接在其他 Windows 电脑上运行安装" -ForegroundColor Cyan
Write-Host "便携版可以直接复制到其他电脑使用，无需安装" -ForegroundColor Cyan
Write-Host ""

# 返回项目根目录
Set-Location $ProjectRoot
