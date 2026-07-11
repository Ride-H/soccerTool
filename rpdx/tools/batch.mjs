#!/usr/bin/env node
// #34 バッチ・シミュレーションCLI（依存ゼロ・決定論）
//   node rpdx/tools/batch.mjs [matchId] [scenarios.json]
//   scenarios.json: [{"l":"名前","s":{"TEAM":[[t,out,in],...]}}, ...]（scenlib直列化形式）
//   省略時: actual + 各交代を1件ずつ取り消す全変種（感度一覧）
import { RPDX, MATCHES } from "../test/load.mjs";

const E = RPDX.engine, S = RPDX.subs, SCN = RPDX.scenlib;
const [, , matchId, file] = process.argv;
const m = MATCHES[matchId] || Object.values(MATCHES)[0];
console.log(`# バッチ: ${m.meta.id}（決定論 — 同一入力は常に同一結果）`);

let entries;
if (file) {
  const { readFileSync } = await import("node:fs");
  entries = JSON.parse(readFileSync(file, "utf8")).map((o, i) => {
    const { scenario, validation } = SCN.parse(m, o);
    if (!validation.ok) console.error(`! ${o.l || i}: ${validation.errors.join(", ")}`);
    return { name: o.l || `#${i}`, scenario };
  });
} else {
  entries = [{ name: "actual", scenario: E.actualScenario(m) }];
  for (const team of E.teamKeys(m)) {
    const subs = E.actualScenario(m).subs[team];
    for (let i = 0; i < subs.length; i++) {
      const sc = S.createScenario(m, `${team}: 交代#${i + 1}(${Math.round(subs[i].t / 60)}')取消`, E.actualScenario(m));
      sc.subs[team] = subs.filter((_, j) => j !== i);
      entries.push({ name: sc.label, scenario: sc });
    }
  }
}

const t0 = Date.now();
const rows = SCN.batch(m, entries);
const keys = E.teamKeys(m);
const W = Math.max(...rows.map(r => r.name.length)) + 2;
console.log("名前".padEnd(W) + "スコア".padEnd(16) + "追加G".padEnd(6) + keys.map(k => `危険度μ(${k})`).join("  ") + "  首位フェーズ");
for (const r of rows) {
  console.log(r.name.padEnd(W) + r.score.padEnd(16) + String(r.added).padEnd(6)
    + keys.map(k => String(r.dangerMean[k]).padStart(10)).join("  ")
    + "  " + keys.map(k => `${k}:${r.topPhase[k]}`).join(" "));
}
console.log(`# ${rows.length}シナリオ / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
