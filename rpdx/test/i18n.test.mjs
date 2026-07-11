// #42 国際化 i18n v1 — 辞書の整合（値が全て非空・キー重複なし・テンプレの data-i18n を網羅）
// DOM は検証しない（node 環境・静的解析のみ）。動的解析文言は日本語のまま=部分対応。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app");
const uiSrc = readFileSync(join(appDir, "ui.mjs"), "utf8");
const htmlSrc = readFileSync(join(appDir, "index.template.html"), "utf8");

// ui.mjs の I18N.en 辞書を抽出（{ "JP": "EN", ... } のリテラルをパース）
const dictOf = (lang) => {
  const m = uiSrc.match(new RegExp(`${lang}\\s*:\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(m, `${lang} 辞書ブロックが見つからない`);
  const dict = {};
  const re = /"([^"]+)"\s*:\s*"([^"]*)"/g;
  let mm;
  while ((mm = re.exec(m[1]))) dict[mm[1]] = mm[2];
  return dict;
};

test("#42 i18n: en 辞書は値が全て非空・キー重複なし", () => {
  const en = dictOf("en");
  const keys = Object.keys(en);
  assert.ok(keys.length >= 25, `辞書語数 ${keys.length}（>=25 期待）`);
  // JSON.parse ベースでキー重複を検出（重複キーは後勝ちで数が減る）
  const rawKeys = [...uiSrc.matchAll(/"([^"]+)"\s*:\s*"[^"]*"/g)]
    .map(x => x[1]);
  // en ブロック内のキー列だけを対象にするため、辞書ブロックを再抽出して数える
  const block = uiSrc.match(/en\s*:\s*\{([\s\S]*?)\}/)[1];
  const blockKeys = [...block.matchAll(/"([^"]+)"\s*:/g)].map(x => x[1]);
  assert.equal(blockKeys.length, new Set(blockKeys).size, "キー重複なし");
  for (const k of keys) {
    assert.ok(k.length > 0, "キー非空");
    assert.ok(typeof en[k] === "string" && en[k].trim().length > 0, `値 非空: ${k}`);
    // 英語辞書の値は非日本語（ASCII 基調 — ひらがな/カタカナ/漢字を含まない）
    assert.ok(!/[぀-ヿ一-鿿]/.test(en[k]), `en 値に日本語: ${k}=${en[k]}`);
  }
});

test("#42 i18n: テンプレの data-i18n キーは全て en 辞書に存在（未訳ゼロ）", () => {
  const en = dictOf("en");
  const used = [...htmlSrc.matchAll(/data-i18n="([^"]+)"/g)].map(x => x[1]);
  assert.ok(used.length >= 20, `data-i18n 使用箇所 ${used.length}`);
  for (const k of new Set(used))
    assert.ok(k in en, `テンプレ data-i18n="${k}" が en 辞書に無い`);
  // 動的に t() で参照する 停止/再生 も辞書に含む（btnPlay ラベル）
  for (const k of ["再生", "停止"])
    assert.ok(k in en, `t() 参照キー ${k} が辞書に無い`);
});
