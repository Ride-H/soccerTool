// 単一ファイルビルド: src + app → dist/rpdx.html（依存ゼロ・オフライン動作）
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");

// マッチパック（src/data_match*.mjs）は置くだけで全て同梱される
const dataPacks = readdirSync(join(root, "src"))
  .filter((f) => /^data_match.*\.mjs$/.test(f))
  .sort()
  .map((f) => "src/" + f);

// core = 純粋計算層（DOM非依存 — Web Worker (#38) がこのタグのテキストを再評価する）
const CORE = [
  "src/version.mjs", "src/noise.mjs", "src/formations.mjs", ...dataPacks,
  "src/engine.mjs", "src/danger.mjs", "src/subs.mjs", "src/sim.mjs", "src/psy.mjs",
  "src/duel.mjs", "src/physio.mjs", "src/filter.mjs", "src/uq.mjs", "src/tactics.mjs", "src/opponent.mjs", "src/scenlib.mjs", "src/policy.mjs", "src/layers.mjs", "src/generic.mjs",
];
const APP = ["app/render3d.mjs", "app/ui.mjs"];

const prelude = `
/* 実行時エラーの可視化（ヘッドレス検証用） */
window.addEventListener("error", (e) => {
  document.title = "RPDX-ERROR";
  let d = document.getElementById("fatal");
  if (!d) {
    d = document.createElement("div");
    d.id = "fatal";
    d.style.cssText = "position:fixed;z-index:9999;left:8px;top:8px;right:8px;background:#3a0d10;color:#ffb4ac;font:11px monospace;padding:10px;border-radius:8px;white-space:pre-wrap";
    document.body && document.body.appendChild(d);
  }
  d.textContent += (e.message || e.error) + " @ " + (e.filename || "") + ":" + e.lineno + "\\n";
});
`;

const coreJs = CORE.map((f) => `\n/* ===== ${f} ===== */\n` + read(f)).join("\n");
const appJs = prelude + APP.map((f) => `\n/* ===== ${f} ===== */\n` + read(f)).join("\n");
const css = read("app/app.css");
let html = read("app/index.template.html");
html = html.replace("/*__CSS__*/", () => css);
html = html.replace("/*__CORE__*/", () => coreJs);
html = html.replace("/*__APP__*/", () => appJs);

mkdirSync(join(root, "..", "dist"), { recursive: true });
const out = join(root, "..", "dist", "rpdx.html");
writeFileSync(out, html);
console.log("built:", out, (html.length / 1024).toFixed(1) + "KB");

// Artifact向け（claude.aiがhtml/head/bodyの骨格でラップするため本文のみ）
const bodyStart = html.indexOf("<body>") + 6;
const bodyEnd = html.indexOf("</body>");
const artifact =
  `<title>RPD-X | 日本 × ブラジル 2026 — D²-Field 戦術解析</title>\n` +
  `<style>\n${css}\n</style>\n` +
  html.slice(bodyStart, bodyEnd);
const out2 = join(root, "..", "dist", "rpdx_artifact.html");
writeFileSync(out2, artifact);
console.log("built:", out2, (artifact.length / 1024).toFixed(1) + "KB");
