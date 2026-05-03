# GlobeVoice Meet 前端

这是桌面端前端工程，基于 `Electron + React + Vite`，负责：

- 展示服务状态与错误信息
- 管理本地 WebSocket 连接
- 提供音频设备选择与 API 配置界面
- 与 Electron 主进程通过 `preload` 暴露的安全 IPC 接口交互

## 开发

```bash
npm install
npm run electron
```

开发模式会先启动 Vite，再由 Electron 拉起窗口；Python 后端由 `electron/main.cjs` 自动启动。

## 构建

```bash
npm run build
npm run electron:build
```

如果需要连同 Python 后端一起完整打包：

```bash
npm run build:all
```

该脚本会先调用 `../backend/build_backend.py` 生成 `backend_engine.exe`，再执行 Electron 打包。

首次执行 `electron-builder` 时，仍可能因为下载 `nsis` 或 Electron 相关缓存而受网络波动影响；成功构建后，缓存会复用，后续构建更稳定。

## 打包产物

- 便携版 EXE：`../release/GlobeVoice Meet-便携版-1.0.0.exe`
- 解包目录：`../release/win-unpacked/`
- 后端 EXE 会被放入 `../release/win-unpacked/resources/backend_engine.exe`

## 后端烟雾测试

可在项目根目录执行：

```bash
python backend/smoke_test_backend.py
```

该脚本会启动本地后端、完成一次 WebSocket 连接与配置更新，并确认服务命令失败时不会卡死。

## 关键目录

- `src/`：React 渲染进程代码
- `electron/`：Electron 主进程与 preload 脚本
- `dist/`：前端构建产物（自动生成，不提交）

## 注意事项

- 推荐使用豆包同声传译大模型 2.0 对应的 App ID 和 Access Token。
- 不要提交 `backend/.env` 或 `backend/.env.runtime`；仓库中只保留 `backend/.env.example`。
- 如果 Electron 窗口启动失败，请优先检查 Python 环境、后端依赖和本地端口占用。
