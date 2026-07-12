// #92 編集可能テンプレート試合（実測なしの起点・generic 薄活用・未較正明示・golden安全）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger, S = RPDX.subs, G = RPDX.generic;

test("#92 templateMatch: 収録実試合と同一APIで動く（engine/danger/subs・決定論）", () => {
  const m = G.templateMatch();
  const keys = E.teamKeys(m);
  assert.equal(keys.length, 2, "2チーム");
  for (const k of keys) assert.ok(m.teams[k].squad.length >= 11, "スカッド11人以上");
  // 同一APIで state/危険度/交代が動く
  const st = E.stateAt(m, E.actualScenario(m), 1500);
  assert.equal(st.players.filter(p => p.onPitch).length, 22, "22人オンピッチ");
  const f = D.fieldAt(m, st, { includeGK: false });
  assert.ok(f.grid.length > 0, "危険度場が算出できる");
  const val = S.validateScenario(m, S.createScenario(m, "t", E.actualScenario(m)));
  assert.ok(val.ok, "シナリオ検証が通る（同一API）");
});

test("#92 未較正フラグ: template は calibrated=false・収録実試合は較正済み扱い", () => {
  const m = G.templateMatch();
  assert.equal(m.meta.calibrated, false, "テンプレは未較正");
  for (const real of Object.values(MATCHES))
    assert.notEqual(real.meta.calibrated, false, "収録実試合は未較正フラグを持たない（較正済み扱い）");
});

test("#92 golden安全: template はレジストリ非登録・収録試合に非干渉", () => {
  const before = Object.keys(MATCHES).length;
  const m = G.templateMatch();
  assert.equal(Object.keys(MATCHES).length, before, "MATCHES 件数は不変（テンプレ非登録）");
  assert.ok(!MATCHES[m.meta.id], "テンプレはレジストリに存在しない");
});

test("#92 決定論: 独立生成した template は同一世界（座標一致）", () => {
  const a = G.templateMatch(), b = G.templateMatch();
  const pa = E.stateAt(a, E.actualScenario(a), 2000).players.map(p => [p.team, p.no, +p.x.toFixed(4), +p.y.toFixed(4)]);
  const pb = E.stateAt(b, E.actualScenario(b), 2000).players.map(p => [p.team, p.no, +p.x.toFixed(4), +p.y.toFixed(4)]);
  assert.deepEqual(pa, pb, "同一テンプレ=同一世界");
});

test("#92 編集可能: template 上の能力値上書きで危険度が動く（#89/#90 と連結）", () => {
  const m = G.templateMatch();
  const keys = E.teamKeys(m);
  const fw = m.teams[keys[0]].squad.find(p => p.pos === "FW") || m.teams[keys[0]].squad[m.teams[keys[0]].squad.length - 1];
  const sc = S.createScenario(m, "edit", E.actualScenario(m));
  const base = E.attrsOf(m, null, keys[0], fw.no);
  sc.attrOverrides = { [keys[0]]: { [fw.no]: { pac: Math.min(99, base.pac + 30), att: 99, tec: 99 } } };
  const f0 = D.fieldAt(m, E.stateAt(m, E.actualScenario(m), 2500), { includeGK: false });
  const f1 = D.fieldAt(m, E.stateAt(m, sc, 2500), { includeGK: false });
  let diff = 0; for (let i = 0; i < f0.grid.length; i++) diff += Math.abs(f0.grid[i] - f1.grid[i]);
  assert.ok(diff > 0.01, `テンプレ上でも編集が危険度に効く ${diff.toFixed(3)}`);
});
