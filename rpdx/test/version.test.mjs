// バージョン: 単一の真実源（RPDX.VERSION）が存在し semver 形式であること
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX } from "./load.mjs";

test("RPDX.VERSION は semver 文字列（リリースタグと一致させる源）", () => {
  assert.equal(typeof RPDX.VERSION, "string", "VERSION は文字列");
  assert.match(RPDX.VERSION, /^\d+\.\d+\.\d+$/, `semver 形式 (${RPDX.VERSION})`);
});
