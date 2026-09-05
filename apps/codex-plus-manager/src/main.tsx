import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getLanguage } from "./i18n";
import "./styles.css";

/* ── Bundled fonts (offline, no Google Fonts request) ──
     Fontsource packages ship woff2 files that Vite bundles into dist/.
     CSS @font-face declarations are injected at build time.              */
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono";

const app = document.getElementById("app");
document.documentElement.lang = getLanguage() === "zh" ? "zh-CN" : "en";

if (app instanceof HTMLElement) {
  createRoot(app).render(<App />);
}
