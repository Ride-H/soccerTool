// #90 能力値→危険度/結果への反映拡張（att/tec/def・較正安全）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger, S = RPDX.subs;
const fieldDiff = (a, b) => { let d = 0; for (let i = 0; i < a.grid.length; i++) d += Math.abs(a.grid[i] - b.grid[i]); return d; };

test("#90 較正保護: 未編集は dw=1.0・危険度は完全不変（golden/OOS保護）", () => {
  for (const m of Object.values(MATCHES)) {
    const st = E.stateAt(m, E.actualScenario(m), 2500);
    for (const p of st.players) {
      assert.equal(p.dwAtk, 1, `${p.team}${p.no} dwAtk`);
      assert.equal(p.dwDef, 1, `${p.team}${p.no} dwDef`);
    }
    // 上書き無しシナリオの危険度場は actual と一致
    const plain = S.createScenario(m, "plain", E.actualScenario(m));
    const a = D.fieldAt(m, E.stateAt(m, plain, 2500), { includeGK: false });
    const b = D.fieldAt(m, E.stateAt(m, E.actualScenario(m), 2500), { includeGK: false });
    assert.equal(fieldDiff(a, b), 0, `${m.meta.id} 未編集=不変`);
  }
});

test("#90 att/tec 上書きで攻撃側の危険度が上がる方向・def 上書きで守備側が上がる方向", () => {
  const base = D.fieldAt(MATCH, E.stateAt(MATCH, E.actualScenario(MATCH), 3500), { includeGK: false });
  const scA = S.createScenario(MATCH, "attUp", E.actualScenario(MATCH));
  scA.attrOverrides = { BRA: { 9: { att: 99, tec: 99 }, 7: { att: 99, tec: 99 } } };
  const fA = D.fieldAt(MATCH, E.stateAt(MATCH, scA, 3500), { includeGK: false });
  assert.ok(fieldDiff(base, fA) > 0.05, `att/tec 効果 ${fieldDiff(base, fA).toFixed(3)}`);
  // dw が反映されている
  const p9 = E.stateAt(MATCH, scA, 3500).players.find(p => p.team === "BRA" && p.no === 9);
  assert.ok(p9.dwAtk > 1, `dwAtk ${p9.dwAtk}`);

  const scD = S.createScenario(MATCH, "defUp", E.actualScenario(MATCH));
  scD.attrOverrides = { JPN: { 22: { def: 99 }, 3: { def: 99 }, 21: { def: 99 } } };
  const fD = D.fieldAt(MATCH, E.stateAt(MATCH, scD, 3500), { includeGK: false });
  assert.ok(fieldDiff(base, fD) > 0.05, `def 効果 ${fieldDiff(base, fD).toFixed(3)}`);
  const pd = E.stateAt(MATCH, scD, 3500).players.find(p => p.team === "JPN" && p.no === 22);
  assert.ok(pd.dwDef > 1, `dwDef ${pd.dwDef}`);
});

test("#90 単調性・有界・決定論: 能力値を上げるほど dw が増え、レンジは有界", () => {
  const mk = (att) => { const s = S.createScenario(MATCH, "m", E.actualScenario(MATCH)); s.attrOverrides = { BRA: { 9: { att, tec: att } } }; return E.stateAt(MATCH, s, 3500).players.find(p => p.team === "BRA" && p.no === 9).dwAtk; };
  assert.ok(mk(99) > mk(70) && mk(70) > mk(40), "att↑で dwAtk↑");
  assert.ok(mk(99) <= 1.3 && mk(20) >= 0.7, "dw は有界（±約24%）");
  assert.equal(mk(99), mk(99), "決定論");
});
