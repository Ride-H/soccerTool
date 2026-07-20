// ESP-ARG 決勝パック — 試合固有ファクトの固定（ESPN/Wikipedia/国内詳報 照合済・2026-07-20）
// 延長(120+5)・実試合レッドカード(90+3)・E・マルティネス11セーブ（W杯決勝最多）を含む
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger, PSY = RPDX.psy, S = RPDX.subs;
const M = MATCHES["wc2026-final-esp-arg"];

test("esparg: パックが登録され既定試合は不変（テンプレ初期画面の規律とも整合）", () => {
  assert.ok(M);
  assert.equal(RPDX.data.MATCH.meta.id, "wc2026-r32-bra-jpn");
});

test("esparg: 最終スコア 1-0（延長）— 106' F・トーレス←N・ウィリアムス", () => {
  const goals = M.events.filter(e => e.type === "goal");
  assert.equal(M.meta.score.ESP, 1);
  assert.equal(M.meta.score.ARG, 0);
  assert.equal(goals.length, 1);
  assert.deepEqual([goals[0].team, goals[0].no, goals[0].assist, goals[0].min], ["ESP", 7, 17, "106'"]);
  const at90 = E.scoreAt(M, M.time.h2.end - 1);
  assert.deepEqual([at90.ESP, at90.ARG], [0, 0], "90分時点は0-0");
  const ft = E.scoreAt(M, E.playedRange(M).t1);
  assert.deepEqual([ft.ESP, ft.ARG], [1, 0]);
});

test("esparg: XI背番号（ESPN/国内詳報 照合）— ESP 4-2-3-1・ARG 4-4-2→HTから4-1-3-2", () => {
  const esp = Object.values(M.teams.ESP.phases[0].assign).sort((a, b) => a - b);
  const arg = Object.values(M.teams.ARG.phases[0].assign).sort((a, b) => a - b);
  assert.deepEqual(esp, [8, 10, 12, 14, 15, 16, 19, 21, 22, 23, 24]);
  assert.deepEqual(arg, [3, 4, 6, 7, 9, 10, 13, 15, 20, 23, 24]);
  assert.equal(M.teams.ESP.phases[0].shape, "4231");
  assert.equal(M.teams.ARG.phases[0].shape, "442");
  assert.equal(M.teams.ARG.phases[1].shape, "4132");
  assert.equal(M.teams.ARG.phases[1].from, M.time.h2.start);
  assert.ok(M.teams.ARG.squad.find(p => p.no === 10).captain, "メッシが主将");
  assert.ok(M.teams.ESP.squad.find(p => p.no === 16).captain, "ロドリが主将");
});

test("esparg: 延長タイム軸 — 8340秒・時計105+/120+表示・エンド写像（#141）", () => {
  const range = E.playedRange(M);
  assert.equal(range.t1, 8340);
  assert.equal(range.ht, M.time.h1.end);
  // ピリオド判定と方向半の写像（延前=後半エンド / 延後=前半エンド）
  assert.equal(E.periodOf(M, 6500), 3);
  assert.equal(E.periodOf(M, 7500), 4);
  assert.equal(E.halfOf(M, 6500), 2, "延長前半は後半と同エンド");
  assert.equal(E.halfOf(M, 7500), 1, "延長後半は前半と同エンド");
  // 時計表示
  assert.equal(E.clockAt(M, M.time.h3.start).disp, "90:00");
  assert.equal(E.clockAt(M, 7200).disp, "106:00");
  assert.equal(E.clockAt(M, M.time.h3.start + 900 + 60).disp, "105+1:00");
  assert.equal(E.clockAt(M, 8340).disp, "120+5:00");
  // 分⇄秒（延長分の往復）。106'は105+1'と重なる境界のため、曖昧でない110'で往復を検証
  //（既存の分ピッカー規約: 重なる分は早いピリオドのストッページを優先）。
  assert.equal(S.tToMinute(M, 7200), 106);
  assert.equal(S.tToLabel(M, 8100), "120+1'");
  assert.ok(Math.abs(S.minuteToT(M, 110) - (M.time.h4.start + 5 * 60)) < 1, `minuteToT(110)=${S.minuteToT(M, 110)}`);
});

test("esparg: 交代 6+6 — 延長ルール（6人・4窓・延長窓≤1）で検証合格・7人目は拒否", () => {
  assert.equal(M.subsActual.ESP.length, 6);
  assert.equal(M.subsActual.ARG.length, 6);
  const v = S.validatePlan(M, M.subsActual, null);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.info.ESP.remaining, 0);
  assert.equal(v.info.ARG.remaining, 0);
  // 7人目（上限超過）は拒否される
  const over = { ESP: [...M.subsActual.ESP, { t: 7300, out: 19, in: 5 }], ARG: M.subsActual.ARG };
  assert.ok(!S.validatePlan(M, over, null).ok, "7人目が通ってはならない");
  // 延長で2窓目（別時刻）も拒否される
  const et2w = { ESP: [...M.subsActual.ESP.slice(0, 5), { t: 7300, out: 16, in: 18 }], ARG: M.subsActual.ARG };
  assert.ok(!S.validatePlan(M, et2w, null).ok, "延長2窓目が通ってはならない");
});

test("esparg: エンソ退場（90+3）— 在場終了・以降ARGは10人・保持者列に現れない", () => {
  const sc = E.actualScenario(M);
  const enzo = E.presenceOf(M, sc, "ARG", 24);
  assert.equal(enzo.from, 0);
  assert.ok(Math.abs(enzo.to - M.outagesActual.ARG[0].t) < 1, `エンソ ${enzo.to}`);
  // 退場前は22人・退場後は21人（ARG=10人）
  const before = E.stateAt(M, sc, 5700);
  assert.equal(before.players.filter(p => p.onPitch).length, 22);
  for (const t of [6300, 7500, 8300]) {
    const st = E.stateAt(M, sc, t);
    assert.equal(st.players.filter(p => p.onPitch && p.team === "ARG").length, 10, `t=${t} ARG`);
    assert.equal(st.players.filter(p => p.onPitch && p.team === "ESP").length, 11, `t=${t} ESP`);
    assert.ok(!st.players.some(p => p.onPitch && p.team === "ARG" && p.no === 24), `t=${t} エンソ不在`);
  }
  // チェーン保持者にも退場後のエンソは現れない
  for (let t = enzo.to + 5; t < 8330; t += 30) {
    const c = E.carrierAt(M, sc, t);
    assert.ok(!(c && c.team === "ARG" && c.no === 24), `t=${t} 退場者が保持`);
  }
});

test("esparg: イベント — E・マルティネスのセーブ11本・取消2件はgoal非計上・警告5+2枚目・赤1", () => {
  const saves = M.events.filter(e => e.type === "save");
  assert.equal(saves.length, 11, "W杯決勝最多11セーブ");
  assert.ok(saves.every(s => s.team === "ARG" && s.no === 23), "全てE・マルティネス");
  const yels = M.events.filter(e => e.type === "yellow");
  assert.deepEqual(yels.map(y => y.no), [6, 5, 13, 24, 20], "警告の順序と番号（5枚・うちエンソが2枚目で退場）");
  assert.ok(yels.every(y => y.team === "ARG"), "警告は全てARG");
  const reds = M.events.filter(e => e.type === "red");
  assert.deepEqual(reds.map(r => [r.team, r.no, r.min]), [["ARG", 24, "90+3'"]]);
  // 取消ゴール2件は shot として収録（goal ではない）
  const disallowed = M.events.filter(e => e.type === "shot" && /取消/.test(e.label));
  assert.equal(disallowed.length, 2);
  assert.deepEqual(disallowed.map(d => d.min), ["96'", "113'"]);
});

test("esparg: 支配率がチェーン較正で実測65/35に近い（±3%）", () => {
  const sc = E.actualScenario(M);
  const st = E.possessionStats(M, sc, E.playedRange(M).t1);
  assert.ok(Math.abs(st.ESP - 0.65) < 0.03, `ESP ${st.ESP}`);
});

test("esparg: 106'ゴール直前30秒に CRITICAL（危険度較正・警報の実体）", () => {
  const sc = E.actualScenario(M);
  const g = M.events.find(e => e.type === "goal");
  let peak = 0;
  for (let t = g.t - 30; t <= g.t; t += 2) {
    const ix = D.indexAt(M, sc, t);
    peak = Math.max(peak, ix.ESP.total);
  }
  assert.ok(peak >= 75, `106' 直前ピーク ${peak.toFixed(1)}`);
});

test("esparg: PSYモメンタム — 決勝点後はスペイン優位", () => {
  const sc = E.actualScenario(M);
  const g = M.events.find(e => e.type === "goal");
  const after = PSY.momentumAt(M, sc, g.t + 40);
  assert.ok(after.ESP > 0.5, `106'後 ESP ${after.ESP}`);
  assert.ok(after.ARG < 0, `106'後 ARG ${after.ARG}`);
});

test("esparg: 出場区間 — シモン/メッシはフル(125分)・トーレスは62'IN・アルバレスは102'OUT", () => {
  const sc = E.actualScenario(M);
  const t1 = E.playedRange(M).t1;
  for (const [team, no] of [["ESP", 23], ["ARG", 10], ["ARG", 23], ["ARG", 3]]) {
    const pr = E.presenceOf(M, sc, team, no);
    assert.equal(pr.from, 0);
    assert.equal(pr.to, t1, `${team}#${no} フル出場`);
  }
  const ft = E.presenceOf(M, sc, "ESP", 7);
  assert.ok(Math.abs(ft.from - M.subsActual.ESP[1].t) < 1, `トーレスIN ${ft.from}`);
  assert.equal(ft.to, t1);
  const alv = E.presenceOf(M, sc, "ARG", 9);
  assert.ok(Math.abs(alv.to - M.subsActual.ARG[5].t) < 1, `アルバレスOUT ${alv.to}`);
});
