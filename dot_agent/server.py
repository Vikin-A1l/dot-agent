"""演示服务端：纯标准库（http.server），零额外依赖。

端点：
  GET  /               前端页面
  GET  /api/runtime    网关运行时信息（stub/真实模型）
  GET  /api/history    历史请求记录
  POST /api/run        执行一次完整流水线 {query: string}

模型选择由 gateway.factory 按环境变量决定：
未设置 → 桩客户端（前端零模型可完整演示路由流程）
OLLAMA_HOST + CLOUD_API_KEY → 真实端云协同

运行: python -m dot_agent.server  (默认 0.0.0.0:8765)
"""
from __future__ import annotations

import asyncio
import json
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .gateway.factory import make_clients, warmup_real
from .pipeline import AgentPipeline
from .orchestrator.evidence import validate_sources

WEB_DIR = Path(__file__).resolve().parent / "web"
HISTORY: list[dict] = []
_HISTORY_LOCK = threading.Lock()
_MAX_HISTORY = 30


def _serialize(result) -> dict:
    return {
        "query": result.query,
        "answer": result.answer,
        "label": result.label.value,
        "path": result.path,
        "trace": result.trace,
        "metrics": result.metrics,
        "subtasks": result.subtasks,
        "success": result.success,
        "error": result.error,
        "provided_sources": result.provided_sources,
        "citations": result.citations,
    }


class Handler(BaseHTTPRequestHandler):
    pipeline: AgentPipeline = None  # type: ignore[assignment]
    runtime: dict = {}
    run_lock = threading.Lock()  # pipeline 内部缓存/计量非线程安全，串行执行

    def log_message(self, fmt, *args):  # 精简日志
        print(f"[server] {fmt % args}")

    # ---------------- GET ----------------
    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            self._send_file(WEB_DIR / "index.html", "text/html; charset=utf-8")
        elif self.path == "/app.js":
            self._send_file(WEB_DIR / "app.js", "text/javascript; charset=utf-8")
        elif self.path == "/style.css":
            self._send_file(WEB_DIR / "style.css", "text/css; charset=utf-8")
        elif self.path == "/api/runtime":
            self._send_json(self.runtime)
        elif self.path == "/api/history":
            with _HISTORY_LOCK:
                self._send_json({"history": HISTORY})
        elif self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
        else:
            self.send_error(404)

    # ---------------- POST ----------------
    def do_POST(self) -> None:
        if self.path != "/api/run":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self._send_json({"error": "invalid_content_length"}, status=400)
            return
        if not 0 < length <= 1024 * 1024:
            self._send_json({"error": "request_body_size_invalid"}, status=413)
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeError, RecursionError):
            self._send_json({"error": "invalid_json"}, status=400)
            return
        try:
            if not isinstance(body, dict) or not isinstance(body.get("query"), str):
                raise ValueError("invalid_query")
            query = body["query"].strip()
            if not query:
                raise ValueError("invalid_query")
            selector = body.get("selector", "bm25")
            if selector not in ("bm25", "local"):
                raise ValueError("invalid_selector")
            options = {}
            if "sources" in body:
                options = {"sources": validate_sources(body["sources"]), "selector": selector}
            elif selector != "bm25":
                raise ValueError("selector_requires_sources")
        except ValueError as error:
            self._send_json({"error": str(error)}, status=400)
            return

        with self.run_lock:  # asyncio.run 每请求独立事件循环
            try:
                self.pipeline.reset_meter()  # 逐请求计量，避免跨请求累积
                result = asyncio.run(self.pipeline.run(query, **options))
            except Exception as e:  # 演示服务不崩，错误回传前端并留堆栈
                traceback.print_exc()
                self._send_json(
                    {"error": "pipeline_failed", "detail": type(e).__name__,
                     "success": False}, status=500,
                )
                return
        data = _serialize(result)
        with _HISTORY_LOCK:
            HISTORY.insert(0, data)
            del HISTORY[_MAX_HISTORY:]
        self._send_json(data, status=200 if result.success else 502)

    # ---------------- helpers ----------------
    def _send_json(self, obj: dict, status: int = 200) -> None:
        payload = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_file(self, path: Path, ctype: str) -> None:
        if not path.exists():
            self.send_error(404)
            return
        payload = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def serve(host: str = "0.0.0.0", port: int = 8765, *, demo: bool = False) -> None:
    if demo:
        from .gateway.stub import StubModelClient
        from .gateway.demo_behavior import local_demo_behavior, cloud_demo_behavior
        from .types import ModelTier
        local = StubModelClient(ModelTier.MD, name="local-demo", behavior=local_demo_behavior)
        cloud = StubModelClient(ModelTier.MC, name="cloud-demo", behavior=cloud_demo_behavior)
        info = {"local": "stub", "cloud": "stub", "notes": ["显式离线演示，不读取真实模型配置"]}
    else:
        local, cloud, info = make_clients()
        asyncio.run(warmup_real(info, local, cloud))  # 真实模型预热，防冷启动污染首请求
    Handler.pipeline = AgentPipeline(local, cloud, run_id="server")
    Handler.runtime = info
    for note in info.get("notes", []):
        print(f"[gateway] {note}")
    print(f"运行时: local={info['local']}  cloud={info['cloud']}")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"演示面板: http://localhost:{port}  (Ctrl+C 退出)")
    server.serve_forever()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--demo", action="store_true", help="显式使用演示模型，不读取真实后端配置")
    args = parser.parse_args()
    serve(args.host, args.port, demo=args.demo)
