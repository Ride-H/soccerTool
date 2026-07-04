import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const S = RPDX.subs, E = RPDX.engine, D = RPDX.danger, SIM = RPDX.sim, F = RPDX.formations;

test("結果再構成: 得点者が不在ならそのゴールは消滅・スコアに反映", () => {
  // マルティネッリ(#22)投入を取消 → 90+5の決勝点は消える
  let sc = S.fromActual(MATCH, "マルティネッリ投入なし");
  sc.subs.BRA = sc.subs.BRA.filter(s => s.in !== 22);
  const oc = SIM.attach(MATCH, sc);
  assert.ok(oc.removed.some(r => r.no === 22), "マルティネッリのゴールが消滅リストにある");
  assert.equal(oc.score.BRA, 1, "ブラジル得点が1に減る");
  assert.equal(oc.actualScore.BRA, 2, "実試合は2");
  // 世界再構成: エンジンの最終スコアも1-1
  const st = E.stateAt(MATCH, sc, 6119);
  assert.equal(st.score.BRA, 1);
  assert.equal(st.score.JPN, 1);
  // タイムラインからも該当ゴールイベントが消える
  const evs = E.eventsOf(MATCH, sc);
  assert.ok(!evs.some(e => e.type === "goal" && e.team === "BRA" && e.no === 22 && !e.sim));
});

test("結果再構成: 決定論 — 同一シナリオは常に同一結末", () => {
  const build = () => {
    let sc = S.fromActual(MATCH, "x");
    sc.subs.BRA = sc.subs.BRA.filter(s => s.in !== 22);
    return SIM.outcome(MATCH, sc);
  };
  const a = build(), b = build();
  assert.equal(a.sig, b.sig);
  assert.deepEqual(a.score, b.score);
  assert.deepEqual(a.added.map(g => [g.t, g.team, g.no]), b.added.map(g => [g.t, g.team, g.no]));
});

test("結果再構成: 攻撃強化シナリオは追加ゴールを生みうる（決定論ポアソン）", () => {
  // 日本を4-4-2化（開始から） → 機会増でJPNに追加ゴール
  let sc = S.fromActual(MATCH, "日本442");
  const r = S.withFormation(MATCH, sc, "JPN", 0, "442");
  assert.ok(r.validation.ok, r.validation.errors.join("/"));
  const oc = SIM.attach(MATCH, r.scenario);
  assert.ok(oc.teamDelta.JPN.deltaPct > oc.teamDelta.BRA.deltaPct, "日本の機会創出Δが相対的に増える");
  // 追加ゴールがあれば得点者はピッチ上のGK以外
  for (const g of oc.added) {
    const pr = E.presenceOf(MATCH, r.scenario, g.team, g.no);
    assert.ok(pr && g.t >= pr.from && g.t <= pr.to, `${g.no} は得点時刻にピッチ上`);
    const p = MATCH.teams[g.team].squad.find(q => q.no === g.no);
    assert.notEqual(p.pos, "GK", "GKは得点者にならない");
  }
});

test("結果再構成: 実試合と同一構成のシナリオは結果不変（sig=0近傍でも無変化）", () => {
  // 実試合の交代をそのまま持つシナリオ → 消滅も追加もなし
  const sc = S.fromActual(MATCH, "実試合コピー");
  const oc = SIM.outcome(MATCH, sc);
  assert.equal(oc.removed.length, 0, "消滅ゴールなし");
  assert.equal(oc.score.BRA, oc.actualScore.BRA);
  assert.equal(oc.score.JPN, oc.actualScore.JPN);
});

test("結果再構成: outcome適用後もスクラブ完全一致（決定論・純関数）", () => {
  let sc = S.fromActual(MATCH, "det");
  sc.subs.BRA = sc.subs.BRA.filter(s => s.in !== 22);
  SIM.attach(MATCH, sc);
  for (const t of [1000, 3600, 5800, 6100]) {
    const a = E.stateAt(MATCH, sc, t);
    const b = E.stateAt(MATCH, sc, t);
    assert.deepEqual(a.players.map(p => [p.no, p.x, p.y]), b.players.map(p => [p.no, p.x, p.y]), `t=${t}`);
  }
});
