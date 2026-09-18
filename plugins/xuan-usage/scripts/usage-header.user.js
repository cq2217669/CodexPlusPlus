/* Built-in relay usage monitor, adapted from Codex Relay Balance in CodexPlusPlusScriptMarket. */
(() => {
  const API_KEY = "__codexPlusRelayBalance";
  const REVISION = "builtin-2026-09-18-v11";
  const ROOT_ID = "codex-plus-relay-balance";
  const PANEL_ID = "codex-plus-relay-balance-panel";
  const STYLE_ID = "codex-plus-relay-balance-style";
  const STORAGE_KEY = "codex-plus-relay-balance-config-v1";
  const DEFAULT_CONFIG = {
    usagePath: "/v1/usage",
    timezone: "Asia/Shanghai",
    refreshMinutes: 5,
    rangeDays: 7,
  };

  if (window[API_KEY]?.revision === REVISION) {
    window[API_KEY].ensure?.();
    return;
  }
  window[API_KEY]?.destroy?.();

  let destroyed = false;
  let root = null;
  let panel = null;
  let timer = 0;
  let observer = null;
  let requestPromise = null;
  let previousSnapshot = null;
  let configRevision = 0;
  let config = loadConfig();
  let state = {
    status: "loading",
    message: "正在读取用量",
    panelOpen: false,
    settingsOpen: false,
    balance: null,
    unit: "USD",
    unlimited: false,
    planName: "",
    profileName: "",
    models: [],
    speedPerHour: null,
    updatedAt: null,
    provider: "unknown",
    todayUsed: null,
    todayLimit: null,
    todayRemaining: null,
    periodLimit: null,
    periodUsed: null,
    periodRemaining: null,
    periodEnd: "",
    openoxKeyName: "",
    tokenConfigured: false,
  };

  function safeText(value) {
    return value == null ? "" : String(value);
  }

  function escapeHtml(value) {
    return safeText(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function numeric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function loadConfig() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return normalizeConfig({ ...DEFAULT_CONFIG, ...stored });
    } catch (_) {
      return { ...DEFAULT_CONFIG };
    }
  }

  function normalizeConfig(value) {
    const refreshMinutes = Math.min(60, Math.max(1, Math.round(numeric(value.refreshMinutes) || 5)));
    const rangeDays = [1, 7, 30, 90].includes(numeric(value.rangeDays)) ? numeric(value.rangeDays) : 7;
    const usagePath = safeText(value.usagePath).trim() || DEFAULT_CONFIG.usagePath;
    const timezone = safeText(value.timezone).trim() || DEFAULT_CONFIG.timezone;
    return { usagePath, timezone, refreshMinutes, rangeDays };
  }

  function saveConfig(next) {
    config = normalizeConfig(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    configRevision += 1;
  }

  function dateRange(days) {
    let parts;
    try {
      parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date());
    } catch (_) {
      throw new Error("统计时区无效，请在用量设置中重新填写");
    }
    const part = (type) => Number(parts.find((item) => item.type === type)?.value);
    const end = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - Math.max(0, days - 1));
    const format = (date) => {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };
    return { startDate: format(start), endDate: format(end) };
  }

  function formatMoney(value, unit = "USD") {
    if (value == null || value === "" || typeof value === "boolean") return "--";
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    const label = safeText(unit || "USD").toUpperCase();
    return label === "USD" ? `$${number.toFixed(2)}` : `${number.toFixed(2)} ${label}`;
  }

  function formatTokens(value) {
    const number = numeric(value);
    if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
    return String(Math.round(number));
  }

  function formatPercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "--";
  }

  function formatDate(value) {
    if (!value) return "--";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? safeText(value) : date.toLocaleDateString();
  }

  function parseBalance(payload) {
    const quota = payload?.quota && typeof payload.quota === "object" ? payload.quota : {};
    const raw = payload?.balance ?? payload?.remaining ?? quota.remaining;
    if (raw == null || typeof raw === "boolean" || (typeof raw === "string" && !raw.trim()) || typeof raw === "object") {
      throw new Error("余额接口未返回有效余额，请检查用量方案");
    }
    const value = Number(raw);
    if (value === -1) {
      return {
        balance: null,
        unit: payload?.unit || quota.unit || "USD",
        unlimited: true,
        planName: payload?.planName || payload?.plan_name || "",
      };
    }
    if (!Number.isFinite(value) || value < 0) throw new Error("余额接口未返回有效余额");
    return {
      balance: value,
      unit: payload?.unit || quota.unit || "USD",
      unlimited: false,
      planName: payload?.planName || payload?.plan_name || "",
    };
  }

  function parseModels(payload) {
    const models = Array.isArray(payload?.model_stats) ? payload.model_stats : [];
    return models
      .map((item) => {
        const cost = numeric(item?.cost);
        const actualCost = numeric(item?.actual_cost ?? item?.cost);
        return {
          model: safeText(item?.model || "未知模型"),
          requests: numeric(item?.requests),
          inputTokens: numeric(item?.input_tokens ?? item?.prompt_tokens),
          cacheCreationTokens: numeric(item?.cache_creation_tokens ?? item?.cache_creation_input_tokens),
          cacheReadTokens: numeric(item?.cache_read_tokens ?? item?.cache_read_input_tokens),
          outputTokens: numeric(item?.output_tokens ?? item?.completion_tokens),
          totalTokens: numeric(item?.total_tokens),
          cost,
          actualCost,
          multiplier: cost > 0 ? actualCost / cost : null,
        };
      })
      .filter((item) => item.model)
      .sort((left, right) => right.actualCost - left.actualCost || right.totalTokens - left.totalTokens);
  }

  function totals(models) {
    return models.reduce(
      (sum, item) => ({
        requests: sum.requests + item.requests,
        hitRequests: sum.hitRequests + numeric(item.hitRequests),
        inputTokens: sum.inputTokens + item.inputTokens,
        cacheCreationTokens: sum.cacheCreationTokens + item.cacheCreationTokens,
        cacheWriteTokens: sum.cacheWriteTokens + numeric(item.cacheWriteTokens),
        cacheReadTokens: sum.cacheReadTokens + item.cacheReadTokens,
        outputTokens: sum.outputTokens + item.outputTokens,
        totalTokens: sum.totalTokens + item.totalTokens,
        cost: sum.cost + item.cost,
        actualCost: sum.actualCost + item.actualCost,
      }),
      { requests: 0, hitRequests: 0, inputTokens: 0, cacheCreationTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, actualCost: 0 },
    );
  }

  function calculateSpeed(models, observedAt, context) {
    const actualCost = totals(models).actualCost;
    let speedPerHour = null;
    if (previousSnapshot?.context === context && observedAt > previousSnapshot.observedAt && actualCost >= previousSnapshot.actualCost) {
      const hours = (observedAt - previousSnapshot.observedAt) / 3_600_000;
      const delta = actualCost - previousSnapshot.actualCost;
      if (hours > 0 && delta > 0) speedPerHour = delta / hours;
    }
    previousSnapshot = { actualCost, observedAt, context };
    return speedPerHour;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // 为右上角三个窗口控制按钮保留空间，窄窗口也不能缩小这段留白。
    style.textContent = `
      #${ROOT_ID}{position:fixed;z-index:2147482400;top:6px;right:152px;white-space:nowrap;-webkit-app-region:no-drag}
      #${ROOT_ID}[data-native-menu="false"]{height:24px;padding:4px 10px;border:1px solid transparent;border-radius:10px;background:transparent;color:color-mix(in srgb,CanvasText 50%,transparent);font:400 14px/14px -apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif;cursor:pointer}
      #${ROOT_ID}[data-native-menu="false"]:hover,#${ROOT_ID}[data-open="true"]{background:color-mix(in srgb,CanvasText 5%,transparent);color:color-mix(in srgb,CanvasText 72%,transparent)}
      #${ROOT_ID}[data-native-menu="false"]:focus-visible{outline:2px solid color-mix(in srgb,CanvasText 65%,transparent);outline-offset:-2px}
      #${ROOT_ID}[data-state="failed"]{color:#dc2626}#${ROOT_ID}[data-state="loading"]{opacity:.72}
      #${PANEL_ID}{position:fixed;z-index:2147482401;top:50px;right:16px;width:min(620px,calc(100vw - 24px));max-height:calc(100vh - 64px);overflow:auto;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;background:Canvas;color:CanvasText;box-shadow:0 18px 54px rgba(0,0,0,.24);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
      #${PANEL_ID}[hidden]{display:none}#${PANEL_ID} *{box-sizing:border-box}
      .crb-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent);background:Canvas}
      .crb-title{font-size:15px;font-weight:700}.crb-sub{margin-top:2px;color:color-mix(in srgb,CanvasText 62%,transparent);font-size:12px}.crb-actions{display:flex;gap:6px}
      .crb-button,.crb-select,.crb-input{height:30px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:5px;background:Canvas;color:CanvasText;font:inherit}.crb-button{padding:0 10px;cursor:pointer}.crb-button:hover{background:color-mix(in srgb,CanvasText 8%,Canvas)}.crb-icon{width:30px;padding:0;font-size:18px}
      .crb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}.crb-select{padding:0 26px 0 8px}.crb-muted{color:color-mix(in srgb,CanvasText 58%,transparent);font-size:12px}
      .crb-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:color-mix(in srgb,currentColor 12%,transparent);border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}.crb-stat{min-width:0;padding:12px 14px;background:Canvas}.crb-stat span{display:block;color:color-mix(in srgb,CanvasText 58%,transparent);font-size:11px}.crb-stat strong{display:block;margin-top:3px;font-size:15px;overflow-wrap:anywhere}
      .crb-message{padding:18px 16px;color:color-mix(in srgb,CanvasText 66%,transparent)}.crb-error{color:#dc2626}.crb-table-wrap{overflow:auto}.crb-table{width:100%;border-collapse:collapse;white-space:nowrap}.crb-table th,.crb-table td{padding:9px 10px;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent);text-align:right}.crb-table th{position:sticky;top:59px;background:Canvas;color:color-mix(in srgb,CanvasText 62%,transparent);font-size:11px;font-weight:600}.crb-table th:first-child,.crb-table td:first-child{text-align:left;max-width:190px;overflow:hidden;text-overflow:ellipsis}.crb-total td{font-weight:700;background:color-mix(in srgb,CanvasText 4%,Canvas)}
      .crb-settings{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}.crb-field{display:grid;gap:5px}.crb-field-wide{grid-column:1/-1}.crb-field span{font-size:12px;color:color-mix(in srgb,CanvasText 62%,transparent)}.crb-input{width:100%;padding:0 9px}.crb-settings-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px}
      .crb-head>div:first-child{min-width:0;overflow-wrap:anywhere}.crb-actions{flex-shrink:0}.crb-today{padding:16px}.crb-today strong{font-size:20px}
      @media(max-width:720px){#${ROOT_ID}{top:8px}.crb-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.crb-settings{grid-template-columns:1fr}.crb-field-wide,.crb-settings-actions{grid-column:auto}.crb-table th{top:59px}}
    `;
    document.documentElement.appendChild(style);
  }

  function ensureElements() {
    ensureStyle();
    if (!root?.isConnected) {
      document.getElementById(ROOT_ID)?.remove();
      root = document.createElement("button");
      root.id = ROOT_ID;
      root.type = "button";
      root.addEventListener("click", () => {
        state.panelOpen = !state.panelOpen;
        state.settingsOpen = false;
        render();
        if (state.panelOpen) void refresh(true);
      });
      document.body.appendChild(root);
    }
    if (!panel?.isConnected) {
      document.getElementById(PANEL_ID)?.remove();
      panel = document.createElement("section");
      panel.id = PANEL_ID;
      panel.hidden = true;
      panel.addEventListener("click", onPanelClick);
      panel.addEventListener("change", onPanelChange);
      document.body.appendChild(panel);
    }
    const header = document.querySelector('[class*="ApplicationMenuTopBar"], .app-header-tint, header');
    const nativeMenuClass = header && [...header.querySelectorAll("button")]
      .find((candidate) => /^(文件|编辑|视图|帮助|file|edit|view|help)$/i.test(candidate.textContent?.trim() || ""))
      ?.className;
    root.className = nativeMenuClass || "";
    root.dataset.nativeMenu = String(Boolean(nativeMenuClass));
  }

  function badgeText() {
    if (state.provider === "openox") {
      if (state.status === "loading") return "今日可用 …";
      if (state.status === "disabled") return "OpenOx 设置";
      if (state.status !== "ok") return "今日可用 --";
      return `今日可用 ${formatMoney(state.todayRemaining, state.unit)} / ${formatMoney(state.todayLimit, state.unit)}`;
    }
    if (state.provider === "owlai") {
      if (state.status === "loading") return "今日已用 …";
      if (state.status !== "ok") return "今日已用 --";
      return `今日已用 ${state.todayUsed == null ? "暂无数据" : formatMoney(state.todayUsed, state.unit)}`;
    }
    if (state.status === "loading") return "余额 …";
    if (state.status === "disabled") return "余额 设置";
    if (state.status !== "ok") return "余额 --";
    if (state.unlimited) return "余额 无限";
    return `余额 ${formatMoney(state.balance, state.unit)}`;
  }

  function summaryHtml(models) {
    const sum = totals(models);
    const multiplier = sum.cost > 0 ? sum.actualCost / sum.cost : null;
    const speed = state.speedPerHour == null ? "等待下次刷新" : `${formatMoney(state.speedPerHour, state.unit)}/小时`;
    return `
      <div class="crb-summary">
        <div class="crb-stat"><span>当前余额</span><strong>${state.unlimited ? "无限" : escapeHtml(formatMoney(state.balance, state.unit))}</strong></div>
        <div class="crb-stat"><span>实际扣费</span><strong>${escapeHtml(formatMoney(models.length ? sum.actualCost : null, state.unit))}</strong></div>
        <div class="crb-stat"><span>实际倍率</span><strong>${multiplier == null ? "--" : `${multiplier.toFixed(2)}×`}</strong></div>
        <div class="crb-stat"><span>刷新间消耗速度</span><strong>${escapeHtml(speed)}</strong></div>
      </div>`;
  }

  function openoxSummaryHtml() {
    return `
      <div class="crb-summary">
        <div class="crb-stat"><span>今日可用</span><strong>${escapeHtml(formatMoney(state.todayRemaining, state.unit))} / ${escapeHtml(formatMoney(state.todayLimit, state.unit))}</strong></div>
        <div class="crb-stat"><span>今日已用</span><strong>${escapeHtml(formatMoney(state.todayUsed, state.unit))}</strong></div>
        <div class="crb-stat"><span>周期剩余</span><strong>${escapeHtml(formatMoney(state.periodRemaining, state.unit))} / ${escapeHtml(formatMoney(state.periodLimit, state.unit))}</strong></div>
        <div class="crb-stat"><span>有效期</span><strong>${escapeHtml(formatDate(state.periodEnd))}</strong></div>
      </div>`;
  }

  function tableHtml(models) {
    if (!models.length) return '<div class="crb-message">接口未提供模型用量明细。</div>';
    const sum = totals(models);
    const row = (item, className = "") => `<tr class="${className}">
      <td title="${escapeHtml(item.model || "合计")}">${escapeHtml(item.model || "合计")}</td>
      <td>${Math.round(item.requests)}</td><td>${formatTokens(item.inputTokens)}</td><td>${formatTokens(item.cacheCreationTokens)}</td><td>${formatTokens(item.cacheReadTokens)}</td><td>${formatTokens(item.outputTokens)}</td><td>${formatTokens(item.totalTokens)}</td><td>${escapeHtml(formatMoney(item.cost, state.unit))}</td><td>${escapeHtml(formatMoney(item.actualCost, state.unit))}</td><td>${item.multiplier == null ? "--" : `${item.multiplier.toFixed(2)}×`}</td>
    </tr>`;
    return `<div class="crb-table-wrap"><table class="crb-table"><thead><tr><th>模型</th><th>请求</th><th>输入</th><th>缓存写入</th><th>缓存读取</th><th>输出</th><th>总 Token</th><th>标价</th><th>实际扣费</th><th>倍率</th></tr></thead><tbody>${models.map((item) => row(item)).join("")}${row({ ...sum, model: "合计", multiplier: sum.cost > 0 ? sum.actualCost / sum.cost : null }, "crb-total")}</tbody></table></div>`;
  }

  function openoxTableHtml(models) {
    if (!models.length) return `<div class="crb-message">统计范围内没有 KEY「${escapeHtml(state.openoxKeyName)}」的调用记录。</div>`;
    const sum = totals(models);
    const promptTokens = sum.inputTokens + sum.cacheReadTokens;
    const row = (item, className = "") => {
      const requests = numeric(item.requests);
      const hitRequests = numeric(item.hitRequests);
      const cacheTokenRate = item.cacheTokenRate == null
        ? (numeric(item.inputTokens) + numeric(item.cacheReadTokens) > 0
          ? numeric(item.cacheReadTokens) / (numeric(item.inputTokens) + numeric(item.cacheReadTokens)) : 0)
        : item.cacheTokenRate;
      return `<tr class="${className}">
        <td title="${escapeHtml(item.model || "合计")}">${escapeHtml(item.model || "合计")}</td>
        <td>${Math.round(requests)}</td><td>${Math.round(hitRequests)} / ${formatPercent(requests > 0 ? hitRequests / requests : 0)}</td><td>${formatTokens(item.inputTokens)}</td><td>${formatTokens(item.cacheReadTokens)}</td><td>${formatPercent(cacheTokenRate)}</td><td>${formatTokens(item.outputTokens)}</td><td>${escapeHtml(formatMoney(item.cost, state.unit))}</td>
      </tr>`;
    };
    return `<div class="crb-table-wrap"><table class="crb-table"><thead><tr><th>模型</th><th>请求</th><th>命中请求 / 比例</th><th>输入</th><th>缓存读取</th><th>Token 命中率</th><th>输出</th><th>费用</th></tr></thead><tbody>${models.map((item) => row(item)).join("")}${row({ ...sum, model: "合计", cacheTokenRate: promptTokens > 0 ? sum.cacheReadTokens / promptTokens : 0 }, "crb-total")}</tbody></table></div>`;
  }

  function todayHtml() {
    return `<div class="crb-stat crb-today"><span>今日已用</span><strong>${state.todayUsed == null ? "暂无数据" : escapeHtml(formatMoney(state.todayUsed, state.unit))}</strong></div>`;
  }

  function toolbarHtml(isToday, rangeLabel) {
    return `${isToday ? "" : `<select class="crb-select" data-action="range" aria-label="统计范围"><option value="1" ${config.rangeDays === 1 ? "selected" : ""}>今天</option><option value="7" ${config.rangeDays === 7 ? "selected" : ""}>最近 7 天</option><option value="30" ${config.rangeDays === 30 ? "selected" : ""}>最近 30 天</option><option value="90" ${config.rangeDays === 90 ? "selected" : ""}>最近 90 天</option></select>`}<button type="button" class="crb-button" data-action="refresh">刷新</button><span class="crb-muted">${state.updatedAt ? `更新于 ${state.updatedAt.toLocaleTimeString()} · ${rangeLabel}` : rangeLabel}</span>`;
  }

  function settingsHtml() {
    if (!state.settingsOpen) return "";
    if (state.provider === "unknown") {
      const message = state.status === "loading"
        ? "正在连接用量插件…"
        : "当前任务的用量插件连接不可用。请完全退出并重新打开 Codex++，然后新建任务后再设置。";
      return `<div class="crb-settings"><div class="crb-message ${state.status === "failed" ? "crb-error" : ""}">${escapeHtml(message)}</div></div>`;
    }
    return `<div class="crb-settings">
      ${state.provider === "openox" ? `<label class="crb-field"><span>KEY 名称</span><input class="crb-input" data-openox="keyName" value="${escapeHtml(state.openoxKeyName)}" placeholder="OpenOx 令牌名称"></label>
      <label class="crb-field"><span>Token</span><input class="crb-input" data-openox="token" type="password" value="" placeholder="${state.tokenConfigured ? "已配置，留空不修改" : "登录 Token"}" autocomplete="off"></label>` : state.provider === "owlai" ? "" : `<label class="crb-field crb-field-wide"><span>余额接口路径</span><input class="crb-input" data-config="usagePath" value="${escapeHtml(config.usagePath)}" placeholder="/v1/usage"></label>
      <label class="crb-field"><span>统计时区</span><input class="crb-input" data-config="timezone" value="${escapeHtml(config.timezone)}"></label>`}
      <label class="crb-field"><span>刷新间隔（分钟）</span><input class="crb-input" data-config="refreshMinutes" type="number" min="1" max="60" value="${config.refreshMinutes}"></label>
      <div class="crb-settings-actions">${state.provider === "openox" ? "" : `<button type="button" class="crb-button" data-action="reset">恢复默认</button>`}<button type="button" class="crb-button" data-action="save">保存并刷新</button></div>
    </div>`;
  }

  function renderPanel() {
    if (!panel) return;
    panel.hidden = !state.panelOpen;
    if (!state.panelOpen) return;
    const isToday = state.provider === "owlai";
    const rangeLabel = isToday ? "今天（站点时区）" : `${config.rangeDays} 天`;
    const body = state.status === "loading"
      ? '<div class="crb-message">正在读取用量…</div>'
      : state.status === "ok"
        ? state.provider === "openox" ? `${openoxSummaryHtml()}${openoxTableHtml(state.models)}` : isToday ? todayHtml() : `${summaryHtml(state.models)}${tableHtml(state.models)}`
        : `<div class="crb-message ${state.status === "failed" ? "crb-error" : ""}">${escapeHtml(state.message || "暂无数据")}</div>`;
    if (state.settingsOpen && panel.querySelector(".crb-settings")) {
      const toolbar = panel.querySelector("[data-crb-toolbar]");
      const content = panel.querySelector("[data-crb-content]");
      if (toolbar) toolbar.innerHTML = toolbarHtml(isToday, rangeLabel);
      if (content) content.innerHTML = body;
      return;
    }
    panel.innerHTML = `
      <div class="crb-head"><div><div class="crb-title">当前供应商用量</div><div class="crb-sub">${escapeHtml(state.profileName || "当前激活中转")}${state.provider === "openox" ? ` · KEY ${escapeHtml(state.openoxKeyName || "未配置")}` : isToday ? " · 当前密钥" : state.planName ? ` · ${escapeHtml(state.planName)}` : ""}</div></div><div class="crb-actions"><button type="button" class="crb-button" data-action="settings">设置</button><button type="button" class="crb-button crb-icon" data-action="close" title="关闭" aria-label="关闭">×</button></div></div>
      ${settingsHtml()}
      <div class="crb-toolbar" data-crb-toolbar>${toolbarHtml(isToday, rangeLabel)}</div>
      <div data-crb-content>${body}</div>`;
  }

  function render() {
    ensureElements();
    root.dataset.state = state.status;
    root.dataset.open = String(state.panelOpen);
    root.textContent = badgeText();
    root.title = state.message || "点击查看中转余额与模型用量";
    root.setAttribute("aria-expanded", String(state.panelOpen));
    renderPanel();
  }

  function setState(next) {
    state = { ...state, ...next };
    render();
  }

  function callBridge(path, payload) {
    const route = {
      "/relay-balance/query": "/v1/usage",
      "/relay-balance/settings": "/v1/usage/settings",
      "/relay-balance/settings/set": "/v1/usage/settings/set",
    }[path];
    if (!route) return Promise.reject(new Error("Xuan 用量请求不受支持"));
    const request = Promise.resolve().then(() => {
      const pageBridge = window.__xuanPluginBridge?.["xuan-usage"];
      if (typeof pageBridge !== "function") throw new Error("用量插件尚未连接，请确认插件已启用并重新打开任务");
      return pageBridge(route, payload || {});
    });
    let timeout;
    return Promise.race([
      request,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("用量请求超时")), path === "/relay-balance/query" ? 70_000 : 20_000); }),
    ]).catch((error) => {
      if (/failed to fetch|networkerror|econnrefused/i.test(error?.message || "")) {
        throw new Error("无法连接用量插件，请重新打开任务后重试");
      }
      throw error;
    }).finally(() => clearTimeout(timeout));
  }

  async function fetchUsage() {
    // 旧的自定义时区不应阻止 OwlAI 查询；通用方案仍在收到响应后校验。
    let range;
    let rangeError;
    try { range = dateRange(config.rangeDays); } catch (error) { rangeError = error; }
    const settings = await callBridge("/relay-balance/settings", {});
    if (!settings || settings.status === "failed") throw new Error(settings?.message || "读取用量设置失败");
    if (settings.disabled) return { status: "disabled", message: settings.message || "当前中转不支持余额查询", profileName: settings.profileName || "", provider: settings.provider || "generic" };
    if (settings.provider === "openox" && (!settings.keyName || !settings.tokenConfigured)) {
      previousSnapshot = null;
      return {
        status: "disabled", provider: "openox", profileName: settings.profileName || "",
        openoxKeyName: settings.keyName || "", tokenConfigured: Boolean(settings.tokenConfigured),
        message: "请在设置中填写 OpenOx KEY 名称和 Token",
      };
    }
    const result = await callBridge("/relay-balance/query", {
      usagePath: config.usagePath,
      timezone: config.timezone,
      ...range,
    });
    if (result?.status === "failed" && ["owlai", "openox"].includes(result.provider)) {
      previousSnapshot = null;
      return { status: "failed", provider: result.provider, openoxKeyName: settings.keyName || "", tokenConfigured: Boolean(settings.tokenConfigured), todayUsed: null, balance: null, planName: "", models: [], speedPerHour: null, updatedAt: null, profileName: result.profileName || "", message: result.message || "今日用量查询失败" };
    }
    if (!result || result.status === "failed") throw new Error(result?.message || "用量请求失败");
    if (result.disabled) return { status: "disabled", message: result.message || "当前中转不支持余额查询", profileName: result.profileName || "", provider: result.provider || "generic" };
    if (result.provider === "owlai") {
      previousSnapshot = null;
      if (!result.data || !Object.hasOwn(result.data, "todayUsed")) throw new Error("未收到有效的今日用量数据");
      const todayUsed = result.data.todayUsed;
      if (todayUsed !== null && (typeof todayUsed !== "number" || !Number.isFinite(todayUsed) || todayUsed < 0)) {
        throw new Error("今日用量数据无效");
      }
      return {
        status: "ok", message: todayUsed == null ? "站点未提供今日实际扣费" : "已更新", provider: "owlai",
        profileName: result.profileName || "", planName: "",
        todayUsed, unit: "USD", updatedAt: new Date(),
        balance: null, unlimited: false, models: [], speedPerHour: null,
      };
    }
    if (result.provider === "openox") {
      previousSnapshot = null;
      const payload = result.data || {};
      const models = Array.isArray(payload.models) ? payload.models.map((item) => ({
        model: safeText(item?.model || "未知模型"),
        requests: numeric(item?.requests),
        hitRequests: numeric(item?.hitRequests),
        hitRate: numeric(item?.hitRate),
        inputTokens: numeric(item?.inputTokens),
        outputTokens: numeric(item?.outputTokens),
        cacheCreationTokens: numeric(item?.cacheCreationTokens),
        cacheWriteTokens: numeric(item?.cacheWriteTokens),
        cacheReadTokens: numeric(item?.cacheReadTokens),
        cacheTokenRate: numeric(item?.cacheTokenRate),
        totalTokens: numeric(item?.totalTokens),
        cost: numeric(item?.cost),
        actualCost: numeric(item?.actualCost ?? item?.cost),
      })) : [];
      return {
        status: "ok", provider: "openox", message: "已更新",
        profileName: result.profileName || "", planName: safeText(payload.planName), unit: payload.unit || "USD",
        openoxKeyName: safeText(payload.keyName || settings.keyName), tokenConfigured: true,
        todayLimit: payload.today?.limit, todayUsed: payload.today?.used, todayRemaining: payload.today?.remaining,
        periodLimit: payload.period?.limit, periodUsed: payload.period?.used, periodRemaining: payload.period?.remaining,
        periodEnd: safeText(payload.period?.end), models, speedPerHour: null, updatedAt: new Date(),
      };
    }
    if (rangeError) throw rangeError;
    const payload = result.data?.data && !Array.isArray(result.data.data) && typeof result.data.data === "object"
      ? result.data.data : result.data || {};
    const balance = parseBalance(payload);
    const models = parseModels(payload);
    const observedAt = Date.now();
    return {
      status: "ok",
      provider: "generic",
      todayUsed: null,
      message: "已更新",
      profileName: result.profileName || "",
      models,
      speedPerHour: calculateSpeed(models, observedAt, JSON.stringify([result.profileId, config.usagePath, config.timezone, range])),
      updatedAt: new Date(observedAt),
      ...balance,
    };
  }

  async function refresh(force = false) {
    if (destroyed) return null;
    if (requestPromise) return requestPromise;
    const revision = configRevision;
    setState({ status: "loading", message: "正在读取用量" });
    const request = fetchUsage()
      .then((next) => {
        if (!destroyed && revision === configRevision) setState(next);
        return next;
      })
      .catch((error) => {
        if (!destroyed && revision === configRevision) setState({ status: "failed", balance: null, todayUsed: null, message: error?.message || "用量查询失败，请检查用量方案和统计时区" });
        return null;
      })
      .finally(() => {
        if (requestPromise === request) requestPromise = null;
        if (!destroyed && revision !== configRevision) {
          previousSnapshot = null;
          void refresh(true);
        } else schedule();
      });
    requestPromise = request;
    return request;
  }

  function schedule() {
    window.clearTimeout(timer);
    if (!destroyed) timer = window.setTimeout(() => void refresh(), config.refreshMinutes * 60_000);
  }

  function onPanelClick(event) {
    const action = event.target?.closest?.("[data-action]")?.dataset?.action;
    if (action === "close") setState({ panelOpen: false, settingsOpen: false });
    if (action === "refresh") void refresh(true);
    if (action === "settings") setState({ settingsOpen: !state.settingsOpen });
    if (action === "reset") {
      saveConfig(DEFAULT_CONFIG);
      panel.querySelector(".crb-settings")?.remove();
      setState({ settingsOpen: true });
    }
    if (action === "save") {
      if (state.provider === "openox") {
        void saveOpenOxSettings();
        return;
      }
      const next = { ...config };
      panel.querySelectorAll("[data-config]").forEach((input) => {
        next[input.dataset.config] = input.value;
      });
      saveConfig(next);
      previousSnapshot = null;
      setState({ settingsOpen: false });
      void refresh(true);
    }
  }

  async function saveOpenOxSettings() {
    const keyName = panel.querySelector('[data-openox="keyName"]')?.value?.trim() || "";
    const token = panel.querySelector('[data-openox="token"]')?.value?.trim() || "";
    if (!keyName) {
      setState({ status: "failed", message: "请填写 OpenOx KEY 名称" });
      return;
    }
    setState({ status: "loading", message: "正在保存 OpenOx 设置" });
    try {
      const result = await callBridge("/relay-balance/settings/set", { keyName, token });
      if (!result || result.status === "failed") throw new Error(result?.message || "OpenOx 设置保存失败");
      previousSnapshot = null;
      setState({
        settingsOpen: false,
        provider: "openox",
        openoxKeyName: result.keyName || keyName,
        tokenConfigured: Boolean(result.tokenConfigured),
      });
      void refresh(true);
    } catch (error) {
      setState({ status: "failed", settingsOpen: true, message: error?.message || "OpenOx 设置保存失败" });
    }
  }

  function onPanelChange(event) {
    if (event.target?.dataset?.action !== "range") return;
    saveConfig({ ...config, rangeDays: numeric(event.target.value) });
    previousSnapshot = null;
    void refresh(true);
  }

  function ensure() {
    if (destroyed) return;
    const missing = !root?.isConnected || !panel?.isConnected;
    ensureElements();
    if (missing) render();
  }

  function destroy() {
    destroyed = true;
    document.removeEventListener("DOMContentLoaded", start);
    window.clearTimeout(timer);
    observer?.disconnect();
    root?.remove();
    panel?.remove();
    document.getElementById(STYLE_ID)?.remove();
    if (window[API_KEY]?.revision === REVISION) delete window[API_KEY];
  }

  window[API_KEY] = { revision: REVISION, ensure, refresh, destroy };
  const start = () => {
    if (destroyed) return;
    ensure();
    observer = new MutationObserver(() => ensure());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    void refresh(true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
