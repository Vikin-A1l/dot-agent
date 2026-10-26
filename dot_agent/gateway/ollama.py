"""Ollama 本地模型客户端（真实后端）。

关键点：token logprobs。Ollama 新版本支持 /api/generate 的 logprobs
参数（返回每 token 的 top 概率）；若服务端不支持，响应中无概率字段，
本客户端把 token_probs 置 None —— α-quantile 信号自动退化为多次采样
一致性（signals.py 已兼容），路由不中断。

环境变量：
  OLLAMA_HOST   默认 http://localhost:11434
  OLLAMA_MODEL  默认 qwen3:4b（16GB 显存建议 4B/8B 量化版）
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from ..types import Caller, GenerationResult, ModelTier
from .base import ModelClient


class OllamaClient(ModelClient):
    tier = ModelTier.MD

    def __init__(
        self,
        host: str | None = None,
        model: str | None = None,
        timeout_s: float = 120.0,
        want_logprobs: bool = True,
        think: bool = False,
    ) -> None:
        import os

        self.host = (host or os.environ.get("OLLAMA_HOST", "http://localhost:11434")).rstrip("/")
        self.model = model or os.environ.get("OLLAMA_MODEL", "qwen3:4b")
        self.timeout_s = timeout_s
        self.want_logprobs = want_logprobs
        # 思考模型（Qwen3 等）默认把 max_tokens 全耗在 thinking 上，正文为空。
        # 仓库部署纪律要求本地关闭思考；Ollama 需显式传 think=false。
        self.think = think
        self.name = f"ollama:{self.model}"
        # 本地回环绕过系统代理（WSL/企业代理会把 localhost 请求也转发的坑）
        from urllib.request import ProxyHandler, build_opener
        from urllib.parse import urlsplit
        handlers = [ProxyHandler({})] if urlsplit(self.host).hostname in (
            "127.0.0.1", "localhost", "::1") else []
        self.opener = build_opener(*handlers)

    async def generate(
        self,
        prompt: str,
        *,
        max_tokens: int = 512,
        temperature: float = 0.0,
        caller: Caller = Caller.EXECUTE,
    ) -> GenerationResult:
        payload: dict = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "think": self.think,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        if self.want_logprobs:
            payload["logprobs"] = 5  # 不支持时服务端忽略或报错，见下方降级
        t0 = time.perf_counter()
        data = self._post(payload, allow_logprobs_retry=True)
        latency = time.perf_counter() - t0

        text = data.get("response", "")
        pt = data.get("prompt_eval_count")
        ct = data.get("eval_count")
        usage_missing = not (isinstance(pt, int) and isinstance(ct, int))
        # usage 缺失时记 0 并标记，绝不按字数估算（计量红线；Ollama 正常都会回 count）
        probs = self._extract_probs(data)
        return GenerationResult(
            text=text,
            token_probs=probs,
            prompt_tokens=pt or 0,
            completion_tokens=ct or 0,
            latency_s=latency,
            usage_missing=usage_missing,
        )

    def _post(self, payload: dict, allow_logprobs_retry: bool) -> dict:
        req = urllib.request.Request(
            f"{self.host}/api/generate",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with self.opener.open(req, timeout=self.timeout_s) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            # 旧版 Ollama 可能不识别 logprobs / think 参数 → 去掉后重试一次
            if allow_logprobs_retry and e.code in (400, 404):
                payload.pop("logprobs", None)
                payload.pop("think", None)
                return self._post(payload, allow_logprobs_retry=False)
            raise RuntimeError(f"Ollama 请求失败: {e.code} {e.read()[:200]!r}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(
                f"无法连接 Ollama（{self.host}），请先 `ollama serve` 并 `ollama pull {self.model}`"
            ) from e

    @staticmethod
    def _extract_probs(data: dict) -> list[float] | None:
        """Ollama logprobs 响应格式随版本而异，兼容两种已知结构；
        识别不了时返回 None（信号退化路径），不抛错。"""
        lp = data.get("logprobs")
        if not lp:
            return None
        try:
            if isinstance(lp, list):  # [{"content": t, "probs": [{"prob": p}, ...]}, ...]
                out = []
                for item in lp:
                    top = item.get("probs") or []
                    if top:
                        out.append(float(top[0].get("prob", top[0].get("p", 0.0))))
                return out or None
            if isinstance(lp, dict) and "tokens" in lp:  # {"tokens": [...], "probs": [...]}
                probs = lp.get("probs")
                if isinstance(probs, list) and probs:
                    return [float(p) for p in probs]
        except (TypeError, ValueError, KeyError):
            return None
        return None
