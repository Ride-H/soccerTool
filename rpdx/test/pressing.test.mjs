// #29 プレッシング・トリガ & カバーシャドウ（決定論・連続・幾何）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine;
const act = (m) => E.actualScenario(m);
const med = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
const distToSeg = (p, a, b) => {
  const vx = b.x - a.x, vy = b.y - a.y;
  const L2 = vx * vx + vy * vy || 1e-9;
  let u = ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(p.x - (a.x + vx * u), p.y - (a.y + vy * u));
};
const supportCentroid = (st, c, hp) => {
  let sx = 0, sy = 0, sw = 0;
  for (const p of st.players) {
    if (!p.onPitch || p.team !== c.team || p.no === c.no || p.role === "GK") continue;
    const w = Math.exp(-Math.hypot(p.x - hp.x, p.y - hp.y) / 6);
    sx += p.x * w; sy += p.y * w; sw += w;
  }
  return sw > 1e-9 ? { x: sx / sw, y: sy / sw } : null;
};

test("#29 trigger: 決定論・点灯率2〜20%・level∈(0,1]・リスタート中はnull", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = act(m), range = E.playedRange(m);
    let frames = 0, on = 0;
    for (let t = range.t0 + 30; t < range.t1; t += 5) {
      const c = E.carrierAt(m, sc, t);
      if (!c || c.mode !== "hold") continue;
      const trig = E.pressTriggerAt(m, sc, t);
      if (c.seg && c.seg.restart) { assert.equal(trig, null, `restart中 @${t}`); continue; }
      frames++;
      if (trig) {
        assert.ok(trig.level > 0 && trig.level <= 1, `level ${trig.level}`);
        assert.notEqual(trig.team, c.team, "プレス側は非保持チーム");
        if (trig.level > 0.5) on++;
        assert.deepEqual(trig, E.pressTriggerAt(m, sc, t), "決定論");
      }
    }
    const rate = on / frames;
    assert.ok(rate > 0.02 && rate < 0.2, `${m.meta.id} 点灯率 ${(rate * 100).toFixed(1)}%`);
  }
});

test("#29 press: トリガ点灯中は最近接守備者が平均≤5.5mまで寄せる（協調プレス実効）", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = act(m), range = E.playedRange(m);
    let sum = 0, n = 0;
    for (let t = range.t0 + 30; t < range.t1; t += 5) {
      const trig = E.pressTriggerAt(m, sc, t);
      if (!trig || trig.level <= 0.6) continue;
      const st = E.stateAt(m, sc, t);
      const c = st.carrier;
      const hp = st.players.find(p => p.team === c.team && p.no === c.no);
      if (!hp) continue;
      let dn = 1e9;
      for (const p of st.players) {
        if (!p.onPitch || p.team === c.team || p.role === "GK") continue;
        dn = Math.min(dn, Math.hypot(p.x - hp.x, p.y - hp.y));
      }
      sum += dn; n++;
    }
    assert.ok(n > 20, `${m.meta.id} サンプル ${n}`);
    assert.ok(sum / n <= 5.5, `${m.meta.id} トリガ中の平均最近接 ${(sum / n).toFixed(2)}m`);
  }
});

test("#29 cover shadow: トリガ中の2番手はパスレーン近傍（回帰ガード: 中央値<9.5m・全体で悪化しない）", () => {
  const laneOn = [], laneOff = [];
  for (const m of Object.values(MATCHES)) {
    const sc = act(m), range = E.playedRange(m);
    for (let t = range.t0 + 30; t < range.t1; t += 5) {
      const st = E.stateAt(m, sc, t);
      const c = st.carrier;
      if (!c || c.mode !== "hold" || c.restart) continue;
      const hp = st.players.find(p => p.team === c.team && p.no === c.no);
      if (!hp) continue;
      const sh = supportCentroid(st, c, hp);
      if (!sh) continue;
      const defs = st.players.filter(p => p.onPitch && p.team !== c.team && p.role !== "GK")
        .map(p => ({ p, d: Math.hypot(p.x - hp.x, p.y - hp.y) })).sort((a, b) => a.d - b.d);
      if (!defs[1]) continue;
      const lane = distToSeg(defs[1].p, hp, sh);
      const trig = E.pressTriggerAt(m, sc, t);
      if (trig && trig.level > 0.6) laneOn.push(lane); else if (!trig) laneOff.push(lane);
    }
  }
  assert.ok(laneOn.length > 50, `トリガ中サンプル ${laneOn.length}`);
  const mOn = med(laneOn.slice()), mOff = med(laneOff.slice());
  assert.ok(mOn < 9.5, `トリガ中レーン距離中央値 ${mOn.toFixed(2)}m（シャドウ導入前は~9.8m）`);
  assert.ok(mOn <= mOff + 0.5, `on ${mOn.toFixed(2)} ≤ off ${mOff.toFixed(2)} + 0.5（シャドウが逆行しない）`);
});
