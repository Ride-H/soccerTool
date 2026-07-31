// 画面層の契約 — 「追加するたびに人が気をつける」ことをやめるための機械的な検査。
//
// 2026-08-01 の作業で分かったこと:
//   1. prompt()/confirm()/alert() は、スマホで試合を見ながら使えないうえ、
//      ヘッドレス検証で画面が止まる（自動確認ができなくなる）。
//   2. 保存の仕組みは既にあるのに、新機能ごとに別の保存を足すと重複が生まれる。
//      端末に書くキーを 1 か所へ登録させ、勝手に増えたら落とす。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const appFiles = readdirSync(appDir).filter((f) => f.endsWith(".mjs"));
const srcOf = (f) => readFileSync(join(appDir, f), "utf8");

// 端末内に書いてよいキーの一覧。増やすときはここへ登録する（＝既存の仕組みで足りないかを一度考える）。
const ALLOWED_STORAGE_KEYS = [
  "rpdx.scenario.v1",       // シナリオのバンドル（手動保存・#91）
  "rpdx.live.autosave.v1",  // ライブの自動保存（同じバンドル形式・#181）
  "rpdx_opts_v1",           // 表示オプション（#134）
  "rpdx_tier_v1",           // 品質ティアの手動指定（#152）
];

test("画面層: prompt/confirm/alert を使わない（スマホで使えず、自動検証も止まる）", () => {
  for (const f of appFiles) {
    const src = srcOf(f);
    for (const fn of ["prompt", "confirm", "alert"]) {
      const re = new RegExp(`(^|[^.\\w])${fn}\\s*\\(`, "g");
      const hits = [...src.matchAll(re)];
      assert.equal(hits.length, 0,
        `app/${f} が ${fn}() を使っている。画面内の操作（44px 以上のボタン等）へ置き換えること`);
    }
  }
});

test("画面層: 端末内へ書くキーは登録済みのものだけ（保存機構の重複を防ぐ）", () => {
  const found = new Set();
  for (const f of appFiles) {
    const src = srcOf(f);
    // 直書きのキー
    for (const m of src.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*["'`]([^"'`]+)["'`]/g)) found.add(m[1]);
    // 定数経由（const NAME = "key" → localStorage...(NAME)）
    for (const m of src.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*([A-Z_][A-Z0-9_]*)\s*[,)]/g)) {
      const dec = src.match(new RegExp(`const\\s+${m[1]}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`));
      if (dec) found.add(dec[1]);
      else assert.fail(`app/${f}: localStorage のキー ${m[1]} の定義が見つからない（定数で定義すること）`);
    }
  }
  const unknown = [...found].filter((k) => !ALLOWED_STORAGE_KEYS.includes(k));
  assert.deepEqual(unknown, [],
    `未登録の保存キー: ${unknown.join(", ")}。既存の仕組み（scenlib のバンドル）で足りないかを確認し、`
    + "必要ならこのテストの ALLOWED_STORAGE_KEYS へ理由つきで登録すること");
  assert.ok(found.size >= 3, `検出できたキーが少なすぎる（${found.size}）— 検査が壊れていないか確認`);
});

test("画面層: 操作要素には説明（aria-label か文字）がある", () => {
  const html = readFileSync(join(appDir, "index.template.html"), "utf8");
  const btns = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(btns.length > 20, `ボタンが少なすぎる（${btns.length}）— 検査が壊れていないか確認`);
  const bad = [];
  for (const [, attrs, inner] of btns) {
    const hasLabel = /aria-label\s*=/.test(attrs);
    const text = inner.replace(/<[^>]*>/g, "").trim();
    if (!hasLabel && !text) bad.push(attrs.slice(0, 60));
  }
  assert.deepEqual(bad, [], `説明の無いボタン: ${bad.join(" / ")}`);
});
