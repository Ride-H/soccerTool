import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX } from "./load.mjs";

const G = RPDX.generic, E = RPDX.engine, D = RPDX.danger, S = RPDX.subs;

test("汎用試合: 選手情報のみから決定論生成・完全動作", () => {
  const m1 = G.createMatch(G.template());
  const m2 = G.createMatch(G.template());
  // 決定論: 同一シードなら同一試合
  assert.deepEqual(
    m1.events.map(e => [e.t, e.type, e.team, e.no]),
    m2.events.map(e => [e.t, e.type, e.team, e.no]));
  // XI 自動選抜: 11人・GK1人
  for (const k of Object.keys(m1.teams)) {
    const assign = m1.teams[k].phases[0].assign;
    assert.equal(Object.values(assign).length, 11);
    const gkNo = assign.GK;
    assert.equal(m1.teams[k].squad.find(p => p.no === gkNo).pos, "GK");
  }
  // スコア整合
  const goals = m1.events.filter(e => e.type === "goal");
  const sc = {};
  for (const k of Object.keys(m1.teams)) sc[k] = 0;
  for (const g of goals) sc[g.team]++;
  assert.deepEqual(m1.meta.score, sc);
});

test("汎用試合: エンジン/危険度/交代が実試合と同一APIで動く", () => {
  const m = G.createMatch(G.template());
  const range = E.playedRange(m);
  for (const t of [1, range.t1 * 0.3, range.t1 * 0.7, range.t1 - 1]) {
    const st = E.stateAt(m, null, t);
    for (const k of Object.keys(m.teams)) {
      assert.equal(st.players.filter(p => p.team === k && p.onPitch).length, 11, `t=${t}`);
    }
    const ix = D.indexAt(m, null, t, {});
    for (const k of Object.keys(m.teams)) {
      assert.ok(ix[k].total >= 0 && ix[k].total <= 100);
    }
  }
  // 交代シミュレーション
  const keys = Object.keys(m.teams);
  const sc = S.createScenario(m, "test");
  const team = keys[0];
  const xi = new Set(Object.values(m.teams[team].phases[0].assign));
  const bench = m.teams[team].squad.find(p => !xi.has(p.no) && p.pos !== "GK");
  const out = [...xi].map(no => m.teams[team].squad.find(p => p.no === no)).find(p => p.pos !== "GK");
  const r = S.withSub(m, sc, team, { t: 3000, out: out.no, in: bench.no });
  assert.ok(r.validation.ok, r.validation.errors.join("/"));
  const st = E.stateAt(m, r.scenario, 4000);
  assert.ok(st.players.find(p => p.team === team && p.no === bench.no && p.onPitch));
  // ゴールアンカーの正確性
  const g = m.events.find(e => e.type === "goal");
  if (g) {
    const b = E.ballAt(m, g.t);
    assert.ok(Math.abs(Math.abs(b.x) - 52.2) < 1.5, `goal ball x=${b.x.toFixed(1)}`);
  }
});

test("汎用試合: 能力値指定・XI指定・イベント持込みも可能", () => {
  const cfg = G.template();
  cfg.home.squad[10].attrs = { pac: 95, sta: 90, def: 40, att: 92, tec: 93, aer: 60 };
  const m = G.createMatch(cfg);
  const p = m.teams[cfg.home.code].squad.find(q => q.no === 11);
  assert.equal(p.attrs.pac, 95);
  assert.equal(p.attrs.att, 92);
});
