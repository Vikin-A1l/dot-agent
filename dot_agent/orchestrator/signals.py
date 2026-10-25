"""难度信号收集（v1 统计信号路由，无需训练）。

三个信号（均为客观统计量，非模型自报置信度，符合申请书口径）：
  alpha_quantile : greedy 试答 token 概率的 α 分位数，越低越难。
                   后端不返回 token 概率时为 None，路由退化为一致性信号。
  consistency    : 同一子任务 k=3 采样（temperature>0）归一化答案一致率。
  exec_ok        : 工具执行校验（TOOLUSE 接入执行器后填充）。

关键优化：greedy 试答结果直接作为"路由判本地"时的子任务答案复用，
省一次生成——与 L2 分类合并推理同一思想（一次推理多处产出）。
"""
from __future__ import annotations

import re

from ..gateway.base import ModelClient
from ..types import Caller, GenerationResult, SignalScores

K_SAMPLES = 3
ALPHA = 0.5  # α-quantile 的 α，路由调优时扫描 {0, 0.2, 0.5, 0.8}

_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
_LETTER_RE = re.compile(r"(?i)\b([A-D])\b")


def normalize_answer(text: str) -> str:
    """答案归一化：取末尾数值 / 选项字母；否则去空白与标点。"""
    tail = text.strip().splitlines()[-1] if text.strip() else ""
    nums = _NUM_RE.findall(tail)
    if nums:
        return f"num:{float(nums[-1]):.3g}"
    letters = _LETTER_RE.findall(tail)
    if letters:
        return f"opt:{letters[-1].upper()}"
    return re.sub(r"[\s，。、；：？！,.!?;:]", "", tail)


def alpha_quantile(probs: list[float], alpha: float = ALPHA) -> float | None:
    if not probs:
        return None
    s = sorted(probs)
    idx = min(int(alpha * len(s)), len(s) - 1)
    return s[idx]


class SignalCollector:
    def __init__(self, client: ModelClient, k: int = K_SAMPLES) -> None:
        self.client = client
        self.k = k

    async def _sample(self, prompt: str, temperature: float) -> GenerationResult | None:
        """单次采样；截断/空答/连接失败返回 None，不中断整个请求。

        采样失败本身也是难度信号：拿不到样本时按"不一致"保守处理，
        由 Router 倾向云端，而不是让异常穿透到 HTTP 层变成 500。
        """
        try:
            return await self.client.generate(
                prompt, max_tokens=256, temperature=temperature, caller=Caller.SIGNAL
            )
        except RuntimeError:  # GenerationError 与 model_http_*/connection 均为 RuntimeError
            return None

    async def collect(self, prompt: str) -> tuple[SignalScores, GenerationResult | None]:
        """返回 (信号, greedy 试答结果)。greedy 结果供路由判本地时复用。

        greedy 为 None 表示本地模型连试答都没完成，调用方必须走升级路径，
        不能把它当作答案使用。
        """
        greedy = await self._sample(prompt, 0.0)
        if greedy is None:
            return SignalScores(alpha_quantile=None, consistency=0.0), None
        aq = alpha_quantile(greedy.token_probs) if greedy.token_probs else None

        samples = [normalize_answer(greedy.text)]
        missing = False
        for _ in range(self.k - 1):
            r = await self._sample(prompt, 0.7)
            if r is None:
                missing = True
                continue
            samples.append(normalize_answer(r.text))
        if missing:  # 有采样缺失 → 一致率不可信，按不一致处理
            consistency = 0.0
        else:
            consistency = len(set(samples)) == 1 and 1.0 or (1.0 / len(set(samples)))

        return SignalScores(alpha_quantile=aq, consistency=consistency), greedy
