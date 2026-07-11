// #37 専門知ルール・オラクル — 実測データなしでも「サッカーとして破綻していない」ことを
// 競技規則・定性知識のルール束で常時保証する。actual と what-if の両世界で検証し、
// 違反は時刻・チーム・選手つきで報告する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine;

// 検証する世界: actual + 代表 what-if（golden と同型の交代取り消し）
const worldsOf = (m) => {
  const actual = E.actualScenario(m);
  const wf = structuredClone(actual);
  delete wf.actual; wf.id = "oracle-wf"; wf.label = "oracle what-if";
  const plus = m.possessionPlus || E.teamKeys(m)[0];
  if (wf.subs[plus] && wf.subs[plus].length) wf.subs[plus] = wf.subs[plus].slice(0, -1);
  return [["actual", actual], ["what-if", wf]];
};

for (const m of Object.values(MATCHES)) {
  const id = m.meta.id;

  for (const [wname, sc] of worldsOf(m)) {
    test(`oracle[${id}|${wname}]: 人数規則 — 常時11人×2・GK各1人・全員場内`, () => {
      const range = E.playedRange(m);
      const bad = [];
      for (let t = range.t0 + 10; t < range.t1; t += 41) {
        const st = E.stateAt(m, sc, t);
        for (const team of E.teamKeys(m)) {
          const on = st.players.filter(p => p.onPitch && p.team === team);
          if (on.length !== 11) bad.push(`t=${t.toFixed(0)} ${team} 人数=${on.length}`);
          const gks = on.filter(p => p.role === "GK");
          if (gks.length !== 1) bad.push(`t=${t.toFixed(0)} ${team} GK=${gks.length}`);
          for (const p of on) {
            if (p.entering) continue;   // 入場アニメはタッチライン外から走り込む（正当）
            if (Math.abs(p.x) > 53 || Math.abs(p.y) > 34.5)
              bad.push(`t=${t.toFixed(0)} ${team}${p.no} 場外(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
          }
        }
      }
      assert.deepEqual(bad, [], `違反 ${bad.length}件: ${bad.slice(0, 3).join(" / ")}`);
    });

    test(`oracle[${id}|${wname}]: ボール規則 — 常時場内（ネット内許容）・チェーン駆動時は保持者の足元`, () => {
      const range = E.playedRange(m);
      const bad = [];
      for (let t = range.t0 + 10; t < range.t1; t += 17) {
        const st = E.stateAt(m, sc, t);
        if (Math.abs(st.ball.x) > 55.5 || Math.abs(st.ball.y) > 36)
          bad.push(`t=${t.toFixed(0)} ball場外(${st.ball.x.toFixed(1)},${st.ball.y.toFixed(1)})`);
        const c = st.carrier;
        if (c && c.mode === "hold" && !c.restart && st.ball.free > 0.9) {
          const h = st.players.find(p => p.onPitch && p.team === c.team && p.no === c.no);
          if (h) {
            const d = Math.hypot(h.x - st.ball.x, h.y - st.ball.y);
            if (d > 6) bad.push(`t=${t.toFixed(0)} 保持者${c.team}${c.no}とボール距離${d.toFixed(1)}m`);
          }
        }
      }
      assert.deepEqual(bad, [], `違反 ${bad.length}件: ${bad.slice(0, 3).join(" / ")}`);
    });

    test(`oracle[${id}|${wname}]: GK規則 — 常に自陣側（ハーフウェーを越えない）`, () => {
      const range = E.playedRange(m);
      const bad = [];
      for (let t = range.t0 + 10; t < range.t1; t += 29) {
        const st = E.stateAt(m, sc, t);
        for (const team of E.teamKeys(m)) {
          const dir = m.dir[team][st.half === 1 ? "h1" : "h2"];
          const gk = st.players.find(p => p.onPitch && p.team === team && p.role === "GK");
          if (gk && dir * gk.x > 0.5) bad.push(`t=${t.toFixed(0)} ${team}GK x=${gk.x.toFixed(1)} (敵陣)`);
        }
      }
      assert.deepEqual(bad, [], `違反 ${bad.length}件: ${bad.slice(0, 3).join(" / ")}`);
    });

    test(`oracle[${id}|${wname}]: リスタート位置規則 — 各再開のボールが規則位置（ピン窓末尾）`, () => {
      const range = E.playedRange(m);
      const bad = []; const seen = { corner: 0, throwin: 0, goalkick: 0, kickoff: 0 };
      for (let t = range.t0 + 10; t < range.t1; t += 1.1) {
        const c = E.carrierAt(m, sc, t);
        if (!c || !c.seg || !c.seg.restart || c.seg.rdelay < 1) continue;
        const tEnd = c.seg.tf + c.seg.rdelay - 0.2;
        if (Math.abs(t - tEnd) > 0.6) continue;                 // 窓末尾（到着後）のみ
        const b = E.ballAt(m, sc, t);
        if (b.free < 0.9) continue;                             // 実試合アンカー窓は対象外
        const kind = c.seg.restart; seen[kind] = (seen[kind] || 0) + 1;
        const ax = Math.abs(b.x), ay = Math.abs(b.y);
        if (kind === "corner" && !(ax >= 49 && ax <= 53.5 && ay >= 31 && ay <= 34.5))   // アーク±2m（長距離運搬の到着余裕）
          bad.push(`t=${t.toFixed(0)} corner (${b.x.toFixed(1)},${b.y.toFixed(1)})`);
        if (kind === "throwin" && !(ay >= 28))
          bad.push(`t=${t.toFixed(0)} throwin y=${b.y.toFixed(1)}`);
        if (kind === "goalkick" && !(ax >= 35 && ay <= 14))
          bad.push(`t=${t.toFixed(0)} goalkick (${b.x.toFixed(1)},${b.y.toFixed(1)})`);
        if (kind === "kickoff" && !(Math.hypot(b.x, b.y) <= 0.8))
          bad.push(`t=${t.toFixed(0)} kickoff (${b.x.toFixed(1)},${b.y.toFixed(1)})`);
        t = tEnd + 1;                                           // 同一窓の重複判定を避ける
      }
      assert.deepEqual(bad, [], `違反 ${bad.length}件: ${bad.slice(0, 3).join(" / ")}`);
      assert.ok(seen.throwin + seen.corner + seen.goalkick > 10, `再開サンプル ${JSON.stringify(seen)}`);
    });
  }

  test(`oracle[${id}]: 運動規則 — チーム平均速度が現実域（0.5〜6 m/s）`, () => {
    const sc = E.actualScenario(m), range = E.playedRange(m);
    for (const team of E.teamKeys(m)) {
      let sum = 0, n = 0;
      for (let t = range.t0 + 60; t < range.t1; t += 47) {
        for (const p of m.teams[team].squad.slice(0, 16)) {
          const pr = E.presenceOf(m, sc, team, p.no);
          if (!pr || t < pr.from + 40 || t > pr.to - 5) continue;
          sum += E.speedKmh(m, sc, team, p.no, t) / 3.6; n++;
        }
      }
      const mean = sum / n;
      assert.ok(mean > 0.5 && mean < 6, `${team} 平均速度 ${mean.toFixed(2)}m/s (n=${n})`);
    }
  });

  test(`oracle[${id}]: 支配率規則 — 両チーム合計=100%`, () => {
    const sc = E.actualScenario(m);
    const st = E.possessionStats(m, sc, E.playedRange(m).t1);
    const keys = E.teamKeys(m);
    assert.ok(Math.abs(st[keys[0]] + st[keys[1]] - 1) < 1e-9, JSON.stringify(st));
  });
}
