// テスト用ローダ: src の各モジュール（グローバル名前空間方式）を順に評価
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
export const SRC_ORDER = [
  "noise.mjs", "formations.mjs", "data_match.mjs",
  "engine.mjs", "danger.mjs", "subs.mjs", "sim.mjs", "generic.mjs",
];
for (const f of SRC_ORDER) {
  (0, eval)(readFileSync(join(dir, f), "utf8"));
}
export const RPDX = globalThis.RPDX;
export const MATCH = RPDX.data.MATCH;
