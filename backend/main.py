import asyncio
import importlib
import io
import uuid
import os
import sys
import logging
import json
import time
import queue
import wave
from urllib.parse import parse_qs, urlparse

import pyaudio
import websockets
from websockets.asyncio.server import serve
from dotenv import load_dotenv
import argparse

is_frozen = bool(getattr(sys, 'frozen', False))
bundle_dir = getattr(sys, '_MEIPASS', None)
if is_frozen and isinstance(bundle_dir, str):
    code_dir = bundle_dir
else:
    code_dir = os.path.dirname(os.path.abspath(__file__))

if is_frozen:
    runtime_dir = os.path.dirname(os.path.abspath(sys.executable))
else:
    runtime_dir = code_dir

configured_runtime_env_path = os.getenv("BACKEND_RUNTIME_ENV_PATH")
if configured_runtime_env_path:
    runtime_env_path = os.path.abspath(configured_runtime_env_path)
elif is_frozen:
    runtime_env_path = os.path.join(runtime_dir, '.env')
else:
    runtime_env_path = os.path.join(runtime_dir, '.env.runtime')

code_env_path = os.path.join(code_dir, '.env')
loaded_env_paths = []
seen_env_paths = set()
for env_path in (runtime_env_path, code_env_path):
    normalized_path = os.path.normcase(os.path.abspath(env_path))
    if normalized_path in seen_env_paths:
        continue
    seen_env_paths.add(normalized_path)
    if os.path.exists(env_path):
        load_dotenv(env_path)
        loaded_env_paths.append(env_path)

if code_dir not in sys.path:
    sys.path.insert(0, code_dir)

python_protogen_dir = os.path.join(code_dir, "python_protogen")
if python_protogen_dir not in sys.path:
    sys.path.append(python_protogen_dir)

ast_service_pb2 = importlib.import_module("python_protogen.products.understanding.ast.ast_service_pb2")
events_pb2 = importlib.import_module("python_protogen.common.events_pb2")

# ================= 配置区域 =================
# 从环境变量中获取火山引擎鉴权信息
app_id = os.getenv("APP_ID")
access_token = os.getenv("ACCESS_TOKEN")
CLUSTER = "volc.service_type.10053"  # 固定值

# 测试模式：如果填入文件路径，将读取文件而不是麦克风。为空则使用麦克风模式。
TEST_AUDIO_FILE = ""

WS_URL = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate"
DEFAULT_LOCAL_WS_PORT = 8765
local_ws_port = int(os.getenv("LOCAL_WS_PORT", str(DEFAULT_LOCAL_WS_PORT)))
VOLC_CONNECT_TIMEOUT = 15
VOLC_START_TIMEOUT = 15
VOLC_RECV_TIMEOUT = 45

MAX_INPUT_QUEUE_CHUNKS = 120
MAX_OUTPUT_QUEUE_CHUNKS = 120
# 音频配置
INPUT_RATE = 16000
INPUT_CHANNELS = 1
INPUT_CHUNK = 3200  # 100ms at 16k * 2bytes

OUTPUT_RATE = 16000
OUTPUT_CHANNELS = 1

# 音频设备配置
# 设置为 None 使用默认设备，或者设置为设备索引
# 可以运行程序查看日志中的设备列表，然后设置对应的索引
INPUT_DEVICE_INDEX = None  # 例如: 0, 1, 2...
OUTPUT_DEVICE_INDEX = None  # 例如: 0, 1, 2...

# ===========================================

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# 全局队列，用于在不同任务间传递数据
audio_input_queue = asyncio.Queue(maxsize=MAX_INPUT_QUEUE_CHUNKS)
frontend_msg_queue = asyncio.Queue()
audio_output_queue = queue.Queue(maxsize=MAX_OUTPUT_QUEUE_CHUNKS) # 使用线程安全的阻塞队列给播放流用

# 全局服务状态
service_running = False
service_starting = False
audio_handler = None
volc_client_task = None # To hold the running volc engine task
file_streamer_task = None
current_input_idx = None
current_output_idx = None
auth_token = None
active_frontend_ws = None
last_warning_times = {}


async def send_status(websocket, message, service_running_state=None, **extra_fields):
    payload = {
        "type": "status",
        "message": message,
    }
    if service_running_state is not None:
        payload["service_running"] = service_running_state
    payload.update(extra_fields)
    await websocket.send(json.dumps(payload))


async def send_subtitle(
    websocket,
    phase,
    text=None,
    start_time=None,
    end_time=None,
    spk_chg=None,
    muted_duration_ms=None,
):
    payload = {
        "type": "subtitle",
        "phase": phase,
        "text": text,
        "start_time": start_time,
        "end_time": end_time,
        "spk_chg": spk_chg,
        "muted_duration_ms": muted_duration_ms,
    }
    await websocket.send(json.dumps(payload))


def is_websocket_open(websocket):
    return websocket is not None and not bool(getattr(websocket, 'closed', False))


def log_throttled_warning(key, message, interval_seconds=5.0):
    now = time.monotonic()
    previous = last_warning_times.get(key, 0.0)
    if now - previous >= interval_seconds:
        logging.warning(message)
        last_warning_times[key] = now


def quote_dotenv_value(value):
    escaped = value.replace('\\', '\\\\').replace('"', '\\"')
    return f'"{escaped}"'


def persist_runtime_config(app_id_value):
    """Persist only APP_ID to the runtime .env file.

    ACCESS_TOKEN is intentionally NOT saved to disk for security reasons.
    Users who need persistent credentials should configure .env manually
    or use an encrypted credential store.
    """
    runtime_env_dir = os.path.dirname(runtime_env_path)
    if runtime_env_dir:
        os.makedirs(runtime_env_dir, exist_ok=True)

    content = "\n".join([
        f"APP_ID={quote_dotenv_value(app_id_value)}",
        "",
    ])
    with open(runtime_env_path, 'w', encoding='utf-8') as env_file:
        env_file.write(content)


async def notify_frontend_status(message, service_running_state=None, **extra_fields):
    if is_websocket_open(active_frontend_ws):
        try:
            await send_status(active_frontend_ws, message, service_running_state=service_running_state, **extra_fields)
        except Exception as error:
            logging.warning(f"Failed to notify frontend: {error}")


async def notify_frontend_subtitle(
    phase,
    text=None,
    start_time=None,
    end_time=None,
    spk_chg=None,
    muted_duration_ms=None,
):
    if is_websocket_open(active_frontend_ws):
        try:
            await send_subtitle(
                active_frontend_ws,
                phase,
                text=text,
                start_time=start_time,
                end_time=end_time,
                spk_chg=spk_chg,
                muted_duration_ms=muted_duration_ms,
            )
        except Exception as error:
            logging.warning(f"Failed to notify frontend subtitle: {error}")


def enqueue_audio_input_chunk(data):
    if not data:
        return

    if audio_input_queue.full():
        try:
            audio_input_queue.get_nowait()
            log_throttled_warning(
                "input_queue_full",
                f"Input audio queue reached {MAX_INPUT_QUEUE_CHUNKS} chunks; dropping oldest audio to keep latency bounded.",
            )
        except asyncio.QueueEmpty:
            pass

    try:
        audio_input_queue.put_nowait(data)
    except asyncio.QueueFull:
        log_throttled_warning(
            "input_queue_still_full",
            "Input audio queue remained full after eviction; skipping current audio chunk.",
        )


def enqueue_audio_output_chunk(data):
    if not data:
        return

    if audio_output_queue.full():
        try:
            audio_output_queue.get_nowait()
            log_throttled_warning(
                "output_queue_full",
                f"Output audio queue reached {MAX_OUTPUT_QUEUE_CHUNKS} chunks; dropping oldest audio to keep playback near real time.",
            )
        except queue.Empty:
            pass

    try:
        audio_output_queue.put_nowait(data)
    except queue.Full:
        log_throttled_warning(
            "output_queue_still_full",
            "Output audio queue remained full after eviction; skipping current playback chunk.",
        )


def parse_device_index(device_index):
    if device_index in (None, ""):
        return None
    return int(device_index)


def clear_audio_queues():
    while True:
        try:
            audio_input_queue.get_nowait()
        except asyncio.QueueEmpty:
            break

    while True:
        try:
            audio_output_queue.get_nowait()
        except queue.Empty:
            break

async def notify_and_stop_service(msg="服务已停止"):
    global service_running, service_starting, audio_handler, volc_client_task, active_frontend_ws, file_streamer_task
    has_active_resources = service_running or service_starting or volc_client_task is not None or file_streamer_task is not None or audio_handler is not None
    if not has_active_resources:
        return
    logging.info(f"Stopping service internally: {msg}")
    service_running = False
    service_starting = False

    current_task = asyncio.current_task()

    if volc_client_task:
        task_to_cancel = volc_client_task
        volc_client_task = None
        if task_to_cancel is not current_task:
            task_to_cancel.cancel()
            try:
                await task_to_cancel
            except asyncio.CancelledError:
                pass
    if file_streamer_task:
        task_to_cancel = file_streamer_task
        file_streamer_task = None
        try:
            task_to_cancel.cancel()
            await task_to_cancel
        except asyncio.CancelledError:
            pass
    if audio_handler:
        audio_handler.stop()
        audio_handler = None
    clear_audio_queues()
    
    if is_websocket_open(active_frontend_ws):
        await notify_frontend_status(msg, service_running_state=False)
        await notify_frontend_subtitle("clear")

class AudioHandler:
    def __init__(self, input_device_index=None, output_device_index=None):
        self.p = pyaudio.PyAudio()
        self.input_stream = None
        self.output_stream = None
        self.is_running = False
        self.input_device_index = input_device_index if input_device_index is not None else INPUT_DEVICE_INDEX
        self.output_device_index = output_device_index if output_device_index is not None else OUTPUT_DEVICE_INDEX
        self.play_thread = None

    def get_audio_devices(self):
        """获取所有音频设备列表"""
        devices = []
        for i in range(self.p.get_device_count()):
            try:
                dev_info = self.p.get_device_info_by_index(i)
                device = {
                    'index': i,
                    'name': dev_info['name'],
                    'maxInputChannels': dev_info['maxInputChannels'],
                    'maxOutputChannels': dev_info['maxOutputChannels'],
                    'isInput': int(dev_info['maxInputChannels']) > 0,
                    'isOutput': int(dev_info['maxOutputChannels']) > 0
                }
                devices.append(device)
            except Exception as e:
                logging.error(f"Error getting device {i}: {e}")
        return devices

    def _resolve_device_index(self, device_type, configured_index):
        uses_input = device_type == "input"
        capability_key = 'maxInputChannels' if uses_input else 'maxOutputChannels'
        default_info_getter = self.p.get_default_input_device_info if uses_input else self.p.get_default_output_device_info

        device_index = configured_index
        if device_index is None:
            try:
                default_device = default_info_getter()
                device_index = default_device['index']
                logging.info(f"Using default {device_type} device: {default_device['name']}")
            except OSError:
                logging.warning(f"No default {device_type} device found. Scanning for available devices...")
                for i in range(self.p.get_device_count()):
                    try:
                        dev_info = self.p.get_device_info_by_index(i)
                        if int(dev_info[capability_key]) > 0:
                            logging.info(f"Found {device_type} device {i}: {dev_info['name']}")
                            device_index = i
                            break
                    except Exception as error:
                        logging.debug(f"Skipping {device_type} device {i}: {error}")
        else:
            dev_info = self.p.get_device_info_by_index(device_index)
            logging.info(f"Using configured {device_type} device {device_index}: {dev_info['name']}")

        if device_index is None:
            raise RuntimeError(f"No valid {device_type} device found")

        return int(device_index)

    def close(self):
        if self.input_stream:
            self.input_stream.stop_stream()
            self.input_stream.close()
            self.input_stream = None
        if self.output_stream:
            self.output_stream.stop_stream()
            self.output_stream.close()
            self.output_stream = None
        self.p.terminate()

    def start_input(self, loop):
        """启动录音流"""
        def callback(in_data, frame_count, time_info, status):
            if self.is_running:
                loop.call_soon_threadsafe(enqueue_audio_input_chunk, in_data)
            return (in_data, pyaudio.paContinue)

        input_device_index = self._resolve_device_index("input", self.input_device_index)

        self.input_stream = self.p.open(
            format=pyaudio.paInt16,
            channels=INPUT_CHANNELS,
            rate=INPUT_RATE,
            input=True,
            input_device_index=input_device_index, # 显式指定设备索引
            frames_per_buffer=INPUT_CHUNK,
            stream_callback=callback
        )
        self.input_stream.start_stream()
        logging.info("Microphone started.")

    def start_output(self):
        """启动播放流 (阻塞式写入)"""
        output_device_index = self._resolve_device_index("output", self.output_device_index)

        self.output_stream = self.p.open(
            format=pyaudio.paInt16,
            channels=OUTPUT_CHANNELS,
            rate=OUTPUT_RATE,
            output=True,
            output_device_index=output_device_index
        )
        self.is_running = True
        
        # 启动一个后台线程专门负责从队列取数据播放，避免阻塞 asyncio 事件循环
        import threading
        self.play_thread = threading.Thread(target=self._play_loop, daemon=True)
        self.play_thread.start()
        logging.info("Speaker started.")

    def _play_loop(self):
        while self.is_running:
            try:
                data = audio_output_queue.get(timeout=1)
                if data is None: # Poison pill to stop thread immediately
                    break
                if self.output_stream is not None:
                    self.output_stream.write(data)
            except queue.Empty:
                continue
            except Exception as e:
                logging.error(f"Playback error: {e}")

    def stop(self):
        self.is_running = False
        
        # 塞入毒丸打破队列阻塞
        try:
            audio_output_queue.put_nowait(None)
        except Exception:
            pass
            
        if self.play_thread and self.play_thread.is_alive():
            self.play_thread.join(timeout=2.0)

        self.close()

class VolcEngineClient:
    def __init__(self, app_id, access_token, source_language="zh", target_language="en", started_message="服务已启动"):
        self.session_id = str(uuid.uuid4())
        self.headers = {
            "X-Api-App-Key": app_id,
            "X-Api-Access-Key": access_token,
            "X-Api-Resource-Id": CLUSTER,
        }
        self.unsupported_audio_warning_sent = False
        self.started_message = started_message
        self.source_language = source_language
        self.target_language = target_language

    def _normalize_output_audio_chunk(self, data):
        if len(data) >= 4 and data[:4] == b'OggS':
            if not self.unsupported_audio_warning_sent:
                logging.error("Received Opus/Ogg audio while PCM output is required. Dropping incompatible audio chunks instead of playing noise.")
                self.unsupported_audio_warning_sent = True
            return None

        if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WAVE':
            try:
                with wave.open(io.BytesIO(data), 'rb') as wav_reader:
                    channel_count = wav_reader.getnchannels()
                    sample_width = wav_reader.getsampwidth()
                    sample_rate = wav_reader.getframerate()
                    if channel_count != OUTPUT_CHANNELS or sample_width != 2 or sample_rate != OUTPUT_RATE:
                        logging.error(
                            "Dropping WAV-wrapped audio chunk with incompatible format: "
                            f"channels={channel_count}, sample_width={sample_width}, sample_rate={sample_rate}."
                        )
                        return None
                    pcm_frames = wav_reader.readframes(wav_reader.getnframes())
                if not pcm_frames:
                    logging.warning("Received WAV-wrapped audio chunk without PCM frames. Dropping chunk.")
                    return None
                logging.warning("Received WAV-wrapped audio chunk. Extracted PCM frames before playback.")
                return pcm_frames
            except wave.Error as error:
                logging.error(f"Failed to decode WAV-wrapped audio chunk: {error}")
                return None

        return data

    async def _notify_session_started(self):
        global service_running, service_starting
        service_starting = False
        service_running = True
        await notify_frontend_status(self.started_message, service_running_state=True)

    async def run(self):
        async with websockets.connect(
            WS_URL,
            additional_headers=self.headers,
            max_size=1000000000,
            open_timeout=VOLC_CONNECT_TIMEOUT,
            ping_interval=20,
            ping_timeout=20,
            close_timeout=5,
        ) as ws:
            response = getattr(ws, 'response', None)
            log_id = response.headers.get('X-Tt-Logid') if response is not None else 'unknown'
            logging.info(f"Connected to Volcengine. LogID: {log_id}")
            
            # 1. 发送 StartSession
            await self._send_start_session(ws)
            
            # 等待 SessionStarted
            try:
                resp = await asyncio.wait_for(ws.recv(), timeout=VOLC_START_TIMEOUT)
            except asyncio.TimeoutError as error:
                raise TimeoutError("Timed out waiting for translation session to start") from error
            start_resp = ast_service_pb2.TranslateResponse()
            start_resp.ParseFromString(resp)
            if start_resp.event != events_pb2.Type.SessionStarted:
                raise RuntimeError("Translation session failed to start")
            logging.info("Session Started.")
            await self._notify_session_started()

            # 2. 并行任务：发送音频 & 接收响应
            send_task = asyncio.create_task(self._send_audio_loop(ws))
            recv_task = asyncio.create_task(self._recv_loop(ws))

            done, pending = await asyncio.wait({send_task, recv_task}, return_when=asyncio.FIRST_COMPLETED)

            for task in pending:
                task.cancel()

            for task in pending:
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            for task in done:
                if task.cancelled():
                    continue
                exception = task.exception()
                if exception:
                    raise exception

    async def _send_start_session(self, ws):
        req = ast_service_pb2.TranslateRequest()
        req.request_meta.SessionID = self.session_id
        req.event = events_pb2.Type.StartSession
        req.user.uid = "python_client"
        
        # 源音频格式 (16k 16bit wav/pcm)
        req.source_audio.format = "wav"
        req.source_audio.rate = INPUT_RATE
        req.source_audio.bits = 16
        req.source_audio.channel = INPUT_CHANNELS
        
        # 目标音频格式 (请求 PCM 以便直接播放，避免解码)
        req.target_audio.format = "pcm"
        req.target_audio.rate = OUTPUT_RATE
        
        req.request.mode = "s2s" # 语音到语音
        req.request.source_language = self.source_language
        req.request.target_language = self.target_language
        
        await ws.send(req.SerializeToString())

    async def _send_audio_loop(self, ws):
        """持续发送麦克风数据"""
        try:
            while True:
                data = await audio_input_queue.get()
                req = ast_service_pb2.TranslateRequest()
                req.request_meta.SessionID = self.session_id
                req.event = events_pb2.Type.TaskRequest
                req.source_audio.binary_data = data
                await ws.send(req.SerializeToString())
                    
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logging.error(f"Send loop error: {e}")
            await notify_and_stop_service(f"网络发送异常: {e}")

    async def _recv_loop(self, ws):
        """持续接收服务端数据"""
        try:
            while True:
                try:
                    data = await asyncio.wait_for(ws.recv(), timeout=VOLC_RECV_TIMEOUT)
                except asyncio.TimeoutError as error:
                    raise TimeoutError("Translation service receive timeout") from error
                resp = ast_service_pb2.TranslateResponse()
                resp.ParseFromString(data)

                # 处理音频 - 使用有界队列，避免长时运行内存持续增长
                if resp.event in (events_pb2.Type.TTSResponse, events_pb2.Type.TTSSentenceEnd):
                    if resp.data:
                        logging.info(f"Received TTS audio chunk: {len(resp.data)} bytes")
                        normalized_chunk = self._normalize_output_audio_chunk(resp.data)
                        if normalized_chunk:
                            enqueue_audio_output_chunk(normalized_chunk)

                elif resp.event == events_pb2.Type.TranslationSubtitleResponse:
                    await notify_frontend_subtitle(
                        "draft",
                        text=resp.text,
                        start_time=resp.start_time,
                        end_time=resp.end_time,
                        spk_chg=resp.spk_chg,
                        muted_duration_ms=resp.muted_duration_ms,
                    )

                elif resp.event == events_pb2.Type.TranslationSubtitleEnd:
                    await notify_frontend_subtitle(
                        "final",
                        text=resp.text,
                        start_time=resp.start_time,
                        end_time=resp.end_time,
                        spk_chg=resp.spk_chg,
                        muted_duration_ms=resp.muted_duration_ms,
                    )

                elif resp.event == events_pb2.Type.SessionFinished:
                    logging.info("Session finished.")
                    break
                    
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logging.error(f"Recv loop error: {e}")
            await notify_and_stop_service(f"网络接收异常: {e}")

# ================= 本地 WebSocket 服务 (推送到前端) =================

async def frontend_handler(websocket):
    global service_running, service_starting, audio_handler, active_frontend_ws

    path = websocket.request.path
    token = parse_qs(urlparse(path).query).get("token", [""])[0]
    if auth_token and token != auth_token:
        logging.warning(f"Unauthorized connection attempt. Path: {path}")
        await websocket.close(code=1008, reason="Unauthorized")
        return

    logging.info("Frontend connected.")
    active_frontend_ws = websocket
    
    try:
        temp_audio = AudioHandler()
        try:
            devices = temp_audio.get_audio_devices()
        finally:
            temp_audio.close()

        if service_starting:
            status_message = "正在连接翻译服务..."
        elif service_running:
            status_message = "服务运行中"
        else:
            status_message = "服务已就绪"

        await send_status(
            websocket,
            status_message,
            service_running_state=service_running,
            serviceStarting=service_starting,
            connected=True,
            devices=devices,
            appId=app_id,
            accessToken="********" if access_token else "",
        )
        
        while True:
            try:
                msg = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                try:
                    data = json.loads(msg)
                except json.JSONDecodeError as error:
                    logging.warning(f"Received malformed frontend message: {error}")
                    await send_status(websocket, "收到无效指令，请重试", service_running_state=service_running)
                    continue
                await handle_frontend_command(websocket, data)
            except asyncio.TimeoutError:
                continue
    except websockets.exceptions.ConnectionClosed:
        logging.info("Frontend disconnected.")
    finally:
        active_frontend_ws = None
        if service_running or service_starting:
            logging.info("Frontend disconnected while service running, cleaning up resources...")
            await notify_and_stop_service("客户端断开，资源释放")

async def handle_frontend_command(websocket, data):
    """处理前端发送的命令"""
    global service_running, service_starting, audio_handler, volc_client_task, app_id, access_token, current_input_idx, current_output_idx, file_streamer_task

    async def run_volc_client_task(volc_client):
        try:
            await volc_client.run()
            if service_running or service_starting:
                await notify_and_stop_service("翻译会话已结束")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logging.error(f"Volc client task failed: {error}")
            if service_starting and not service_running:
                await notify_and_stop_service(f"服务启动失败: {error}")
            else:
                await notify_and_stop_service(f"服务运行异常: {error}")

    async def start_translation_service(input_dev_idx, output_dev_idx, source_language="zh", target_language="en", started_message="服务已启动"):
        global service_running, service_starting, audio_handler, volc_client_task, file_streamer_task

        parsed_input_idx = parse_device_index(input_dev_idx)
        parsed_output_idx = parse_device_index(output_dev_idx)

        logging.info(f"Starting audio with Input Device: {parsed_input_idx}, Output Device: {parsed_output_idx}")
        logging.info(f"Language direction: {source_language} -> {target_language}")
        clear_audio_queues()
        audio_handler = AudioHandler(input_device_index=parsed_input_idx, output_device_index=parsed_output_idx)
        loop = asyncio.get_running_loop()

        try:
            audio_handler.start_output()
            service_running = False
            service_starting = True
            await send_status(websocket, "正在连接翻译服务...", service_running_state=False, serviceStarting=True)

            if TEST_AUDIO_FILE and os.path.exists(TEST_AUDIO_FILE):
                logging.info(f"Test mode: streaming from file {TEST_AUDIO_FILE}")

                async def file_streamer():
                    with open(TEST_AUDIO_FILE, "rb") as f:
                        f.read(44)
                        while service_running or service_starting:
                            chunk = f.read(INPUT_CHUNK)
                            if not chunk:
                                break
                            enqueue_audio_input_chunk(chunk)
                            await asyncio.sleep(0.1)

                file_streamer_task = asyncio.create_task(file_streamer())
            else:
                logging.info("Normal mode: streaming from microphone")
                audio_handler.start_input(loop)

            volc_client = VolcEngineClient(app_id, access_token, source_language=source_language, target_language=target_language, started_message=started_message)
            volc_client_task = asyncio.create_task(run_volc_client_task(volc_client))
        except Exception:
            service_running = True
            await notify_and_stop_service("服务启动失败，资源已回收")
            raise

    command_type = data.get('type')

    if command_type == 'service_command':
        command = data.get('command')
        
        if command == 'stop':
            if service_running or service_starting:
                logging.info("Stopping service...")
                await notify_and_stop_service("服务已手动停止")
        
        elif command == 'start':
            if service_starting:
                await send_status(websocket, "翻译服务正在连接中，请稍候", service_running_state=False, serviceStarting=True)
                return
            if not service_running:
                logging.info("Starting service...")
                if not app_id or not access_token:
                    logging.error("Cannot start service: APP_ID or ACCESS_TOKEN not configured.")
                    await send_status(websocket, "启动失败: API密钥未配置", service_running_state=False)
                    return

                input_dev_idx = data.get('inputDevice')
                output_dev_idx = data.get('outputDevice')
                src_lang = data.get('sourceLanguage', 'zh')
                tgt_lang = data.get('targetLanguage', 'en')

                current_input_idx = input_dev_idx
                current_output_idx = output_dev_idx

                try:
                    await start_translation_service(input_dev_idx, output_dev_idx, source_language=src_lang, target_language=tgt_lang, started_message="服务已启动")
                except Exception as e:
                    logging.error(f"Failed to start service: {e}")
                    service_running = False
                    service_starting = False
                    audio_handler = None
                    await send_status(websocket, f"启动失败: {str(e)}", service_running_state=False)

    elif command_type == 'update_config':
        logging.info("Updating API configuration...")
        new_app_id = data.get('appId')
        new_access_token = data.get('accessToken')

        if not new_app_id or not new_access_token:
            logging.error("Update failed: App ID or Access Token is missing.")
            await send_status(websocket, "更新失败: App ID 或 Access Token 为空", service_running_state=service_running)
            return

        persistence_message = "配置已更新"
        try:
            persist_runtime_config(new_app_id)
        except OSError as error:
            persistence_message = f"配置已更新，但本地保存失败: {error}"
            logging.error(f"Failed to persist runtime config to {runtime_env_path}: {error}")

        app_id = new_app_id
        access_token = new_access_token
        logging.info("Configuration updated. Restarting service if it is running.")

        if service_running:
            await notify_and_stop_service("正在更新配置重启...")
            await asyncio.sleep(1)

            logging.info("Restarting service with new configuration...")
            try:
                await start_translation_service(current_input_idx, current_output_idx, started_message="配置已更新，服务重启成功")
                logging.info("Service restarted successfully with new config.")
            except Exception as e:
                logging.error(f"Failed to restart service: {e}")
                service_running = False
                service_starting = False
                audio_handler = None
                await send_status(websocket, f"重启失败: {str(e)}", service_running_state=False)
        else:
            await send_status(websocket, persistence_message, service_running_state=False)

async def start_local_server():
    async with serve(frontend_handler, "localhost", local_ws_port):
        logging.info(f"Local WebSocket server started on port {local_ws_port}")
        print("BACKEND_READY", flush=True) # Signal that the backend is ready
        await asyncio.Future()  # run forever

# ================= 控制台自毁守护 =================
def monitor_stdin():
    """监控标准输入，如果主进程挂掉管道断裂，则子进程自杀防止僵尸"""
    try:
        while True:
            line = sys.stdin.readline()
            if not line:
                logging.error("Parent process died (stdin EOF). Self-destructing.")
                os._exit(1)
            time.sleep(1)
    except Exception as error:
        logging.error(f"Stdin monitor crashed: {error}")
        os._exit(1)

# ================= 主入口 =================

async def main():
    # 启动本地WebSocket服务器
    await start_local_server()

if __name__ == "__main__":
    import threading
    stdin_thread = threading.Thread(target=monitor_stdin, daemon=True)
    stdin_thread.start()

    parser = argparse.ArgumentParser()
    parser.add_argument("--token", type=str, default="", help="Auth token for local websocket")
    parser.add_argument("--port", type=int, default=local_ws_port, help="Local websocket listen port")
    args = parser.parse_args()
    
    auth_token = args.token
    local_ws_port = args.port
    if auth_token:
        logging.info("Server started with WS Authentication Token.")

    logging.info(f"Runtime config path: {runtime_env_path}")
    if loaded_env_paths:
        logging.info(f"Loaded backend config from: {', '.join(loaded_env_paths)}")
    else:
        logging.info("No backend config file found. Waiting for frontend-provided credentials if needed.")

    if not app_id or not access_token:
        logging.warning("启动警告: APP_ID 或 ACCESS_TOKEN 未在可用配置中找到。")
        logging.warning("服务将正常启动，但请务必通过前端设置界面进行配置，否则无法翻译。")
    
    # 无论有没有密钥，都强制启动服务，以便前端能连接并发送配置
    # Windows 下 asyncio 使用 ProactorEventLoop 可能在某些音频库下有问题，但通常 OK
    # 如果报错，可以尝试: asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
