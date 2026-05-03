import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

import websockets


BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN = "smoke-test-token"


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_backend_ready(process: subprocess.Popen[str], timeout: int = 20) -> None:
    deadline = time.time() + timeout
    output_lines: list[str] = []
    stdout = process.stdout

    if stdout is None:
        raise RuntimeError("Backend process stdout is unavailable")

    while time.time() < deadline:
        line = stdout.readline()
        if line:
            output_lines.append(line.rstrip())
            if "BACKEND_READY" in line:
                return
        if process.poll() is not None:
            break

    joined_output = "\n".join(output_lines[-20:])
    raise RuntimeError(f"Backend failed to become ready. Recent output:\n{joined_output}")


async def run_smoke_flow(port: int, runtime_env_path: str) -> None:
    uri = f"ws://localhost:{port}/?token={TOKEN}"
    async with websockets.connect(uri) as websocket:
        initial_status = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
        if not initial_status.get("connected"):
            raise RuntimeError(f"Unexpected initial payload: {initial_status}")

        await websocket.send(json.dumps({"type": "update_config", "appId": "demo", "accessToken": "demo"}))
        config_status = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
        if config_status.get("message") != "配置已更新":
            raise RuntimeError(f"Unexpected config response: {config_status}")
        if not os.path.exists(runtime_env_path):
            raise RuntimeError(f"Expected runtime config to be persisted at {runtime_env_path}")
        saved_env = open(runtime_env_path, "r", encoding="utf-8").read()
        if 'APP_ID="demo"' not in saved_env:
            raise RuntimeError(f"APP_ID not found in persisted config: {saved_env}")
        if 'ACCESS_TOKEN' in saved_env:
            raise RuntimeError("ACCESS_TOKEN should NOT be persisted to disk for security")

        await websocket.send(json.dumps({
            "type": "service_command",
            "command": "start",
            "inputDevice": 99999,
            "outputDevice": 99999,
        }))
        start_status = json.loads(await asyncio.wait_for(websocket.recv(), timeout=15))
        if start_status.get("service_running"):
            raise RuntimeError(f"Expected failed start for invalid devices, got: {start_status}")
        if "启动失败" not in start_status.get("message", ""):
            raise RuntimeError(f"Unexpected start failure message: {start_status}")


def main() -> int:
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    port = pick_free_port()

    with tempfile.TemporaryDirectory(prefix="backend-smoke-") as temp_dir:
        runtime_env_path = os.path.join(temp_dir, ".env.runtime")
        env["BACKEND_RUNTIME_ENV_PATH"] = runtime_env_path

        process = subprocess.Popen(
            [sys.executable, "main.py", "--token", TOKEN, "--port", str(port)],
            cwd=BACKEND_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE,
            text=True,
            env=env,
        )

        try:
            wait_for_backend_ready(process)
            asyncio.run(run_smoke_flow(port, runtime_env_path))
            print("Smoke test passed.")
            return 0
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)


if __name__ == "__main__":
    raise SystemExit(main())
