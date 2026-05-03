#!/usr/bin/env python3
"""
后端打包脚本 - 使用 PyInstaller 将 Python 后端打包成独立的 exe
"""
import os
import sys
import subprocess

def build_backend():
    """打包后端服务"""
    print("开始打包后端服务...")
    
    # 获取当前目录
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(backend_dir)
    dist_dir = os.path.join(root_dir, "dist")
    
    # 确保 dist 目录存在
    os.makedirs(dist_dir, exist_ok=True)
    
    # PyInstaller 参数
    args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onefile",  # 打包成单个文件
        "--name", "backend_engine",  # 输出文件名
        "--distpath", dist_dir,  # 输出目录
        "--workpath", os.path.join(backend_dir, "build"),  # 临时文件目录
        "--specpath", backend_dir,  # spec 文件目录
        "--add-data", f"python_protogen{os.pathsep}python_protogen",  # 包含 protobuf 文件
        "--hidden-import", "websockets",
        "--hidden-import", "websockets.legacy",
        "--hidden-import", "websockets.legacy.server",
        "--hidden-import", "pyaudio",
        "--hidden-import", "numpy",
        "--hidden-import", "google.protobuf",
        "--collect-all", "google.protobuf",
        "--hidden-import", "pkg_resources",
        "--hidden-import", "pkg_resources._vendor",
        "--collect-all", "pkg_resources",
        "--hidden-import", "dotenv",
        "--hidden-import", "websockets.asyncio.server",
        "--hidden-import", "websockets.asyncio.client",
        os.path.join(backend_dir, "main.py")  # 主入口文件
    ]
    
    print(f"执行命令: {' '.join(args)}")
    
    # 执行打包
    result = subprocess.run(args, capture_output=True, text=True)
    
    if result.returncode == 0:
        print("后端打包成功！")
        print(f"输出文件: {os.path.join(dist_dir, 'backend_engine.exe')}")
    else:
        print("后端打包失败！")
        print("错误输出:", result.stderr)
        return False
    
    return True

if __name__ == "__main__":
    success = build_backend()
    sys.exit(0 if success else 1)
