(() => {
  const API_KEY = "__codexPlusWorkspaceSearch";
  const ROOT_ID = "codex-plus-workspace-search";
  const STYLE_ID = `${ROOT_ID}-style`;
  const BUTTON_CLASS = `${ROOT_ID}-button`;
  const POLL_INTERVAL_MS = 80;
  const SEARCH_DEBOUNCE_MS = 250;

  try {
    window[API_KEY]?.cleanup?.();
  } catch (_) {}
  if (window.top !== window || window.self !== window || !window.electronBridge || !/^app:\/\/-\//i.test(window.location.href)) return;

  const state = {
    root: null,
    query: null,
    include: null,
    exclude: null,
    caseSensitive: null,
    wholeWord: null,
    regex: null,
    status: null,
    stop: null,
    results: null,
    preview: null,
    rootList: null,
    searchId: "",
    searchRevision: 0,
    debounceTimer: 0,
    pollTimer: 0,
    observer: null,
    previousFocus: null,
  };

  function bridgeCall(path, payload = {}) {
    if (typeof window.__codexSessionDeleteBridge !== "function") {
      return Promise.resolve({ status: "failed", message: "搜索桥接不可用，请重启轩++" });
    }
    return Promise.resolve(window.__codexSessionDeleteBridge(path, payload)).catch((error) => ({
      status: "failed",
      message: error?.message || String(error),
    }));
  }

  function absoluteLocalPath(value) {
    const path = String(value || "").trim();
    if (!path || path.includes("\0") || path.includes("://")) return "";
    if (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path) || path.startsWith("/")) return path;
    return "";
  }

  function reactKeys(element) {
    return Object.keys(element || {}).filter((key) => key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance") || key.startsWith("__reactProps"));
  }

  function workspacePathFromObject(source) {
    if (!source || typeof source !== "object") return "";
    for (const key of ["cwd", "workspaceRoot", "rootPath", "workingDirectory", "workingDir", "displayCwd"]) {
      const path = absoluteLocalPath(source[key]);
      if (path && !/[\\/]\.codex$/i.test(path)) return path;
    }
    return "";
  }

  function walkObject(root, visitor) {
    const visited = new WeakSet();
    const stack = [{ value: root, depth: 0 }];
    let scanned = 0;
    while (stack.length && scanned < 360) {
      const { value, depth } = stack.pop();
      if (!value || typeof value !== "object" || visited.has(value) || depth > 9) continue;
      visited.add(value);
      scanned += 1;
      const result = visitor(value);
      if (result) return result;
      if (value instanceof Element || value === window || value === document) continue;
      for (const key of Object.keys(value).slice(0, 90)) {
        if (["ownerDocument", "parentElement", "parentNode", "children", "childNodes"].includes(key)) continue;
        try {
          const child = value[key];
          if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
        } catch (_) {}
      }
    }
    return "";
  }

  function workspacePathFromElement(element) {
    for (const key of reactKeys(element)) {
      const path = walkObject(element[key], workspacePathFromObject);
      if (path) return path;
    }
    return "";
  }

  function currentWorkspacePath() {
    const activeRow = document.querySelector(
      '[data-app-action-sidebar-thread-active="true"], [data-app-action-sidebar-thread-id][aria-current="page"], [data-app-action-sidebar-thread-id][aria-current="true"]',
    );
    for (let node = activeRow; node && node !== document.body; node = node.parentElement) {
      const path = workspacePathFromElement(node);
      if (path) return path;
    }
    for (const selector of ["[data-workspace-root]", "[data-cwd]", "[data-root-path]"]) {
      const node = document.querySelector(selector);
      const path = absoluteLocalPath(node?.dataset?.workspaceRoot || node?.dataset?.cwd || node?.dataset?.rootPath);
      if (path) return path;
    }
    const remembered = Array.isArray(window.__codexPluginMarketplaceLastCwds)
      ? window.__codexPluginMarketplaceLastCwds.map(absoluteLocalPath).filter(Boolean)
      : [];
    return remembered[0] || "";
  }

  function uniqueRoots(values) {
    const seen = new Set();
    return values.filter((value) => {
      const path = absoluteLocalPath(value);
      if (!path) return false;
      const key = path.replace(/[\\/]+$/, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} { position: fixed; inset: 0; z-index: 2147483100; display: grid; place-items: center; background: rgba(15, 18, 22, .38); color: var(--color-token-text-primary, #20242a); font: 13px/1.45 system-ui, sans-serif; }
      #${ROOT_ID}[hidden] { display: none; }
      #${ROOT_ID} * { box-sizing: border-box; letter-spacing: 0; }
      #${ROOT_ID} .ws-dialog { width: min(1040px, calc(100vw - 32px)); height: min(760px, calc(100vh - 32px)); display: grid; grid-template-rows: auto auto minmax(0, 1fr); overflow: hidden; border: 1px solid var(--color-token-border-default, #c9cdd3); border-radius: 8px; background: var(--color-token-bg-primary, #fff); box-shadow: 0 18px 55px rgba(0, 0, 0, .24); }
      #${ROOT_ID} .ws-head { min-height: 48px; display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--color-token-border-light, #e1e4e8); }
      #${ROOT_ID} .ws-head strong { font-size: 14px; }
      #${ROOT_ID} .ws-head small { min-width: 0; overflow: hidden; color: var(--color-token-text-secondary, #69707a); text-overflow: ellipsis; white-space: nowrap; }
      #${ROOT_ID} .ws-head .ws-spacer { flex: 1; }
      #${ROOT_ID} button { color: inherit; font: inherit; }
      #${ROOT_ID} .ws-icon-button { width: 30px; height: 30px; display: inline-grid; place-items: center; border: 1px solid transparent; border-radius: 5px; background: transparent; cursor: pointer; }
      #${ROOT_ID} .ws-icon-button:hover { border-color: var(--color-token-border-default, #c9cdd3); background: var(--color-token-bg-secondary, #f4f5f7); }
      #${ROOT_ID} .ws-action-button { height: 30px; padding: 0 9px; border: 1px solid var(--color-token-border-default, #c9cdd3); border-radius: 5px; background: var(--color-token-bg-primary, #fff); cursor: pointer; }
      #${ROOT_ID} .ws-action-button:hover { background: var(--color-token-bg-secondary, #f4f5f7); }
      #${ROOT_ID} .ws-form { display: grid; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--color-token-border-light, #e1e4e8); background: var(--color-token-bg-secondary, #f8f9fa); }
      #${ROOT_ID} .ws-query-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 6px; }
      #${ROOT_ID} input { min-width: 0; height: 34px; padding: 6px 9px; border: 1px solid var(--color-token-border-default, #c9cdd3); border-radius: 5px; outline: none; background: var(--color-token-bg-primary, #fff); color: inherit; font: inherit; }
      #${ROOT_ID} input:focus { border-color: #2878bd; box-shadow: 0 0 0 1px #2878bd; }
      #${ROOT_ID} .ws-option { min-width: 36px; height: 34px; border: 1px solid var(--color-token-border-default, #c9cdd3); border-radius: 5px; background: var(--color-token-bg-primary, #fff); cursor: pointer; }
      #${ROOT_ID} .ws-option[aria-pressed="true"] { border-color: #2878bd; background: #e8f2fb; color: #155c95; }
      #${ROOT_ID} .ws-filter-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
      #${ROOT_ID} .ws-body { min-height: 0; display: grid; grid-template-columns: minmax(300px, 46%) minmax(0, 54%); }
      #${ROOT_ID} .ws-results, #${ROOT_ID} .ws-preview { min-height: 0; overflow: auto; }
      #${ROOT_ID} .ws-results { border-right: 1px solid var(--color-token-border-light, #e1e4e8); }
      #${ROOT_ID} .ws-empty { padding: 28px 18px; color: var(--color-token-text-secondary, #69707a); text-align: center; }
      #${ROOT_ID} .ws-file { border-bottom: 1px solid var(--color-token-border-light, #e1e4e8); }
      #${ROOT_ID} .ws-file-head { position: sticky; top: 0; z-index: 1; width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 0; background: var(--color-token-bg-secondary, #f5f6f7); text-align: left; cursor: pointer; }
      #${ROOT_ID} .ws-file-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${ROOT_ID} .ws-count { margin-left: auto; color: var(--color-token-text-secondary, #69707a); font-variant-numeric: tabular-nums; }
      #${ROOT_ID} .ws-match { width: 100%; display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; padding: 5px 10px; border: 0; background: transparent; text-align: left; cursor: pointer; }
      #${ROOT_ID} .ws-match:hover, #${ROOT_ID} .ws-match.is-selected { background: #edf5fb; }
      #${ROOT_ID} .ws-line-number { color: var(--color-token-text-secondary, #69707a); text-align: right; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
      #${ROOT_ID} .ws-line-text { min-width: 0; overflow: hidden; color: var(--color-token-text-primary, #20242a); font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: pre; }
      #${ROOT_ID} mark { border-radius: 2px; background: #ffe58a; color: #1b1d20; }
      #${ROOT_ID} .ws-preview-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 7px 10px; border-bottom: 1px solid var(--color-token-border-light, #e1e4e8); background: var(--color-token-bg-primary, #fff); }
      #${ROOT_ID} .ws-preview-head span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${ROOT_ID} .ws-preview-code { min-width: max-content; padding: 8px 0; }
      #${ROOT_ID} .ws-preview-line { display: grid; grid-template-columns: 58px minmax(0, 1fr); min-height: 23px; padding: 2px 12px 2px 0; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
      #${ROOT_ID} .ws-preview-line.is-target { background: #fff5c2; }
      #${ROOT_ID} .ws-preview-line span:first-child { padding-right: 12px; color: var(--color-token-text-secondary, #69707a); text-align: right; user-select: none; }
      #${ROOT_ID} .ws-preview-line code { white-space: pre; }
      .${BUTTON_CLASS} { height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 9px; border: 1px solid var(--color-token-border-light, rgba(127,127,127,.25)); border-radius: 5px; background: transparent; color: inherit; font: 12px/1 system-ui, sans-serif; cursor: pointer; }
      .${BUTTON_CLASS}:hover { background: var(--color-token-bg-secondary, rgba(127,127,127,.1)); }
      @media (max-width: 720px) { #${ROOT_ID} .ws-dialog { width: 100vw; height: 100vh; border: 0; border-radius: 0; } #${ROOT_ID} .ws-body { grid-template-columns: 1fr; } #${ROOT_ID} .ws-preview { display: none; } #${ROOT_ID} .ws-results { border-right: 0; } #${ROOT_ID} .ws-filter-row { grid-template-columns: 1fr; } }
    `;
    document.head.appendChild(style);
  }

  function createRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    ensureStyles();
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "工作区全文搜索");
    root.innerHTML = `
      <div class="ws-dialog">
        <div class="ws-head"><strong>工作区全文搜索</strong><small data-ws-status>Ctrl+Shift+F</small><span class="ws-spacer"></span><button class="ws-action-button" data-ws-stop type="button" hidden>停止</button><button class="ws-icon-button" data-ws-close type="button" title="关闭" aria-label="关闭">×</button></div>
        <div class="ws-form">
          <input data-ws-root list="${ROOT_ID}-roots" aria-label="工作区路径" placeholder="工作区绝对路径" spellcheck="false"><datalist id="${ROOT_ID}-roots"></datalist>
          <div class="ws-query-row"><input data-ws-query aria-label="搜索内容" placeholder="搜索" spellcheck="false"><button class="ws-option" data-ws-case type="button" aria-pressed="false" title="区分大小写">Aa</button><button class="ws-option" data-ws-word type="button" aria-pressed="false" title="全字匹配">ab</button><button class="ws-option" data-ws-regex type="button" aria-pressed="false" title="使用正则表达式">.*</button></div>
          <div class="ws-filter-row"><input data-ws-include aria-label="包含文件" placeholder="包含文件，例如 src/**, *.rs" spellcheck="false"><input data-ws-exclude aria-label="排除文件" placeholder="排除文件，例如 target/**, *.lock" spellcheck="false"></div>
        </div>
        <div class="ws-body"><div class="ws-results" data-ws-results><div class="ws-empty">输入内容以搜索当前工作区</div></div><div class="ws-preview" data-ws-preview><div class="ws-empty">选择搜索结果以预览</div></div></div>
      </div>`;
    document.body.appendChild(root);
    state.root = root;
    state.query = root.querySelector("[data-ws-query]");
    state.include = root.querySelector("[data-ws-include]");
    state.exclude = root.querySelector("[data-ws-exclude]");
    state.caseSensitive = root.querySelector("[data-ws-case]");
    state.wholeWord = root.querySelector("[data-ws-word]");
    state.regex = root.querySelector("[data-ws-regex]");
    state.status = root.querySelector("[data-ws-status]");
    state.stop = root.querySelector("[data-ws-stop]");
    state.results = root.querySelector("[data-ws-results]");
    state.preview = root.querySelector("[data-ws-preview]");
    state.rootList = root.querySelector(`#${ROOT_ID}-roots`);
    const rootInput = root.querySelector("[data-ws-root]");

    root.querySelector("[data-ws-close]").addEventListener("click", close);
    state.stop.addEventListener("click", stopSearch);
    root.addEventListener("mousedown", (event) => { if (event.target === root) close(); });
    [state.query, state.include, state.exclude, rootInput].forEach((input) => input.addEventListener("input", scheduleSearch));
    state.query.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        startSearch();
      }
    });
    [state.caseSensitive, state.wholeWord, state.regex].forEach((button) => button.addEventListener("click", () => {
      button.setAttribute("aria-pressed", button.getAttribute("aria-pressed") !== "true" ? "true" : "false");
      startSearch();
    }));
    return root;
  }

  function setStatus(message) {
    if (state.status) state.status.textContent = message;
  }

  function setSearching(active) {
    if (state.stop) state.stop.hidden = !active;
  }

  function parseGlobs(value) {
    return String(value || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 32);
  }

  async function cancelActiveSearch() {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = 0;
    const searchId = state.searchId;
    state.searchId = "";
    if (searchId) await bridgeCall("/workspace-search/cancel", { searchId });
    setSearching(false);
  }

  async function stopSearch() {
    state.searchRevision += 1;
    await cancelActiveSearch();
    setStatus("已取消");
    renderEmpty("搜索已取消");
  }

  function scheduleSearch() {
    window.clearTimeout(state.debounceTimer);
    state.debounceTimer = window.setTimeout(startSearch, SEARCH_DEBOUNCE_MS);
  }

  async function startSearch() {
    window.clearTimeout(state.debounceTimer);
    const rootInput = state.root?.querySelector("[data-ws-root]");
    const root = absoluteLocalPath(rootInput?.value);
    const query = state.query?.value.trim() || "";
    const revision = ++state.searchRevision;
    await cancelActiveSearch();
    if (revision !== state.searchRevision) return;
    if (!query) {
      renderEmpty("输入内容以搜索当前工作区");
      setStatus("Ctrl+Shift+F");
      return;
    }
    if (!root) {
      renderEmpty("请选择有效的工作区绝对路径");
      setStatus("缺少工作区");
      return;
    }
    setStatus("正在搜索…");
    setSearching(true);
    renderEmpty("正在搜索…");
    const response = await bridgeCall("/workspace-search/start", {
      root,
      query,
      caseSensitive: state.caseSensitive?.getAttribute("aria-pressed") === "true",
      wholeWord: state.wholeWord?.getAttribute("aria-pressed") === "true",
      regex: state.regex?.getAttribute("aria-pressed") === "true",
      include: parseGlobs(state.include?.value),
      exclude: parseGlobs(state.exclude?.value),
      maxResults: 2000,
    });
    if (revision !== state.searchRevision) return;
    if (response?.status !== "ok" || !response.searchId) {
      renderEmpty(response?.message || "搜索启动失败");
      setStatus("搜索失败");
      setSearching(false);
      return;
    }
    state.searchId = response.searchId;
    pollSearch(response.searchId, revision);
  }

  async function pollSearch(searchId, revision) {
    if (state.searchId !== searchId || state.searchRevision !== revision) return;
    const response = await bridgeCall("/workspace-search/poll", { searchId });
    if (state.searchId !== searchId || state.searchRevision !== revision) return;
    if (response?.status === "running") {
      state.pollTimer = window.setTimeout(() => pollSearch(searchId, revision), POLL_INTERVAL_MS);
      return;
    }
    state.searchId = "";
    setSearching(false);
    if (response?.status !== "ok") {
      if (response?.status !== "cancelled") renderEmpty(response?.message || "搜索失败");
      setStatus(response?.status === "cancelled" ? "已取消" : "搜索失败");
      return;
    }
    renderResults(response.results || [], response.root || "");
    const suffix = response.truncated ? "，结果已截断" : "";
    setStatus(`${response.results?.length || 0} 个结果，${response.elapsedMs || 0} ms${suffix}`);
  }

  function renderEmpty(message) {
    state.results.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "ws-empty";
    empty.textContent = message;
    state.results.appendChild(empty);
  }

  function appendHighlightedText(target, text, ranges) {
    const characters = Array.from(String(text || ""));
    let cursor = 0;
    for (const range of Array.isArray(ranges) ? ranges : []) {
      const start = Math.max(cursor, Math.min(characters.length, Number(range.start) || 0));
      const end = Math.max(start, Math.min(characters.length, Number(range.end) || start));
      if (start > cursor) target.appendChild(document.createTextNode(characters.slice(cursor, start).join("")));
      const mark = document.createElement("mark");
      mark.textContent = characters.slice(start, end).join("");
      target.appendChild(mark);
      cursor = end;
    }
    if (cursor < characters.length) target.appendChild(document.createTextNode(characters.slice(cursor).join("")));
  }

  function renderResults(results, root) {
    state.results.replaceChildren();
    state.preview.innerHTML = '<div class="ws-empty">选择搜索结果以预览</div>';
    if (!results.length) {
      renderEmpty("未找到匹配内容");
      return;
    }
    const groups = new Map();
    for (const result of results) {
      const key = String(result.relativePath || result.path || "");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(result);
    }
    for (const [path, matches] of groups) {
      const section = document.createElement("section");
      section.className = "ws-file";
      const head = document.createElement("button");
      head.className = "ws-file-head";
      head.type = "button";
      head.title = path;
      const label = document.createElement("strong");
      label.textContent = path;
      const count = document.createElement("span");
      count.className = "ws-count";
      count.textContent = String(matches.length);
      head.append(label, count);
      const body = document.createElement("div");
      head.addEventListener("click", () => { body.hidden = !body.hidden; });
      for (const match of matches) {
        const button = document.createElement("button");
        button.className = "ws-match";
        button.type = "button";
        const number = document.createElement("span");
        number.className = "ws-line-number";
        number.textContent = String(match.line || "");
        const text = document.createElement("span");
        text.className = "ws-line-text";
        appendHighlightedText(text, match.text, match.ranges);
        button.append(number, text);
        button.addEventListener("click", () => {
          state.results.querySelectorAll(".ws-match.is-selected").forEach((node) => node.classList.remove("is-selected"));
          button.classList.add("is-selected");
          loadPreview(root, match);
        });
        button.addEventListener("dblclick", () => openFile(match));
        body.appendChild(button);
      }
      section.append(head, body);
      state.results.appendChild(section);
    }
  }

  async function loadPreview(root, match) {
    state.preview.innerHTML = '<div class="ws-empty">正在载入预览…</div>';
    const response = await bridgeCall("/workspace-search/preview", { root, path: match.path, line: match.line });
    if (response?.status !== "ok") {
      state.preview.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "ws-empty";
      empty.textContent = response?.message || "无法预览文件";
      state.preview.appendChild(empty);
      return;
    }
    state.preview.replaceChildren();
    const head = document.createElement("div");
    head.className = "ws-preview-head";
    const label = document.createElement("span");
    label.textContent = `${response.path}:${match.line}`;
    label.title = response.path;
    const open = document.createElement("button");
    open.className = "ws-icon-button";
    open.type = "button";
    open.textContent = "↗";
    open.title = "在 Codex 中打开";
    open.setAttribute("aria-label", "在 Codex 中打开");
    open.addEventListener("click", () => openFile(match));
    head.append(label, open);
    const code = document.createElement("div");
    code.className = "ws-preview-code";
    for (const item of response.lines || []) {
      const row = document.createElement("div");
      row.className = `ws-preview-line${Number(item.number) === Number(match.line) ? " is-target" : ""}`;
      const number = document.createElement("span");
      number.textContent = String(item.number);
      const text = document.createElement("code");
      text.textContent = String(item.text || "");
      row.append(number, text);
      code.appendChild(row);
    }
    state.preview.append(head, code);
  }

  function callCodexApi(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `workspace-search-${Date.now()}-${Math.random()}`;
      const cleanup = () => {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      };
      const onMessage = (event) => {
        const message = event?.data;
        if (!message || message.type !== "fetch-response" || message.requestId !== requestId) return;
        cleanup();
        if (message.responseType !== "success") reject(new Error(message.error || "Codex open-file failed"));
        else resolve(message.bodyJsonString || "");
      };
      window.addEventListener("message", onMessage);
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error("Codex open-file timed out")); }, 2500);
      Promise.resolve(window.electronBridge.sendMessageFromView({
        type: "fetch",
        requestId,
        method: "POST",
        url: `vscode://codex/${method}`,
        body: JSON.stringify(params),
      })).catch((error) => { cleanup(); reject(error); });
    });
  }

  async function openFile(match) {
    try {
      await callCodexApi("open-file", {
        path: match.path,
        filePath: match.path,
        line: Number(match.line) || 1,
        column: Number(match.column) || 1,
      });
      setStatus(`已打开 ${match.relativePath}:${match.line}`);
    } catch (_) {
      setStatus("当前 Codex 版本不支持直接跳转，已保留文件预览");
    }
  }

  async function loadRoots() {
    const current = currentWorkspacePath();
    const remembered = Array.isArray(window.__codexPluginMarketplaceLastCwds) ? window.__codexPluginMarketplaceLastCwds : [];
    const response = await bridgeCall("/workspace-search/roots", {});
    const roots = uniqueRoots([current, ...remembered, ...(Array.isArray(response?.roots) ? response.roots : [])]);
    state.rootList.replaceChildren();
    for (const root of roots) {
      const option = document.createElement("option");
      option.value = root;
      state.rootList.appendChild(option);
    }
    const input = state.root.querySelector("[data-ws-root]");
    if (!input.value || !roots.some((root) => root.toLowerCase() === input.value.toLowerCase())) input.value = current || roots[0] || "";
  }

  async function open() {
    const root = createRoot();
    state.previousFocus = document.activeElement;
    root.hidden = false;
    await loadRoots();
    window.setTimeout(() => state.query?.focus(), 0);
  }

  function close() {
    if (!state.root || state.root.hidden) return;
    state.root.hidden = true;
    state.searchRevision += 1;
    cancelActiveSearch();
    if (state.previousFocus instanceof HTMLElement && state.previousFocus.isConnected) state.previousFocus.focus();
  }

  function toggle() {
    if (state.root && !state.root.hidden) close();
    else open();
  }

  function ensureHeaderButton() {
    if (document.querySelector(`.${BUTTON_CLASS}`)) return;
    const header = document.querySelector('[class*="ApplicationMenuTopBar"], .app-header-tint, header');
    if (!header) return;
    const button = document.createElement("button");
    button.className = BUTTON_CLASS;
    button.type = "button";
    button.textContent = "全文搜索";
    button.title = "工作区全文搜索 (Ctrl+Shift+F)";
    button.addEventListener("click", open);
    header.appendChild(button);
  }

  function onKeyDown(event) {
    if (event.key.toLowerCase() === "f" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggle();
      return;
    }
    if (event.key === "Escape" && state.root && !state.root.hidden) {
      event.preventDefault();
      close();
    }
  }

  function cleanup() {
    document.removeEventListener("keydown", onKeyDown, true);
    state.observer?.disconnect();
    window.clearTimeout(state.debounceTimer);
    window.clearTimeout(state.pollTimer);
    cancelActiveSearch();
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((node) => node.remove());
    delete window[API_KEY];
  }

  document.addEventListener("keydown", onKeyDown, true);
  state.observer = new MutationObserver(ensureHeaderButton);
  state.observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureHeaderButton();
  window[API_KEY] = { open, close, toggle, cleanup };
})();
