// #80 外的失点（仮説）の注入と巻き返しビルダー — 危険度非連動・golden安全・非帰属
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, S = RPDX.subs, SIM = RPDX.sim, SCN = RPDX.scenlib, PSY = RPDX.psy;

const withShock = (t = 1800, team = "JPN", kind = "ref-penalty") =>
  S.withShockGoal(MATCH, S.fromActual(MATCH, "shock"), { t, team, kind });

test("#80 注入: 危険度に依存せず必ず計上・得点者は非特定（no=null）・決定論", () => {
  const r = withShock();
  assert.ok(r.validation.ok);
  const oc = SIM.outcome(MATCH, r.scenario);
  assert.equal(oc.score.JPN, 2, "実試合1+仮定1");
  const sg = oc.added.find(a => a.shock);
  assert.ok(sg && sg.no === null && sg.kind === "ref-penalty");
  assert.match(sg.label, /仮定/);
  assert.match(sg.detail, /断定ではありません/);
  const oc2 = SIM.outcome(MATCH, withShock().scenario);
  assert.deepEqual(oc2.score, oc.score, "決定論");
});

test("#80 golden安全: shockGoals 未指定の outcome/世界は従来と一致", () => {
  const plain = S.fromActual(MATCH, "plain");
  const oc = SIM.outcome(MATCH, plain);
  assert.deepEqual(oc.score, { JPN: 1, BRA: 2 }, "実試合再現");
  assert.ok(!oc.added.some(a => a.shock));
  // 通常追加ゴールの抽選は shock の有無に依存しない（sHash 同一）
  const shock = withShock().scenario;
  const ocS = SIM.outcome(MATCH, shock);
  assert.deepEqual(ocS.added.filter(a => !a.shock).map(a => [a.t, a.no]),
    oc.added.filter(a => !a.shock).map(a => [a.t, a.no]), "危険度連動ゴールは独立");
});

test("#80 PSY: 仮定失点でモメンタムが被弾側に大きく振れる（kind重み単調）", () => {
  const base = S.fromActual(MATCH, "b");
  const t = 1800;
  const swing = (kind) => {
    const sc = S.withShockGoal(MATCH, S.fromActual(MATCH, "k"), { t, team: "JPN", kind }).scenario;
    SIM.attach(MATCH, sc);
    return PSY.momentumAt(MATCH, sc, t + 40).BRA;   // 被弾側（負）
  };
  const pen = swing("ref-penalty"), setp = swing("set-piece");
  assert.ok(pen < 0 && setp < 0, "被弾側は負");
  assert.ok(pen <= setp, `誤審PK(${pen.toFixed(2)})はセットピース(${setp.toFixed(2)})以上のスイング`);
  SIM.attach(MATCH, base);
});

test("#80/#128 検証: 未知kind拒否・時刻外拒否・チーム毎6件目拒否（上限5）", () => {
  assert.ok(!S.withShockGoal(MATCH, S.fromActual(MATCH, "v"), { t: 1800, team: "JPN", kind: "meteor" }).validation.ok);
  assert.ok(!S.withShockGoal(MATCH, S.fromActual(MATCH, "v"), { t: 9e9, team: "JPN", kind: "deflection" }).validation.ok);
  let sc = S.fromActual(MATCH, "v");
  for (let i = 0; i < 5; i++)
    sc = S.withShockGoal(MATCH, sc, { t: 900 + i * 600, team: "JPN", kind: "manual" }).scenario;
  assert.equal(sc.shockGoals.length, 5, "5件まで可");
  const r6 = S.withShockGoal(MATCH, sc, { t: 4800, team: "JPN", kind: "manual" });
  assert.ok(!r6.validation.ok, "6件目拒否");
});

test("#80 直列化: serialize/parse・bundle 往復で shockGoals 保存", () => {
  const sc = withShock().scenario;
  const r1 = SCN.parse(MATCH, SCN.serialize(sc));
  assert.deepEqual(r1.scenario.shockGoals, sc.shockGoals);
  const r2 = SCN.parseBundle(MATCH, SCN.serializeBundle(MATCH, sc, null));
  assert.deepEqual(r2.scenario.shockGoals, sc.shockGoals);
});

test("#80(B) 巻き返し: ビハインド側を特定し最終ビハインド区間の開始から介入・降順ランク・決定論", () => {
  const behind = S.withShockGoal(MATCH, S.fromActual(MATCH, "behind"), { t: 1200, team: "BRA", kind: "deflection" }).scenario;
  const res = SCN.recoveryPlans(MATCH, behind);
  assert.equal(res.trailer, "JPN");
  assert.ok(res.minute >= 50 && res.minute <= 60, `介入分 ${res.minute}（56'失点直後）`);
  assert.ok(res.plans.length >= 1);
  for (let i = 1; i < res.plans.length; i++)
    assert.ok(res.plans[i - 1].objective >= res.plans[i].objective, "降順");
  for (const p of res.plans) assert.ok(p.validation.ok && p.scenario && typeof p.objective === "number");
  const res2 = SCN.recoveryPlans(MATCH, behind);
  assert.deepEqual(res2.plans.map(p => [p.id, p.objective]), res.plans.map(p => [p.id, p.objective]), "決定論");
});

test("#80(B) 同点・リード時はプランなし／全パックで安全に動作", () => {
  for (const m of Object.values(MATCHES)) {
    const res = SCN.recoveryPlans(m, S.fromActual(m, "x"));
    // 収録試合はどれも決着つき → trailer が立つ（同点なら null で plans 空）
    if (res.trailer) {
      assert.ok(res.plans.every(p => p.validation.ok), m.meta.id);
    } else {
      assert.equal(res.plans.length, 0);
    }
  }
});
