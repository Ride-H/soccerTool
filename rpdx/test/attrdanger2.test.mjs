// #106 能力値の効き拡張 v2 — att/tec/def→CPR/PLV・GK属性(def/aer)→危険度（較正保護）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger, S = RPDX.subs;

const avgOf = (sc, team, field = "total", t0 = 600, t1 = 5400) => {
  let a = 0, n = 0;
  for (let t = t0; t < t1; t += 45) {
    const ix = D.indexAt(MATCH, sc, t)[team];
    a += field === "total" ? ix.total : ix.mods[field];
    n++;
  }
  return a / n;
};

test("#106 較正保護: 未編集は全収録試合で total がビット一致（golden/OOS不変）", () => {
  for (const m of Object.values(MATCHES)) {
    const act = E.actualScenario(m);
    const plain = S.createScenario(m, "plain", act);
    const keys = E.teamKeys(m);
    for (let t = 400; t < 5000; t += 555) {
      const a = D.indexAt(m, act, t), b = D.indexAt(m, plain, t);
      for (const k of keys) assert.equal(a[k].total, b[k].total, `${m.meta.id} ${k}@${t}`);
    }
  }
});

test("#106 GK属性: 守備側GKの def/aer 強化で相手の危険度が下がる（弱体化で上がる）", () => {
  const act = E.actualScenario(MATCH);
  const plain = S.createScenario(MATCH, "p", act);
  const up = S.createScenario(MATCH, "up", act);
  up.attrOverrides = { JPN: { 1: { def: 99, aer: 99 } } };
  const dn = S.createScenario(MATCH, "dn", act);
  dn.attrOverrides = { JPN: { 1: { def: 30, aer: 30 } } };
  const base = avgOf(plain, "BRA"), u = avgOf(up, "BRA"), d = avgOf(dn, "BRA");
  assert.ok(u < base - 0.5, `GK強化で低下 ${base.toFixed(2)}→${u.toFixed(2)}`);
  assert.ok(d > base + 0.5, `GK弱体で上昇 ${base.toFixed(2)}→${d.toFixed(2)}`);
});

test("#106 CPR/PLV: 前線の att/tec 編集で CPR・PLV モジュール自体が動く", () => {
  const act = E.actualScenario(MATCH);
  const plain = S.createScenario(MATCH, "p", act);
  const nerf = S.createScenario(MATCH, "n", act);
  nerf.attrOverrides = { BRA: { 9: { att: 20, tec: 20 }, 7: { att: 20, tec: 20 }, 20: { att: 20, tec: 20 } } };
  const cpr0 = avgOf(plain, "BRA", "CPR"), cpr1 = avgOf(nerf, "BRA", "CPR");
  const plv0 = avgOf(plain, "BRA", "PLV"), plv1 = avgOf(nerf, "BRA", "PLV");
  assert.ok(cpr1 < cpr0, `CPR低下 ${cpr0.toFixed(2)}→${cpr1.toFixed(2)}`);
  assert.ok(plv1 < plv0, `PLV低下 ${plv0.toFixed(2)}→${plv1.toFixed(2)}`);
});

test("#106 def→レーン遮断/圧迫: 守備側 def 強化で相手の CPR+PLV が下がる", () => {
  const act = E.actualScenario(MATCH);
  const plain = S.createScenario(MATCH, "p", act);
  const wall = S.createScenario(MATCH, "w", act);
  wall.attrOverrides = { JPN: { 22: { def: 99 }, 3: { def: 99 }, 21: { def: 99 }, 24: { def: 99 }, 15: { def: 99 } } };
  const s0 = avgOf(plain, "BRA", "CPR") + avgOf(plain, "BRA", "PLV");
  const s1 = avgOf(wall, "BRA", "CPR") + avgOf(wall, "BRA", "PLV");
  assert.ok(s1 < s0, `CPR+PLV低下 ${s0.toFixed(2)}→${s1.toFixed(2)}`);
});

test("#106 有界・決定論: 極端編集でも効果はソフト（総合±30%以内）・同一入力=同一出力", () => {
  const act = E.actualScenario(MATCH);
  const plain = S.createScenario(MATCH, "p", act);
  const extreme = S.createScenario(MATCH, "x", act);
  extreme.attrOverrides = { JPN: { 1: { def: 99, aer: 99 }, 22: { def: 99 }, 3: { def: 99 } } };
  const base = avgOf(plain, "BRA"), x = avgOf(extreme, "BRA");
  assert.ok(x > base * 0.7 && x < base * 1.3, `有界 ${base.toFixed(2)}→${x.toFixed(2)}`);
  const extreme2 = S.createScenario(MATCH, "x2", act);
  extreme2.attrOverrides = { JPN: { 1: { def: 99, aer: 99 }, 22: { def: 99 }, 3: { def: 99 } } };
  assert.equal(avgOf(extreme2, "BRA"), x, "決定論");
});
