/* Built-in relay usage monitor, adapted from Codex Relay Balance in CodexPlusPlusScriptMarket. */
(() => {
  const API_KEY = "__codexPlusRelayBalance";
  const REVISION = "builtin-2026-09-04-v1";
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
  let config = loadConfig();
  let state = {
    status: "loading",
    message: "正在读取余额",
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
  }

  function dateRange(days) {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - Math.max(0, days - 1));
    const format = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };
    return { startDate: format(start), endDate: format(end) };
  }

  function formatMoney(value, unit = "USD") {
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

  function parseBalance(payload) {
    const quota = payload?.quota && typeof payload.quota === "object" ? payload.quota : {};
    const raw = payload?.balance ?? payload?.remaining ?? quota.remaining;
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
        inputTokens: sum.inputTokens + item.inputTokens,
        cacheCreationTokens: sum.cacheCreationTokens + item.cacheCreationTokens,
        cacheReadTokens: sum.cacheReadTokens + item.cacheReadTokens,
        outputTokens: sum.outputTokens + item.outputTokens,
        totalTokens: sum.totalTokens + item.totalTokens,
        cost: sum.cost + item.cost,
        actualCost: sum.actualCost + item.actualCost,
      }),
      { requests: 0, inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, actualCost: 0 },
    );
  }

  function calculateSpeed(models, observedAt) {
    const actualCost = totals(models).actualCost;
    let speedPerHour = null;
    if (previousSnapshot && observedAt > previousSnapshot.observedAt && actualCost >= previousSnapshot.actualCost) {
      const hours = (observedAt - previousSnapshot.observedAt) / 3_600_000;
      const delta = actualCost - previousSnapshot.actualCost;
      if (hours > 0 && delta > 0) speedPerHour = delta / hours;
    }
    previousSnapshot = { actualCost, observedAt };
    return speedPerHour;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID}{position:fixed;z-index:2147482400;top:12px;right:92px;height:30px;padding:0 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:6px;background:color-mix(in srgb,Canvas 92%,transparent);color:CanvasText;font:600 12px/28px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.12);cursor:pointer;white-space:nowrap}
      #${ROOT_ID}:hover,#${ROOT_ID}[data-open="true"]{background:color-mix(in srgb,CanvasText 9%,Canvas)}
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
      @media(max-width:720px){#${ROOT_ID}{top:8px;right:52px}.crb-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.crb-settings{grid-template-columns:1fr}.crb-field-wide,.crb-settings-actions{grid-column:auto}.crb-table th{top:59px}}
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
  }

  function badgeText() {
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
        <div class="crb-stat"><span>实际扣费</span><strong>${escapeHtml(formatMoney(sum.actualCost, state.unit))}</strong></div>
        <div class="crb-stat"><span>实际倍率</span><strong>${multiplier == null ? "--" : `${multiplier.toFixed(2)}×`}</strong></div>
        <div class="crb-stat"><span>刷新间消耗速度</span><strong>${escapeHtml(speed)}</strong></div>
      </div>`;
  }

  function tableHtml(models) {
    if (!models.length) return '<div class="crb-message">接口未返回 model_stats 模型统计。</div>';
    const sum = totals(models);
    const row = (item, className = "") => `<tr class="${className}">
      <td title="${escapeHtml(item.model || "合计")}">${escapeHtml(item.model || "合计")}</td>
      <td>${Math.round(item.requests)}</td><td>${formatTokens(item.inputTokens)}</td><td>${formatTokens(item.cacheCreationTokens)}</td><td>${formatTokens(item.cacheReadTokens)}</td><td>${formatTokens(item.outputTokens)}</td><td>${formatTokens(item.totalTokens)}</td><td>${escapeHtml(formatMoney(item.cost, state.unit))}</td><td>${escapeHtml(formatMoney(item.actualCost, state.unit))}</td><td>${item.multiplier == null ? "--" : `${item.multiplier.toFixed(2)}×`}</td>
    </tr>`;
    return `<div class="crb-table-wrap"><table class="crb-table"><thead><tr><th>模型</th><th>请求</th><th>输入</th><th>缓存写入</th><th>缓存读取</th><th>输出</th><th>总 Token</th><th>标价</th><th>实际扣费</th><th>倍率</th></tr></thead><tbody>${models.map((item) => row(item)).join("")}${row({ ...sum, model: "合计", multiplier: sum.cost > 0 ? sum.actualCost / sum.cost : null }, "crb-total")}</tbody></table></div>`;
  }

  function settingsHtml() {
    if (!state.settingsOpen) return "";
    return `<div class="crb-settings">
      <label class="crb-field crb-field-wide"><span>余额接口路径</span><input class="crb-input" data-config="usagePath" value="${escapeHtml(config.usagePath)}" placeholder="/v1/usage"></label>
      <label class="crb-field"><span>统计时区</span><input class="crb-input" data-config="timezone" value="${escapeHtml(config.timezone)}"></label>
      <label class="crb-field"><span>刷新间隔（分钟）</span><input class="crb-input" data-config="refreshMinutes" type="number" min="1" max="60" value="${config.refreshMinutes}"></label>
      <div class="crb-settings-actions"><button type="button" class="crb-button" data-action="reset">恢复默认</button><button type="button" class="crb-button" data-action="save">保存并刷新</button></div>
    </div>`;
  }

  function renderPanel() {
    if (!panel) return;
    panel.hidden = !state.panelOpen;
    if (!state.panelOpen) return;
    const rangeLabel = `${config.rangeDays} 天`;
    const body = state.status === "loading"
      ? '<div class="crb-message">正在读取中转余额与模型用量…</div>'
      : state.status === "ok"
        ? `${summaryHtml(state.models)}${tableHtml(state.models)}`
        : `<div class="crb-message ${state.status === "failed" ? "crb-error" : ""}">${escapeHtml(state.message || "暂无数据")}</div>`;
    panel.innerHTML = `
      <div class="crb-head"><div><div class="crb-title">中转余额</div><div class="crb-sub">${escapeHtml(state.profileName || "当前激活中转")}${state.planName ? ` · ${escapeHtml(state.planName)}` : ""}</div></div><div class="crb-actions"><button type="button" class="crb-button" data-action="settings">设置</button><button type="button" class="crb-button crb-icon" data-action="close" title="关闭" aria-label="关闭">×</button></div></div>
      ${settingsHtml()}
      <div class="crb-toolbar"><select class="crb-select" data-action="range" aria-label="统计范围"><option value="1" ${config.rangeDays === 1 ? "selected" : ""}>今天</option><option value="7" ${config.rangeDays === 7 ? "selected" : ""}>最近 7 天</option><option value="30" ${config.rangeDays === 30 ? "selected" : ""}>最近 30 天</option><option value="90" ${config.rangeDays === 90 ? "selected" : ""}>最近 90 天</option></select><button type="button" class="crb-button" data-action="refresh">刷新</button><span class="crb-muted">${state.updatedAt ? `更新于 ${state.updatedAt.toLocaleTimeString()} · ${rangeLabel}` : rangeLabel}</span></div>
      ${body}`;
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
    if (typeof window.__codexSessionDeleteBridge !== "function") {
      return Promise.reject(new Error("轩++ 后端桥接不可用，请重启轩++"));
    }
    return Promise.race([
      window.__codexSessionDeleteBridge(path, payload),
      new Promise((_, reject) => setTimeout(() => reject(new Error("余额请求超时")), 20_000)),
    ]);
  }

  async function fetchUsage() {
    const range = dateRange(config.rangeDays);
    const result = await callBridge("/relay-balance/query", {
      usagePath: config.usagePath,
      timezone: config.timezone,
      ...range,
    });
    if (!result || result.status === "failed") throw new Error(result?.message || "余额请求失败");
    if (result.disabled) return { status: "disabled", message: result.message || "当前中转不支持余额查询", profileName: result.profileName || "" };
    const balance = parseBalance(result.data || {});
    const models = parseModels(result.data || {});
    const observedAt = Date.now();
    return {
      status: "ok",
      message: "已更新",
      profileName: result.profileName || "",
      models,
      speedPerHour: calculateSpeed(models, observedAt),
      updatedAt: new Date(observedAt),
      ...balance,
    };
  }

  async function refresh(force = false) {
    if (destroyed) return null;
    if (requestPromise) return requestPromise;
    setState({ status: "loading", message: "正在读取余额" });
    const request = fetchUsage()
      .then((next) => {
        setState(next);
        return next;
      })
      .catch((error) => {
        setState({ status: "failed", balance: null, message: error?.message || String(error) });
        return null;
      })
      .finally(() => {
        if (requestPromise === request) requestPromise = null;
        schedule();
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
      setState({ settingsOpen: true });
    }
    if (action === "save") {
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
    window.clearTimeout(timer);
    observer?.disconnect();
    root?.remove();
    panel?.remove();
    document.getElementById(STYLE_ID)?.remove();
    if (window[API_KEY]?.revision === REVISION) delete window[API_KEY];
  }

  window[API_KEY] = { revision: REVISION, ensure, refresh, destroy };
  const start = () => {
    ensure();
    observer = new MutationObserver(() => ensure());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    void refresh(true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
