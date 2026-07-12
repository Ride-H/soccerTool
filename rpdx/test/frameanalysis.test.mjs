// #85 編集/静止フレームの方向的タクティカル解析（読み取り専用・決定論・状態入力）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, T = RPDX.tactics;

test("#85 fromState: shape/voronoi は合成でも編集でも同一APIで動く・決定論", () => {
  for (const m of Object.values(MATCHES)) {
    const f = E.editFrameAt(m, null, 2000);
    for (const team of E.teamKeys(m)) {
      const sh = T.shapeFromState(m, f, team);
      assert.equal(sh.lines.reduce((a, b) => a + b, 0), 10, "10人");
      assert.ok(sh.width > 0 && sh.area > 0);
      assert.deepEqual(sh, T.shapeFromState(m, f, team), "決定論");
    }
    const v = T.voronoiFromState(m, f);
    const keys = E.teamKeys(m);
    assert.ok(Math.abs(v[keys[0]] + v[keys[1]] - 1) < 1e-9, "Voronoi合計100%");
  }
});

test("#85 shapeMetrics 互換: リファクタ後も (match,sc,team,t) が同一結果（#33 不変）", () => {
  const sc = E.actualScenario(MATCH);
  const viaWrap = T.shapeMetrics(MATCH, sc, "BRA", 3000);
  const viaState = T.shapeFromState(MATCH, E.stateAt(MATCH, sc, 3000), "BRA");
  assert.deepEqual(viaWrap, viaState);
});

test("#85 frameAnalysis: 構造完全・決定論・提案は最大3件", () => {
  const f = E.editFrameAt(MATCH, null, 3480);
  const a = T.frameAnalysis(MATCH, f, { team: "BRA" });
  assert.ok(a.danger && a.shape.BRA && a.shape.JPN && a.voronoi && a.offside.own && a.offside.opp && a.nearBall);
  assert.ok(Array.isArray(a.suggestions) && a.suggestions.length >= 1 && a.suggestions.length <= 3);
  for (const sug of a.suggestions) assert.ok(sug.text && sug.exploits && typeof sug.severity === "number");
  assert.deepEqual(a, T.frameAnalysis(MATCH, f, { team: "BRA" }), "決定論");
});

test("#85 frameAnalysis: 数的不利を作ると overload-against が提案される", () => {
  const f = E.editFrameAt(MATCH, null, 2000);
  const b = f.ball;
  // JPN の非GKを全員ボール周辺へ、BRA非GKを遠方へ → BRA視点で大幅な数的不利
  for (const p of f.players) {
    if (p.role === "GK") continue;
    if (p.team === "JPN") { p.x = b.x; p.y = b.y; }               // JPN全員をボールへ
    else { p.x = b.x > 0 ? -40 : 40; p.y = 30; }
  }
  const a = T.frameAnalysis(MATCH, f, { team: "BRA" });
  assert.ok(a.nearBall.diff <= -3, `nearBall.diff ${a.nearBall.diff}`);
  assert.equal(a.suggestions[0].exploits, "overload-against", JSON.stringify(a.suggestions[0]));
});

test("#85 frameAnalysis: 相手最終ラインを高くすると space-behind が提案される", () => {
  const f = E.editFrameAt(MATCH, null, 2000);
  const dir = MATCH.dir.BRA[f.half === 1 ? "h1" : "h2"];
  // JPN(守備)の全非GKを BRA攻撃方向へ大きく押し上げ（=ラインが高い）＋ボールは中盤
  for (const p of f.players) {
    if (p.team === "JPN" && p.role !== "GK") { p.x = dir * 12; p.y = (p.no % 5 - 2) * 6; }  // 高いライン=dir·x小
  }
  f.ball.x = 0; f.ball.y = 0;
  const a = T.frameAnalysis(MATCH, f, { team: "BRA" });
  assert.ok(a.suggestions.some(s => s.exploits === "space-behind"), JSON.stringify(a.suggestions));
});
