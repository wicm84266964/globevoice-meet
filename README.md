# GlobeVoice Meet

GlobeVoice Meet 是一个面向跨国会议的实时同声传译桌面助手，使用 Electron + React 构建桌面界面，使用 Python 后端采集音频、连接火山引擎同声传译 WebSocket 服务，并把实时字幕与翻译音频回传到桌面端。

## 项目缘起

这个项目最初是为了一次和外国导师的远程视频会议准备的。现成的同传软件或会议翻译服务价格比较高，常见方案每月要一百多元，对偶尔开跨国语音会议的人来说有点不划算。

于是我自己接入了豆包同声传译模型，做了一个能在桌面端运行的实时同传助手。实际开会后感觉效果还可以，基本能支撑顺畅交流，所以把这次项目整理出来分享给有类似需求的人。

## 推荐配置

- **服务**：豆包同声传译大模型 2.0
- **凭证**：在本地复制 `backend/.env.example` 为 `backend/.env`，填入自己的 `APP_ID` 和 `ACCESS_TOKEN`
- **注意**：不要提交 `backend/.env`、`backend/.env.runtime`、打包产物或日志文件

## 会议音频接入说明

GlobeVoice Meet 本身不内置虚拟音频驱动。若需要把翻译后的语音接入 Zoom、Teams、腾讯会议等会议软件，请自行安装第三方虚拟音频设备，并在应用中选择对应输出设备。

Windows 推荐：
- VB-Cable: https://vb-audio.com/Cable/
- Voicemeeter: https://vb-audio.com/Voicemeeter/

macOS 推荐：
- BlackHole: https://github.com/ExistentialAudio/BlackHole

出于驱动安装权限、系统兼容性和第三方授权原因，本项目不会将这些虚拟音频插件打包进发布包。

### 密钥安全说明

- Access Token **不会**被持久化到磁盘。前端仅在编辑/保存流程中临时持有 Token，关闭后即丢弃。
- APP ID 会保存到 `backend/.env.runtime` 以便下次启动时自动加载。
- 如需持久化 Access Token，请手动编辑 `backend/.env`，并确保该文件不被提交到版本控制。
- 未来版本可能引入系统凭据管理（如 Electron safeStorage）实现加密存储。

## 运行环境

| 依赖 | 版本要求 |
|------|----------|
| Python | 3.10+ |
| Node.js | 18+ |
| npm | 9+ |

### Python 依赖

```bash
cd backend
pip install -r requirements.txt
```

> **PyAudio / PortAudio 安装提示**
>
> - **Windows**：`pip install pyaudio` 通常可直接安装预编译 wheel。如果失败，可从 [这里](https://www.lfd.uci.edu/~gohlke/pythonlibs/#pyaudio) 下载对应版本的 `.whl` 文件手动安装。
> - **macOS**：先安装 PortAudio：`brew install portaudio`，然后 `pip install pyaudio`。
> - **Linux (Debian/Ubuntu)**：`sudo apt-get install portaudio19-dev python3-pyaudio`，然后 `pip install pyaudio`。

### 前端依赖

```bash
cd frontend
npm install
```

## 开发运行

```bash
cd frontend
npm run electron
```

开发模式会先启动 Vite 开发服务器，再由 Electron 拉起窗口；Python 后端由 Electron 主进程自动启动。

## 完整打包

```powershell
.\build_all.ps1
```

或在 `frontend` 目录下执行：

```bash
npm run build:all
```

打包产物位于 `release/` 目录。

## 项目结构

- `backend/`：Python WebSocket 后端、音频采集、火山引擎同声传译连接逻辑
- `frontend/`：Electron + React 桌面界面
- `build_all.ps1` / `build_all.bat`：Windows 一键打包脚本
- `ZOOM使用指南.md`：会议软件音频路由使用说明

## 发布前检查

```bash
python backend/smoke_test_backend.py
```

```bash
cd frontend && npm run lint
cd frontend && npm run build
```

## 许可证

本项目基于 MIT 许可证开源，详见 [LICENSE](LICENSE)。
