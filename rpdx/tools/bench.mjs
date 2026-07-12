#!/usr/bin/env node
// #40 ベンチマーク・ハーネス（依存ゼロ・決定論ワークロード）
//   node rpdx/tools/bench.mjs [--json]
// 代表操作の実行時間を計測する。エンジンは決定論なのでワークロードのノイズが小さく、
// 最適化(#39/#38)の効果測定と退行検出の基準になる。
import { RPDX, MATCH, MATCHES } from "../test/load.mjs";

const E = RPDX.engine, D = RPDX.danger, SIM = RPDX.sim, S = RPDX.subs, PHYS = RPDX.physio;
const json = process.argv.includes("--json");

const ops = [
  ["buildChain(cold)", () => {                       // チェーン構築（全キャッシュ破棄から）
    E.clearCaches();
    E.carrierAt(MATCH, E.actualScenario(MATCH), 3000);
  }],
  ["stateAt x300(warm)", () => {                     // 再生ループの本体（1フレーム=1回）
    const sc = E.actualScenario(MATCH);
    for (let i = 0; i < 300; i++) E.stateAt(MATCH, sc, 100 + i * 17.3);
  }],
  ["danger.curve(step8, cold)", () => {              // タイムライン曲線（起動コストの主部）
    D.clearCaches && D.clearCaches();
    D.curve(MATCH, E.actualScenario(MATCH), { step: 8, includeGK: false });
  }],
  ["SIM.outcome(what-if)", () => {                   // 結果再構成（シナリオ切替のコスト）
    const sc = S.createScenario(MATCH, "bench", E.actualScenario(MATCH));
    sc.subs.BRA = sc.subs.BRA.slice(0, -1);
    SIM.outcome(MATCH, sc);
  }],
  ["physio.summary(1player)", () => {                // インスペクタ系の重い集計
    PHYS.clearCaches && PHYS.clearCaches();
    PHYS.summary(MATCH, E.actualScenario(MATCH), "JPN", 24);
  }],
  ["distanceCovered(full)", () => {                  // 走行距離（1秒スイープ）
    E.clearCaches();
    E.distanceCovered(MATCH, E.actualScenario(MATCH), "JPN", 24, E.playedRange(MATCH).t1);
  }],
];

// 各操作: ウォームアップ1回 + 3回計測の中央値
const rows = [];
for (const [name, fn] of ops) {
  fn();
  const times = [];
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  rows.push({ name, ms: +times[1].toFixed(1), min: +times[0].toFixed(1), max: +times[2].toFixed(1) });
}

if (json) {
  console.log(JSON.stringify({ date: "-", node: process.version, rows }, null, 1));
} else {
  console.log("# RPD-X ベンチ（中央値/3回・決定論ワークロード）");
  const W = Math.max(...rows.map(r => r.name.length)) + 2;
  for (const r of rows) console.log(r.name.padEnd(W) + String(r.ms).padStart(8) + " ms  (min " + r.min + " / max " + r.max + ")");
  console.log("total".padEnd(W) + String(+rows.reduce((a, r) => a + r.ms, 0).toFixed(1)).padStart(8) + " ms");
}
