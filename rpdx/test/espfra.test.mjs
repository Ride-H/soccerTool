// FRA-ESP マッチパック — 試合固有ファクトの固定（ESPN/FIFA/国内詳報 照合済・2026-07-15）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger, PSY = RPDX.psy;
const M = MATCHES["wc2026-sf-fra-esp"];

test("espfra: パックが登録され既定試合は不変（テンプレ初期画面の規律とも整合）", () => {
  assert.ok(M);
  assert.equal(RPDX.data.MATCH.meta.id, "wc2026-r32-bra-jpn");
});

test("espfra: 最終スコア 0-2・得点者と分（22'PK オヤルサバル / 58' ポロ←オルモ）", () => {
  const goals = M.events.filter(e => e.type === "goal");
  assert.equal(M.meta.score.FRA, 0);
  assert.equal(M.meta.score.ESP, 2);
  assert.deepEqual(goals.map(g => [g.team, g.no]), [["ESP", 21], ["ESP", 12]]);
  assert.deepEqual(goals.map(g => g.min), ["22'", "58'"]);
  assert.equal(goals[1].assist, 10, "58' はオルモのアシスト（ワンツー）");
  const after22 = E.scoreAt(M, goals[0].t + 30);
  assert.deepEqual([after22.FRA, after22.ESP], [0, 1]);
  const ft = E.scoreAt(M, E.playedRange(M).t1);
  assert.deepEqual([ft.FRA, ft.ESP], [0, 2]);
});

test("espfra: XI背番号（ESPN/footballchannel 相互照合）・両軍4-2-3-1", () => {
  const fra = Object.values(M.teams.FRA.phases[0].assign).sort((a, b) => a - b);
  const esp = Object.values(M.teams.ESP.phases[0].assign).sort((a, b) => a - b);
  assert.deepEqual(fra, [3, 4, 5, 7, 8, 10, 11, 12, 14, 16, 17]);
  assert.deepEqual(esp, [8, 10, 12, 14, 15, 16, 19, 21, 22, 23, 24]);
  assert.equal(M.teams.FRA.phases[0].shape, "4231");
  assert.equal(M.teams.ESP.phases[0].shape, "4231");
  assert.ok(M.teams.FRA.squad.find(p => p.no === 10).captain, "エンバペが主将");
});

test("espfra: 交代 5+5件・決定機イベント（shot2/save1/警告1=エンバペ）", () => {
  assert.equal(M.subsActual.FRA.length, 5);
  assert.equal(M.subsActual.ESP.length, 5);
  assert.equal(M.events.filter(e => e.type === "shot").length, 2);   // 79'トーレス / 88'FK
  assert.equal(M.events.filter(e => e.type === "save").length, 1);   // 81'シモン
  const yels = M.events.filter(e => e.type === "yellow");
  assert.deepEqual(yels.map(y => [y.team, y.no]), [["FRA", 10]]);
});

test("espfra: 支配率がチェーン較正で実測49/51に近い（±3%）", () => {
  const sc = E.actualScenario(M);
  const st = E.possessionStats(M, sc, E.playedRange(M).t1);
  assert.ok(Math.abs(st.ESP - 0.51) < 0.03, `ESP ${st.ESP}`);
});

test("espfra: 両ゴール直前30秒に CRITICAL（危険度較正・警報の実体）", () => {
  const sc = E.actualScenario(M);
  for (const g of M.events.filter(e => e.type === "goal")) {
    let peak = 0;
    for (let t = g.t - 30; t <= g.t; t += 2) {
      const ix = D.indexAt(M, sc, t);
      peak = Math.max(peak, ix.ESP.total);
    }
    assert.ok(peak >= 75, `${g.min} 直前ピーク ${peak.toFixed(1)}`);
  }
});

test("espfra: PSYモメンタム — 先制/追加点後はスペイン優位", () => {
  const sc = E.actualScenario(M);
  const g2 = M.events.filter(e => e.type === "goal")[1];
  const after = PSY.momentumAt(M, sc, g2.t + 40);
  assert.ok(after.ESP > 0.5, `58'後 ESP ${after.ESP}`);
  assert.ok(after.FRA < 0, `58'後 FRA ${after.FRA}`);
});

test("espfra: 出場区間 — エンバペはフル出場・サリバは30'負傷交代・ポロは84'まで", () => {
  const sc = E.actualScenario(M);
  const mbappe = E.presenceOf(M, sc, "FRA", 10);
  assert.equal(mbappe.from, 0);
  assert.equal(mbappe.to, E.playedRange(M).t1);
  const saliba = E.presenceOf(M, sc, "FRA", 17);
  assert.ok(Math.abs(saliba.to - 30 * 60) < 1, `サリバ ${saliba.to}`);
  const porro = E.presenceOf(M, sc, "ESP", 12);
  assert.ok(Math.abs(porro.to - (2940 + 39 * 60)) < 1, `ポロ ${porro.to}`);  // 84' = m2(84)
});
