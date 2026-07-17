// #117 守備構造解析 v1 — 守備側帰属ビュー(v1a)＋守備ブロック読み出し(v1b)・読み取り専用
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, T = RPDX.tactics, S = RPDX.subs;
const ESPFRA = MATCHES["wc2026-sf-fra-esp"];

test("#117 v1a: 帰属ビュー — 守備の物語が数値化される（ESPは被CPR/被TRVが小さい）", () => {
  const prof = T.defenseProfile(ESPFRA, null);
  const c = prof.conceded;
  assert.ok(prof.samples > 30);
  assert.ok(c.ESP.CPR < c.FRA.CPR, `被CPR: ESP ${c.ESP.CPR} < FRA ${c.FRA.CPR}`);
  assert.ok(c.ESP.TRV < c.FRA.TRV * 0.75, `被TRV(カウンター抑止): ESP ${c.ESP.TRV} << FRA ${c.FRA.TRV}`);
  for (const k of E.teamKeys(ESPFRA))
    for (const v of Object.values(c[k])) assert.ok(v >= 0 && isFinite(v));
});

test("#117 v1b: ブロック — 非保持時のみ・GK除外・低ブロックの判別（JPN vs BRA）", () => {
  const bJ = T.defenseBlock(MATCH, null, "JPN");
  const bB = T.defenseBlock(MATCH, null, "BRA");
  assert.ok(bJ && bB);
  assert.ok(bJ.lineHeight < bB.lineHeight - 5, `JPN低ブロック line ${bJ.lineHeight} << BRA ${bB.lineHeight}`);
  assert.ok(bJ.depth < bB.depth - 10, `JPNコンパクト depth ${bJ.depth} << BRA ${bB.depth}`);
  // 値域
  for (const b of [bJ, bB]) {
    assert.ok(b.lineHeight > 0 && b.lineHeight < 52.5);
    assert.ok(b.width > 0 && b.width < 68 && b.depth > 0 && b.depth < 105);
    assert.ok(b.centralClosure >= 0 && b.centralClosure <= 1);
  }
});

test("#117 v1b: 保持中は null（非保持時のみの読み出し）", () => {
  const range = E.playedRange(MATCH);
  let nulls = 0, vals = 0;
  for (let t = range.t0 + 60; t < range.t1; t += 97) {
    const c = E.carrierAt(MATCH, null, t);
    if (!c || c.mode !== "hold") continue;
    const b = T.defenseBlockAt(MATCH, null, c.team, t);
    if (b === null) nulls++; else vals++;
  }
  assert.ok(nulls > 20 && vals === 0, `保持側は常にnull (null=${nulls}, val=${vals})`);
});

test("#117 #106接続: def 上書きで中央閉鎖度が上がる（dwDefがレーン遮断に効く）", () => {
  const act = E.actualScenario(MATCH);
  const plain = S.createScenario(MATCH, "p", act);
  const wall = S.createScenario(MATCH, "w", act);
  wall.attrOverrides = { JPN: { 22: { def: 99 }, 3: { def: 99 }, 21: { def: 99 }, 24: { def: 99 }, 15: { def: 99 } } };
  const c0 = T.defenseBlock(MATCH, plain, "JPN").centralClosure;
  const c1 = T.defenseBlock(MATCH, wall, "JPN").centralClosure;
  assert.ok(c1 > c0, `中央閉鎖 ${c0}→${c1}`);
});

test("#117 読み取り専用・決定論: 呼び出し前後で世界不変・同一入力=同一出力", () => {
  const act = E.actualScenario(MATCH);
  const sig = () => E.stateAt(MATCH, act, 3000).players.map(p => [p.team, p.no, +p.x.toFixed(6)]);
  const before = sig();
  const p1 = T.defenseProfile(MATCH, null);
  const b1 = T.defenseBlock(MATCH, null, "JPN");
  assert.deepEqual(sig(), before, "世界状態は不変（読み取り専用）");
  assert.deepEqual(T.defenseProfile(MATCH, null), p1, "決定論(profile)");
  assert.deepEqual(T.defenseBlock(MATCH, null, "JPN"), b1, "決定論(block)");
});

test("#117 全パック横断: profile/block が全収録試合で健全に算出", () => {
  for (const m of Object.values(MATCHES)) {
    const prof = T.defenseProfile(m, null);
    assert.ok(prof.samples > 20, m.meta.id);
    for (const k of E.teamKeys(m)) {
      const b = T.defenseBlock(m, null, k);
      assert.ok(b && b.samples > 5, `${m.meta.id} ${k}`);
    }
  }
});
