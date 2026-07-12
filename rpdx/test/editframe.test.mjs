// #82 停止フレームの手動編集 — 編集フレームのデータモデル・直列化・解析入力の健全性
// （対話的なピッキング/ドラッグは headless 目視で検証。ここは純関数コアを固定する）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger, S = RPDX.scenlib;

test("#82 editFrameAt: 22人+ボール+referees[]・値域・決定論", () => {
  for (const m of Object.values(MATCHES)) {
    const f = E.editFrameAt(m, null, 1500);
    assert.equal(f.players.filter(p => p.onPitch).length, 22, "22人");
    assert.ok(f.ball && typeof f.ball.x === "number", "ボール");
    assert.deepEqual(f.referees, [], "審判は空で開始");
    assert.ok(f.score && f.half, "score/half");
    for (const p of f.players) assert.ok(Math.abs(p.x) <= 53 && Math.abs(p.y) <= 35, "場内");
    const g = E.editFrameAt(m, null, 1500);
    assert.deepEqual(f.players.map(p => [p.team, p.no, p.x, p.y]), g.players.map(p => [p.team, p.no, p.x, p.y]), "決定論");
  }
});

test("#82 編集はキャッシュ/合成f(t)を汚さない（golden安全の担保）", () => {
  const sc = E.actualScenario(MATCH);
  const before = E.stateAt(MATCH, sc, 1500).players.map(p => [p.team, p.no, p.x, p.y]);
  const f = E.editFrameAt(MATCH, sc, 1500);
  // 編集フレームを大きく書き換える
  f.players[0].x = 40; f.players[0].y = 20; f.ball.x = -50; f.referees.push({ x: 0, y: 30 });
  const after = E.stateAt(MATCH, sc, 1500).players.map(p => [p.team, p.no, p.x, p.y]);
  assert.deepEqual(after, before, "stateAt は編集の影響を受けない（深いコピー）");
});

test("#82 serializeFrame/parseFrame: 座標往復一致（選手・ボール・審判）", () => {
  const f = E.editFrameAt(MATCH, null, 1200);
  f.players[3].x = 10.5; f.players[3].y = -7.25;
  f.ball.x = 3.1; f.ball.y = -0.4;
  f.referees = [{ x: 0, y: 20 }, { x: -30, y: -18 }];
  const str = S.serializeFrame(f);
  const f2 = S.parseFrame(MATCH, str);
  const a = f.players[3], b = f2.players.find(p => p.team === a.team && p.no === a.no);
  assert.deepEqual([b.x, b.y], [10.5, -7.25], "選手座標");
  assert.deepEqual([f2.ball.x, f2.ball.y], [3.1, -0.4], "ボール座標");
  assert.equal(f2.referees.length, 2, "審判2");
  assert.equal(f2.edited, true);
});

test("#82 編集フレームは解析(fieldAt)の有効な入力・決定論・編集で結果が動く", () => {
  const f = E.editFrameAt(MATCH, null, 1200);
  const before = D.fieldAt(MATCH, f, { includeGK: false });
  assert.equal(before.grid.length, 42 * 28, "危険度場が算出される");
  // 攻撃選手をゴール前へ動かすと場が変わる
  const atk = f.players.find(p => p.team === MATCH.possessionPlus && p.role !== "GK");
  const dir = MATCH.dir[atk.team][f.half === 1 ? "h1" : "h2"];
  atk.x = dir * 45; atk.y = 2;
  const after = D.fieldAt(MATCH, f, { includeGK: false });
  let diff = 0;
  for (let i = 0; i < before.grid.length; i++) diff += Math.abs(before.grid[i] - after.grid[i]);
  assert.ok(diff > 0.01, `編集で危険度場が変化 (${diff.toFixed(3)})`);
  // 同一編集フレームは同一結果（決定論）
  const again = D.fieldAt(MATCH, f, { includeGK: false });
  for (let i = 0; i < after.grid.length; i++) assert.equal(after.grid[i], again.grid[i]);
});
