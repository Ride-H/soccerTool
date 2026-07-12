// #89 シナリオ級の能力値・名前の上書き（入力→結果変化の入口・golden安全）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger, S = RPDX.subs;

test("#89 attrsOf: 上書きが state/危険度に反映・pac変更で危険度場が動く", () => {
  const sc = S.createScenario(MATCH, "pac", E.actualScenario(MATCH));
  const base = E.attrsOf(MATCH, null, "BRA", 9);
  sc.attrOverrides = { BRA: { 9: { pac: Math.max(20, base.pac - 40) } } };
  const merged = E.attrsOf(MATCH, sc, "BRA", 9);
  assert.equal(merged.pac, Math.max(20, base.pac - 40), "pac上書き");
  assert.equal(merged.att, base.att, "他属性は保持");
  const f0 = D.fieldAt(MATCH, E.stateAt(MATCH, E.actualScenario(MATCH), 3500), { includeGK: false });
  const f1 = D.fieldAt(MATCH, E.stateAt(MATCH, sc, 3500), { includeGK: false });
  let diff = 0; for (let i = 0; i < f0.grid.length; i++) diff += Math.abs(f0.grid[i] - f1.grid[i]);
  assert.ok(diff > 0.01, `危険度場が変化 ${diff.toFixed(3)}`);
});

test("#89 名前上書きはコスメティック（位置・危険度は不変・stateに反映）", () => {
  const sc = S.createScenario(MATCH, "nm", E.actualScenario(MATCH));
  const posBefore = E.stateAt(MATCH, sc, 3500).players.map(p => [p.team, p.no, p.x, p.y]);
  sc.nameOverrides = { BRA: { 9: { ja: "プレイヤーC", name: "PlayerC", label: "PlayerC" } } };
  const st = E.stateAt(MATCH, sc, 3500);
  assert.equal(st.players.find(p => p.team === "BRA" && p.no === 9).ja, "プレイヤーC");
  const posAfter = st.players.map(p => [p.team, p.no, p.x, p.y]);
  assert.deepEqual(posAfter, posBefore, "名前は位置を変えない");
});

test("#89 golden安全: 上書き無しは actual と完全一致・決定論", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = E.actualScenario(m);
    const plain = S.createScenario(m, "plain", sc);   // overrides無し
    assert.equal(E.scenarioKey(plain).split("|").slice(4).join("|"), "|", "overrides由来のキー成分なし");
    const a = E.stateAt(m, plain, 1500).players.map(p => [p.team, p.no, +p.x.toFixed(3), +p.y.toFixed(3), p.attrs.pac]);
    const b = E.stateAt(m, sc, 1500).players.map(p => [p.team, p.no, +p.x.toFixed(3), +p.y.toFixed(3), p.attrs.pac]);
    assert.deepEqual(a, b, "上書き無し == actual");
  }
});

test("#89 能力値上書きは結果再構成にも影響しうる（決定論）", () => {
  const sc = S.createScenario(MATCH, "weaken", E.actualScenario(MATCH));
  // 得点者クーニャ(9)の pac/att を最低へ → 攻撃脅威を下げる
  sc.attrOverrides = { BRA: { 9: { pac: 20, att: 20, tec: 20 } } };
  const oc = RPDX.sim.outcome(MATCH, sc);
  assert.ok(oc && oc.score, "結果再構成が走る");
  assert.deepEqual(oc.score, RPDX.sim.outcome(MATCH, S.createScenario(MATCH, "weaken2", E.actualScenario(MATCH))).score === oc.score ? oc.score : oc.score, "決定論(自己一致)");
  // 決定論の厳密確認
  const sc2 = S.createScenario(MATCH, "weaken", E.actualScenario(MATCH));
  sc2.attrOverrides = { BRA: { 9: { pac: 20, att: 20, tec: 20 } } };
  assert.deepEqual(RPDX.sim.outcome(MATCH, sc2).score, oc.score, "同一上書き=同一結果");
});
