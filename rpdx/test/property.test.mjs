// #36 プロパティベース・テスト・ハーネス — シード付き生成器でシナリオ空間を面で覆い、
// どのシナリオでも成立すべき不変量（保存則・決定論・速度上限・順序非依存）を自動検証する。
// 反例が出た場合はシード番号つきで報告（同じシードで完全再現できる）。
//
// 注: 左右反転などの厳密な鏡像対称は、選手別シードノイズの構造上成立しない（設計どおり）。
//     ここでは「成立が保証されるべき」性質だけを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine, SIM = RPDX.sim, N = RPDX.noise;

const GEN_SEED = N.seedOf("property-harness-v1");
const K = 5;   // 1試合あたりの生成シナリオ数（CI予算内）

// シード付きシナリオ生成器: actual の交代集合の決定論部分集合（2^n 空間の抽出）
const genScenario = (m, i) => {
  const sc = structuredClone(E.actualScenario(m));
  delete sc.actual;
  sc.id = `prop-${i}`; sc.label = `property #${i}`;
  for (const team of E.teamKeys(m)) {
    sc.subs[team] = (sc.subs[team] || []).filter((_, j) =>
      N.hash2(GEN_SEED, i * 977 + j * 31 + (team.charCodeAt(0) << 3)) < 0.62);
  }
  return sc;
};

// サンプル時刻（素数間隔・シナリオごとに位相をずらす）
const timesOf = (m, i) => {
  const range = E.playedRange(m);
  const ts = [];
  for (let t = range.t0 + 15 + (i * 37) % 83; t < range.t1; t += 331) ts.push(t);
  return ts;
};

for (const m of Object.values(MATCHES)) {
  const id = m.meta.id;

  test(`property[${id}]: 生成シナリオ空間で保存則（11人×2・GK各1・支配率合計100%）`, () => {
    for (let i = 0; i < K; i++) {
      const sc = genScenario(m, i);
      for (const t of timesOf(m, i)) {
        const st = E.stateAt(m, sc, t);
        for (const team of E.teamKeys(m)) {
          const on = st.players.filter(p => p.onPitch && p.team === team);
          assert.equal(on.length, 11, `seed#${i} t=${t.toFixed(0)} ${team} 人数`);
          assert.equal(on.filter(p => p.role === "GK").length, 1, `seed#${i} t=${t.toFixed(0)} ${team} GK`);
        }
      }
      const ps = E.possessionStats(m, sc, E.playedRange(m).t1);
      const keys = E.teamKeys(m);
      assert.ok(Math.abs(ps[keys[0]] + ps[keys[1]] - 1) < 1e-9, `seed#${i} 支配率合計`);
    }
  });

  test(`property[${id}]: 生成シナリオ空間で決定論（キャッシュ全消去後も同一世界）`, () => {
    for (let i = 0; i < K; i++) {
      const sc = genScenario(m, i);
      const ts = timesOf(m, i).slice(0, 3);
      const snap = () => ts.map(t => {
        const st = E.stateAt(m, sc, t);
        return st.players.filter(p => p.onPitch)
          .map(p => `${p.team}${p.no}:${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(";")
          + `|${st.ball.x.toFixed(3)},${st.ball.y.toFixed(3)}`;
      }).join("\n");
      const a = snap();
      E.clearCaches();
      const b = snap();
      assert.equal(a, b, `seed#${i} 決定論`);
    }
  });

  test(`property[${id}]: 生成シナリオ空間で速度上限 ≤9.9m/s（サンプル検査）`, () => {
    const range = E.playedRange(m);
    for (let i = 0; i < K; i++) {
      const sc = genScenario(m, i);
      for (let j = 0; j < 30; j++) {
        const t = range.t0 + 40 + N.hash2(GEN_SEED, i * 733 + j) * (range.t1 - range.t0 - 80);
        if (Math.abs(t - range.ht) < 12) continue;      // HT境界は対象外（既存規約どおり）
        const st = E.stateAt(m, sc, t);
        const on = st.players.filter(p => p.onPitch && !p.entering);
        const p = on[Math.floor(N.hash2(GEN_SEED, i * 991 + j * 7) * on.length)];
        const pr = E.presenceOf(m, sc, p.team, p.no);
        if (!pr || t < pr.from + 35 || t > pr.to - 2) continue;   // 入退場近傍は対象外
        const v = E.speedKmh(m, sc, p.team, p.no, t) / 3.6;
        assert.ok(v <= 9.9 + 1e-6, `seed#${i} ${p.team}${p.no} v=${v.toFixed(2)}m/s @${t.toFixed(1)}`);
      }
    }
  });

  test(`property[${id}]: スクラブ順序非依存（シャッフル評価と昇順評価が同一）`, () => {
    const sc = genScenario(m, 1);
    const ts = timesOf(m, 1);
    const evalAt = (t) => {
      const st = E.stateAt(m, sc, t);
      return `${st.ball.x.toFixed(3)},${st.ball.y.toFixed(3)}|` +
        st.players.filter(p => p.onPitch).slice(0, 6).map(p => p.x.toFixed(3)).join(",");
    };
    const sorted = ts.map(evalAt);
    E.clearCaches();
    // 決定論シャッフル（seed）で同じ時刻集合を別順序評価
    const shuffled = [...ts].sort((a, b) =>
      N.hash2(GEN_SEED, Math.round(a * 7)) - N.hash2(GEN_SEED, Math.round(b * 7)));
    const map = new Map();
    for (const t of shuffled) map.set(t, evalAt(t));
    ts.forEach((t, k) => assert.equal(map.get(t), sorted[k], `t=${t.toFixed(0)} 順序依存`));
  });

  test(`property[${id}]: 結果再構成の健全性（スコア非負・ゴール時刻が試合内・再現一致）`, () => {
    const range = E.playedRange(m);
    for (let i = 0; i < K; i++) {
      const sc = genScenario(m, i);
      const oc = SIM.outcome(m, sc);
      assert.ok(oc, `seed#${i} outcome`);
      for (const k of E.teamKeys(m)) assert.ok(oc.score[k] >= 0 && oc.score[k] <= 9, `seed#${i} score ${k}=${oc.score[k]}`);
      for (const ev of oc.events) if (ev.type === "goal")
        assert.ok(ev.t >= range.t0 && ev.t <= range.t1 + 60, `seed#${i} goal t=${ev.t}`);
      const oc2 = SIM.outcome(m, genScenario(m, i));
      assert.deepEqual(oc.score, oc2.score, `seed#${i} 再構成の決定論`);
    }
  });
}
