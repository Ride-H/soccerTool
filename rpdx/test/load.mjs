// テスト用ローダ: src の各モジュール（グローバル名前空間方式）を順に評価
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const dataPacks = readdirSync(dir).filter((f) => /^data_match.*\.mjs$/.test(f)).sort();
export const SRC_ORDER = [
  "noise.mjs", "formations.mjs", ...dataPacks,
  "engine.mjs", "danger.mjs", "subs.mjs", "sim.mjs", "psy.mjs",
  "duel.mjs", "physio.mjs", "filter.mjs", "uq.mjs", "tactics.mjs", "generic.mjs",
];
for (const f of SRC_ORDER) {
  (0, eval)(readFileSync(join(dir, f), "utf8"));
}
export const RPDX = globalThis.RPDX;
export const MATCH = RPDX.data.MATCH;
export const MATCHES = RPDX.data.MATCHES;
