// #31 GK守備幾何 — 角度圧縮（二等分線）+ スイーパー飛び出し（決定論・整合）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine;
const HALF = 52.5;
const act = (m) => E.actualScenario(m);
const gkDepthAndLine = (m, sc, t) => {
  const st = E.stateAt(m, sc, t);
  // GK は「平滑ボール（ballSlow）」を脅威として反応する（実ボールはシュートで置き去りにされ得る）
  const bs = E.ballSlowAt(m, t);
  const out = {};
  for (const team of E.teamKeys(m)) {
    const dir = m.dir[team][st.half === 1 ? "h1" : "h2"];
    const gx = -dir * HALF;
    const gk = st.players.find(p => p.onPitch && p.team === team && p.role === "GK");
    const dGoal = Math.hypot(gx - bs.x, bs.y) || 1;         // 平滑ボール基準
    const depth = Math.hypot(gx - gk.x, gk.y);
    // ゴール→ボール直線への横ズレ（二等分線からの外れ）
    const ux = (bs.x - gx) / dGoal, uy = bs.y / dGoal;
    const px = gk.x - gx, py = gk.y;
    const cross = Math.abs(px * uy - py * ux);   // 直線からの距離
    out[team] = { gk, dGoal, depth, cross, ball: bs, gx, dir };
  }
  return out;
};

for (const m of Object.values(MATCHES)) {
  const id = m.meta.id;

  test(`gk[${id}]: GKは常に自ゴール半径内・ボールを追い越さない・飛び出しが有界`, () => {
    const sc = act(m), range = E.playedRange(m);
    for (let t = range.t0 + 30; t < range.t1; t += 19) {
      const d = gkDepthAndLine(m, sc, t);
      for (const team of E.teamKeys(m)) {
        const g = d[team];
        assert.ok(g.depth >= 0.5 && g.depth <= 18, `${team} 飛出 ${g.depth.toFixed(1)}m @${t}`);
        assert.ok(g.depth <= g.dGoal + 0.5, `${team} ボール追い越し @${t}`);
        // 自ゴール側の半面に留まる（極端に前へ出ない）
        assert.ok(g.dir * g.gk.x < 0 || Math.abs(g.gk.x) > 20, `${team} GK位置 @${t}`);
      }
    }
  });

  test(`gk[${id}]: 角度圧縮 — ボールが自陣サイド寄りのとき GK は二等分線付近でボール側へ`, () => {
    const sc = act(m), range = E.playedRange(m);
    let checked = 0, onLine = 0, sameSide = 0;
    for (let t = range.t0 + 30; t < range.t1; t += 7) {
      for (const team of E.teamKeys(m)) {
        const g = gkDepthAndLine(m, sc, t)[team];
        const prog = g.dir * g.ball.x + HALF;        // 0=自ゴール
        if (prog > 45 || Math.abs(g.ball.y) < 5) continue;   // 自陣かつサイド寄りのみ
        checked++;
        if (g.cross < 4.5) onLine++;                 // 二等分線±4.5m以内
        if (Math.sign(g.gk.y) === Math.sign(g.ball.y)) sameSide++;
      }
    }
    assert.ok(checked > 40, `サンプル ${checked}`);
    // 統計的性質（0.75+）— チェーン再編成でボール軌道が微小変動しても壊れない余裕を持つ
    assert.ok(onLine / checked > 0.75, `二等分線付近率 ${onLine}/${checked}`);
    assert.ok(sameSide / checked > 0.75, `ボール側へ寄る率 ${sameSide}/${checked}`);
  });

  test(`gk[${id}]: 至近ほど飛び出す（近さ×飛び出しの正の相関＝角度圧縮の単調性）`, () => {
    const sc = act(m), range = E.playedRange(m);
    const xs = [], ys = [];
    for (let t = range.t0 + 30; t < range.t1; t += 5) {
      for (const team of E.teamKeys(m)) {
        const g = gkDepthAndLine(m, sc, t)[team];
        xs.push(1 - g.dGoal / 62);   // 近さ（0…1）
        ys.push(g.depth);            // 飛び出し
      }
    }
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    const r = sxy / (Math.sqrt(sxx * syy) || 1);
    assert.ok(n > 200, `サンプル ${n}`);
    assert.ok(r > 0.6, `近さと飛び出しの相関 r=${r.toFixed(3)}`);
  });

  test(`gk[${id}]: 決定論`, () => {
    const sc = act(m);
    for (const t of [500, 2500, 5000]) {
      const a = gkDepthAndLine(m, sc, t), b = gkDepthAndLine(m, sc, t);
      for (const team of E.teamKeys(m)) assert.deepEqual([a[team].gk.x, a[team].gk.y], [b[team].gk.x, b[team].gk.y]);
    }
  });
}
