import React, { useState, useEffect, useRef, useCallback } from 'react';


function App() {
  const [status, setStatus] = useState("disconnected");
  const [statusMessage, setStatusMessage] = useState("未连接");
  const [finalSubtitle, setFinalSubtitle] = useState('');
  const [draftSubtitle, setDraftSubtitle] = useState('');
  const [appId, setAppId] = useState(() => localStorage.getItem('appId') ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const [devices, setDevices] = useState([]);
  const [selectedInputDevice, setSelectedInputDevice] = useState(() => localStorage.getItem('selectedInputDevice') ?? '');
  const [selectedOutputDevice, setSelectedOutputDevice] = useState(() => localStorage.getItem('selectedOutputDevice') ?? '');
  const [sourceLanguage, setSourceLanguage] = useState(() => localStorage.getItem('sourceLanguage') ?? 'zh');
  const [targetLanguage, setTargetLanguage] = useState(() => localStorage.getItem('targetLanguage') ?? 'en');
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const [isServiceRunning, setIsServiceRunning] = useState(false);
  const [alwaysOnTopEnabled, setAlwaysOnTopEnabled] = useState(false);
  const [alwaysOnTopSupported, setAlwaysOnTopSupported] = useState(false);
  const [isAlwaysOnTopUpdating, setIsAlwaysOnTopUpdating] = useState(false);
  const [isSubtitleFocusMode, setIsSubtitleFocusMode] = useState(false);
  const [isSubtitleFocusModeUpdating, setIsSubtitleFocusModeUpdating] = useState(false);
  const wsRef = useRef(null);
  const connectWebSocketRef = useRef(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimeoutRef = useRef(null);
  const shouldReconnectRef = useRef(true);
  const isEditingRef = useRef(false);
  const isSavingRef = useRef(false);
  const minWindowSizeRef = useRef({ width: 0, height: 0 });
  const maxReconnectDelay = 30000;
  const contentRef = useRef(null);

  useEffect(() => {
    window.electronAPI?.log?.('[renderer] App mounted');
  }, []);

  useEffect(() => {
    let isCancelled = false;
    const electronAPI = window.electronAPI;

    if (!electronAPI?.getAlwaysOnTop || !electronAPI?.setAlwaysOnTop) {
      setAlwaysOnTopSupported(false);
      return undefined;
    }

    setAlwaysOnTopSupported(true);

    void electronAPI.getAlwaysOnTop()
      .then((enabled) => {
        if (!isCancelled) {
          setAlwaysOnTopEnabled(Boolean(enabled));
        }
      })
      .catch((error) => {
        console.error('Failed to read always-on-top state.', error);
        if (!isCancelled) {
          setAlwaysOnTopSupported(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  useEffect(() => {
    isSavingRef.current = isSaving;
  }, [isSaving]);

  const clearSubtitles = useCallback(() => {
    setFinalSubtitle('');
    setDraftSubtitle('');
  }, []);

  const updateMinWindowSize = useCallback((size) => {
    if (size && Number.isFinite(size.minWidth) && Number.isFinite(size.minHeight)) {
      minWindowSizeRef.current = {
        width: size.minWidth,
        height: size.minHeight,
      };
      return true;
    }

    return false;
  }, []);

  const connectWebSocket = useCallback(async () => {
    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return;
    }

    let tokenSuffix = '';
    if (window.electronAPI?.getWsToken) {
      try {
        const token = await window.electronAPI.getWsToken();
        if (token) {
          tokenSuffix = `?token=${encodeURIComponent(token)}`;
        }
      } catch (error) {
        console.error('Failed to fetch WS token', error);
      }
    }

    const ws = new WebSocket(`ws://localhost:8765/${tokenSuffix}`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectCountRef.current = 0;
      setStatus('connected');
      setStatusMessage('服务已连接');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'status') {
          const msg = data.message ?? '服务已就绪';
          setStatusMessage(msg);

          if (msg.includes('配置已更新')) {
            if (isSavingRef.current) {
              alert(msg);
              setIsSaving(false);
              setIsEditing(false);
            }
          } else if (msg.includes('失败') || msg.toLowerCase().includes('error')) {
            // If saving, stop the loading state
            if (isSavingRef.current) {
               setIsSaving(false);
            }
            // Alert on error for better visibility
            alert(msg);
          }

          if (Array.isArray(data.devices)) {
            setDevices(data.devices);
          }
          if (typeof data.service_running === 'boolean') {
            setIsServiceRunning(data.service_running);
            if (!data.service_running) {
              clearSubtitles();
            }
          }
          if (data.appId && !isEditingRef.current) {
            setAppId(data.appId);
          }
        } else if (data.type === 'subtitle') {
          const subtitleText = typeof data.text === 'string' ? data.text : '';

          if (data.phase === 'draft') {
            setDraftSubtitle(subtitleText);
          } else if (data.phase === 'final') {
            setFinalSubtitle(subtitleText);
            setDraftSubtitle('');
          } else if (data.phase === 'clear') {
            clearSubtitles();
          }
        }
      } catch (error) {
        console.error('Parse error:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      clearSubtitles();
      setStatus('disconnected');
      setIsServiceRunning(false);

      if (!shouldReconnectRef.current) {
        setStatusMessage('连接已关闭');
        return;
      }

      let delay = 3000 * Math.pow(1.5, reconnectCountRef.current);
      if (delay > maxReconnectDelay) {
        delay = maxReconnectDelay;
      }
      reconnectCountRef.current += 1;

      setStatusMessage(reconnectCountRef.current > 5 ? '后台未响应，请检查' : '连接断开，尝试重连...');
      reconnectTimeoutRef.current = window.setTimeout(() => {
        void connectWebSocketRef.current?.();
      }, delay);
    };
  }, [clearSubtitles]);

  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
  }, [connectWebSocket]);

  useEffect(() => {
    void connectWebSocket();

    const contentEl = contentRef.current;
    let resizeObserver;
    if (contentEl && window.electronAPI) {
      const resizeWindowByContent = () => {
        const measuredWidth = Math.ceil(contentEl.getBoundingClientRect().width);
        const measuredHeight = Math.ceil(contentEl.getBoundingClientRect().height);
        const width = Math.max(measuredWidth, minWindowSizeRef.current.width);
        const height = Math.max(measuredHeight, minWindowSizeRef.current.height);
        window.electronAPI.resizeWindow({ width, height });
      };

      if (window.electronAPI.getMinWindowSize) {
        void window.electronAPI.getMinWindowSize()
          .then((size) => {
            if (updateMinWindowSize(size)) {
              resizeWindowByContent();
            }
          })
          .catch((error) => {
            console.error('Failed to fetch minimum window size.', error);
          });
      }

      resizeObserver = new ResizeObserver(() => {
        resizeWindowByContent();
      });
      resizeObserver.observe(contentEl);
    }

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, [connectWebSocket, updateMinWindowSize]);

  useEffect(() => {
    if (appId) {
      localStorage.setItem('appId', appId);
      return;
    }
    localStorage.removeItem('appId');
  }, [appId]);

  // Access Token is NOT persisted to localStorage for security.
  // It only lives in memory during the current session.

  useEffect(() => {
    if (selectedInputDevice) {
      localStorage.setItem('selectedInputDevice', selectedInputDevice);
      return;
    }
    localStorage.removeItem('selectedInputDevice');
  }, [selectedInputDevice]);

  useEffect(() => {
    if (selectedOutputDevice) {
      localStorage.setItem('selectedOutputDevice', selectedOutputDevice);
      return;
    }
    localStorage.removeItem('selectedOutputDevice');
  }, [selectedOutputDevice]);

  useEffect(() => {
    localStorage.setItem('sourceLanguage', sourceLanguage);
  }, [sourceLanguage]);

  useEffect(() => {
    localStorage.setItem('targetLanguage', targetLanguage);
  }, [targetLanguage]);

  const handleSaveConfig = () => {
    const trimmedAppId = appId.trim();
    const trimmedAccessToken = accessToken.trim();

    if (!trimmedAppId || !trimmedAccessToken) {
      alert('请完整填写 App ID 和 Access Token。');
      return;
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setIsSaving(true);
      try {
        wsRef.current.send(JSON.stringify({
          type: 'update_config',
          appId: trimmedAppId,
          accessToken: trimmedAccessToken,
        }));
      } catch (error) {
        console.error('Failed to send update_config to backend.', error);
        alert('配置发送失败，请稍后重试。');
        setIsSaving(false);
        return;
      }
    } else {
      console.error('WebSocket is not connected. Cannot send config to backend.');
      alert('后端未连接，无法保存配置。');
      return;
    }

    setAppId(trimmedAppId);
    setTokenConfigured(true);
    // Clear accessToken from memory after sending; it's only needed during this edit/save flow
    setAccessToken('');
    // Wait for backend confirmation
  };

  const handleClose = () => {
    window.electronAPI.closeWindow();
  };

  const handleAlwaysOnTopChange = async (event) => {
    const nextValue = event.target.checked;
    const electronAPI = window.electronAPI;

    if (!electronAPI?.setAlwaysOnTop) {
      return;
    }

    setIsAlwaysOnTopUpdating(true);

    try {
      const appliedValue = await electronAPI.setAlwaysOnTop(nextValue);
      setAlwaysOnTopEnabled(Boolean(appliedValue));
    } catch (error) {
      console.error('Failed to update always-on-top state.', error);
    } finally {
      setIsAlwaysOnTopUpdating(false);
    }
  };

  const handleSubtitleFocusModeChange = useCallback(async (enabled) => {
    const electronAPI = window.electronAPI;

    setIsSubtitleFocusModeUpdating(true);

    try {
      if (electronAPI?.setSubtitleFocusMode) {
        const size = await electronAPI.setSubtitleFocusMode(enabled);
        updateMinWindowSize(size);
      }
    } catch (error) {
      console.error('Failed to update subtitle focus mode.', error);
    } finally {
      setIsSubtitleFocusMode(enabled);
      setIsSubtitleFocusModeUpdating(false);
    }
  }, [updateMinWindowSize]);

  const revealDeviceSettings = useCallback(async (nextStatusMessage, alertMessage) => {
    setIsServiceRunning(false);
    setStatusMessage(nextStatusMessage);

    if (isSubtitleFocusMode) {
      await handleSubtitleFocusModeChange(false);
    }

    setShowDeviceSettings(true);
    alert(alertMessage);
  }, [handleSubtitleFocusModeChange, isSubtitleFocusMode]);

  const toggleService = async () => {
    const command = isServiceRunning ? 'stop' : 'start';

    if (command === 'start') {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setIsServiceRunning(false);
        setStatusMessage('后端未连接，无法启动服务');
        alert('后端未连接，请先启动并连接后端服务。');
        return;
      }

      if (!selectedInputDevice || !selectedOutputDevice) {
        await revealDeviceSettings('请先选择输入和输出设备', '请先在设备设置中选择输入和输出设备。');
        return;
      }

      const inputDeviceIndex = Number.parseInt(selectedInputDevice, 10);
      const outputDeviceIndex = Number.parseInt(selectedOutputDevice, 10);

      if (Number.isNaN(inputDeviceIndex) || Number.isNaN(outputDeviceIndex)) {
        await revealDeviceSettings('设备选择无效，请重新选择', '设备选择无效，请在设备设置中重新选择输入和输出设备。');
        return;
      }

      const inputDeviceExists = inputDevices.some((device) => Number(device.index) === inputDeviceIndex);
      const outputDeviceExists = outputDevices.some((device) => Number(device.index) === outputDeviceIndex);

      if (!inputDeviceExists || !outputDeviceExists) {
        await revealDeviceSettings('设备列表已变化，请重新选择输入和输出设备', '检测到已保存的设备不再可用，请在设备设置中重新选择输入和输出设备。');
        return;
      }

      console.log('Sending command:', command);
      wsRef.current.send(JSON.stringify({
        type: 'service_command',
        command,
        inputDevice: inputDeviceIndex,
        outputDevice: outputDeviceIndex,
        sourceLanguage,
        targetLanguage,
      }));
      return;
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log('Sending command:', command);
      wsRef.current.send(JSON.stringify({
        type: 'service_command',
        command,
      }));
    }
  };

  const inputDevices = devices.filter(d => d.isInput);
  const outputDevices = devices.filter(d => d.isOutput);
  const isBarMode = isSubtitleFocusMode;

  return (
    <div
      ref={contentRef}
      className={`relative select-none font-sans shadow-lg ${isBarMode
        ? 'w-[64rem] max-w-[calc(100vw-24px)] rounded-2xl border border-white/15 bg-gray-800 px-3 py-3 text-left shadow-2xl'
        : 'w-[48rem] max-w-[calc(100vw-32px)] rounded-xl border border-gray-600 bg-gray-800 p-6 text-center'
        }`}
      style={{ maxHeight: '90vh', overflowY: 'auto' }}
    >
      {isBarMode ? (
        <>
          <div className="mb-3 flex items-start gap-2">
            <div
              className="drag-region flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left"
              style={{ WebkitAppRegion: 'drag' }}
            >
              <div className="flex items-center gap-1.5 text-white/35">
                <span className="h-1.5 w-1.5 rounded-full bg-white/40"></span>
                <span className="h-1.5 w-1.5 rounded-full bg-white/40"></span>
                <span className="h-1.5 w-1.5 rounded-full bg-white/40"></span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-semibold text-white">字幕条模式</span>
                <span className="text-gray-400">拖动这里移动窗口</span>
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
              <div className="flex min-w-0 flex-1 basis-64 items-center gap-2 rounded-xl border border-white/10 bg-black/10 px-3 py-2 no-drag">
                <div className={`h-2.5 w-2.5 flex-none rounded-full ${status === 'connected' ? 'bg-green-500' : 'bg-red-500'}`}></div>
                <span className="truncate text-sm text-white">{statusMessage}</span>
              </div>

              <button
                onClick={toggleService}
                className={`rounded-xl px-4 py-2 text-sm transition-colors no-drag ${isServiceRunning
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-green-600 hover:bg-green-700 text-white'
                  }`}
              >
                {isServiceRunning ? '停止服务' : '启动服务'}
              </button>

              <label
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors no-drag ${alwaysOnTopEnabled
                  ? 'border-blue-400/40 bg-blue-500/10 text-blue-100'
                  : 'border-white/15 bg-white/5 text-gray-300'
                  } ${alwaysOnTopSupported && !isAlwaysOnTopUpdating
                  ? 'cursor-pointer hover:border-white/30 hover:text-white'
                  : 'cursor-not-allowed opacity-70'
                  }`}
                title={alwaysOnTopSupported ? '保持窗口位于其他窗口上方' : '仅桌面端支持窗口置顶'}
              >
                <input
                  type="checkbox"
                  checked={alwaysOnTopEnabled}
                  onChange={handleAlwaysOnTopChange}
                  disabled={!alwaysOnTopSupported || isAlwaysOnTopUpdating}
                  className="h-4 w-4 accent-blue-500 no-drag"
                />
                <span>{isAlwaysOnTopUpdating ? '置顶中...' : '窗口置顶'}</span>
              </label>

              <label
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors no-drag ${isSubtitleFocusMode
                  ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100'
                  : 'border-white/15 bg-white/5 text-gray-300'
                  } ${isSubtitleFocusModeUpdating
                  ? 'cursor-not-allowed opacity-70'
                  : 'cursor-pointer hover:border-white/30 hover:text-white'
                  }`}
                title="切换为仅保留字幕和核心控制的桌面字幕条布局"
              >
                <input
                  type="checkbox"
                  checked={isSubtitleFocusMode}
                  onChange={(event) => {
                    void handleSubtitleFocusModeChange(event.target.checked);
                  }}
                  disabled={isSubtitleFocusModeUpdating}
                  className="h-4 w-4 accent-emerald-500 no-drag"
                />
                <span>{isSubtitleFocusModeUpdating ? '切换中...' : '字幕条模式'}</span>
              </label>

              <div className="flex items-center gap-1.5 no-drag">
                <button
                  onClick={() => window.electronAPI.minimizeWindow()}
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-white/60 transition-colors hover:bg-white/10 hover:text-white no-drag"
                >
                  —
                </button>
                <button
                  onClick={handleClose}
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-white/60 transition-colors hover:bg-white/10 hover:text-white no-drag"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/20 bg-white/5 p-3 text-left">
            <div className="rounded-xl border border-white/10 bg-black/10 px-4 py-4">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div className="text-xs font-medium text-gray-400">实时字幕</div>
                <span className="text-xs text-gray-500">GlobeVoice Meet</span>
              </div>

              <div className="pt-4">
                <div className="min-h-24 overflow-hidden">
                  <p className="h-full overflow-hidden whitespace-pre-wrap break-words text-xl leading-8 text-white">
                    {finalSubtitle || '\u00A0'}
                  </p>
                </div>
                <div className="mt-3 min-h-11 overflow-hidden border-t border-white/10 pt-3">
                  <p className="h-full overflow-hidden whitespace-pre-wrap break-words text-sm leading-6 text-gray-300">
                    {draftSubtitle || '\u00A0'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="absolute top-2 right-2 flex space-x-2 no-drag z-10"> {/* Container for buttons */}
            {/* 最小化按钮 */}
            <button
              onClick={() => window.electronAPI.minimizeWindow()}
              className="w-8 h-8 flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 rounded-full transition-colors no-drag"
            >
              —
            </button>
            {/* 关闭按钮 */}
            <button
              onClick={handleClose}
              className="w-8 h-8 flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 rounded-full transition-colors no-drag"
            >
              ✕
            </button>
          </div>

          {/* 标题 */}
          <div
            className="mb-6 pr-20 cursor-move drag-region"
            style={{ WebkitAppRegion: 'drag' }}
          >
            <>
              <h1 className="text-3xl font-bold text-white">GlobeVoice Meet</h1>
              <div className="flex items-center justify-between mt-2">
                <div className="flex-1"></div>
                <div className="text-lg text-white font-medium">跨国会议实时同传</div>
                <div className="flex-1 text-right">
                  <span className="text-sm text-gray-400">建议配置豆包同声传译大模型 2.0</span>
                </div>
              </div>
            </>
          </div>

          {/* 状态指示 */}
          <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
            <div className={`w-3 h-3 rounded-full ${status === 'connected' ? 'bg-green-500' : 'bg-red-500'}`}></div>
            <span className="text-lg text-white">{statusMessage}</span>

            {/* 服务开关 */}
            <button
              onClick={toggleService}
              className={`px-4 py-2 rounded-lg transition-colors no-drag ${isServiceRunning
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-green-600 hover:bg-green-700 text-white'
                }`}
            >
              {isServiceRunning ? '停止服务' : '启动服务'}
            </button>

            <label
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors no-drag ${alwaysOnTopEnabled
                ? 'border-blue-400/40 bg-blue-500/10 text-blue-100'
                : 'border-white/15 bg-white/5 text-gray-300'
                } ${alwaysOnTopSupported && !isAlwaysOnTopUpdating
                ? 'cursor-pointer hover:border-white/30 hover:text-white'
                : 'cursor-not-allowed opacity-70'
                }`}
              title={alwaysOnTopSupported ? '保持窗口位于其他窗口上方' : '仅桌面端支持窗口置顶'}
            >
              <input
                type="checkbox"
                checked={alwaysOnTopEnabled}
                onChange={handleAlwaysOnTopChange}
                disabled={!alwaysOnTopSupported || isAlwaysOnTopUpdating}
                className="h-4 w-4 accent-blue-500 no-drag"
              />
              <span>{isAlwaysOnTopUpdating ? '置顶中...' : '窗口置顶'}</span>
            </label>

            <label
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors no-drag ${isSubtitleFocusMode
                ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100'
                : 'border-white/15 bg-white/5 text-gray-300'
                } ${isSubtitleFocusModeUpdating
                ? 'cursor-not-allowed opacity-70'
                : 'cursor-pointer hover:border-white/30 hover:text-white'
                }`}
              title="切换为仅保留字幕和核心控制的桌面字幕条布局"
            >
              <input
                type="checkbox"
                checked={isSubtitleFocusMode}
                onChange={(event) => {
                  void handleSubtitleFocusModeChange(event.target.checked);
                }}
                disabled={isSubtitleFocusModeUpdating}
                className="h-4 w-4 accent-emerald-500 no-drag"
              />
              <span>{isSubtitleFocusModeUpdating ? '切换中...' : '字幕条模式'}</span>
            </label>
          </div>

          <div className="mb-6 rounded-lg px-4 py-4 border border-white/20 bg-white/5 text-left">
            <div className="flex h-28 gap-3 flex-col overflow-hidden">
              <div className="flex-1 overflow-hidden rounded-lg border border-white/10 bg-black/10 px-3 py-2">
                <p className="h-full overflow-hidden whitespace-pre-wrap break-words text-white text-base leading-6">
                  {finalSubtitle || '\u00A0'}
                </p>
              </div>
              <div className="h-11 overflow-hidden rounded-lg border border-white/10 bg-black/10 px-3 py-2">
                <p className="h-full overflow-hidden whitespace-pre-wrap break-words text-gray-300 text-sm leading-5">
                  {draftSubtitle || '\u00A0'}
                </p>
              </div>
            </div>
          </div>
        </>
      )}

      {!isBarMode && (
        <>
          {/* 设备设置按钮 */}
          <button
            onClick={() => setShowDeviceSettings(!showDeviceSettings)}
            className="w-full px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors mb-6 no-drag"
          >
            {showDeviceSettings ? '隐藏设备设置' : '显示设备设置'}
          </button>

          {/* 设备设置区域 */}
          {showDeviceSettings && (
            <div className="border-t border-white/20 pt-6 mb-6">
              <h2 className="text-xl font-semibold text-white mb-4">音频设备设置</h2>

              {/* 调试信息 */}
              <div className="bg-yellow-900/30 border border-yellow-500/30 rounded-lg p-3 text-left mb-4">
                <p className="text-sm text-yellow-300">
                  📊 调试信息：<br />
                  • 总设备数: {devices.length}<br />
                  • 输入设备数: {inputDevices.length}<br />
                  • 输出设备数: {outputDevices.length}
                </p>
              </div>

              {/* 输入设备选择 */}
              <div className="mb-4 text-left">
                <label className="block text-sm text-gray-300 mb-2">输入设备（麦克风）</label>
                <select
                  value={selectedInputDevice}
                  onChange={(e) => setSelectedInputDevice(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500 no-drag"
                >
                  <option value="">选择输入设备</option>
                  {inputDevices.map(device => (
                    <option key={device.index} value={device.index}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* 输出设备选择 */}
              <div className="mb-4 text-left">
                <label className="block text-sm text-gray-300 mb-2">输出设备（扬声器/虚拟设备）</label>
                <select
                  value={selectedOutputDevice}
                  onChange={(e) => setSelectedOutputDevice(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500 no-drag"
                >
                  <option value="">选择输出设备</option>
                  {outputDevices.map(device => (
                    <option key={device.index} value={device.index}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* 语言方向选择 */}
              <div className="mb-4 text-left">
                <label className="block text-sm text-gray-300 mb-2">翻译方向</label>
                <div className="flex gap-4">
                  <div className="flex-1">
                    <select
                      value={sourceLanguage}
                      onChange={(e) => setSourceLanguage(e.target.value)}
                      className="w-full px-4 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500 no-drag"
                    >
                      <option value="zh">中文</option>
                      <option value="en">英语</option>
                      <option value="ja">日语</option>
                      <option value="ko">韩语</option>
                      <option value="fr">法语</option>
                      <option value="de">德语</option>
                      <option value="es">西班牙语</option>
                    </select>
                    <span className="text-xs text-gray-500 mt-1 block">源语言</span>
                  </div>
                  <div className="flex items-center text-gray-400 text-lg pt-1">→</div>
                  <div className="flex-1">
                    <select
                      value={targetLanguage}
                      onChange={(e) => setTargetLanguage(e.target.value)}
                      className="w-full px-4 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500 no-drag"
                    >
                      <option value="en">英语</option>
                      <option value="zh">中文</option>
                      <option value="ja">日语</option>
                      <option value="ko">韩语</option>
                      <option value="fr">法语</option>
                      <option value="de">德语</option>
                      <option value="es">西班牙语</option>
                    </select>
                    <span className="text-xs text-gray-500 mt-1 block">目标语言</span>
                  </div>
                </div>
              </div>

              {/* 提示信息 */}
              <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-3 text-left">
                <p className="text-sm text-blue-300">
                  💡 <strong>Zoom会议使用提示：</strong><br />
                  • 选择虚拟音频设备（如 "CABLE Output"）作为输出设备<br />
                  • 在Zoom中将此设备设置为麦克风输入<br />
                  • 这样会议中的人就能听到翻译后的英文语音
                </p>
              </div>
            </div>
          )}

          {/* API配置区域 */}
          <div className="border-t border-white/20 pt-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-white">API 配置</h2>
              <button
                onClick={() => setIsEditing(!isEditing)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors no-drag"
              >
                {isEditing ? '取消' : '编辑'}
              </button>
            </div>

            {isEditing ? (
              <div className="space-y-4">
                <div className="text-left">
                  <label className="block text-sm text-gray-300 mb-2">App ID</label>
                  <input
                    type="text"
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder="请输入 App ID"
                    className="w-full px-4 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500 no-drag"
                  />
                </div>
                <div className="text-left">
                  <label className="block text-sm text-gray-300 mb-2">Access Token</label>
                  <div className="relative">
                    <input
                      type={showToken ? "text" : "password"}
                      value={accessToken}
                      onChange={(e) => setAccessToken(e.target.value)}
                      placeholder="请输入 Access Token"
                      className="w-full px-4 py-2 pr-14 bg-gray-800 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500 no-drag"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-gray-400 hover:text-white no-drag"
                    >
                      {showToken ? '隐藏' : '显示'}
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleSaveConfig}
                  disabled={isSaving}
                  className={`w-full px-4 py-2 rounded-lg transition-colors no-drag ${
                    isSaving ? 'bg-gray-500 cursor-not-allowed text-white' : 'bg-green-600 hover:bg-green-700 text-white'
                  }`}
                >
                  {isSaving ? '保存中...' : '保存配置'}
                </button>
              </div>
            ) : (
              <div className="space-y-2 text-left">
                <div className="text-sm text-gray-400">
                  <span className="font-medium">App ID:</span> {appId || '未配置'}
                </div>
                <div className="text-sm text-gray-400">
                  <span className="font-medium">Access Token:</span> {tokenConfigured ? '已配置' : '未配置'}
                </div>
              </div>
            )}
          </div>

          {/* 使用说明 */}
          <div className="border-t border-white/20 pt-6 mt-6 text-left">
            <h3 className="text-lg font-semibold text-white mb-2">使用说明</h3>
            <ul className="text-sm text-gray-400 space-y-1">
              <li>• 确保后端服务正在运行</li>
              <li>• 配置正确的 App ID 和 Access Token</li>
              <li>• 对着麦克风说话，系统会自动翻译并播放</li>
              <li>• 修改配置后需要重启后端服务</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
