/* 端云协同智能体演示面板逻辑：请求调度、指标渲染、依赖图 SVG、时间线 */
"use strict";

const $ = (id) => document.getElementById(id);
/* 错误码 → 可读提示：后端只回码，人话放在前端，避免改后端契约 */
const ERROR_HINTS = {
  model_incomplete_answer: "本地模型回答被长度上限截断（model_incomplete_answer），已尝试升级云端，可重试或换个问法",
  model_empty_answer: "模型返回空回答（model_empty_answer），可重试",
  model_invalid_response: "模型返回格式异常（model_invalid_response）",
  model_connection_error: "模型接口连接失败（model_connection_error），检查隧道或后端服务",
  model_http_401: "云端鉴权失败（401），检查 API Key",
  model_http_402: "云端余额不足（402）",
  model_http_429: "云端限流（429），请稍后重试",
  model_http_500: "云端服务异常（500）",
  model_http_503: "云端服务不可用（503）",
  evidence_incomplete: "资料问答未完成（引用或格式契约未通过）",
  task_ledger_write_failed: "结果已生成，但指标落库失败（task_ledger_write_failed）",
};
const EXAMPLES = [
  "一个班30人, 每5人一组共多少组? 教室长8米宽6米面积是多少?",
  "下列哪项不是哺乳动物？\nA. 鲸鱼\nB. 鲨鱼\nC. 蝙蝠\nD. 海豚",
  "预算500元以内, 周六出发两日游, 每天不超过3个景点, 请给出方案花费",
  "帮我查询北京明天的天气并发送提醒给同事",
  "帮我计算 12*(3+4) 的结果",
];

/* ---------------- 启动 ---------------- */
async function boot() {
  // 示例 chips
  EXAMPLES.forEach((q, i) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = q.length > 22 ? q.slice(0, 22) + "…" : q;
    chip.onclick = () => { $("sources").value = ""; $("query").value = q; run(); };
    $("examples").appendChild(chip);
  });

  const evidenceExample = document.createElement("button");
  evidenceExample.className = "chip";
  evidenceExample.textContent = "资料问答示例";
  evidenceExample.onclick = () => {
    $("query").value = "报名截止时间是什么？";
    $("sources").value = "活动地点在教学楼。\n\n报名截止时间是周五17点。";
    $("selector").value = "bm25";
    document.querySelector(".source-input").open = true;
    run();
  };
  $("examples").appendChild(evidenceExample);
  const runtime = await (await fetch("/api/runtime")).json();
  const stub = runtime.local === "stub" || runtime.cloud === "stub";
  $("runtime").textContent =
    `local: ${runtime.local} · cloud: ${runtime.cloud}` + (stub ? "（stub 演示模式）" : "");
  loadHistory();
}

/* ---------------- 运行 ---------------- */
async function run() {
  const query = $("query").value.trim();
  if (!query) return;
  const payload = { query };
  const sourceText = $("sources").value;
  if (sourceText.trim()) {
    payload.sources = sourceText.split(/\n\s*\n/).filter(text => text.trim())
      .map((text, i) => ({ source_id: "source-" + (i + 1), text }));
    payload.selector = $("selector").value;
  }
  $("run").disabled = true;
  $("answer").textContent = "推理中…";
  try {
    const resp = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (data.metrics) render(data);
    if (data.error) {
      $("answer").textContent = "运行未完成：" + (ERROR_HINTS[data.error] || data.error);
      $("answer").classList.add("error");
    } else {
      $("answer").classList.remove("error");
    }
    loadHistory();
  } catch (e) {
    $("answer").textContent = "请求失败，请检查本地服务是否运行。";
  } finally {
    $("run").disabled = false;
  }
}

/* ---------------- 渲染 ---------------- */
function render(d) {
  renderRich($("answer"), d.answer || "");
  $("path").textContent = {
    cache_hit: "缓存命中", fast_path: "快速通道·本地直答",
    pipeline: "分解流水线", direct_cloud: "整题收敛云端",
    evidence_bm25: "检索证据 → 云端回答", evidence_local: "本地选证据 → 云端回答",
    evidence_full_fallback: "全文云端回退", evidence_failed: "资料问答未完成",
  }[d.path] || d.path;

  const m = d.metrics || {};
  $("t-ctime").textContent = m.C_time_s != null ? `${m.C_time_s.toFixed(3)}s` : "–";
  const stages = m.stage_latency_s || {};
  $("t-ctime-sub").textContent = Object.entries(stages)
    .map(([k, v]) => `${k} ${v.toFixed(3)}`).join(" · ") || "无阶段耗时";
  $("t-capi").textContent = (m.simulated ? "模拟 " : "") + (m.C_API_total ?? "–");
  $("t-capi-sub").textContent = `in ${m.C_API_in ?? 0} / out ${m.C_API_out ?? 0} · 云端调用 ${m.cloud_calls ?? 0} 次`;
  if (m.unknown_usage_calls) $("t-capi-sub").textContent += " · 已知小计，另有 " + m.unknown_usage_calls + " 次用量未知";
  if (m.simulated) $("t-capi-sub").textContent += " · 模拟用量，不代表真实模型表现";
  if (m.ledger_complete === false) $("t-capi-sub").textContent += " · 账本不完整";
  $("source-trace").textContent = (d.provided_sources || []).length
    ? "提供给云端的来源：" + d.provided_sources.join("、") + "；答案引用：" + ((d.citations || []).join("、") || "无")
    : "";
  $("t-local").textContent = m.local_calls ?? "–";
  $("t-local-sub").textContent = `本地推理 ${m.local_latency_s ?? 0}s`;
  $("t-label").textContent = d.label;
  $("t-label-sub").textContent = `路径: ${d.path}`;

  renderDag(d.subtasks || []);
  renderTrace(d.trace || []);
  renderStages(m);
  renderCalls(m);
  renderSubtasks(d);
}

/* ---------------- 依赖图（拓扑分层 SVG）---------------- */
function renderDag(subtasks) {
  const box = $("dag");
  if (!subtasks.length) {
    box.innerHTML = '<div class="dag-empty">本请求未拆分任务。资料问答的证据选择与引用可在结果和决策时间线中查看。</div>';
    return;
  }
  const levels = {};
  subtasks.forEach((st) => { (levels[st.level] = levels[st.level] || []).push(st); });
  const levelKeys = Object.keys(levels).map(Number).sort((a, b) => a - b);

  const W = 168, H = 74, GX = 56, GY = 26, PAD = 8;
  const maxPerLevel = Math.max(...levelKeys.map((k) => levels[k].length));
  const height = maxPerLevel * (H + GY) - GY + PAD * 2;
  const width = levelKeys.length * (W + GX) - GX + PAD * 2;
  const pos = {};
  levelKeys.forEach((lv, ci) => {
    const arr = levels[lv];
    arr.forEach((st, ri) => {
      const gap = (height - arr.length * H) / (arr.length + 1);
      pos[st.id] = { x: PAD + ci * (W + GX), y: gap * (ri + 1) + ri * H, st };
    });
  });

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  let svg = `<svg width="${width}" height="${height}" role="img" aria-label="子任务依赖图">`;
  // 边（deps → 本节点），水平贝塞尔
  subtasks.forEach((st) => {
    (st.deps || []).forEach((dep) => {
      if (!pos[dep] || !pos[st.id]) return;
      const a = pos[dep], b = pos[st.id];
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
      const mx = (x1 + x2) / 2;
      svg += `<path class="edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
    });
  });
  // 节点
  subtasks.forEach((st) => {
    const p = pos[st.id];
    const cls = st.assigned === "MC" ? "mc" : "md";
    const tip = esc(`【${st.id} → ${st.assigned}】${st.description}\n答案: ${st.answer || "—"}`);
    const desc = st.description.length > 16 ? st.description.slice(0, 16) + "…" : st.description;
    svg += `<g class="node ${cls}"><title>${tip}</title>
      <rect class="${cls}" x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8"/>
      <text class="sid" x="${p.x + 12}" y="${p.y + 20}">${st.id} · ${st.assigned}
        <tspan class="lv" fill="#898781">· L${st.level}</tspan></text>
      <text class="desc" x="${p.x + 12}" y="${p.y + 42}">${esc(desc)}</text>
      <text class="desc" x="${p.x + 12}" y="${p.y + 60}" fill="#898781">${esc((st.answer || "—").slice(0, 18))}</text>
    </g>`;
  });
  svg += "</svg>";
  box.innerHTML = svg;
}


/* ---------------- 富文本：Markdown + LaTeX ---------------- */
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeHtml(html) {
  // 模型输出直接塞进 DOM，先去掉脚本与内联事件
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

/* 行尾单个反斜杠在 LaTeX 里几乎都是换行，补成 \\；已经成对的 \\ 保持原样。
   不补的话 KaTeX 会把整块当成语法错误，cases/matrix 之类直接渲染失败。 */
function normalizeMath(src) {
  return String(src).split("\n").map((line) => {
    const m = line.match(/^(.*?)(\\+)[ \t]*$/);
    if (!m) return line;
    return m[2].length % 2 === 1 ? m[1] + m[2] + "\\" : line;
  }).join("\n");
}

function katexHtml(item) {
  if (!window.katex || typeof window.katex.renderToString !== "function") {
    return `<code>${escapeHtml(item.src)}</code>`;
  }
  try {
    return window.katex.renderToString(item.src, {
      displayMode: item.display,
      throwOnError: false,
      strict: false,
    });
  } catch (e) {
    return `<code>${escapeHtml(item.src)}</code>`;
  }
}

/* 先把公式整段抽出来换成占位符，再交给 Markdown；否则 $$ 块里的反斜杠会被
   Markdown 当作转义或强制换行吃掉，公式必然渲染失败。渲染完再塞回去。 */
function renderRich(el, text) {
  const src = String(text == null ? "" : text);
  if (!src.trim()) { el.textContent = "—"; return; }
  el.classList.add("md");

  const items = [];
  const keep = (body, display) => {
    items.push({ src: normalizeMath(body.trim()), display });
    return `@@MATH${items.length - 1}@@`;
  };

  const protectedText = src
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, g) => keep(g, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, g) => keep(g, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (m, g) => keep(g, false))
    .replace(/\$([^$\n]+?)\$/g, (m, g) => keep(g, false));

  let html = protectedText;
  if (window.marked && typeof window.marked.parse === "function") {
    html = sanitizeHtml(window.marked.parse(protectedText, { breaks: true }));
  } else {
    html = escapeHtml(protectedText).replace(/\n/g, "<br>");
  }

  // 独占一段的块级公式包成 div，避免被 <p> 的间距切开
  html = html.replace(/<p>\s*@@MATH(\d+)@@\s*<\/p>/g, (m, i) => {
    const item = items[Number(i)];
    return item && item.display ? `<div class="math-block">${katexHtml(item)}</div>` : m;
  });
  html = html.replace(/@@MATH(\d+)@@/g, (m, i) => {
    const item = items[Number(i)];
    return item ? katexHtml(item) : m;
  });

  el.innerHTML = html;
}

/* ---------------- 阶段耗时 ---------------- */
function renderStages(m) {
  const el = $("stages");
  if (!el) return;
  const rows = Object.entries(m.stage_latency_s || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!rows.length) { el.innerHTML = '<div class="muted">本次请求没有阶段计时</div>'; return; }
  const max = Math.max(...rows.map(([, v]) => v));
  el.innerHTML = rows.map(([k, v]) => {
    const pct = Math.max(2, Math.round((v / max) * 100));
    return `<div class="stage-row"><span class="stage-name">${escapeHtml(k)}</span>` +
      `<span class="bar"><i style="width:${pct}%"></i></span>` +
      `<span class="stage-val">${v.toFixed(3)}s</span></div>`;
  }).join("");
}

/* ---------------- 逐次调用 ---------------- */
function renderCalls(m) {
  const el = $("calls");
  if (!el) return;
  const calls = m.calls || [];
  const cnt = $("callcount");
  if (cnt) cnt.textContent = calls.length ? `（共 ${calls.length} 次）` : "";
  if (!calls.length) {
    el.innerHTML = '<tbody><tr><td class="muted">本次请求没有模型调用（可能命中缓存）</td></tr></tbody>';
    return;
  }
  const head = "<thead><tr><th>#</th><th>调用方</th><th>档位</th><th>输入</th><th>输出</th><th>耗时</th></tr></thead>";
  const body = calls.map((c) => {
    const tierCls = c.tier === "MC" ? "cloud" : "local";
    const down = c.requested_tier && c.requested_tier !== c.tier
      ? ' <span class="tag warn">降级</span>' : "";
    const tok = (v) => (v == null ? "未知" : v);
    return `<tr><td>${c.seq}</td><td>${escapeHtml(c.caller)}</td>` +
      `<td><span class="tag ${tierCls}">${c.tier}</span>${down}</td>` +
      `<td class="num">${tok(c.in)}</td><td class="num">${tok(c.out)}</td>` +
      `<td class="num">${(c.latency_s || 0).toFixed(2)}s</td></tr>`;
  }).join("");
  el.innerHTML = head + `<tbody>${body}</tbody>`;
}

/* ---------------- 子任务明细 ---------------- */
function renderSubtasks(d) {
  const el = $("subdetail");
  if (!el) return;
  const subs = d.subtasks || [];
  if (!subs.length) {
    el.innerHTML = '<div class="muted">本请求未拆分任务（快速通道或整题收敛）</div>';
    return;
  }
  el.innerHTML = subs.map((st) => {
    const deps = (st.deps || []).length ? st.deps.join("、") : "无";
    const tierCls = st.assigned === "MC" ? "cloud" : "local";
    return `<div class="sub-item">
      <div class="sub-head"><b>${escapeHtml(st.id)}</b>
        <span class="tag ${tierCls}">${escapeHtml(st.assigned || "–")}</span>
        <span class="muted">L${st.level} · 依赖 ${escapeHtml(deps)}${st.status ? " · " + escapeHtml(st.status) : ""}</span></div>
      <div class="sub-q">${escapeHtml(st.description || "")}</div>
      <div class="sub-a">${escapeHtml(st.answer || "")}</div>
    </div>`;
  }).join("");
}

/* ---------------- 时间线 ---------------- */
function renderTrace(trace) {
  $("trace").innerHTML = trace.map((line) => {
    let cls = "";
    if (/云端|升级|MC/.test(line)) cls = "cloud";
    else if (/本地|MD|工具执行成功/.test(line)) cls = "local";
    else if (/失败|耗尽|重分类|收敛/.test(line)) cls = "warn";
    return `<li class="${cls}">${line.replace(/</g, "&lt;")}</li>`;
  }).join("");
}

/* ---------------- 历史 ---------------- */
async function loadHistory() {
  const data = await (await fetch("/api/history")).json();
  const el = $("history");
  if (!data.history.length) { el.innerHTML = '<div class="muted">暂无</div>'; return; }
  el.innerHTML = "";
  data.history.forEach((h) => {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `<span class="q">${h.query.replace(/</g, "&lt;")}</span>
      <span class="meta">${h.label} · ${h.path} · C_API ${h.metrics.C_API_total} tok · ${(h.metrics.C_time_s || 0).toFixed(3)}s</span>`;
    item.onclick = () => render(h);
    el.appendChild(item);
  });
}

$("run").onclick = run;
$("query").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
});
boot();
