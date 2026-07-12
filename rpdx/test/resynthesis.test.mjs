// #83 編集フレーム→制約(editAnchors)→既存エンジンで再合成（中間路）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, S = RPDX.scenlib;

const moveOne = (m, t, dx, dy) => {
  const f = E.editFrameAt(m, null, t);
  const p = f.players.find(q => q.team === m.possessionPlus && q.role !== "GK");
  p.x += dx; p.y += dy;
  return { f, no: p.no, team: p.team, target: { x: p.x, y: p.y } };
};

test("#83 scenarioFromFrame: 編集時刻で編集位置を通過・移動なしはアンカー0", () => {
  const { f, no, team, target } = moveOne(MATCH, 2000, 15, -8);
  const { scenario, moved } = S.scenarioFromFrame(MATCH, f);
  assert.equal(moved, 1, "1人だけ動かした");
  const at = E.stateAt(MATCH, scenario, 2000).players.find(p => p.team === team && p.no === no);
  assert.ok(Math.hypot(at.x - target.x, at.y - target.y) < 1.5, `編集時刻で通過 (${at.x.toFixed(1)},${at.y.toFixed(1)})`);
  // 未編集フレーム→アンカー0
  const f0 = E.editFrameAt(MATCH, null, 2000);
  assert.equal(S.scenarioFromFrame(MATCH, f0).moved, 0);
});

test("#83 再合成: 編集は以降へ伝播し、時間とともにベースラインへ減衰", () => {
  const { f, no, team } = moveOne(MATCH, 2000, 18, -6);
  const { scenario } = S.scenarioFromFrame(MATCH, f);
  const base = E.actualScenario(MATCH);
  const diffAt = (t) => {
    const a = E.stateAt(MATCH, base, t).players.find(p => p.team === team && p.no === no);
    const b = E.stateAt(MATCH, scenario, t).players.find(p => p.team === team && p.no === no);
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  assert.ok(diffAt(2001) > 5, `直後は大きく異なる ${diffAt(2001).toFixed(1)}m`);
  assert.ok(diffAt(2030) < diffAt(2003), "時間とともに減衰");
  assert.ok(diffAt(2060) < 1.5, `十分後はベースラインへ収束 ${diffAt(2060).toFixed(2)}m`);
});

test("#83 決定論・スクラブ一致・速度上限（サンプル）", () => {
  const { f, team, no } = moveOne(MATCH, 2000, 20, 10);
  const { scenario } = S.scenarioFromFrame(MATCH, f);
  for (const t of [2000, 2005, 2015]) {
    const a = E.stateAt(MATCH, scenario, t).players.find(p => p.team === team && p.no === no);
    E.clearCaches();
    const b = E.stateAt(MATCH, scenario, t).players.find(p => p.team === team && p.no === no);
    assert.deepEqual([a.x, a.y], [b.x, b.y], "決定論");
    const v = E.speedKmh(MATCH, scenario, team, no, t) / 3.6;
    assert.ok(v <= 9.9 + 1e-6, `速度 ${v.toFixed(2)}m/s @${t}`);
  }
});

test("#83 golden安全: editAnchors 機構は actual/未編集の世界に影響しない", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = E.actualScenario(m);
    // actual の scenarioKey に editAnchors 由来の成分が無い（末尾セグメントが空）
    assert.equal(E.scenarioKey(sc).split("|")[3] || "", "", "actual に editAnchors 成分なし");
    // 未編集フレームからの再合成は editAnchors 0 → 位置は actual と一致
    const f0 = E.editFrameAt(m, null, 1500);
    const { scenario, moved } = S.scenarioFromFrame(m, f0);
    assert.equal(moved, 0, "未編集はアンカー0");
    const a = E.stateAt(m, scenario, 1500).players.map(p => [p.team, p.no, +p.x.toFixed(3), +p.y.toFixed(3)]);
    const b = E.stateAt(m, sc, 1500).players.map(p => [p.team, p.no, +p.x.toFixed(3), +p.y.toFixed(3)]);
    assert.deepEqual(a, b, "未編集再合成 == actual（世界不変）");
  }
});
