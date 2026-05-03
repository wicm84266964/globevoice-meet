const { app, BrowserWindow, screen, ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const WINDOW_WIDTH = 900;
const WINDOW_HEIGHT = 700;
const MIN_WINDOW_WIDTH = 760;
const MIN_WINDOW_HEIGHT = 520;
const SUBTITLE_FOCUS_MIN_WINDOW_HEIGHT = 320;
const MAX_WINDOW_WIDTH = 960;
const WINDOW_MARGIN = 32;
const logFilePath = path.join(os.tmpdir(), 'globevoice-meet.log');

function log(message, error) {
  const details = error instanceof Error ? `\n${error.stack || error.message}` : '';
  const line = `[${new Date().toISOString()}] ${message}${details}\n`;

  try {
    fs.appendFileSync(logFilePath, line, 'utf8');
  } catch (writeError) {
    console.error('写入日志失败:', writeError);
  }

  if (error) {
    console.log(message, error);
    return;
  }

  console.log(message);
}

// Generate a random token for local WebSocket authentication
const wsToken = crypto.randomUUID();
process.env.WS_AUTH_TOKEN = wsToken;
log(`应用启动，日志文件: ${logFilePath}`);

let mainWindow = null;
let backendProcess = null;
let alwaysOnTopEnabled = false;
let hasTemporaryAlwaysOnTop = false;
let subtitleFocusModeEnabled = false;
let activeMinWindowWidth = MIN_WINDOW_WIDTH;
let activeMinWindowHeight = MIN_WINDOW_HEIGHT;
let savedNormalWindowBounds = null;

function getActiveMinWindowSize() {
  return {
    minWidth: activeMinWindowWidth,
    minHeight: activeMinWindowHeight,
  };
}

function applyActiveMinimumWindowSize() {
  const activeMinSize = getActiveMinWindowSize();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setMinimumSize(activeMinSize.minWidth, activeMinSize.minHeight);
  }
  return activeMinSize;
}

function getDisplayForWindowBounds(bounds) {
  if (!bounds) {
    return screen.getPrimaryDisplay();
  }
  return screen.getDisplayMatching(bounds);
}

function getMaxWindowWidthForDisplay(display, minWidth) {
  const availableWidth = Math.max(display.workArea.width - WINDOW_MARGIN, minWidth);
  return Math.min(MAX_WINDOW_WIDTH, availableWidth);
}

function clampWindowSizeForDisplay(display, width, height) {
  const activeMinSize = getActiveMinWindowSize();
  const maxWidth = getMaxWindowWidthForDisplay(display, activeMinSize.minWidth);
  const maxHeight = Math.max(display.workArea.height - WINDOW_MARGIN, activeMinSize.minHeight);
  return {
    width: Math.min(Math.max(Number(width) || WINDOW_WIDTH, activeMinSize.minWidth), maxWidth),
    height: Math.min(Math.max(Number(height) || WINDOW_HEIGHT, activeMinSize.minHeight), maxHeight),
  };
}

function getSubtitleBarBounds(display, width, height) {
  const clamped = clampWindowSizeForDisplay(display, width, height);
  const centeredX = display.workArea.x + Math.round((display.workArea.width - clamped.width) / 2);
  const bottomAnchoredY = display.workArea.y + display.workArea.height - clamped.height - WINDOW_MARGIN;
  return {
    width: clamped.width,
    height: clamped.height,
    x: centeredX,
    y: Math.max(display.workArea.y, bottomAnchoredY),
  };
}

function setSubtitleFocusMode(enabled) {
  const wasEnabled = subtitleFocusModeEnabled;
  subtitleFocusModeEnabled = Boolean(enabled);
  activeMinWindowWidth = MIN_WINDOW_WIDTH;
  activeMinWindowHeight = subtitleFocusModeEnabled
    ? SUBTITLE_FOCUS_MIN_WINDOW_HEIGHT
    : MIN_WINDOW_HEIGHT;

  const activeMinSize = applyActiveMinimumWindowSize();

  if (mainWindow && !mainWindow.isDestroyed()) {
    const currentBounds = mainWindow.getBounds();

    if (subtitleFocusModeEnabled) {
      if (!wasEnabled) {
        savedNormalWindowBounds = { ...currentBounds };
      }

      const display = getDisplayForWindowBounds(currentBounds);
      const subtitleBarBounds = getSubtitleBarBounds(display, currentBounds.width, currentBounds.height);
      mainWindow.setBounds(subtitleBarBounds);
    } else {
      const restoreBounds = savedNormalWindowBounds
        ? { ...savedNormalWindowBounds }
        : currentBounds;
      const display = getDisplayForWindowBounds(restoreBounds);
      const restoredSize = clampWindowSizeForDisplay(display, restoreBounds.width, restoreBounds.height);
      const nextBounds = {
        x: restoreBounds.x,
        y: restoreBounds.y,
        width: restoredSize.width,
        height: restoredSize.height,
      };

      mainWindow.setBounds(nextBounds);
      savedNormalWindowBounds = null;
    }
  }

  return activeMinSize;
}

function applyAlwaysOnTopState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.setAlwaysOnTop(hasTemporaryAlwaysOnTop || alwaysOnTopEnabled);
}

// 启动后端服务
function startBackend() {
  return new Promise((resolve, reject) => {
    const isDev = !app.isPackaged;

    let command;
    let args;
    let cwd;

    if (isDev) {
      const backendDir = path.join(__dirname, '../../backend');
      command = 'python';
      args = ['main.py', '--token', wsToken];
      cwd = backendDir;
      log(`开发模式：使用 Python 启动后端服务，工作目录: ${cwd}`);
    } else {
      const backendPath = path.join(process.resourcesPath, 'backend_engine.exe');
      if (!fs.existsSync(backendPath)) {
        log(`后端程序不存在: ${backendPath}`);
        return reject(new Error('后端程序不存在: ' + backendPath));
      }
      command = backendPath;
      args = ['--token', wsToken];
      cwd = null;
      log(`生产模式：使用打包后的后端程序 ${backendPath}`);
    }

    log(`尝试启动后端服务: ${command} ${args.join(' ')}`);

    try {
      let isSettled = false;

      const settleResolve = (value) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        clearTimeout(startupTimeout);
        resolve(value);
      };

      const settleReject = (error) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        clearTimeout(startupTimeout);
        reject(error);
      };

      const options = { detached: false, windowsHide: true };
      if (cwd) {
        options.cwd = cwd;
      }

      backendProcess = spawn(command, args, options);

      const startupTimeout = setTimeout(() => {
        log('后端启动超时。');
        settleReject(new Error('Backend startup timed out.'));
      }, 15000); // 15秒超时

      backendProcess.stdout.on('data', (data) => {
        const output = data.toString();
        log(`[后端] ${output.trim()}`);
        if (output.includes('BACKEND_READY')) {
          log('后端已就绪。');
          settleResolve(true);
        }
      });

      backendProcess.stderr.on('data', (data) => {
        log(`[后端输出] ${data.toString().trim()}`);
      });

      backendProcess.on('error', (err) => {
        log('启动后端服务失败', err);
        settleReject(err);
      });
      
      backendProcess.on('close', (code) => {
        log(`后端进程退出，退出码: ${code}`);
        if (!isSettled && code !== 0) {
          settleReject(new Error(`Backend exited before ready with code ${code}`));
        }
        backendProcess = null;
      });

    } catch (error) {
      log('启动后端服务时发生异常', error);
      reject(error);
    }
  });
}

// 停止后端服务
function stopBackend() {
  if (backendProcess) {
    log(`停止后端服务，PID: ${backendProcess.pid}`);
    try {
      backendProcess.kill();
      backendProcess = null;
    } catch (error) {
      log('停止后端服务失败', error);
    }
  }
}

function createWindow() {
  const isDev = !app.isPackaged;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  hasTemporaryAlwaysOnTop = false;
  subtitleFocusModeEnabled = false;
  activeMinWindowWidth = MIN_WINDOW_WIDTH;
  activeMinWindowHeight = MIN_WINDOW_HEIGHT;
  savedNormalWindowBounds = null;

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    x: Math.round((width - WINDOW_WIDTH) / 2),
    y: Math.round((height - WINDOW_HEIGHT) / 2),
    frame: false,
    transparent: isDev,
    alwaysOnTop: alwaysOnTopEnabled,
    resizable: true,
    hasShadow: !isDev,
    backgroundColor: '#111827',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.once('ready-to-show', () => {
    log('主窗口 ready-to-show');
    mainWindow.center();
    hasTemporaryAlwaysOnTop = true;
    applyAlwaysOnTopState();
    mainWindow.show();
    mainWindow.focus();
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        hasTemporaryAlwaysOnTop = false;
        applyAlwaysOnTopState();
      }
    }, 3000);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('主窗口 did-finish-load');
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log(`renderer console[level=${level}] ${message} @ ${sourceId}:${line}`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log(`主窗口 did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`渲染进程退出: reason=${details.reason} exitCode=${details.exitCode}`);
  });

  mainWindow.on('unresponsive', () => {
    log('主窗口无响应');
  });

  mainWindow.on('show', () => {
    log('主窗口 show');
  });

  mainWindow.on('closed', () => {
    log('主窗口 closed');
  });

  // 处理窗口移动
  ipcMain.on('move-window', (event, { deltaX, deltaY }) => {
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition(x + deltaX, y + deltaY);
    }
  });

  // 提供 WebSocket Token 给前端
  ipcMain.handle('get-ws-token', () => process.env.WS_AUTH_TOKEN);

  ipcMain.handle('get-min-window-size', () => ({
    ...getActiveMinWindowSize(),
  }));

  ipcMain.handle('set-subtitle-focus-mode', (_event, enabled) => {
    const activeMinSize = setSubtitleFocusMode(enabled);
    log(`字幕聚焦模式已${subtitleFocusModeEnabled ? '开启' : '关闭'}，最小尺寸 ${activeMinSize.minWidth}x${activeMinSize.minHeight}`);
    return activeMinSize;
  });

  ipcMain.handle('get-always-on-top', () => alwaysOnTopEnabled);

  ipcMain.handle('set-always-on-top', (_event, enabled) => {
    alwaysOnTopEnabled = Boolean(enabled);
    applyAlwaysOnTopState();
    log(`窗口持续置顶已${alwaysOnTopEnabled ? '开启' : '关闭'}`);
    return alwaysOnTopEnabled;
  });

  ipcMain.on('renderer-log', (_event, message) => {
    log(String(message));
  });

  // 处理窗口关闭
  ipcMain.on('close-window', () => {
    if (mainWindow) {
      mainWindow.close();
    }
  });

  // 处理窗口最小化
  ipcMain.on('minimize-window', () => {
    if (mainWindow) {
      mainWindow.minimize();
    }
  });

  // 处理窗口大小调整
  ipcMain.on('resize-window', (_event, size) => {
    if (mainWindow) {
      const currentBounds = mainWindow.getBounds();
      const display = getDisplayForWindowBounds(currentBounds);
      const clampedSize = clampWindowSizeForDisplay(display, size?.width, size?.height);
      log(`调整窗口尺寸到 ${clampedSize.width}x${clampedSize.height}`);

      if (subtitleFocusModeEnabled) {
        const subtitleBarBounds = getSubtitleBarBounds(display, clampedSize.width, clampedSize.height);
        mainWindow.setBounds(subtitleBarBounds);
        return;
      }

      mainWindow.setSize(clampedSize.width, clampedSize.height);
      mainWindow.center();
    }
  });

  ipcMain.on('set-ignore-mouse-events', (_event, ignore) => {
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const rendererPath = path.join(__dirname, '../dist/index.html');
    log(`加载生产页面: ${rendererPath}`);
    mainWindow.loadFile(rendererPath);
  }

  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      log('主窗口未在预期时间内显示，强制 show');
      mainWindow.show();
      mainWindow.focus();
    }
  }, 5000);
}

app.whenReady().then(async () => {
  try {
    // 启动并等待后端就绪
    await startBackend();
    // 后端就绪后，创建窗口
    createWindow();
  } catch (error) {
    log('应用启动失败', error);
    // 在这里可以添加一个对话框来通知用户
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // 停止后端服务
  stopBackend();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// 应用退出时确保停止后端
app.on('before-quit', () => {
  stopBackend();
});

// 处理异常退出
process.on('exit', () => {
  stopBackend();
});
