/*
 * Xuan++ built-in Prompt Optimize (official rewrite).
 *
 * Reference: community "Prompt Optimize" market script v1.0.3. This built-in
 * version replaces the market implementation:
 *   - settings are stored in the Xuan++ settings store, not renderer
 *     localStorage; the API key never leaves the Xuan++ backend;
 *   - optimization requests go through the Xuan++ bridge
 *     /prompt-optimize/generate so the upstream request and key handling stay
 *     in the Rust side.
 *
 * Host contract: injected by the Xuan++ launcher into the Codex renderer
 * (app://-), where window.__codexSessionDeleteBridge is available. The script
 * self-destroys when the feature is disabled or the bridge is missing.
 */
(() => {
  const SCRIPT_VERSION = "1.1.0";
  const INSTANCE_REVISION = "official-2026-09-v6";
  const API_KEY = "__codexPlusPromptOptimize";
  const BRIDGE_KEY = "__codexSessionDeleteBridge";
  const STYLE_ID = `codex-plus-prompt-optimize-style-${INSTANCE_REVISION}`;
  const BUTTON_ATTR = `data-cpo-button-${INSTANCE_REVISION}`;
  const PANEL_ATTR = `data-cpo-panel-${INSTANCE_REVISION}`;
  const TOAST_ATTR = `data-cpo-toast-${INSTANCE_REVISION}`;
  const BUTTON_LABELS = {
    idle: "润色",
    loading: "润色中...",
    restore: "恢复",
  };
  const POLL_MS = 1800;
  const DEBOUNCE_MS = 120;
  const TOAST_MS = 2400;
  const BRIDGE_TIMEOUT_MS = 75000;
  const MAX_CONTEXT_TURNS = 4;
  const MAX_CONTEXT_CHARS = 6000;
  const DEFAULT_BASE_URLS = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
  };
  const DEFAULT_MODELS = {
    openai: "gpt-4o-mini",
    anthropic: "claude-haiku-4-5-20251001",
  };
  const STYLE_OPTIONS = [
    { value: "concise", label: "简洁" },
    { value: "structured", label: "结构化" },
    { value: "coding", label: "编码任务" },
  ];

  const previous = window[API_KEY];
  if (previous && typeof previous.destroy === "function" && previous.revision !== INSTANCE_REVISION) {
    try {
      previous.destroy();
    } catch (_) {
      /* ignore */
    }
  }
  if (
    previous &&
    previous.revision === INSTANCE_REVISION &&
    typeof previous.ensure === "function"
  ) {
    try {
      previous.ensure();
    } catch (_) {
      /* ignore */
    }
    return;
  }

  const promptOptimizeState = (() => {
    function create() {
      return { mode: "idle", originalText: null, optimizedText: null };
    }

    function saveSnapshotIfApplied(state, originalText, optimizedText, wasApplied) {
      if (!wasApplied) return false;
      state.mode = "optimized";
      state.originalText = originalText;
      state.optimizedText = optimizedText;
      return true;
    }

    function clearSnapshot(state) {
      state.mode = "idle";
      state.originalText = null;
      state.optimizedText = null;
    }

    function needsRestoreConfirmation(state, currentText) {
      return state.mode === "optimized" && state.optimizedText !== currentText;
    }

    return { create, saveSnapshotIfApplied, clearSnapshot, needsRestoreConfirmation };
  })();

  const promptOptimizeContext = (() => {
    function selectRecentTurns(turns, maxTurns = MAX_CONTEXT_TURNS, maxChars = MAX_CONTEXT_CHARS) {
      const selected = [];
      let remaining = Math.max(0, maxChars);
      const candidates = Array.isArray(turns) ? turns.slice(-Math.max(0, maxTurns)) : [];
      for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
        const candidate = candidates[index] || {};
        const userText = String(candidate.userText || "").trim();
        const assistantText = String(candidate.assistantText || "").trim();
        const turn = {};
        if (assistantText) {
          turn.assistantText = assistantText.slice(0, remaining);
          remaining -= turn.assistantText.length;
        }
        if (userText && remaining > 0) {
          turn.userText = userText.slice(0, remaining);
          remaining -= turn.userText.length;
        }
        if (turn.userText || turn.assistantText) selected.unshift(turn);
      }
      return selected;
    }

    function shouldIncludeProjectMap(draft, style) {
      if (style === "coding") return true;
      return /(?:当前|这个|本|项目|仓库|代码库|模块|文件|函数|类|接口|测试|构建|编译|依赖|repo|repository|project|workspace|codebase|module|file|function|class|interface|test|build|compile|dependency)/i.test(
        String(draft || ""),
      );
    }

    return { selectRecentTurns, shouldIncludeProjectMap };
  })();

  const runtime = {
    observer: null,
    pollId: 0,
    mutationTimer: 0,
    toastTimer: 0,
    resizeHandler: null,
    shortcutHandler: null,
    disposed: false,
    loading: false,
    epoch: 0,
    settings: null,
    bridgeBroken: false,
    lastPlacement: null,
    writeToken: 0,
  };

  // Map per-thread optimized state so the button can restore the original
  // draft instead of the optimized one.
  const threadState = Object.create(null);

  function locationSessionId() {
    const source = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const match =
      source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i) ||
      source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/) ||
      source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function currentThreadKey() {
    const input = findComposerInput();
    if (input) {
      let node = input;
      while (node && node !== document.body) {
        const id =
          node.getAttribute && node.getAttribute("data-app-action-sidebar-thread-id");
        if (id) return id;
        node = node.parentNode;
      }
    }
    return locationSessionId() || "__draft__";
  }

  function currentSessionId() {
    const threadKey = currentThreadKey();
    return threadKey === "__draft__" ? "" : threadKey;
  }

  function getThreadState() {
    const key = currentThreadKey();
    const state = threadState[key] || promptOptimizeState.create();
    threadState[key] = state;
    return state;
  }

  function clearThreadOptimized(state) {
    promptOptimizeState.clearSnapshot(state || getThreadState());
  }

  function bridgeCall(path, payload) {
    if (typeof window[BRIDGE_KEY] !== "function") {
      return Promise.reject(new Error("Xuan++ 桥未就绪"));
    }
    let timer = 0;
    const timeout = new Promise((resolve) => {
      timer = window.setTimeout(() => resolve({ error: "Xuan++ 桥请求超时" }), BRIDGE_TIMEOUT_MS);
    });
    const request = Promise.resolve().then(() => window[BRIDGE_KEY](path, payload || {}));
    return Promise.race([request, timeout]).finally(() => window.clearTimeout(timer));
  }

  async function refreshSettings() {
    const result = await bridgeCall("/prompt-optimize/settings", {});
    if (!result || result.status !== "ok" || !result.settings) {
      runtime.bridgeBroken = true;
      runtime.settings = null;
      return null;
    }
    runtime.bridgeBroken = false;
    runtime.settings = result.settings;
    return runtime.settings;
  }

  function isConfigured(settings) {
    if (!settings) return false;
    return Boolean(
      settings.baseUrlConfigured &&
        settings.apiKeyConfigured &&
        settings.model &&
        settings.model.trim(),
    );
  }

  function normalizeText(value) {
    return collapseWs(value);
  }

  function roleFromConversationLabel(label) {
    const text = normalizeText(label?.textContent || "");
    if (/^(你说|you said|user)\s*[:：]?$/i.test(text)) return "user";
    if (/^(ChatGPT|assistant|codex)(?:\s+说|\s+said)?\s*[:：]?$/i.test(text)) return "assistant";
    return "";
  }

  function conversationMessageText(container) {
    if (!(container instanceof Element)) return "";
    const clone = container.cloneNode(true);
    clone.querySelectorAll?.("h4.sr-only,button,[role='button'],svg").forEach((item) => item.remove());
    return normalizeText(clone.textContent || "");
  }

  function labeledConversationMessage(turn, role) {
    if (!(turn instanceof Element)) return "";
    const labels = Array.from(turn.querySelectorAll("h4.sr-only"));
    for (let index = labels.length - 1; index >= 0; index -= 1) {
      const label = labels[index];
      if (roleFromConversationLabel(label) !== role) continue;
      return conversationMessageText(label.parentElement);
    }
    return "";
  }

  function collectRecentConversationTurns() {
    const turns = Array.from(
      document.querySelectorAll(
        "div.contents[data-content-search-turn-key], [data-testid='conversation-turn']",
      ),
    ).map((turn) => ({
      userText: labeledConversationMessage(turn, "user"),
      assistantText: labeledConversationMessage(turn, "assistant"),
    }));
    return promptOptimizeContext.selectRecentTurns(turns);
  }

  function collapseWs(value) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) {
      return false;
    }
    return true;
  }

  function isInSidebar(node) {
    let current = node;
    while (current && current !== document.body) {
      if (!(current instanceof Element)) {
        current = current.parentNode;
        continue;
      }
      const role = current.getAttribute && current.getAttribute("role");
      const label = String(current.getAttribute && current.getAttribute("aria-label") || "");
      if (role === "navigation" || /sidebar|nav-section|thread-list/i.test(label)) return true;
      current = current.parentNode;
    }
    return false;
  }

  function isSendLikeLabel(text) {
    return /^(send|stop|提交|发送|停止|run|执行)$/i.test(text.trim());
  }

  function isModelLikeLabel(text) {
    const label = text.trim();
    if (!label) return false;
    if (/(model|模型)/i.test(label)) return true;
    return /^(gpt|o[1-9]|claude|gemini|deepseek|qwen|kimi|moonshot|mistral|llama|sonnet|opus|haiku)[a-z0-9._-]*/i.test(label);
  }

  function modelSelectorBeforeSend(clickables, send) {
    if (!(send instanceof HTMLElement)) return null;
    const sendRect = send.getBoundingClientRect();
    return clickables
      .filter((button) => button !== send)
      .filter((button) => isModelLikeLabel(normalizeText(button.getAttribute("aria-label") || button.textContent || "")))
      .filter((button) => button.getBoundingClientRect().right <= sendRect.left + 2)
      .sort((left, right) => right.getBoundingClientRect().right - left.getBoundingClientRect().right)[0] || null;
  }

  function findComposerInput() {
    const editable = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'))
      .filter((element) => isVisible(element) && !isInSidebar(element))
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        const aArea = aRect.width * aRect.height;
        const bArea = bRect.width * bRect.height;
        return bArea - aArea || bRect.top - aRect.top;
      });
    if (editable.length) return editable[0];
    const bottom = Array.from(document.querySelectorAll("main [role='textbox'], main textarea"))
      .filter((element) => isVisible(element))
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return bottom[0] || null;
  }

  function isMacPlatform() {
    const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
    return /mac|iphone|ipad|ipod/i.test(platform);
  }

  function eventTargetsComposer(event) {
    const input = findComposerInput();
    const target = event.target;
    if (!(input instanceof Element) || !(target instanceof Node)) return false;
    return input === target || input.contains(target);
  }

  function isPromptOptimizeShortcut(event) {
    if (event.key !== "Enter" || event.repeat || event.isComposing || event.keyCode === 229) return false;
    if (event.altKey || event.shiftKey) return false;
    if (isMacPlatform()) return event.metaKey && !event.ctrlKey;
    return event.ctrlKey && !event.metaKey;
  }

  function onPromptOptimizeShortcut(event) {
    if (runtime.disposed || event.defaultPrevented) return;
    if (!isPromptOptimizeShortcut(event) || !eventTargetsComposer(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onButtonClick(event);
  }

  function installPromptOptimizeShortcut() {
    if (runtime.shortcutHandler) return;
    runtime.shortcutHandler = onPromptOptimizeShortcut;
    window.addEventListener("keydown", runtime.shortcutHandler, true);
  }

  function readComposerText(input) {
    if (!(input instanceof HTMLElement)) return "";
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      return normalizeText(input.value);
    }
    return normalizeText(input.innerText || input.textContent || "");
  }

  function setNativeValue(element, value) {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    if (!proto) return false;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
      return true;
    }
    element.value = value;
    return true;
  }

  function dispatchInputEvents(element) {
    try {
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: null }),
      );
    } catch (_) {
      element.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  }

  function writeComposerText(text, input) {
    if (!(input instanceof HTMLElement)) return { ok: false, reason: "input-not-found" };
    const next = normalizeText(text);
    const token = ++runtime.writeToken;
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      input.focus();
      setNativeValue(input, next);
      dispatchInputEvents(input);
      return { ok: true, token, input, next };
    }
    input.focus();
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (_) {
      /* ignore */
    }
    let replaced = false;
    try {
      if (typeof document.execCommand === "function") {
        document.execCommand("selectAll", false, null);
        replaced = document.execCommand("insertText", false, next) !== false;
      }
    } catch (_) {
      replaced = false;
    }
    if (!replaced) return { ok: false, reason: "editor-write-unsupported" };
    dispatchInputEvents(input);
    return { ok: true, token, input, next };
  }

  async function writeComposerTextWithFallback(text, input) {
    const writeToken = (runtime.writeToken = (runtime.writeToken || 0) + 1);
    const result = writeComposerText(text, input);
    if (result.ok) {
      await new Promise((resolve) => {
        if (typeof window.requestAnimationFrame !== "function") {
          window.setTimeout(resolve, 0);
          return;
        }
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
      });
      if (writeToken === runtime.writeToken && result.input.isConnected) {
        const verified = normalizeText(readComposerText(result.input));
        if (verified === result.next || verified.trimEnd() === result.next.trimEnd()) {
          return { ok: true };
        }
      }
    }
    try {
      await navigator.clipboard.writeText(normalizeText(text));
      return { ok: false, clipboard: true };
    } catch (_) {
      return { ok: false, clipboard: false };
    }
  }

  function showToast(message, kind) {
    const host = document.querySelector(`[${TOAST_ATTR}]`);
    if (host) host.remove();
    const toast = document.createElement("div");
    toast.setAttribute(TOAST_ATTR, "true");
    toast.className = `cpo-toast ${kind === "error" ? "cpo-toast-error" : ""}`;
    toast.textContent = message;
    document.documentElement.appendChild(toast);
    if (runtime.toastTimer) window.clearTimeout(runtime.toastTimer);
    runtime.toastTimer = window.setTimeout(() => {
      const current = document.querySelector(`[${TOAST_ATTR}]`);
      if (current) current.remove();
    }, TOAST_MS);
  }

  function detectAppearance() {
    const root = document.documentElement;
    const body = document.body;
    const classes = `${root?.className || ""} ${body?.className || ""}`.toLowerCase();
    if (/\b(dark|electron-dark|theme-dark|appearance-dark|dream-theme-dark)\b/.test(classes)) return "dark";
    if (/\b(light|electron-light|theme-light|appearance-light|dream-theme-light)\b/.test(classes)) return "light";

    const dataTheme = [root, body]
      .flatMap((element) => [
        element?.getAttribute("data-theme"),
        element?.getAttribute("data-appearance"),
        element?.getAttribute("data-color-mode"),
      ])
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (dataTheme.includes("dark")) return "dark";
    if (dataTheme.includes("light")) return "light";

    try {
      const colorScheme = `${getComputedStyle(root).colorScheme} ${getComputedStyle(body).colorScheme}`;
      if (colorScheme.includes("dark") && !colorScheme.includes("light")) return "dark";
      if (colorScheme.includes("light") && !colorScheme.includes("dark")) return "light";
    } catch (_) {
      /* fall through */
    }

    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function isSuccessfulSettingsSave(result) {
    return Boolean(
      result &&
        result.status !== "failed" &&
        (result.status === "ok" || typeof result.codexAppPromptOptimizeProtocol === "string"),
    );
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${BUTTON_ATTR}]{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-width:42px;height:30px;padding:0 7px;border-radius:8px;cursor:pointer;font-size:12px;line-height:1;flex:none;user-select:none}
      [${BUTTON_ATTR}]:hover{background:rgba(128,128,128,.14)}
      [${BUTTON_ATTR}].cpo-loading{opacity:.55;cursor:progress}
      [${PANEL_ATTR}]{all:initial;--cpo-overlay:rgba(0,0,0,.28);--cpo-surface:#fff;--cpo-input:#fff;--cpo-text:#111;--cpo-muted:#666;--cpo-label:#333;--cpo-border:#ccc;--cpo-key:#1a7f37;--cpo-primary:#111;position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:var(--cpo-overlay);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--cpo-text);color-scheme:light}
      [${PANEL_ATTR}][data-cpo-theme="dark"]{--cpo-overlay:rgba(0,0,0,.56);--cpo-surface:#1d1f23;--cpo-input:#282b30;--cpo-text:#f4f5f7;--cpo-muted:#b2b8c2;--cpo-label:#e5e7eb;--cpo-border:#464c56;--cpo-key:#74d69b;--cpo-primary:#e9edf3;color-scheme:dark}
      [${PANEL_ATTR}] .cpo-card{width:min(520px,calc(100vw - 40px));max-height:min(620px,calc(100vh - 40px));overflow:auto;background:var(--cpo-surface);border:1px solid var(--cpo-border);border-radius:12px;padding:18px 20px;box-shadow:0 18px 50px rgba(0,0,0,.24)}
      [${PANEL_ATTR}] h2{margin:0 0 4px;font-size:16px}
      [${PANEL_ATTR}] .cpo-sub{margin:0 0 14px;color:var(--cpo-muted)}
      [${PANEL_ATTR}] .cpo-field{margin:10px 0}
      [${PANEL_ATTR}] label{display:block;margin-bottom:4px;font-weight:600;color:var(--cpo-label)}
      [${PANEL_ATTR}] input,[${PANEL_ATTR}] select{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--cpo-border);border-radius:8px;font:inherit;background:var(--cpo-input);color:var(--cpo-text)}
      [${PANEL_ATTR}] .cpo-row{display:flex;gap:10px}
      [${PANEL_ATTR}] .cpo-row>.cpo-field{flex:1}
      [${PANEL_ATTR}] .cpo-hint{margin:6px 0 0;color:var(--cpo-muted);font-size:12px}
      [${PANEL_ATTR}] .cpo-key-state{margin-top:6px;font-size:12px;color:var(--cpo-key)}
      [${PANEL_ATTR}] .cpo-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
      [${PANEL_ATTR}] button{all:unset;box-sizing:border-box;padding:8px 16px;border-radius:8px;cursor:pointer;font:inherit;border:1px solid var(--cpo-border);background:var(--cpo-input);color:var(--cpo-text)}
      [${PANEL_ATTR}] button.cpo-primary{background:var(--cpo-primary);border-color:var(--cpo-primary);color:var(--cpo-surface)}
      [${PANEL_ATTR}] button:disabled{opacity:.5;cursor:not-allowed}
      .cpo-toast{all:initial;position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:2147483001;background:#111;color:#fff;padding:9px 16px;border-radius:999px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.24);max-width:min(560px,calc(100vw - 40px))}
      .cpo-toast.cpo-toast-error{background:#b42318}
      [data-cpo-composer-${INSTANCE_REVISION}]{display:inline-flex;align-items:center;margin-right:8px}
    `;
    document.documentElement.appendChild(style);
  }

  function removeStyle() {
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  function currentButtonState() {
    const state = getThreadState();
    return runtime.loading ? "loading" : state.mode === "optimized" ? "restore" : "idle";
  }

  function refreshButtonAppearance(button) {
    const current = button || document.querySelector(`[${BUTTON_ATTR}]`);
    if (!(current instanceof HTMLElement)) return;
    const state = currentButtonState();
    current.classList.toggle("cpo-loading", state === "loading");
    current.disabled = state === "loading";
    current.setAttribute("aria-busy", state === "loading" ? "true" : "false");
    current.setAttribute("aria-label", BUTTON_LABELS[state]);
    current.textContent = BUTTON_LABELS[state];
    current.title =
      state === "loading"
        ? "正在润色"
        : state === "restore"
          ? "恢复润色前的文本"
          : "润色（右键设置）";
  }

  function createButton() {
    const button = document.createElement("button");
    button.setAttribute(BUTTON_ATTR, "true");
    button.type = "button";
    button.addEventListener("click", onButtonClick);
    button.addEventListener("contextmenu", onButtonContextMenu);
    refreshButtonAppearance(button);
    return button;
  }

  function composerInsertAnchor(input) {
    if (!(input instanceof HTMLElement)) return null;
    let node = input;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentNode) {
      if (!(node instanceof Element)) continue;
      const role = node.getAttribute && node.getAttribute("role");
      const label = String(node.getAttribute && node.getAttribute("aria-label") || "");
      if (/composer|composer-surface/i.test(label)) return { node, before: node.firstChild };
      if (role === "textbox") continue;
      const clickables = Array.from(node.querySelectorAll("button"))
        .filter((el) => isVisible(el))
        .slice(-8);
      const send = clickables.find((el) => {
        const text = normalizeText(el.getAttribute("aria-label") || el.textContent || "");
        return isSendLikeLabel(text);
      });
      if (send) {
        const modelSelector = modelSelectorBeforeSend(clickables, send);
        if (modelSelector && modelSelector.parentElement) {
          return { node: modelSelector.parentElement, before: modelSelector };
        }
        return { node: send.parentElement || send.parentNode, before: send };
      }
    }
    return null;
  }

  function ensureButton() {
    if (runtime.disposed) return;
    const input = findComposerInput();
    if (!input) {
      destroyButton();
      return;
    }
    const existing = document.querySelector(`[${BUTTON_ATTR}]`);
    if (existing && existing.isConnected && isVisible(existing)) {
      runtime.lastPlacement = null;
      return;
    }
    const anchor = composerInsertAnchor(input);
    const button = createButton();
    if (anchor && anchor.node instanceof Element) {
      const host = document.createElement("span");
      host.setAttribute(`data-cpo-composer-${INSTANCE_REVISION}`, "true");
      host.appendChild(button);
      const before = anchor.before?.parentNode === anchor.node ? anchor.before : null;
      anchor.node.insertBefore(host, before);
    } else {
      button.style.position = "fixed";
      button.style.zIndex = "2147483002";
      placeButtonNearInput(button, input);
      document.documentElement.appendChild(button);
      runtime.lastPlacement = button;
    }
    refreshButtonAppearance(button);
  }

  function placeButtonNearInput(button, input) {
    const rect = input.getBoundingClientRect();
    button.style.right = `${Math.max(12, window.innerWidth - rect.right + 8)}px`;
    button.style.top = `${Math.max(8, rect.bottom - 38)}px`;
  }

  function destroyButton() {
    document.querySelectorAll(`[${BUTTON_ATTR}]`).forEach((node) => node.remove());
    document.querySelectorAll(`[data-cpo-composer-${INSTANCE_REVISION}]`).forEach((node) => node.remove());
    runtime.lastPlacement = null;
  }

  function destroyAll() {
    destroyButton();
    document.querySelectorAll(`[${PANEL_ATTR}]`).forEach((node) => node.remove());
    document.querySelectorAll(`[${TOAST_ATTR}]`).forEach((node) => node.remove());
    removeStyle();
    if (runtime.observer) runtime.observer.disconnect();
    if (runtime.pollId) window.clearInterval(runtime.pollId);
    if (runtime.mutationTimer) window.clearTimeout(runtime.mutationTimer);
    if (runtime.toastTimer) window.clearTimeout(runtime.toastTimer);
    if (runtime.resizeHandler) window.removeEventListener("resize", runtime.resizeHandler);
    if (runtime.shortcutHandler) window.removeEventListener("keydown", runtime.shortcutHandler, true);
    runtime.shortcutHandler = null;
    runtime.disposed = true;
    if (window[API_KEY] === api) window[API_KEY] = undefined;
  }

  async function runOptimize() {
    const epoch = runtime.epoch;
    runtime.loading = true;
    refreshButtonAppearance();
    try {
      if (!(await refreshSettings())) {
        if (!runtime.bridgeBroken) showToast("无法读取润色配置", "error");
        return;
      }
      if (!runtime.settings.enabled) {
        destroyAll();
        return;
      }
      if (!isConfigured(runtime.settings)) {
        showToast("请先配置 API", "");
        openSettingsPanel();
        return;
      }
      const input = findComposerInput();
      const original = normalizeText(readComposerText(input));
      if (!original) {
        showToast("请先输入内容", "");
        return;
      }
      const state = getThreadState();
      const recentTurns = collectRecentConversationTurns();
      const projectContextHint = [
        original,
        ...recentTurns.flatMap((turn) => [turn.userText || "", turn.assistantText || ""]),
      ].join("\n");
      const result = await bridgeCall("/prompt-optimize/generate", {
        text: original,
        context: {
          sessionId: currentSessionId(),
          recentTurns,
          includeProjectMap: promptOptimizeContext.shouldIncludeProjectMap(
            projectContextHint,
            runtime.settings.style,
          ),
        },
      });
      if (epoch !== runtime.epoch) return;
      if (!result || result.status !== "ok") {
        const message = result && result.error ? result.error : "优化失败";
        showToast(String(message).slice(0, 200), "error");
        return;
      }
      const optimized = normalizeText(result.text || "");
      if (!optimized) {
        showToast("模型返回为空", "error");
        return;
      }
      const activeInput = findComposerInput();
      if (!activeInput || normalizeText(readComposerText(activeInput)) !== original) {
        showToast("输入内容已变化，优化结果未写入", "");
        return;
      }
      const writeResult = await writeComposerTextWithFallback(optimized, activeInput);
      if (promptOptimizeState.saveSnapshotIfApplied(state, original, optimized, writeResult.ok)) {
        showToast("已润色，点击恢复可还原原文", "");
      } else if (writeResult.clipboard) {
        showToast("优化结果已复制，请手动替换输入框内容", "");
      } else {
        showToast("写入输入框失败", "error");
      }
    } finally {
      if (epoch === runtime.epoch) {
        runtime.loading = false;
        refreshButtonAppearance();
      }
    }
  }

  async function runRestore() {
    const state = getThreadState();
    if (state.mode !== "optimized" || state.originalText == null) {
      showToast("没有可还原的原文", "");
      return;
    }
    const input = findComposerInput();
    const currentText = normalizeText(readComposerText(input));
    if (
      promptOptimizeState.needsRestoreConfirmation(state, currentText) &&
      !window.confirm("当前文本已编辑。恢复将覆盖当前编辑，是否继续？")
    ) {
      return;
    }
    const writeResult = await writeComposerTextWithFallback(state.originalText, input);
    if (writeResult.ok) {
      clearThreadOptimized(state);
      showToast("已恢复润色前的文本", "");
    } else if (writeResult.clipboard) {
      showToast("原文已复制，请手动替换输入框内容", "");
    } else {
      showToast("写入输入框失败", "error");
    }
    refreshButtonAppearance();
  }

  function onButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (runtime.disposed) return;
    if (runtime.loading) return;
    const state = getThreadState();
    if (state.mode === "optimized") {
      void runRestore();
      return;
    }
    void runOptimize();
  }

  function onButtonContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    void openSettingsPanel();
  }

  function closeSettingsPanel() {
    document.querySelectorAll(`[${PANEL_ATTR}]`).forEach((node) => node.remove());
  }

  async function openSettingsPanel() {
    closeSettingsPanel();
    const settings = (await refreshSettings()) || runtime.settings || {};
    const overlay = document.createElement("div");
    overlay.setAttribute(PANEL_ATTR, "true");
    overlay.dataset.cpoTheme = detectAppearance();
    const protocol = settings.protocol === "anthropic" ? "anthropic" : "openai";
    const baseUrl = settings.baseUrl || DEFAULT_BASE_URLS[protocol];
    const model = settings.model || DEFAULT_MODELS[protocol];
    const style = STYLE_OPTIONS.some((item) => item.value === settings.style)
      ? settings.style
      : "structured";
    overlay.innerHTML = `
      <div class="cpo-card" role="dialog" aria-modal="true" aria-label="润色设置">
        <h2>润色设置</h2>
        <p class="cpo-sub">配置外部 LLM；API Key 只保存在 Xuan++ 本地设置中。</p>
        <div class="cpo-row">
          <div class="cpo-field">
            <label>协议</label>
            <select data-cpo="protocol">
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <div class="cpo-field">
            <label>风格</label>
            <select data-cpo="style">
              ${STYLE_OPTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="cpo-field">
          <label>Base URL</label>
          <input data-cpo="baseUrl" type="url" spellcheck="false" placeholder="https://api.example.com/v1" />
          <p class="cpo-hint">仅 HTTPS；OpenAI 兼容默认 ${DEFAULT_BASE_URLS.openai}</p>
        </div>
        <div class="cpo-row">
          <div class="cpo-field">
            <label>Model</label>
            <input data-cpo="model" spellcheck="false" placeholder="gpt-4o-mini" />
          </div>
          <div class="cpo-field">
            <label>API Key</label>
            <input data-cpo="apiKey" type="password" autocomplete="new-password" placeholder="留空保持不变" />
          </div>
        </div>
        <div class="cpo-field">
          <label class="cpo-check"><input data-cpo="clearKey" type="checkbox" /> 清除已保存的 API Key</label>
          <p class="cpo-key-state">${settings.apiKeyConfigured ? "已保存 API Key（再次输入可替换）" : "未配置 API Key"}</p>
        </div>
        <div class="cpo-actions">
          <button type="button" data-cpo-action="close">取消</button>
          <button type="button" class="cpo-primary" data-cpo-action="save">保存</button>
        </div>
      </div>
    `;
    const protocolEl = overlay.querySelector('[data-cpo="protocol"]');
    const baseUrlEl = overlay.querySelector('[data-cpo="baseUrl"]');
    const modelEl = overlay.querySelector('[data-cpo="model"]');
    const apiKeyEl = overlay.querySelector('[data-cpo="apiKey"]');
    const styleEl = overlay.querySelector('[data-cpo="style"]');
    const clearKeyEl = overlay.querySelector('[data-cpo="clearKey"]');
    protocolEl.value = protocol;
    baseUrlEl.value = baseUrl;
    modelEl.value = model;
    styleEl.value = style;
    protocolEl.addEventListener("change", () => {
      const nextProtocol = protocolEl.value === "anthropic" ? "anthropic" : "openai";
      const currentBase = baseUrlEl.value.trim();
      const currentModel = modelEl.value.trim();
      if (!currentBase || currentBase === DEFAULT_BASE_URLS.openai || currentBase === DEFAULT_BASE_URLS.anthropic) {
        baseUrlEl.value = DEFAULT_BASE_URLS[nextProtocol];
      }
      if (!currentModel || currentModel === DEFAULT_MODELS.openai || currentModel === DEFAULT_MODELS.anthropic) {
        modelEl.value = DEFAULT_MODELS[nextProtocol];
      }
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeSettingsPanel();
    });
    overlay.querySelector('[data-cpo-action="close"]').addEventListener("click", (event) => {
      event.preventDefault();
      closeSettingsPanel();
    });
    overlay.querySelector('[data-cpo-action="save"]').addEventListener("click", (event) => {
      event.preventDefault();
      void saveSettingsFromPanel(protocolEl, baseUrlEl, modelEl, apiKeyEl, styleEl, clearKeyEl);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettingsPanel();
      }
    });
    document.documentElement.appendChild(overlay);
    if (!settings.apiKeyConfigured) apiKeyEl.focus();
    else baseUrlEl.focus();
  }

  async function saveSettingsFromPanel(protocolEl, baseUrlEl, modelEl, apiKeyEl, styleEl, clearKeyEl) {
    const next = {
      codexAppPromptOptimizeProtocol: protocolEl.value === "anthropic" ? "anthropic" : "openai",
      codexAppPromptOptimizeStyle: styleEl.value,
    };
    const baseUrl = baseUrlEl.value.trim().replace(/\/+$/, "");
    const model = modelEl.value.trim();
    if (!baseUrl) {
      showToast("请填写 Base URL", "error");
      baseUrlEl.focus();
      return;
    }
    if (!model) {
      showToast("请填写 Model", "error");
      modelEl.focus();
      return;
    }
    next.codexAppPromptOptimizeBaseUrl = baseUrl;
    next.codexAppPromptOptimizeModel = model;
    const apiKey = apiKeyEl.value.trim();
    if (apiKey) next.codexAppPromptOptimizeApiKey = apiKey;
    if (clearKeyEl.checked) next.codexAppPromptOptimizeApiKey = "";
    const saveButton = document.querySelector(`[${PANEL_ATTR}] [data-cpo-action="save"]`);
    if (saveButton) saveButton.disabled = true;
    try {
      const result = await bridgeCall("/settings/set", next);
      if (!isSuccessfulSettingsSave(result)) {
        const message = result && result.message ? result.message : "保存设置失败";
        showToast(String(message).slice(0, 200), "error");
        return;
      }
      await refreshSettings();
      closeSettingsPanel();
      showToast("设置已保存", "");
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  }

  function scheduleEnsure() {
    if (runtime.disposed) return;
    if (runtime.mutationTimer) window.clearTimeout(runtime.mutationTimer);
    runtime.mutationTimer = window.setTimeout(() => {
      runtime.mutationTimer = 0;
      try {
        ensureButton();
      } catch (_) {
        /* ignore */
      }
    }, DEBOUNCE_MS);
  }

  async function startObservers() {
    if (runtime.observer) runtime.observer.disconnect();
    runtime.observer = new MutationObserver(() => scheduleEnsure());
    runtime.observer.observe(document.documentElement, { childList: true, subtree: true });
    if (!runtime.resizeHandler) {
      runtime.resizeHandler = () => {
        if (runtime.lastPlacement instanceof HTMLElement) {
          const input = findComposerInput();
          if (input) placeButtonNearInput(runtime.lastPlacement, input);
        }
      };
      window.addEventListener("resize", runtime.resizeHandler);
    }
    if (runtime.pollId) window.clearInterval(runtime.pollId);
    runtime.pollId = window.setInterval(() => {
      if (runtime.disposed) return;
      try {
        ensureButton();
      } catch (_) {
        /* ignore */
      }
    }, POLL_MS);
    await refreshSettings();
    if (runtime.disposed) return;
    if (!runtime.settings || runtime.settings.enabled === false) {
      destroyAll();
      return;
    }
    installPromptOptimizeShortcut();
    installStyle();
    ensureButton();
  }

  function ensure() {
    if (runtime.disposed) return;
    startObservers().catch(() => {
      /* ignore */
    });
  }

  const api = {
    revision: INSTANCE_REVISION,
    version: SCRIPT_VERSION,
    ensure,
    isOptimizing: () => runtime.loading,
    destroy: destroyAll,
  };
  window[API_KEY] = api;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ensure(), { once: true });
  } else {
    ensure();
  }
})();
