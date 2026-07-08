// ARG-EGY マッチパック — 試合固有ファクトの固定（FIFA/ESPN照合済・2026-07-08）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine, PSY = RPDX.psy;
const M = MATCHES["wc2026-r16-arg-egy"];

test("argegy: パックが登録され既定試合は不変", () => {
  assert.ok(M);
  assert.equal(RPDX.data.MATCH.meta.id, "wc2026-r32-bra-jpn");
});

test("argegy: 最終スコア 3-2・得点者と分（逆転の順序）", () => {
  const goals = M.events.filter(e => e.type === "goal");
  assert.equal(M.meta.score.ARG, 3);
  assert.equal(M.meta.score.EGY, 2);
  // 順序: EGY(イブラヒム2) → EGY(ジコ11) → ARG(ロメロ13) → ARG(メッシ10) → ARG(エンソ24)
  assert.deepEqual(goals.map(g => [g.team, g.no]),
    [["EGY", 2], ["EGY", 11], ["ARG", 13], ["ARG", 10], ["ARG", 24]]);
  assert.deepEqual(goals.map(g => g.min), ["15'", "67'", "79'", "83'", "90+2'"]);
  // 2点ビハインドからの逆転: 67'直後は 0-2、終了時 3-2
  const after67 = E.scoreAt(M, goals[1].t + 30);
  assert.deepEqual([after67.ARG, after67.EGY], [0, 2]);
  const ft = E.scoreAt(M, E.playedRange(M).t1);
  assert.deepEqual([ft.ARG, ft.EGY], [3, 2]);
});

test("argegy: XI背番号（FIFA Tactical Line-up）", () => {
  const arg = Object.values(M.teams.ARG.phases[0].assign).sort((a, b) => a - b);
  const egy = Object.values(M.teams.EGY.phases[0].assign).sort((a, b) => a - b);
  assert.deepEqual(arg, [3, 5, 6, 7, 9, 10, 13, 20, 23, 24, 26]);
  assert.deepEqual(egy, [2, 3, 5, 8, 10, 11, 12, 15, 17, 19, 23]);
  // キャプテン: 両チーム10番
  assert.ok(M.teams.ARG.squad.find(p => p.no === 10).captain);
  assert.ok(M.teams.EGY.squad.find(p => p.no === 10).captain);
});

test("argegy: 交代 5+4件・イベント数（PKセーブ/VAR取消/警告4）", () => {
  assert.equal(M.subsActual.ARG.length, 5);
  assert.equal(M.subsActual.EGY.length, 4);
  assert.equal(M.events.filter(e => e.type === "save").length, 1);   // 21' PKセーブ
  assert.equal(M.events.filter(e => e.type === "shot").length, 1);   // 60' VAR取消
  const yels = M.events.filter(e => e.type === "yellow");
  assert.equal(yels.length, 4);
  assert.ok(yels.every(y => y.team === "EGY"));                      // 警告は全てエジプト側
});

test("argegy: 支配率がチェーン較正で実測64/36に近い（±3%）", () => {
  const sc = E.actualScenario(M);
  const st = E.possessionStats(M, sc, E.playedRange(M).t1);
  assert.ok(Math.abs(st.ARG - 0.64) < 0.03, `ARG ${st.ARG}`);
});

test("argegy: PSYモメンタム — 67'でEGY優位 → 90+2'でARGへ大反転", () => {
  const sc = E.actualScenario(M);
  const t67 = M.events.find(e => e.type === "goal" && e.no === 11).t;
  const t92 = M.events.find(e => e.type === "goal" && e.no === 24).t;
  const after67 = PSY.momentumAt(M, sc, t67 + 40);
  assert.ok(after67.EGY > 0.5, `67'後 EGY ${after67.EGY}`);
  assert.ok(after67.ARG < 0, `67'後 ARG ${after67.ARG}`);
  const after92 = PSY.momentumAt(M, sc, t92 + 40);
  assert.ok(after92.ARG > 0.5, `90+2後 ARG ${after92.ARG}`);
  assert.ok(after92.EGY < 0, `90+2後 EGY ${after92.EGY}`);
});

test("argegy: PSY覚醒 — 逆転クライマックス(90+2)は前半中盤より高覚醒", () => {
  const sc = E.actualScenario(M);
  const calm = PSY.playerAt(M, sc, "ARG", 24, 1500);
  const climax = PSY.playerAt(M, sc, "ARG", 24, 5740);
  assert.ok(climax.ar > calm.ar + 15, `${calm.ar} -> ${climax.ar}`);
  assert.ok(climax.hrv < calm.hrv, "HRVプロキシは終盤に低下");
});

test("argegy: サラーはフル出場・ジコは80'交代", () => {
  const sc = E.actualScenario(M);
  const salah = E.presenceOf(M, sc, "EGY", 10);
  assert.equal(salah.from, 0);
  assert.equal(salah.to, E.playedRange(M).t1);
  const ziko = E.presenceOf(M, sc, "EGY", 11);
  assert.ok(Math.abs(ziko.to - (2880 + 35 * 60)) < 1);   // 80' = m2(80)
});
