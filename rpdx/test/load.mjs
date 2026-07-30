// テスト用ローダ: src の各モジュール（グローバル名前空間方式）を順に評価。
// (0, eval) ではなくファイル名付きの vm 評価にしてある。無名スクリプトだと V8 の
// カバレッジがソース行に紐づかず、「何がテストされていないか」を測れないため。
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const dataPacks = readdirSync(dir).filter((f) => /^data_match.*\.mjs$/.test(f)).sort();
export const SRC_ORDER = [
  "version.mjs", "noise.mjs", "formations.mjs", ...dataPacks,
  "engine.mjs", "danger.mjs", "subs.mjs", "sim.mjs", "psy.mjs",
  "duel.mjs", "physio.mjs", "filter.mjs", "uq.mjs", "tactics.mjs", "opponent.mjs", "scenlib.mjs", "policy.mjs", "layers.mjs", "generic.mjs",
];
export const evalFile = (path) => vm.runInThisContext(readFileSync(path, "utf8"), { filename: path });
for (const f of SRC_ORDER) evalFile(join(dir, f));
export const RPDX = globalThis.RPDX;
export const MATCH = RPDX.data.MATCH;
export const MATCHES = RPDX.data.MATCHES;
