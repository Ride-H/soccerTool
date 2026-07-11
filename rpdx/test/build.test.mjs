// #38 ビルド構造 — core（DOM非依存の計算層）と app（描画/UI）の2タグ分離を検証。
// core タグのテキストは Web Worker が Blob として再評価するため、この構造が契約になる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("#38 build: rpdx-core タグ = 計算層のみ（DOM非依存）・app 層は core の後", () => {
  execSync(`node ${join(root, "build.mjs")}`, { stdio: "pipe" });
  const html = readFileSync(join(root, "..", "dist", "rpdx.html"), "utf8");
  const coreStart = html.indexOf('<script id="rpdx-core">');
  assert.ok(coreStart > 0, "core タグが存在");
  const coreEnd = html.indexOf("</script>", coreStart);
  const core = html.slice(coreStart, coreEnd);
  // core は計算層を含む
  for (const marker of ["R.engine", "R.danger", "R.scenlib", "R.sim", "data_match"]) {
    assert.ok(core.includes(marker), `core に ${marker}`);
  }
  // core は DOM 層を含まない（Worker で評価可能）
  for (const bad of ["render3d.mjs", "ui.mjs", "document.getElementById"]) {
    assert.ok(!core.includes(bad), `core に ${bad} が無い`);
  }
  // app 層（描画）は core の後に存在
  const appIdx = html.indexOf("render3d.mjs", coreEnd);
  assert.ok(appIdx > coreEnd, "app 層は core の後");
});
