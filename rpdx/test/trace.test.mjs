// 要件トレーサビリティを node --test からも回す。
// 「約束を足したのに検証手段を足していない」「テストを改名したのに紐付けを直していない」を
// 通常のテスト実行で落とす（人が別コマンドを打たないと気づけない仕組みにはしない）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("要件トレーサビリティ: すべての要件に生きた検証手段がある", () => {
  let out = "";
  try {
    out = execFileSync("node", [join(root, "rpdx", "tools", "trace.mjs")], { encoding: "utf8", cwd: root });
  } catch (e) {
    assert.fail(`トレーサビリティ NG:\n${e.stdout || e.message}`);
  }
  assert.match(out, /トレーサビリティ OK/);
});

test("要件レジストリ: 未充足の要件は Issue と検証計画を持つ", async () => {
  const { REQUIREMENTS } = await import("../spec/requirements.mjs");
  const open = REQUIREMENTS.filter((r) => r.status === "open");
  for (const r of open) {
    assert.ok(r.issue, `${r.id} に Issue が無い`);
    assert.ok(r.plan, `${r.id} に検証計画が無い`);
  }
  assert.ok(REQUIREMENTS.filter((r) => r.status === "held").length >= 25, "担保している要件が減っていない");
});
