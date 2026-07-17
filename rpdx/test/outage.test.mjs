// #81 数的不利（退場・交代枠なし負傷）— 10 vs 11 の what-if（golden安全）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, S = RPDX.subs, D = RPDX.danger, SIM = RPDX.sim, SCN = RPDX.scenlib;

const mkOutage = (t = 3600, no = 9, team = "BRA") =>
  S.withOutage(MATCH, S.fromActual(MATCH, "outage"), team, { t, no, kind: "red-card" });

test("#81 withOutage: 検証OK・退場後は21人（当該チーム10人）・退場者不在", () => {
  const r = mkOutage();
  assert.ok(r.validation.ok, JSON.stringify(r.validation.errors));
  assert.equal(r.dropped, 1, "退場者の後続交代(66')は自動取り下げ");
  const sc = r.scenario;
  const before = E.stateAt(MATCH, sc, 3500).players.filter(p => p.onPitch);
  const after = E.stateAt(MATCH, sc, 3700).players.filter(p => p.onPitch);
  assert.equal(before.length, 22);
  assert.equal(after.length, 21);
  assert.equal(after.filter(p => p.team === "BRA").length, 10);
  assert.ok(!after.some(p => p.team === "BRA" && p.no === 9), "退場者はピッチ上に不在");
});

test("#81 リシェイプ: 10人シェイプへ決定論再割当・GK維持・スロット10", () => {
  const sc = mkOutage().scenario;
  const ros = E.rosterAt(MATCH, sc, "BRA", 3700);
  assert.ok(ros.shape.startsWith("10_"), `10人シェイプ ${ros.shape}`);
  assert.equal(Object.keys(ros.assign).length, 10);
  const gkNo = ros.assign.GK;
  assert.equal(MATCH.teams.BRA.squad.find(p => p.no === gkNo).pos, "GK", "GKスロットはGK");
  // reshape 指定も通る
  const r2 = S.withOutage(MATCH, S.fromActual(MATCH, "o2"), "BRA", { t: 3600, no: 9, reshape: "10_531" });
  assert.ok(r2.validation.ok);
  assert.equal(E.rosterAt(MATCH, r2.scenario, "BRA", 3700).shape, "10_531");
});

test("#81 チェーン整合: 退場者は保持者に選ばれない（binding前提の維持）", () => {
  const sc = mkOutage().scenario;
  let bad = 0;
  for (let t = 3610; t < 5900; t += 23) {
    const c = E.carrierAt(MATCH, sc, t);
    if (c && c.team === "BRA" && c.no === 9) bad++;
  }
  assert.equal(bad, 0);
});

test("#81 現実性: 退場側の支配率が下がり・相手の危険度が上がる（方向的・決定論）", () => {
  const sc = mkOutage().scenario;
  const plain = S.createScenario(MATCH, "plain", E.actualScenario(MATCH));
  const t1 = E.playedRange(MATCH).t1;
  const p10 = E.possessionStats(MATCH, sc, t1).BRA;
  const p11 = E.possessionStats(MATCH, plain, t1).BRA;
  assert.ok(p10 < p11 - 0.03, `支配率低下 ${p11.toFixed(3)}→${p10.toFixed(3)}`);
  let d10 = 0, d11 = 0, n = 0;
  for (let t = 3660; t < 5700; t += 45) { d10 += D.indexAt(MATCH, sc, t).JPN.total; d11 += D.indexAt(MATCH, plain, t).JPN.total; n++; }
  assert.ok(d10 / n > d11 / n * 1.15, `相手危険度上昇 ${(d11 / n).toFixed(2)}→${(d10 / n).toFixed(2)}`);
  // 決定論
  const sc2 = mkOutage().scenario;
  assert.deepEqual(SIM.outcome(MATCH, sc2).score, SIM.outcome(MATCH, sc).score);
});

test("#81 golden安全: outages 未指定の世界は従来とビット一致・hash不変", () => {
  const act = E.actualScenario(MATCH);
  const plain = S.createScenario(MATCH, "plain", act);
  const a = E.stateAt(MATCH, plain, 4000).players.map(p => [p.team, p.no, +p.x.toFixed(6), +p.y.toFixed(6)]);
  const b = E.stateAt(MATCH, act, 4000).players.map(p => [p.team, p.no, +p.x.toFixed(6), +p.y.toFixed(6)]);
  assert.deepEqual(a, b);
  // possessionAt: scenario無し/outages無しは同値
  for (let t = 100; t < 6000; t += 777)
    assert.equal(E.possessionAt(MATCH, t), E.possessionAt(MATCH, t, plain));
});

test("#81 検証: GK退場拒否・チーム2件目拒否・在場外拒否・presence終了", () => {
  const base = S.fromActual(MATCH, "v");
  assert.ok(!S.withOutage(MATCH, base, "JPN", { t: 3600, no: 1 }).validation.ok, "GK拒否");
  const one = mkOutage().scenario;
  assert.ok(!S.withOutage(MATCH, one, "BRA", { t: 4000, no: 7 }).validation.ok, "2件目拒否");
  assert.ok(!S.withOutage(MATCH, base, "JPN", { t: 100, no: 8 }).validation.ok, "未投入選手(久保)の退場拒否");
  const pres = E.presenceOf(MATCH, mkOutage().scenario, "BRA", 9);
  assert.equal(pres.to, 3600);
});

test("#81 直列化: serialize/parse・bundle 往復で outages と世界が一致", () => {
  const sc = mkOutage().scenario;
  const r1 = SCN.parse(MATCH, SCN.serialize(sc));
  assert.ok(r1.validation.ok);
  assert.equal(E.scenarioHash(r1.scenario), E.scenarioHash(sc), "scenlib往復");
  const r2 = SCN.parseBundle(MATCH, SCN.serializeBundle(MATCH, sc, null));
  assert.ok(r2.validation.ok);
  assert.equal(E.scenarioHash(r2.scenario), E.scenarioHash(sc), "bundle往復");
});

test("#81 全パック横断: 各収録試合で退場what-ifが成立（22→21・決定論）", () => {
  for (const m of Object.values(MATCHES)) {
    const [a] = m.teamOrder;
    // 先発の非GKフィールド選手を1人選ぶ
    const assign = m.teams[a].phases[0].assign;
    const no = Object.entries(assign).find(([s]) => s !== "GK")[1];
    const r = S.withOutage(m, S.fromActual(m, "x"), a, { t: 1800, no });
    assert.ok(r.validation.ok, `${m.meta.id}: ${JSON.stringify(r.validation.errors)}`);
    const st = E.stateAt(m, r.scenario, 2400).players.filter(p => p.onPitch);
    assert.equal(st.length, 21, m.meta.id);
  }
});
