// #127 ボール再合成＋保持者編集の通過保証 / #128 手動スコア修正（追加・減点）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, S = RPDX.scenlib, SUB = RPDX.subs, SIM = RPDX.sim;

// 記録ゴール±40s を避けた時刻グリッド（ボール編集はゴール再現アンカーと非干渉の時刻で検証）
const goalTs = MATCH.events.filter(e => e.type === "goal").map(e => e.t);
const safeT = (t) => goalTs.every(g => Math.abs(t - g) > 40);
const grid = (n) => {
  const out = [];
  let t = 760;
  while (out.length < n) { if (safeT(t)) out.push(t); t += 470; }
  return out;
};

test("#127 ボール編集10回（別時刻）: 全時刻で編集位置を通過・多重共存", () => {
  let sc = null;
  const targets = [];
  for (const [i, t] of grid(10).entries()) {
    const f = E.editFrameAt(MATCH, sc, t);
    f.ball.x += (i % 2 === 0 ? 12 : -12);
    f.ball.y += (i % 3) * 4 - 4;
    targets.push({ t, x: f.ball.x, y: f.ball.y });
    const r = S.scenarioFromFrame(MATCH, f, sc);
    assert.equal(r.ballMoved, 1, `round${i} ballMoved`);
    sc = r.scenario;
  }
  assert.equal(sc.editBall.length, 10, "10本の editBall 共存");
  for (const tg of targets) {
    const b = E.ballAt(MATCH, sc, tg.t);
    const d = Math.hypot(b.x - tg.x, b.y - tg.y);
    assert.ok(d < 2.0, `t=${tg.t} ボール通過誤差 ${d.toFixed(2)}m`);
  }
});

test("#127 保持者編集10回（別時刻）: 厳密通過＋ボールが足元に追随（吸着）", () => {
  let sc = null;
  const targets = [];
  const t1 = E.playedRange(MATCH).t1;
  // 安定保持（binding と同条件）の時刻を走査で見つけながら、ちょうど10回編集する
  let t = 760, lastPicked = -1e9;
  while (targets.length < 10 && t < t1 - 200) {
    const c = E.carrierAt(MATCH, sc, t);
    const b0 = E.ballAt(MATCH, sc, t);
    const ok = safeT(t) && t - lastPicked > 180
      && c && c.mode === "hold" && c.u > 0.75 && !c.restart && b0.free > 0.9;
    if (ok) {
      const f = E.editFrameAt(MATCH, sc, t);
      const p = f.players.find(q => q.team === c.team && q.no === c.no);
      p.x += 10; p.y += (p.y > 0 ? -7 : 7);
      targets.push({ t, team: c.team, no: c.no, x: p.x, y: p.y });
      sc = S.scenarioFromFrame(MATCH, f, sc).scenario;
      lastPicked = t;
      t += 180;
    } else t += 37;
  }
  assert.equal(targets.length, 10, `保持局面での編集 10 回`);
  for (const tg of targets) {
    const st = E.stateAt(MATCH, sc, tg.t);
    const p = st.players.find(q => q.team === tg.team && q.no === tg.no);
    const d = Math.hypot(p.x - tg.x, p.y - tg.y);
    assert.ok(d < 1.0, `t=${tg.t} 保持者通過誤差 ${d.toFixed(2)}m`);
    const bd = Math.hypot(st.ball.x - p.x, st.ball.y - p.y);
    assert.ok(bd < 1.6, `t=${tg.t} ボール追随 ${bd.toFixed(2)}m`);
  }
});

test("#127 複合（選手+ボール）: キー相異・グループ削除でボールも消える・往復・golden", () => {
  let sc = null;
  const keys = [];
  for (const [i, t] of grid(6).entries()) {
    const f = E.editFrameAt(MATCH, sc, t);
    const c = E.carrierAt(MATCH, sc, t);
    const mover = f.players.find(q => q.team === MATCH.possessionPlus && q.role !== "GK"
      && !(c && c.team === q.team && c.no === q.no));
    mover.x += 6 + i;
    f.ball.x += 9;
    sc = S.scenarioFromFrame(MATCH, f, sc).scenario;
    keys.push(E.scenarioKey(sc));
  }
  assert.equal(new Set(keys).size, 6, "キー全相異");
  // 往復
  const rt = S.parseBundle(MATCH, S.serializeBundle(MATCH, sc, null));
  assert.equal(E.scenarioKey(rt.scenario), E.scenarioKey(sc), "bundle往復キー一致");
  assert.equal(rt.scenario.editBall.length, 6);
  // グループ削除（先頭時刻）→ 選手アンカーとボールが同時に消える
  const t0 = sc.editBall[0].t;
  const r = S.withoutEditGroup(MATCH, sc, t0);
  assert.equal(r.removed, 2, "選手1+ボール1");
  assert.ok(r.scenario.editBall.every(b => Math.abs(b.t - t0) > 0.5));
  // golden: editBall 未使用世界は不変
  for (const m of Object.values(MATCHES)) {
    const act = E.actualScenario(m);
    const plain = SUB.createScenario(m, "p", act);
    const a = E.ballAt(m, plain, 2000), b = E.ballAt(m, act, 2000);
    assert.deepEqual([a.x, a.y], [b.x, b.y], m.meta.id);
  }
});

test("#128 追加点(manual): スコア+1・「記帳」ラベル・PSY中立（外的種別より小スイング）", () => {
  const r = SUB.withShockGoal(MATCH, SUB.fromActual(MATCH, "m"), { t: 1800, team: "JPN", kind: "manual" });
  assert.ok(r.validation.ok);
  const oc = SIM.outcome(MATCH, r.scenario);
  assert.equal(oc.score.JPN, 2);
  const g = oc.added.find(a => a.shock);
  assert.match(g.label, /手動スコア修正/);
  // PSY: manual(1.0) は ref-penalty(1.6) より小さいスイング（他ゴールと離れた70分・クランプ非飽和域で比較）
  const PSY = RPDX.psy;
  const swing = (kind) => {
    const sc = SUB.withShockGoal(MATCH, SUB.fromActual(MATCH, "k2"), { t: 4200, team: "JPN", kind }).scenario;
    SIM.attach(MATCH, sc);
    return PSY.momentumAt(MATCH, sc, 4240).BRA;
  };
  const mw = swing("manual"), rw = swing("ref-penalty");
  assert.ok(mw > rw + 0.1, `manual(${mw.toFixed(2)}) は誤審PK(${rw.toFixed(2)})より小さい負スイング`);
});

test("#128 減点: 記録ゴール取消でスコア-1・再現抑制・理由明示・実記録不変", () => {
  // 実試合 BRA 2-1 JPN。BRA の 56' カゼミーロ(3360s) を取消 → 1-1
  const r = SUB.withRemoveGoal(MATCH, SUB.fromActual(MATCH, "rm"), { team: "BRA", t: 3480 });
  assert.ok(r.validation.ok, JSON.stringify(r.validation.errors));
  const oc = SIM.outcome(MATCH, r.scenario);
  assert.equal(oc.score.BRA, 1, "BRA 2→1");
  assert.equal(oc.score.JPN, 1);
  const rm = oc.removed.find(x => x.reason.includes("手動取消"));
  assert.ok(rm && rm.team === "BRA");
  // 再現抑制: 取消ゴール時刻でボールはネット(−52.2 or +52.2)に固定されない
  SIM.attach(MATCH, r.scenario);
  const st = E.stateAt(MATCH, r.scenario, rm.t);
  assert.ok(Math.abs(Math.abs(st.ball.x) - 52.2) > 1.5, `ネット再現が抑制 ball.x=${st.ball.x.toFixed(1)}`);
  // 実記録（match.events）は不変
  assert.ok(MATCH.events.some(e => e.type === "goal" && e.team === "BRA" && e.t === rm.t));
});

test("#128 検証と規模: 存在しないゴール拒否・追加5+減点まで決定論・往復・golden", () => {
  const bad = SUB.withRemoveGoal(MATCH, SUB.fromActual(MATCH, "b"), { team: "JPN", t: 4000 });
  assert.ok(!bad.validation.ok, "±60秒に該当ゴールなし→拒否");
  // 追加5(manual) + 記録ゴール取消2（JPN 29' / BRA 56'）の複合
  let sc = SUB.fromActual(MATCH, "big");
  for (let i = 0; i < 5; i++)
    sc = SUB.withShockGoal(MATCH, sc, { t: 900 + i * 600, team: "JPN", kind: "manual" }).scenario;
  sc = SUB.withRemoveGoal(MATCH, sc, { team: "JPN", t: 1740 }).scenario;
  sc = SUB.withRemoveGoal(MATCH, sc, { team: "BRA", t: 3480 }).scenario;
  const oc = SIM.outcome(MATCH, sc);
  assert.equal(oc.score.JPN, 5, "1-1+5-1=5");   // 実1 +5 −1
  assert.equal(oc.score.BRA, 1);
  const oc2 = SIM.outcome(MATCH, sc);
  assert.deepEqual(oc2.score, oc.score, "決定論");
  const rt = S.parseBundle(MATCH, S.serializeBundle(MATCH, sc, null));
  assert.deepEqual(rt.scenario.removeGoals, sc.removeGoals);
  assert.deepEqual(rt.scenario.shockGoals, sc.shockGoals);
  // golden: 未指定は従来一致
  const plain = SIM.outcome(MATCH, SUB.fromActual(MATCH, "p"));
  assert.deepEqual(plain.score, { JPN: 1, BRA: 2 });
});
