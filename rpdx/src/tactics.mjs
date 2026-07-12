/* =========================================================================
   RPDX.tactics — 戦術フェーズ自動分類（Issue #32 v1・読み取り専用）
   ---------------------------------------------------------------------------
   合成状態から各時刻の「局面（フェーズ）」を決定論分類する解釈レイヤ。
   ヒューリスティックの決定木であり、実測ラベルの学習ではない（非予測・明示規律）。
   位置・イベント・危険度・結果には一切影響しない。

   タクソノミ（保持チーム視点 + 状況）:
     set-piece   … リスタート（スローイン/コーナー/ゴールキック/キックオフ）のピン〜再開
     transition  … 奪取直後（ターンオーバーから4秒・攻守が切り替わる過渡）
     build-up    … 保持チームが自陣~40%でボールを動かす
     progression … 中盤の前進（40〜75%）
     finishing   … 敵陣最終域（>75% またはゴール25m以内）
   press フラグ … 相手の協調プレスが点灯中（#29 pressTriggerAt・build-up等に重なる）
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const T = (R.tactics = {});
  const E = R.engine;
  const HALF_W = 52.5;

  T.PHASES = ["set-piece", "transition", "build-up", "progression", "finishing"];

  // 各時刻のフェーズ: { phase, team, press } / プレー外は null を返さず set-piece に含める
  T.phaseAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const c = E.carrierAt(match, scenario, t);
    if (!c) return { phase: "transition", team: null, press: false };
    const trig = E.pressTriggerAt(match, scenario, t);
    const press = !!(trig && trig.level > 0.5);
    // 1) セットピース: リスタート区間（運搬〜ピン〜解放直後）
    if (c.seg && c.seg.restart && t <= c.seg.tf + (c.seg.rdelay || 0) + 1.2)
      return { phase: "set-piece", team: c.team, press: false };
    // 2) トランジション: 奪取（相手からのターンオーバー）後4秒
    if (c.seg && c.seg.from && c.seg.from.team !== c.team && t - c.seg.t0 < 4)
      return { phase: "transition", team: c.team, press };
    // 3) 保持フェーズ: ボール前進度で3分割
    const half = E.halfOf(match, t);
    const dir = match.dir[c.team][half === 1 ? "h1" : "h2"];
    const bs = E.ballSlowAt(match, t);
    const prog = (dir * bs.x + HALF_W) / 105;            // 0=自ゴール … 1=敵ゴール
    const dGoal = Math.hypot(dir * HALF_W - bs.x, bs.y); // 敵ゴールまで
    const phase = (prog > 0.75 || dGoal < 25) ? "finishing"
      : prog < 0.40 ? "build-up" : "progression";
    return { phase, team: c.team, press };
  };

  // フェーズ別の時間集計 [秒]（チーム別・2s格子・シナリオ毎にキャッシュ）
  const shareCache = new Map();
  T.clearCaches = () => shareCache.clear();
  T.phaseShares = (match, scenario) => {
    scenario = scenario || E.actualScenario(match);
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    const hit = shareCache.get(key);
    if (hit) return hit;
    const range = E.playedRange(match);
    const out = {};
    for (const team of E.teamKeys(match)) {
      out[team] = {}; for (const ph of T.PHASES) out[team][ph] = 0;
      out[team].press = 0;
    }
    const STEP = 2;
    for (let t = range.t0 + 2; t < range.t1; t += STEP) {
      const p = T.phaseAt(match, scenario, t);
      if (!p.team) continue;
      out[p.team][p.phase] += STEP;
      if (p.press) {
        const opp = E.oppOf(match, p.team);
        out[opp].press += STEP;                          // プレスは守備側の実績
      }
    }
    if (shareCache.size > 16) shareCache.clear();
    shareCache.set(key, out);
    return out;
  };

  /* ---------------- 実効フォーメーション & 形メトリクス（Issue #33 v1） ----------------
     宣言陣形ではなく「いま実際にどう並んでいるか」を中立に測る読み取りレイヤ。
     width/depth/凸包面積(compactness)/重心/実効ライン構成/ライン間距離/Voronoi占有。 */

  // 凸包（Andrew monotone chain・依存ゼロ）→ 面積 [m²]
  const hullArea = (pts) => {
    if (pts.length < 3) return 0;
    const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const half = (arr) => {
      const h = [];
      for (const q of arr) {
        while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
        h.push(q);
      }
      return h;
    };
    const hull = [...half(p).slice(0, -1), ...half(p.reverse()).slice(0, -1)];
    let a = 0;
    for (let i = 0; i < hull.length; i++) {
      const q = hull[i], r = hull[(i + 1) % hull.length];
      a += q.x * r.y - r.x * q.y;
    }
    return Math.abs(a) / 2;
  };

  // 実効ライン推定: 深さ順に並べ、最大2ギャップで3ラインへ分割（決定論）
  const effLines = (depths) => {
    const d = [...depths].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < d.length; i++) gaps.push({ i, g: d[i] - d[i - 1] });
    gaps.sort((a, b) => b.g - a.g || a.i - b.i);
    const cuts = gaps.slice(0, 2).map(x => x.i).sort((a, b) => a - b);
    const lines = [];
    let prev = 0;
    for (const c of [...cuts, d.length]) { lines.push(c - prev); prev = c; }
    return lines;   // 守備側から [DF, MF, FW]
  };

  // 形メトリクス（1チーム・1時刻）
  T.shapeMetrics = (match, scenario, team, t) => {
    const st = E.stateAt(match, scenario || E.actualScenario(match), t);
    const half = st.half;
    const dir = match.dir[team][half === 1 ? "h1" : "h2"];
    const out = st.players.filter(p => p.onPitch && !p.entering && p.team === team && p.role !== "GK");
    const depths = out.map(p => dir * p.x);
    const ys = out.map(p => p.y);
    const width = Math.max(...ys) - Math.min(...ys);
    const depth = Math.max(...depths) - Math.min(...depths);
    const lines = effLines(depths);
    // ライン間距離: ライン重心間の平均ギャップ
    const sorted = [...depths].sort((a, b) => a - b);
    let idx = 0; const centers = [];
    for (const n of lines) { centers.push(sorted.slice(idx, idx + n).reduce((a, b) => a + b, 0) / n); idx += n; }
    const lineGap = centers.length > 1
      ? (centers[centers.length - 1] - centers[0]) / (centers.length - 1) : 0;
    return {
      width, depth,
      area: hullArea(out.map(p => ({ x: p.x, y: p.y }))),     // compactness（小=圧縮）
      centroid: {
        x: out.reduce((a, p) => a + p.x, 0) / out.length,
        y: out.reduce((a, p) => a + p.y, 0) / out.length,
      },
      lines, effShape: lines.join("-"), lineGap,
    };
  };

  // Voronoi占有（近似: 4m格子の最近接選手で塗り分け・GK除く・中立の空間占有%）
  T.voronoiShare = (match, scenario, t) => {
    const st = E.stateAt(match, scenario || E.actualScenario(match), t);
    const ps = st.players.filter(p => p.onPitch && !p.entering && p.role !== "GK");
    const count = {}; let total = 0;
    for (const k of E.teamKeys(match)) count[k] = 0;
    for (let x = -50; x <= 50; x += 4) for (let y = -32; y <= 32; y += 4) {
      let best = null, bd = 1e9;
      for (const p of ps) {
        const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
        if (d < bd) { bd = d; best = p; }
      }
      count[best.team]++; total++;
    }
    const share = {};
    for (const k of E.teamKeys(match)) share[k] = count[k] / total;
    return share;
  };

  // タイムライン帯用の低解像度サンプル列 [{u(0..1), phase, team}]
  T.phaseStrip = (match, scenario, n = 240) => {
    scenario = scenario || E.actualScenario(match);
    const range = E.playedRange(match);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = range.t0 + ((i + 0.5) / n) * (range.t1 - range.t0);
      const p = T.phaseAt(match, scenario, t);
      out.push({ u: i / n, phase: p.phase, team: p.team });
    }
    return out;
  };
})();
