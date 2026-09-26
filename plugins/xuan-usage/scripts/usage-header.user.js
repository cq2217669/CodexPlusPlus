/* Built-in relay usage monitor, adapted from Codex Relay Balance in CodexPlusPlusScriptMarket. */
(() => {
  const API_KEY = "__codexPlusRelayBalance";
  const REVISION = "builtin-2026-09-24-v25";
  const ROOT_ID = "codex-plus-relay-balance";
  const PANEL_ID = "codex-plus-relay-balance-panel";
  const STYLE_ID = "codex-plus-relay-balance-style";
  const STORAGE_KEY = "codex-plus-relay-balance-config-v1";
  const ENSURE_DEBOUNCE_MS = 750;
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
  let headerHostObserver = null;
  let bootstrapObserver = null;
  let observedHeader = null;
  let ensureTimer = 0;
  let requestPromise = null;
  let previousSnapshot = null;
  let panelPosition = null;
  let panelDrag = null;
  const excludedRows = new Set();
  let configRevision = 0;
  let bridgeWaitStartedAt = Date.now();
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
    bridgeReady: false,
    todayUsed: null,
    todayLimit: null,
    todayRemaining: null,
    periodLimit: null,
    periodUsed: null,
    periodRemaining: null,
    periodEnd: "",
    openoxKeyName: "",
    openoxKeys: [],
    openoxKeyCount: 0,
    tokenConfigured: false,
    refreshing: false,
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

  function formatRequestTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return safeText(value);
    return date.toLocaleString(undefined, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  function latestRequestTime(left, right) {
    if (!left) return safeText(right);
    if (!right) return safeText(left);
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime > leftTime ? safeText(right) : safeText(left);
    return safeText(right) > safeText(left) ? safeText(right) : safeText(left);
  }

  function daysUntil(endValue) {
    if (!endValue) return null;
    const end = new Date(endValue);
    const now = new Date();
    if (Number.isNaN(end.getTime())) return null;
    const startOfEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
    const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.round((startOfEnd - startOfNow) / 86_400_000);
  }

  // 把剩余天数拼到「有效期」label 末尾，避免在 strong 数值行里被强行断行
  function expiryLabel(value) {
    const days = daysUntil(value);
    if (days == null) return "有效期";
    if (days < 0) return `有效期（已过期 ${Math.abs(days)} 天）`;
    if (days === 0) return "有效期（今天到期）";
    return `有效期（剩 ${days} 天）`;
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
    const result = models.reduce(
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
        requestTime: latestRequestTime(sum.requestTime, item.requestTime),
      }),
      { requests: 0, hitRequests: 0, inputTokens: 0, cacheCreationTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, actualCost: 0, requestTime: "" },
    );
    return result;
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
      #${PANEL_ID}{position:fixed;z-index:2147482401;top:50px;right:16px;width:min(720px,calc(100vw - 24px));max-width:calc(100vw - 24px);border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;background:Canvas;color:CanvasText;box-shadow:0 18px 54px rgba(0,0,0,.24);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
      #${PANEL_ID}[hidden]{display:none}#${PANEL_ID} *{box-sizing:border-box}
      .crb-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent);background:Canvas;cursor:grab;touch-action:none;user-select:none}.crb-head :is(button,input,select,textarea,a){user-select:auto}#${PANEL_ID}[data-dragging="true"] .crb-head{cursor:grabbing}
      .crb-title{font-size:15px;font-weight:700}.crb-sub{margin-top:2px;color:color-mix(in srgb,CanvasText 62%,transparent);font-size:12px}.crb-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0}.crb-head-meta{margin-right:2px;white-space:nowrap}
      .crb-button,.crb-select,.crb-input{height:30px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:5px;background:Canvas;color:CanvasText;font:inherit}.crb-button{padding:0 10px;cursor:pointer}.crb-button:hover{background:color-mix(in srgb,CanvasText 8%,Canvas)}.crb-button:disabled{cursor:wait;opacity:.62}.crb-button[aria-expanded="true"]{background:color-mix(in srgb,CanvasText 8%,Canvas)}.crb-refresh{min-width:58px}.crb-icon{width:30px;padding:0;font-size:18px}
      .crb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}.crb-select{padding:0 26px 0 8px}.crb-muted{color:color-mix(in srgb,CanvasText 58%,transparent);font-size:12px}
      .crb-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:color-mix(in srgb,currentColor 12%,transparent);border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}.crb-stat{min-width:0;padding:12px 14px;background:Canvas}.crb-stat span{display:block;color:color-mix(in srgb,CanvasText 58%,transparent);font-size:11px}.crb-stat strong{display:block;margin-top:3px;font-size:15px;overflow-wrap:anywhere}.crb-summary-openox{grid-template-columns:repeat(3,minmax(0,1fr))}.crb-summary-openox .crb-stat{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:9px 14px}.crb-summary-openox .crb-stat span,.crb-summary-openox .crb-stat strong{display:block;margin:0;white-space:nowrap}.crb-summary-openox .crb-stat strong{font-size:14px}
      .crb-message{padding:18px 16px;color:color-mix(in srgb,CanvasText 66%,transparent)}.crb-error{color:#dc2626}.crb-table-wrap{overflow-x:auto;overflow-y:hidden}.crb-table{width:100%;border-collapse:collapse;white-space:nowrap}.crb-table th,.crb-table td{padding:9px 10px;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent);text-align:right}.crb-table th{background:Canvas;color:color-mix(in srgb,CanvasText 62%,transparent);font-size:11px;font-weight:600}.crb-table th:first-child,.crb-table td:first-child{text-align:left;max-width:190px;overflow:hidden;text-overflow:ellipsis}.crb-total td{font-weight:700;background:color-mix(in srgb,CanvasText 4%,Canvas)}
      .crb-table tr[data-usage-row-key]{cursor:pointer;user-select:none}.crb-row-muted td{color:color-mix(in srgb,CanvasText 38%,Canvas)}
      .crb-settings{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}.crb-field{display:grid;gap:5px}.crb-field-wide{grid-column:1/-1}.crb-field span{font-size:12px;color:color-mix(in srgb,CanvasText 62%,transparent)}.crb-input{width:100%;padding:0 9px}.crb-settings-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px}
      .crb-head>div:first-child{min-width:0;overflow-wrap:anywhere}.crb-actions{flex-shrink:0}.crb-today{padding:16px}.crb-today strong{font-size:20px}
      .crb-keys{display:grid;gap:16px;padding:14px 16px}.crb-key{min-width:0}.crb-key-title{margin-bottom:6px;font-size:12px;font-weight:600;color:color-mix(in srgb,CanvasText 70%,transparent)}
      @media(max-width:720px){#${ROOT_ID}{top:8px}.crb-summary:not(.crb-summary-openox){grid-template-columns:repeat(2,minmax(0,1fr))}.crb-head-openox{align-items:flex-start;flex-direction:column}.crb-head-openox .crb-actions{width:100%;justify-content:flex-start;flex-wrap:wrap}.crb-head-openox .crb-head-meta{margin-right:auto}.crb-settings{grid-template-columns:1fr}.crb-field-wide,.crb-settings-actions{grid-column:auto}}
      @media(max-width:520px){.crb-summary-openox{grid-template-columns:1fr}.crb-summary-openox .crb-stat{padding-block:7px}}
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
      panel.addEventListener("dblclick", onPanelDoubleClick);
      panel.addEventListener("keydown", onPanelKeyDown);
      panel.addEventListener("pointerdown", onPanelPointerDown);
      panel.addEventListener("pointermove", onPanelPointerMove);
      panel.addEventListener("pointerup", onPanelPointerEnd);
      panel.addEventListener("pointercancel", onPanelPointerEnd);
      document.body.appendChild(panel);
    }
    const header = findHeader();
    const nativeMenuClass = header && [...header.querySelectorAll("button")]
      .find((candidate) => /^(文件|编辑|视图|帮助|file|edit|view|help)$/i.test(candidate.textContent?.trim() || ""))
      ?.className;
    root.className = nativeMenuClass || "";
    root.dataset.nativeMenu = String(Boolean(nativeMenuClass));
  }

  function findHeader() {
    return document.querySelector('[class*="ApplicationMenuTopBar"], .app-header-tint, header');
  }

  function badgeText() {
    // 统一用「余额 $X」窄文本，避免在窄窗口与右上角的窗口控制按钮重叠
    const remaining = state.provider === "openox" ? state.todayRemaining : state.balance;
    if (state.status === "loading") return `余额 …`;
    if (state.status === "disabled") return `余额 设置`;
    if (state.status !== "ok") return `余额 --`;
    if (state.provider === "owlai") return `今日已用 ${state.todayUsed == null ? "暂无数据" : formatMoney(state.todayUsed, state.unit)}`;
    if (state.unlimited) return `余额 无限`;
    return `余额 ${formatMoney(remaining, state.unit)}`;
  }

  function clampPanelPosition(left, top) {
    if (!panel) return { left, top };
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    const headerHeight = panel.querySelector(".crb-head")?.getBoundingClientRect().height || 48;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = rect.height <= window.innerHeight - margin * 2
      ? Math.max(margin, window.innerHeight - rect.height - margin)
      : Math.max(margin, window.innerHeight - headerHeight - margin);
    return {
      left: Math.min(maxLeft, Math.max(margin, left)),
      top: Math.min(maxTop, Math.max(margin, top)),
    };
  }

  function applyPanelPosition() {
    if (!panelPosition || !panel?.isConnected) return;
    panelPosition = clampPanelPosition(panelPosition.left, panelPosition.top);
    panel.style.left = `${panelPosition.left}px`;
    panel.style.top = `${panelPosition.top}px`;
    panel.style.right = "auto";
  }

  function onPanelPointerDown(event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    const header = event.target?.closest?.(".crb-head");
    if (!header || event.target?.closest?.('button,input,select,textarea,a,[data-action]')) return;
    const rect = panel.getBoundingClientRect();
    panelPosition = { left: rect.left, top: rect.top };
    panelDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
    };
    panel.dataset.dragging = "true";
    panel.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function onPanelPointerMove(event) {
    if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
    panelPosition = clampPanelPosition(
      panelDrag.startLeft + event.clientX - panelDrag.startX,
      panelDrag.startTop + event.clientY - panelDrag.startY,
    );
    applyPanelPosition();
    event.preventDefault();
  }

  function onPanelPointerEnd(event) {
    if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
    if (panel.hasPointerCapture?.(event.pointerId)) panel.releasePointerCapture(event.pointerId);
    panelDrag = null;
    delete panel.dataset.dragging;
  }

  function summaryHtml(models) {
    const sum = totals(activeModels(models, "generic"));
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
      <div class="crb-summary crb-summary-openox">
        <div class="crb-stat"><span>今日已用</span><strong data-summary="todayUsed">${escapeHtml(formatMoney(openoxTodayUsed(), state.unit))}</strong></div>
        <div class="crb-stat"><span>周期剩余</span><strong data-summary="periodRemaining">${escapeHtml(formatMoney(state.periodRemaining, state.unit))}</strong></div>
        <div class="crb-stat"><span data-summary="expiryLabel">${escapeHtml(expiryLabel(state.periodEnd))}</span><strong data-summary="periodEnd">${escapeHtml(formatDate(state.periodEnd))}</strong></div>
      </div>`;
  }

  function usageRowKey(provider, keyName, modelName) {
    return JSON.stringify([provider, safeText(state.profileName), safeText(keyName), safeText(modelName)]);
  }

  function isRowExcluded(rowKey) {
    return excludedRows.has(rowKey);
  }

  function usageRowAttributes(rowKey) {
    if (!rowKey) return "";
    const excluded = isRowExcluded(rowKey);
    const hint = excluded ? "已停止计入合计，双击恢复" : "双击停止计入合计";
    return ` data-usage-row-key="${escapeHtml(rowKey)}" tabindex="0" title="${hint}" aria-label="${hint}"`;
  }

  function activeModels(models, provider, keyName = "") {
    return models.filter((item) => !isRowExcluded(usageRowKey(provider, keyName, item.model)));
  }

  function sortModelsByRequestTime(models) {
    return models
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        const leftTime = Date.parse(safeText(left.item.requestTime));
        const rightTime = Date.parse(safeText(right.item.requestTime));
        const normalizedLeft = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
        const normalizedRight = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
        return normalizedRight - normalizedLeft || left.index - right.index;
      })
      .map(({ item }) => item);
  }

  function openoxTodayUsed() {
    if (state.todayUsed == null) return null;
    const excludedCost = (state.openoxKeys || []).reduce((keyTotal, key) => keyTotal
      + (key.models || []).reduce((modelTotal, model) => modelTotal
        + (isRowExcluded(usageRowKey("openox", key.keyName, model.model)) ? numeric(model.cost) : 0), 0), 0);
    return Math.max(0, numeric(state.todayUsed) - excludedCost);
  }

  function tableHtml(models) {
    if (!models.length) return '<div class="crb-message">接口未提供模型用量明细。</div>';
    const sum = totals(activeModels(models, "generic"));
    const row = (item, className = "", rowKey = "") => `<tr class="${className}${isRowExcluded(rowKey) ? " crb-row-muted" : ""}"${usageRowAttributes(rowKey)}>
      <td title="${escapeHtml(item.model || "合计")}">${escapeHtml(item.model || "合计")}</td>
      <td>${Math.round(item.requests)}</td><td>${formatTokens(item.inputTokens)}</td><td>${formatTokens(item.cacheCreationTokens)}</td><td>${formatTokens(item.cacheReadTokens)}</td><td>${formatTokens(item.outputTokens)}</td><td>${formatTokens(item.totalTokens)}</td><td>${escapeHtml(formatMoney(item.cost, state.unit))}</td><td>${escapeHtml(formatMoney(item.actualCost, state.unit))}</td><td>${item.multiplier == null ? "--" : `${item.multiplier.toFixed(2)}×`}</td>
    </tr>`;
    return `<div class="crb-table-wrap"><table class="crb-table"><thead><tr><th>模型</th><th>请求</th><th>输入</th><th>缓存写入</th><th>缓存读取</th><th>输出</th><th>总 Token</th><th>标价</th><th>实际扣费</th><th>倍率</th></tr></thead><tbody>${models.map((item) => row(item, "", usageRowKey("generic", "", item.model))).join("")}${row({ ...sum, model: "合计", multiplier: sum.cost > 0 ? sum.actualCost / sum.cost : null }, "crb-total")}</tbody></table></div>`;
  }

  function openoxRowsHtml(models, keyName = "") {
    const row = (item, className = "", rowKey = "") => {
      const requests = numeric(item.requests);
      const cacheTokenRate = item.cacheTokenRate == null
        ? (numeric(item.inputTokens) + numeric(item.cacheReadTokens) > 0
          ? numeric(item.cacheReadTokens) / (numeric(item.inputTokens) + numeric(item.cacheReadTokens)) : 0)
        : item.cacheTokenRate;
      return `<tr class="${className}${isRowExcluded(rowKey) ? " crb-row-muted" : ""}"${usageRowAttributes(rowKey)}>
        <td title="${escapeHtml(item.model || "合计")}">${escapeHtml(item.model || "合计")}</td>
        <td data-field="requests">${Math.round(requests)}</td><td data-field="requestTime">${escapeHtml(formatRequestTime(item.requestTime))}</td><td data-field="inputTokens">${formatTokens(item.inputTokens)}</td><td data-field="cacheTokenRate">${formatPercent(cacheTokenRate)}</td><td data-field="outputTokens">${formatTokens(item.outputTokens)}</td><td data-field="cost">${escapeHtml(formatMoney(item.cost, state.unit))}</td>
      </tr>`;
    };
    const sortedModels = sortModelsByRequestTime(models);
    const sum = totals(activeModels(models, "openox", keyName));
    return `<div class="crb-table-wrap"><table class="crb-table"><thead><tr><th>模型</th><th>请求</th><th>请求时间</th><th>输入</th><th>Token 命中率</th><th>输出</th><th>费用</th></tr></thead><tbody>${sortedModels.map((item) => row(item, "", usageRowKey("openox", keyName, item.model))).join("")}${row({ ...sum, model: "合计" }, "crb-total")}</tbody></table></div>`;
  }

  // OpenOx：每个 KEY 一张明细表，并在各自表格底部展示独立合计。
  function openoxTablesHtml() {
    const keys = state.openoxKeys || [];
    if (!keys.length) return '<div class="crb-message">当前没有活跃 KEY。</div>';
    const sections = keys.map((item, index) => `
      <div class="crb-key" data-key-section="${index}">
        <div class="crb-key-title">KEY · ${escapeHtml(item.keyName || "未知 KEY")}</div>
        ${item.models?.length
          ? openoxRowsHtml(item.models || [], item.keyName || "")
          : '<div class="crb-message">今天没有调用记录。</div>'}
      </div>`).join("");
    return `<div class="crb-keys">${sections}</div>`;
  }

  function openoxStructureSignature() {
    return JSON.stringify((state.openoxKeys || [])
      .map((item) => [item.keyName, sortModelsByRequestTime(item.models || []).map((model) => [model.model, model.requestTime, isRowExcluded(usageRowKey("openox", item.keyName, model.model))]), Boolean(item.models?.length)]));
  }

  function updateOpenoxValues(content) {
    const fields = {
      todayUsed: formatMoney(openoxTodayUsed(), state.unit),
      periodRemaining: formatMoney(state.periodRemaining, state.unit),
      expiryLabel: expiryLabel(state.periodEnd),
      periodEnd: formatDate(state.periodEnd),
      keyCount: String(numeric(state.openoxKeyCount)),
    };
    Object.entries(fields).forEach(([name, value]) => {
      const element = panel.querySelector(`[data-summary="${name}"]`);
      if (element) element.textContent = value;
    });
    (state.openoxKeys || []).forEach((key, keyIndex) => {
      const section = content.querySelector(`[data-key-section="${keyIndex}"]`);
      if (!section) return;
      const rows = section.querySelectorAll("tbody tr");
      sortModelsByRequestTime(key.models || []).forEach((model, modelIndex) => updateOpenoxRow(rows[modelIndex], model));
      if (key.models?.length) updateOpenoxRow(rows[rows.length - 1], totals(activeModels(key.models, "openox", key.keyName)));
    });
  }

  function updateOpenoxRow(row, item) {
    if (!row) return;
    const values = {
      requests: String(Math.round(numeric(item.requests))),
      requestTime: formatRequestTime(item.requestTime),
      inputTokens: formatTokens(item.inputTokens),
      cacheTokenRate: formatPercent(item.cacheTokenRate == null
        ? (numeric(item.inputTokens) + numeric(item.cacheReadTokens) > 0
          ? numeric(item.cacheReadTokens) / (numeric(item.inputTokens) + numeric(item.cacheReadTokens)) : 0)
        : item.cacheTokenRate),
      outputTokens: formatTokens(item.outputTokens),
      cost: formatMoney(item.cost, state.unit),
    };
    Object.entries(values).forEach(([field, value]) => {
      const cell = row.querySelector(`[data-field="${field}"]`);
      if (cell) cell.textContent = value;
    });
  }

  function todayHtml() {
    return `<div class="crb-stat crb-today"><span>今日已用</span><strong>${state.todayUsed == null ? "暂无数据" : escapeHtml(formatMoney(state.todayUsed, state.unit))}</strong></div>`;
  }

  function refreshButtonHtml() {
    return `<button type="button" class="crb-button crb-refresh" data-action="refresh" ${state.refreshing ? 'disabled aria-busy="true"' : ""}>${state.refreshing ? "刷新中" : "刷新"}</button>`;
  }

  function toolbarHtml(isToday, rangeLabel) {
    return `${isToday ? "" : `<select class="crb-select" data-action="range" aria-label="统计范围"><option value="1" ${config.rangeDays === 1 ? "selected" : ""}>今天</option><option value="7" ${config.rangeDays === 7 ? "selected" : ""}>最近 7 天</option><option value="30" ${config.rangeDays === 30 ? "selected" : ""}>最近 30 天</option><option value="90" ${config.rangeDays === 90 ? "selected" : ""}>最近 90 天</option></select>`}${refreshButtonHtml()}<span class="crb-muted" data-toolbar-meta>${toolbarMeta(rangeLabel)}</span>`;
  }

  function openoxActionsHtml(rangeLabel) {
    return `<span class="crb-muted crb-head-meta" data-toolbar-meta>${toolbarMeta(rangeLabel)}</span>${refreshButtonHtml()}<button type="button" class="crb-button" data-action="settings" aria-expanded="${state.settingsOpen}">设置</button><button type="button" class="crb-button crb-icon" data-action="close" title="关闭" aria-label="关闭">×</button>`;
  }

  function toolbarMeta(rangeLabel) {
    return state.updatedAt ? `更新于 ${state.updatedAt.toLocaleTimeString()} · ${rangeLabel}` : rangeLabel;
  }

  function syncPanelControls(rangeLabel) {
    const toolbarMetaElement = panel.querySelector("[data-toolbar-meta]");
    if (toolbarMetaElement) toolbarMetaElement.textContent = toolbarMeta(rangeLabel);
    const refreshButton = panel.querySelector('[data-action="refresh"]');
    if (refreshButton) {
      refreshButton.disabled = Boolean(state.refreshing);
      refreshButton.toggleAttribute("aria-busy", Boolean(state.refreshing));
      refreshButton.textContent = state.refreshing ? "刷新中" : "刷新";
    }
    const settingsButton = panel.querySelector('[data-action="settings"]');
    if (settingsButton) settingsButton.setAttribute("aria-expanded", String(state.settingsOpen));
  }

  function settingsHtml() {
    if (!state.settingsOpen) return "";
    if (!state.bridgeReady) {
      const message = state.status === "loading"
        ? "正在连接用量插件…"
        : "当前任务的用量插件连接不可用。请完全退出并重新打开 Codex++，然后新建任务后再设置。";
      return `<div class="crb-settings"><div class="crb-message ${state.status === "failed" ? "crb-error" : ""}">${escapeHtml(message)}</div></div>`;
    }
    return `<div class="crb-settings">
      ${state.provider === "openox" ? `<label class="crb-field crb-field-wide"><span>Token</span><input class="crb-input" data-openox="token" type="password" value="" placeholder="${state.tokenConfigured ? "已配置，留空不修改" : "登录 Token"}" autocomplete="off"></label>` : state.provider === "owlai" ? "" : `<label class="crb-field crb-field-wide"><span>余额接口路径</span><input class="crb-input" data-config="usagePath" value="${escapeHtml(config.usagePath)}" placeholder="/v1/usage"></label>
      <label class="crb-field"><span>统计时区</span><input class="crb-input" data-config="timezone" value="${escapeHtml(config.timezone)}"></label>`}
      <label class="crb-field"><span>刷新间隔（分钟）</span><input class="crb-input" data-config="refreshMinutes" type="number" min="1" max="60" value="${config.refreshMinutes}"></label>
      <div class="crb-settings-actions">${state.provider === "openox" ? "" : `<button type="button" class="crb-button" data-action="reset">恢复默认</button>`}<button type="button" class="crb-button" data-action="save">保存并刷新</button></div>
    </div>`;
  }

  function renderPanel() {
    if (!panel) return;
    panel.hidden = !state.panelOpen;
    if (!state.panelOpen) return;
    // OpenOx 后端只能按天聚合，前端同样收窄为当天；其余 provider 保持原行为
    const isToday = state.provider === "owlai" || state.provider === "openox";
    const rangeLabel = state.provider === "openox"
      ? "今天（OpenOx 限定当天）"
      : isToday ? "今天（站点时区）" : `${config.rangeDays} 天`;
    const isOpenOx = state.provider === "openox";
    const body = state.status === "loading" && !state.bridgeReady
      ? '<div class="crb-message">正在连接用量插件…</div>'
      : state.status === "loading"
        ? '<div class="crb-message">正在读取用量…</div>'
        : state.status === "ok"
          ? state.provider === "openox" ? `${openoxSummaryHtml()}${openoxTablesHtml()}` : isToday ? todayHtml() : `${summaryHtml(state.models)}${tableHtml(state.models)}`
          : `<div class="crb-message ${state.status === "failed" ? "crb-error" : ""}">${escapeHtml(state.message || "暂无数据")}</div>`;
    const existingContent = panel.querySelector("[data-crb-content]");
    const settingsDomMatches = Boolean(panel.querySelector(".crb-settings")) === state.settingsOpen;
    if (state.status === "ok" && isOpenOx && existingContent && settingsDomMatches
      && existingContent.dataset.openoxStructure === openoxStructureSignature()) {
      updateOpenoxValues(existingContent);
      syncPanelControls(rangeLabel);
      applyPanelPosition();
      return;
    }
    if (state.settingsOpen && panel.querySelector(".crb-settings")) {
      const toolbar = panel.querySelector("[data-crb-toolbar]");
      const content = panel.querySelector("[data-crb-content]");
      if (toolbar) toolbar.innerHTML = toolbarHtml(isToday, rangeLabel);
      if (content) {
        content.innerHTML = body;
        if (isOpenOx && state.status === "ok") content.dataset.openoxStructure = openoxStructureSignature();
        else delete content.dataset.openoxStructure;
      }
      syncPanelControls(rangeLabel);
      applyPanelPosition();
      return;
    }
    panel.innerHTML = `
      <div class="crb-head ${isOpenOx ? "crb-head-openox" : ""}"><div><div class="crb-title">当前供应商用量</div><div class="crb-sub">${escapeHtml(state.profileName || "当前激活中转")}${isOpenOx ? ` · <span data-summary="keyCount">${numeric(state.openoxKeyCount)}</span> 个 KEY` : isToday ? " · 当前密钥" : state.planName ? ` · ${escapeHtml(state.planName)}` : ""}</div></div><div class="crb-actions">${isOpenOx ? openoxActionsHtml(rangeLabel) : `<button type="button" class="crb-button" data-action="settings" aria-expanded="${state.settingsOpen}">设置</button><button type="button" class="crb-button crb-icon" data-action="close" title="关闭" aria-label="关闭">×</button>`}</div></div>
      ${settingsHtml()}
      ${isOpenOx ? "" : `<div class="crb-toolbar" data-crb-toolbar>${toolbarHtml(isToday, rangeLabel)}</div>`}
      <div data-crb-content>${body}</div>`;
    const content = panel.querySelector("[data-crb-content]");
    if (content && isOpenOx && state.status === "ok") content.dataset.openoxStructure = openoxStructureSignature();
    applyPanelPosition();
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

  // 等待宿主把桥函数注入页面，不额外发送 settings 探针，避免冷启动重复 RPC。
  async function waitForBridge(timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (typeof window.__xuanPluginBridge?.["xuan-usage"] === "function") return true;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return typeof window.__xuanPluginBridge?.["xuan-usage"] === "function";
  }

  async function fetchUsage() {
    const ready = await waitForBridge(2500);
    if (!ready) {
      previousSnapshot = null;
      const timedOut = Date.now() - bridgeWaitStartedAt >= 15_000;
      return {
        status: timedOut ? "failed" : "loading",
        provider: "unknown",
        bridgeReady: false,
        message: timedOut ? "用量插件连接超时；仍会自动重试，也可重新打开任务" : "正在连接用量插件…",
        profileName: state.profileName || "",
        balance: null,
        unit: state.unit,
        unlimited: false,
        planName: "",
        models: [],
        speedPerHour: null,
        updatedAt: state.updatedAt || null,
        todayUsed: null,
        todayLimit: null,
        todayRemaining: null,
        periodLimit: null,
        periodUsed: null,
        periodRemaining: null,
        periodEnd: "",
        openoxKeyName: "",
        openoxKeys: [],
        openoxKeyCount: 0,
        tokenConfigured: false,
      };
    }
    bridgeWaitStartedAt = Date.now();
    state.bridgeReady = true;
    // 旧的自定义时区不应阻止 OwlAI 查询；通用方案仍在收到响应后校验。
    let range;
    let rangeError;
    try { range = dateRange(config.rangeDays); } catch (error) { rangeError = error; }
    const settings = await callBridge("/relay-balance/settings", {});
    if (!settings || settings.status === "failed") throw new Error(settings?.message || "读取用量设置失败");
    if (settings.disabled) return { status: "disabled", message: settings.message || "当前中转不支持余额查询", profileName: settings.profileName || "", provider: settings.provider || "generic", bridgeReady: true };
    if (settings.provider === "openox" && !settings.tokenConfigured) {
      previousSnapshot = null;
      return {
        status: "disabled", provider: "openox", profileName: settings.profileName || "",
        openoxKeyName: settings.keyName || "", openoxKeys: [], openoxKeyCount: 0, tokenConfigured: Boolean(settings.tokenConfigured),
        message: "请在设置中填写 OpenOx Token",
      };
    }
    // OpenOx 站点只允许按天聚合，强制按当天查询，给后端 start_date=end_date=今天
    if (settings.provider === "openox") {
      range = dateRange(1);
    }
    const result = await callBridge("/relay-balance/query", {
      usagePath: config.usagePath,
      timezone: config.timezone,
      ...range,
    });
    if (result?.status === "failed" && ["owlai", "openox"].includes(result.provider)) {
      previousSnapshot = null;
      return { status: "failed", provider: result.provider, openoxKeyName: settings.keyName || "", openoxKeys: [], openoxKeyCount: 0, tokenConfigured: Boolean(settings.tokenConfigured), todayUsed: null, balance: null, planName: "", models: [], speedPerHour: null, updatedAt: null, profileName: result.profileName || "", message: result.message || "今日用量查询失败" };
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
      const toModels = (list) => Array.isArray(list) ? list.map((item) => ({
        model: safeText(item?.model || "未知模型"),
        requests: numeric(item?.requests),
        requestTime: safeText(item?.requestTime),
        inputTokens: numeric(item?.inputTokens),
        outputTokens: numeric(item?.outputTokens),
        cacheCreationTokens: numeric(item?.cacheCreationTokens),
        cacheWriteTokens: numeric(item?.cacheWriteTokens),
        cacheReadTokens: numeric(item?.cacheReadTokens),
        totalTokens: numeric(item?.totalTokens),
        cost: numeric(item?.cost),
        actualCost: numeric(item?.actualCost ?? item?.cost),
      })) : [];
      // 每个 KEY 一组明细；models 是后端合并后的总合计（所有 KEY 共用额度）
      const openoxKeys = Array.isArray(payload.keys)
        ? payload.keys.map((item) => ({ keyName: safeText(item?.keyName || "未知 KEY"), models: toModels(item?.models) }))
        : [];
      return {
        status: "ok", provider: "openox", message: "已更新",
        profileName: result.profileName || "", planName: safeText(payload.planName), unit: payload.unit || "USD",
        openoxKeyName: safeText(payload.keyName || settings.keyName), tokenConfigured: true,
        todayLimit: payload.today?.limit, todayUsed: payload.today?.used, todayRemaining: payload.today?.remaining,
        periodLimit: payload.period?.limit, periodUsed: payload.period?.used, periodRemaining: payload.period?.remaining,
        periodEnd: safeText(payload.period?.end),
        models: toModels(payload.models), openoxKeys, openoxKeyCount: numeric(payload.keyCount ?? openoxKeys.length),
        speedPerHour: null, updatedAt: new Date(),
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
    setState(state.status === "ok"
      ? { refreshing: true }
      : { refreshing: true, status: "loading", message: "正在读取用量" });
    // 默认按配置间隔；桥未就绪 / 失败 / 禁用时由本次结果自适应收缩
    let nextRetryMs = config.refreshMinutes * 60_000;
    const request = fetchUsage()
      .then((next) => {
        if (!destroyed && revision === configRevision) setState(next);
        if (next?.bridgeReady === false) nextRetryMs = 500;
        else if (next?.status === "ok") nextRetryMs = config.refreshMinutes * 60_000;
        else if (next?.status === "failed" || next?.status === "disabled") nextRetryMs = 30_000;
        else nextRetryMs = config.refreshMinutes * 60_000;
        return next;
      })
      .catch((error) => {
        if (!destroyed && revision === configRevision) setState({ status: "failed", bridgeReady: state.bridgeReady, balance: null, todayUsed: null, message: error?.message || "用量查询失败，请检查用量方案和统计时区" });
        // 桥一直就绪但调用栈崩溃：30s 后重试，避免对供应商施压
        nextRetryMs = state.bridgeReady ? 30_000 : 3000;
        return null;
      })
      .finally(() => {
        if (requestPromise === request) requestPromise = null;
        if (!destroyed) setState({ refreshing: false });
        if (!destroyed && revision !== configRevision) {
          previousSnapshot = null;
          void refresh(true);
        } else schedule(nextRetryMs);
      });
    requestPromise = request;
    return request;
  }

  function schedule(delayMs) {
    window.clearTimeout(timer);
    if (destroyed) return;
    const ms = Number.isFinite(delayMs) ? delayMs : config.refreshMinutes * 60_000;
    timer = window.setTimeout(() => void refresh(true), ms);
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

  function toggleUsageRow(row) {
    const rowKey = row?.dataset?.usageRowKey;
    if (!rowKey) return;
    if (excludedRows.has(rowKey)) excludedRows.delete(rowKey);
    else excludedRows.add(rowKey);
    render();
  }

  function onPanelDoubleClick(event) {
    const row = event.target?.closest?.("tr[data-usage-row-key]");
    if (!row || !panel.contains(row)) return;
    toggleUsageRow(row);
    event.preventDefault();
  }

  function onPanelKeyDown(event) {
    if (!["Enter", " "].includes(event.key)) return;
    const row = event.target?.closest?.("tr[data-usage-row-key]");
    if (!row || !panel.contains(row)) return;
    toggleUsageRow(row);
    event.preventDefault();
  }

  async function saveOpenOxSettings() {
    // KEY 名称已废弃（所有 KEY 统一统计），只需保存 Token
    const token = panel.querySelector('[data-openox="token"]')?.value?.trim() || "";
    setState({ status: "loading", message: "正在保存 OpenOx 设置" });
    try {
      const result = await callBridge("/relay-balance/settings/set", { token });
      if (!result || result.status === "failed") throw new Error(result?.message || "OpenOx 设置保存失败");
      previousSnapshot = null;
      setState({
        settingsOpen: false,
        provider: "openox",
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
    watchChrome();
    if (missing) render();
  }

  function scheduleEnsure(delayMs = ENSURE_DEBOUNCE_MS) {
    if (destroyed || ensureTimer) return;
    ensureTimer = window.setTimeout(() => {
      ensureTimer = 0;
      try { ensure(); } catch (_) { destroy(); }
    }, delayMs);
  }

  function watchChrome() {
    const header = findHeader();
    if (header === observedHeader && (observer || bootstrapObserver)) return;
    observer?.disconnect();
    headerHostObserver?.disconnect();
    bootstrapObserver?.disconnect();
    observer = null;
    headerHostObserver = null;
    bootstrapObserver = null;
    observedHeader = header;
    if (!header) {
      const body = document.body;
      if (body) {
        bootstrapObserver = new MutationObserver(() => scheduleEnsure(0));
        // 顶部栏可能稍后挂到已有外壳中；找到后立即切换到局部观察。
        bootstrapObserver.observe(body, { childList: true, subtree: true });
      }
      return;
    }
    observer = new MutationObserver(() => scheduleEnsure());
    observer.observe(header, { childList: true, subtree: true });
    const host = header.parentElement;
    if (host) {
      headerHostObserver = new MutationObserver(() => {
        if (findHeader() !== observedHeader) scheduleEnsure(0);
      });
      for (let ancestor = host; ancestor; ancestor = ancestor.parentElement) {
        headerHostObserver.observe(ancestor, { childList: true });
      }
    }
  }

  function destroy() {
    destroyed = true;
    document.removeEventListener("DOMContentLoaded", start);
    window.removeEventListener("resize", applyPanelPosition);
    window.clearTimeout(timer);
    window.clearTimeout(ensureTimer);
    observer?.disconnect();
    headerHostObserver?.disconnect();
    bootstrapObserver?.disconnect();
    observedHeader = null;
    root?.remove();
    panel?.remove();
    document.getElementById(STYLE_ID)?.remove();
    if (window[API_KEY]?.revision === REVISION) delete window[API_KEY];
  }

  window[API_KEY] = { revision: REVISION, ensure, refresh, destroy };
  if (window.__codexPlusUserScripts?.currentKey) window.__codexPlusUserScripts.registerCleanup?.(destroy);
  const start = () => {
    if (destroyed) return;
    ensure();
    window.addEventListener("resize", applyPanelPosition);
    void refresh(true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
