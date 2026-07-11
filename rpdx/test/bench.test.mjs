// #40 性能予算（perf budget）— 代表操作の実行時間に上限を課し、退行をCIで検出する。
// 予算はローカル中央値の**数十倍**に設定 — 共有CIランナーの揺らぎに加え、node --test は
// テストファイルを並列実行するためCPU競合で数倍に膨らむ。桁が変わる退行だけを捕まえる。
// 精密計測は rpdx/tools/bench.mjs（単独実行）で行う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger;

const timeIt = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };

test("#40 budget: 再生ループ stateAt×300（warm）< 2000ms", () => {
  const sc = E.actualScenario(MATCH);
  E.stateAt(MATCH, sc, 50);                       // warm
  const ms = timeIt(() => { for (let i = 0; i < 300; i++) E.stateAt(MATCH, sc, 100 + i * 17.3); });
  assert.ok(ms < 2000, `${ms.toFixed(0)}ms（ローカル基準 ~22ms）`);
});

test("#40 budget: 危険度曲線 step8（cold）< 6000ms", () => {
  D.clearCaches();
  const ms = timeIt(() => D.curve(MATCH, E.actualScenario(MATCH), { step: 8, includeGK: false }));
  assert.ok(ms < 6000, `${ms.toFixed(0)}ms（ローカル基準 ~160ms）`);
});

test("#40 budget: チェーン構築（cold）< 2500ms", () => {
  E.clearCaches();
  const ms = timeIt(() => E.carrierAt(MATCH, E.actualScenario(MATCH), 3000));
  assert.ok(ms < 2500, `${ms.toFixed(0)}ms（ローカル基準 ~29ms）`);
});

test("#40 budget: 走行距離フルスイープ < 25000ms", () => {
  E.clearCaches();
  const ms = timeIt(() => E.distanceCovered(MATCH, E.actualScenario(MATCH), "JPN", 24, E.playedRange(MATCH).t1));
  assert.ok(ms < 25000, `${ms.toFixed(0)}ms（ローカル基準 ~1020ms — #39 の最適化対象）`);
});
