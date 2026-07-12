// #45 決定論ポリシー探索（research・軽量）— ランキング降順・決定論・validator・基準の存在
// モデル上の探索であり実試合の予測ではない。格子は小さく保つ（≤12候補・<30s）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const E = RPDX.engine, P = RPDX.policy, S = RPDX.subs, F = RPDX.formations;

const OPTS = { formations: ["442", "4231"], minutes: [46, 60] };   // 2×2 + 基準 = 5候補

test("#45 policy: envSpec は行動空間メタを返す（陣形は F.SHAPES と一致）", () => {
  const spec = P.envSpec(MATCH, "JPN");
  assert.equal(spec.team, "JPN");
  assert.deepEqual(spec.formations, Object.keys(F.SHAPES), "陣形集合");
  assert.ok(spec.minutesRange[0] >= 1 && spec.minutesRange[1] <= 90, "分レンジ");
  assert.equal(spec.subWindows, 3, "交代機会");
  assert.deepEqual(spec, P.envSpec(MATCH, "JPN"), "決定論");
});

test("#45 policy: objective は決定論スカラ（同一シナリオ=同一値）", () => {
  const sc = S.fromActual(MATCH, "obj-test");
  const v = P.objective(MATCH, sc, "JPN");
  assert.equal(typeof v, "number");
  assert.ok(Number.isFinite(v), "有限値");
  assert.equal(P.objective(MATCH, sc, "JPN"), v, "決定論");
});

test("#45 policy: gridSearch はランキング降順・決定論・候補は全て validator 合格", () => {
  const ranked = P.gridSearch(MATCH, "JPN", OPTS, 20);
  assert.ok(ranked.length >= 3 && ranked.length <= 12, `候補数 ${ranked.length}（≤12）`);
  // 降順（value 単調非増加）
  for (let i = 1; i < ranked.length; i++)
    assert.ok(ranked[i].value <= ranked[i - 1].value + 1e-12,
      `降順違反 ${ranked[i - 1].value} → ${ranked[i].value}`);
  // 各候補は形が揃い、validateScenario 合格
  for (const r of ranked) {
    assert.ok(typeof r.label === "string" && r.label, "label");
    assert.equal(typeof r.value, "number", "value");
    assert.ok(/[A-Z]{3}\s\d/.test(r.score), `score 文字列 ${r.score}`);
    assert.ok(S.validateScenario(MATCH, r.scenario).ok, `validator 合格: ${r.label}`);
  }
  // 決定論: 再実行で同一ランキング（label と value の列が一致）
  const again = P.gridSearch(MATCH, "JPN", OPTS, 20);
  assert.deepEqual(again.map(r => [r.label, r.value]), ranked.map(r => [r.label, r.value]), "決定論");
});

test("#45 policy: 実試合の基準がランキング内に存在し、比較可能", () => {
  const ranked = P.gridSearch(MATCH, "JPN", OPTS, 20);
  const base = ranked.find(r => /基準/.test(r.label));
  assert.ok(base, "実試合（基準）候補が含まれる");
  // 基準の value は actual シナリオの objective と整合（結果再構成の同値コピー）
  const baseObj = P.objective(MATCH, base.scenario, "JPN");
  assert.ok(Math.abs(base.value - baseObj) < 1e-9, "基準 objective 一致");
  // 少なくとも1候補が基準と異なる value を持つ（探索に意味がある＝順序が付く）
  assert.ok(ranked.some(r => Math.abs(r.value - base.value) > 1e-6), "候補間に差がある");
});
