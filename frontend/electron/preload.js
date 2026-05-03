const { contextBridge, ipcRenderer } = require('electron');

try {
  ipcRenderer.send('renderer-log', '[preload] loaded');
} catch (error) {
  console.error('Failed to notify preload load state', error);
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object.
contextBridge.exposeInMainWorld('electronAPI', {
  getWsToken: () => ipcRenderer.invoke('get-ws-token'),
  getMinWindowSize: () => ipcRenderer.invoke('get-min-window-size'),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  moveWindow: (deltaX, deltaY) => ipcRenderer.send('move-window', { deltaX, deltaY }),
  closeWindow: () => ipcRenderer.send('close-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  resizeWindow: (size) => ipcRenderer.send('resize-window', size),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse-events', ignore),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('set-always-on-top', enabled),
  setSubtitleFocusMode: (enabled) => ipcRenderer.invoke('set-subtitle-focus-mode', enabled),
  log: (message) => ipcRenderer.send('renderer-log', message),
});
