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
  // #85: 任意 state（合成 or 編集フレーム）から形メトリクスを計算する核。
  T.shapeFromState = (match, state, team) => {
    const half = state.half;
    const dir = match.dir[team][half === 1 ? "h1" : "h2"];
    const out = state.players.filter(p => p.onPitch && !p.entering && p.team === team && p.role !== "GK");
    if (out.length < 2) return { width: 0, depth: 0, area: 0, centroid: { x: 0, y: 0 }, lines: [out.length], effShape: String(out.length), lineGap: 0 };
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
  T.shapeMetrics = (match, scenario, team, t) =>
    T.shapeFromState(match, E.stateAt(match, scenario || E.actualScenario(match), t), team);

  // Voronoi占有（近似: 4m格子の最近接選手で塗り分け・GK除く・中立の空間占有%）
  T.voronoiFromState = (match, state) => {
    const ps = state.players.filter(p => p.onPitch && !p.entering && p.role !== "GK");
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
  T.voronoiShare = (match, scenario, t) =>
    T.voronoiFromState(match, E.stateAt(match, scenario || E.actualScenario(match), t));

  /* ---------------- 方向的タクティカル解析（Issue #85 v1・読み取り専用） ----------------
     編集/静止フレームから「その瞬間の位置・構造の帰結」を出す。テンポ/因果は断定しない
     （1フレームは空間、TPA/TRV=時間依存は対象外）。出力=モデル上の位置系の指摘。 */

  const HALF_H = 34;
  // フレームからのオフサイド境界（攻撃 team が越える相手2nd-lastの深さ dir·x）
  T.frameOffside = (match, state, attackingTeam) => {
    const opp = E.oppOf(match, attackingTeam);
    const half = state.half;
    const dir = match.dir[attackingTeam][half === 1 ? "h1" : "h2"];
    const depths = state.players
      .filter(p => p.onPitch && p.team === opp).map(p => dir * p.x).sort((a, b) => b - a);
    const secondLast = depths.length >= 2 ? depths[1] : (depths[0] ?? dir * 52.5);
    const ballDepth = state.ball ? dir * state.ball.x : -1e9;
    return { offsideDepth: Math.max(secondLast, ballDepth), dir };
  };

  // 局所数的優位（ボール周辺 R=16m の 攻(team) − 守 人数差）
  const localNumbers = (state, team, cx, cy, R = 16) => {
    let atk = 0, def = 0;
    for (const p of state.players) {
      if (!p.onPitch || p.role === "GK") continue;
      if (Math.hypot(p.x - cx, p.y - cy) > R) continue;
      if (p.team === team) atk++; else def++;
    }
    return { atk, def, diff: atk - def };
  };

  // フレーム総合解析。opts.team = 助言対象（既定=possessionPlus）
  T.frameAnalysis = (match, state, opts = {}) => {
    const D = R.danger;
    const keys = E.teamKeys(match);
    const team = opts.team || match.possessionPlus || keys[0];
    const opp = E.oppOf(match, team);
    const half = state.half;
    const dir = match.dir[team][half === 1 ? "h1" : "h2"];
    // 危険度場のホットスポット（fieldAt: >0 plus脅威 / <0 minus脅威）
    const fld = D.fieldAt(match, state, { includeGK: !!opts.includeGK });
    const NXF = 42, NYF = 28;
    const cellXY = (idx) => {
      const i = idx % NXF, j = (idx / NXF) | 0;
      return { x: -52.5 + ((i + 0.5) / NXF) * 105, y: -HALF_H + ((j + 0.5) / NYF) * 68 };
    };
    let plusMax = 0, minusMax = 0, plusAt = null, minusAt = null;
    for (let k = 0; k < fld.grid.length; k++) {
      const v = fld.grid[k];
      if (v > plusMax) { plusMax = v; plusAt = cellXY(k); }
      if (-v > minusMax) { minusMax = -v; minusAt = cellXY(k); }
    }
    const plus = match.possessionPlus || keys[0];
    const myThreat = team === plus ? plusMax : minusMax;      // 自軍が作る脅威
    const oppThreat = team === plus ? minusMax : plusMax;     // 被脅威
    const myAt = team === plus ? plusAt : minusAt;
    const oppAt = team === plus ? minusAt : plusAt;

    const shape = { [team]: T.shapeFromState(match, state, team), [opp]: T.shapeFromState(match, state, opp) };
    const voronoi = T.voronoiFromState(match, state);
    const offOwn = T.frameOffside(match, state, team);        // 自軍が越える相手ライン
    const offOpp = T.frameOffside(match, state, opp);         // 相手が越える自軍ライン

    // 方向的な指摘（決定論・severity降順）
    const sugg = [];
    const b = state.ball || { x: 0, y: 0 };
    // (1) ボール周辺の数的状況
    const near = localNumbers(state, team, b.x, b.y);
    if (near.diff <= -2) sugg.push({ severity: 2 + (-near.diff), exploits: "overload-against",
      text: `ボール周辺で ${-near.diff} 人の数的不利 — カバーを寄せて局所同数化` });
    else if (near.diff >= 2 && dir * b.x > 10) sugg.push({ severity: 1.5 + near.diff, exploits: "overload-for",
      text: `敵陣でボール周辺 ${near.diff} 人の数的優位 — 素早い展開で仕留める` });
    // (2) 相手最終ラインが高い → 背後スペース（相手2nd-lastから相手ゴールまでの空間）
    const spaceBehind = 52.5 - offOwn.offsideDepth;          // 大=ライン高い=背後が広い
    if (spaceBehind > 32) sugg.push({ severity: 1 + (spaceBehind - 32) / 10, exploits: "space-behind",
      text: `相手の最終ラインが高い（背後に約${spaceBehind.toFixed(0)}m）— 裏へのランで背後を突く` });
    // (3) 被脅威が大 → その地点のカバー（fieldAt はセル脅威密度 ~0..1.5）
    if (oppThreat > 0.35 && oppAt) sugg.push({ severity: oppThreat * 3, exploits: "cover-threat",
      text: `被危険度が高い地点(${oppAt.x.toFixed(0)},${oppAt.y.toFixed(0)}) — 最短の守備者を寄せて遮断` });
    // (4) 幅の不均衡: 自軍が狭く、ボールがサイド
    if (shape[team].width < 34 && Math.abs(b.y) > 14) sugg.push({ severity: 0.8, exploits: "width",
      text: `幅が狭くボールがサイド — 逆サイドの幅を取り相手を広げる` });

    sugg.sort((a, b) => b.severity - a.severity);
    if (!sugg.length) sugg.push({ severity: 0, exploits: "stable",
      text: `構造は安定 — 明確な位置的弱点は検出されず（テンポ/因果は本解析の対象外）` });
    return {
      team, opp,
      danger: { myThreat: +myThreat.toFixed(1), oppThreat: +oppThreat.toFixed(1), myAt, oppAt },
      shape, voronoi,
      offside: { own: offOwn, opp: offOpp },
      nearBall: near,
      suggestions: sugg.slice(0, 3),
    };
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
