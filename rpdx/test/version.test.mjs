// バージョン: 単一の真実源（RPDX.VERSION）が存在し semver 形式であること
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX } from "./load.mjs";

test("RPDX.VERSION は semver 文字列（リリースタグと一致させる源）", () => {
  assert.equal(typeof RPDX.VERSION, "string", "VERSION は文字列");
  assert.match(RPDX.VERSION, /^\d+\.\d+\.\d+$/, `semver 形式 (${RPDX.VERSION})`);
});

// リリース前検査: README がガイドの版を「ツール本体と同版」と書いていないこと。
// ガイドは依頼に応じて発行する方針（毎リリースは作らない）なので、同版と書くと
// 版を上げた瞬間に README が嘘になる。
test("README がガイドの版を本体と同版だと約束していない", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.ok(!/版はツール本体と同版/.test(readme),
    "README がガイドを本体と同版だと約束している — ガイドは依頼発行なので食い違う");
  // ガイドへのリンクが実在の版を指していること
  const m = readme.match(/RPD-X_運用ガイドライン_v([0-9.]+)\.pdf/);
  assert.ok(m, "README にガイドへのリンクが無い");
  assert.match(m[1], /^\d+\.\d+\.\d+$/, `ガイドの版表記が semver でない: ${m[1]}`);
});
