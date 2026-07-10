// #46 ボール物理 — バウンド（反発）+ マグヌス曲がり（決定論・端点保存）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine;
const act = (m) => E.actualScenario(m);

test("#46 bounceHeight: 端点で接地・頂点が h・反発でピークが e² 減衰", () => {
  const h = 3, e = 0.5, hops = 3;
  assert.ok(Math.abs(E.ballBounceHeight(0, h, e, hops) - 0.11) < 1e-9, "launch=接地");
  assert.ok(Math.abs(E.ballBounceHeight(1, h, e, hops) - 0.11) < 1e-6, "着地=接地");
  // ホップ0の頂点（d0=(1-e)=0.5 の中点 u=0.25）で ≈ 0.11+h
  const p0 = E.ballBounceHeight(0.25, h, e, hops);
  assert.ok(Math.abs(p0 - (0.11 + h)) < 1e-6, `hop0 peak ${p0}`);
  // ホップ1の頂点は h·e² だけ低い（反発減衰）
  // hop1: 区間[0.5, 0.75]、中点 u=0.625
  const p1 = E.ballBounceHeight(0.625, h, e, hops);
  assert.ok(p1 < p0 && Math.abs((p1 - 0.11) - h * e * e) < 1e-6, `hop1 peak ${p1}`);
});

test("#46 bounceHeight: hops=1 は単一放物線（u=0.5 で頂点 h）", () => {
  const h = 2.5;
  const mid = E.ballBounceHeight(0.5, h, 0.52, 1);
  assert.ok(Math.abs(mid - (0.11 + h)) < 1e-6, `single arc peak ${mid}`);
  assert.ok(E.ballBounceHeight(0, h, 0.52, 1) < mid && E.ballBounceHeight(1, h, 0.52, 1) < mid);
});

test("#46 ballAt: 端点（アンカー時刻）でマグヌス曲がりは0＝アンカー位置を保存", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = act(m);
    for (const anc of m.ballAnchors.slice(0, 8)) {
      const b = E.ballAt(m, sc, anc.t);
      assert.ok(Math.abs(b.x - anc.x) < 2.0 && Math.abs(b.y - anc.y) < 2.0,
        `${m.meta.id} t=${anc.t} ball(${b.x.toFixed(1)},${b.y.toFixed(1)}) vs anchor(${anc.x},${anc.y})`);
    }
  }
});

test("#46 ballAt: z は現実域[0.1, 3.6]・飛球で1m超の高さが出る・決定論", () => {
  const m = MATCH, sc = act(m), range = E.playedRange(m);
  let maxZ = 0;
  for (let t = range.t0; t < range.t1; t += 1.3) {
    const b = E.ballAt(m, sc, t);
    assert.ok(b.z >= 0.1 && b.z <= 3.6, `z=${b.z} @${t}`);
    maxZ = Math.max(maxZ, b.z);
    const b2 = E.ballAt(m, sc, t);
    assert.deepEqual([b.x, b.y, b.z], [b2.x, b2.y, b2.z]);
  }
  assert.ok(maxZ > 1.0, `飛球の最大高 ${maxZ.toFixed(2)}m`);
});

test("#46 ballAt: マグヌス曲がりは軌道を場内に保ち、既存の連続性を悪化させない", () => {
  // 回帰ガード: 曲がり有り/無しで各ステップ移動量の差が bow 上限内（曲がり自体は無害）。
  // 注: アンカー/チェーン境界の既存不連続は #46 の範囲外（別途 issue 追跡）。
  const orig = E.BALL_PHYS.MAX_BOW;
  try {
    for (const m of Object.values(MATCHES)) {
      const sc = act(m), range = E.playedRange(m);
      const sample = (t) => { E.BALL_PHYS.MAX_BOW = orig; const a = E.ballAt(m, sc, t); E.BALL_PHYS.MAX_BOW = 0; const b = E.ballAt(m, sc, t); return [a, b]; };
      let maxDelta = 0;
      for (let t = range.t0; t < range.t1; t += 0.7) {
        const [a, b] = sample(t);
        assert.ok(Math.abs(a.x) <= 55 && Math.abs(a.y) <= 36, `場外 (${a.x},${a.y}) @${t}`);
        maxDelta = Math.max(maxDelta, Math.hypot(a.x - b.x, a.y - b.y));
      }
      assert.ok(maxDelta <= orig + 1e-6, `${m.meta.id} 曲がり寄与 ${maxDelta.toFixed(2)}m ≤ ${orig}m`);
    }
  } finally { E.BALL_PHYS.MAX_BOW = orig; }
});

/* ================= #50 チェーン境界の連続性（瞬間移動の根絶） ================= */

test("#50 ballAt: 全走査で 0.1s ステップ移動 ≤ 5m（テレポート回帰ガード）", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = act(m), range = E.playedRange(m);
    let prev = null, maxStep = 0, at = 0;
    for (let t = range.t0; t < range.t1; t += 0.1) {
      const b = E.ballAt(m, sc, t);
      if (prev) { const s = Math.hypot(b.x - prev.x, b.y - prev.y); if (s > maxStep) { maxStep = s; at = t; } }
      prev = b;
    }
    assert.ok(maxStep <= 5, `${m.meta.id} 最大 ${maxStep.toFixed(2)}m/0.1s @${at.toFixed(1)}（旧バグは~9.6m）`);
  }
});

test("#50 ballAt: リスタート解放はセグメント終端までに完了し境界がC0連続", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = act(m), range = E.playedRange(m);
    // 全リスタート境界近傍で前後0.1sの跳びを確認
    let checked = 0;
    for (let t = range.t0 + 5; t < range.t1 - 1; t += 0.5) {
      const c = E.carrierAt(m, sc, t);
      if (!c || !c.seg || !c.seg.restart) continue;
      const end = c.seg.t1;
      if (end == null || end > range.t1 - 1) continue;
      const b1 = E.ballAt(m, sc, end - 0.05), b2 = E.ballAt(m, sc, end + 0.05);
      assert.ok(Math.hypot(b2.x - b1.x, b2.y - b1.y) < 3.0,
        `${m.meta.id} restart境界 t=${end.toFixed(1)} 跳び ${Math.hypot(b2.x - b1.x, b2.y - b1.y).toFixed(2)}m`);
      checked++;
      t = end + 1;   // 同一セグメントの重複チェックを避ける
    }
    assert.ok(checked > 10, `${m.meta.id} リスタート境界サンプル ${checked}`);
  }
});
