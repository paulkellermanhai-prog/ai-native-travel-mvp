#!/usr/bin/env python3
"""Serve the existing local prototype and its assets; no production API is exposed."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import webbrowser


class PreviewHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Local edits should appear on the next reload.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description="启动安途本地网页原型")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1–65535 之间")
    root = Path(__file__).resolve().parent.parent / "prototypes" / "egypt-trip"
    if not (root / "index.html").is_file():
        parser.error("找不到原型文件，请保留完整工程目录后重试。")
    try:
        server = ThreadingHTTPServer(
            ("127.0.0.1", args.port), partial(PreviewHandler, directory=str(root))
        )
    except OSError as error:
        print(f"启动失败：{error}\n如果已有预览窗口，请先关闭其终端，或使用 --port 指定端口。", file=sys.stderr)
        return 1
    url = f"http://localhost:{args.port}/"
    print(f"安途已启动：{url}", flush=True)
    print("按 Ctrl+C 停止。聊天、兴趣和行程保存在当前浏览器的本地存储。", flush=True)
    print("继续使用同一浏览器和地址可恢复记录；更换端口或清除网站数据会影响读取。", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
