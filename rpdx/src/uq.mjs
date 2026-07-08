/* =========================================================================
   RPDX.uq — 不確実性定量化・検証（Issue #19 v1・異分野輸入）
   ---------------------------------------------------------------------------
   「断定できる解析」の要石: 主張 = 点推定 + 区間 + 検証統計。
   v1 は D²-Field のゴール窓警報性能を全収録試合で評価する:
     - TPR/FPR に Wilson 90%信頼区間（閉形式・依存ゼロ）
     - Brier スコアとベースライン比スキル
   注意: 評価世界はゴール再現アンカーを含む（真の予測力の主張には実測データが必要 — #7/#12）。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const UQ = (R.uq = {});
  const E = R.engine, D = R.danger, N = R.noise;
  const clamp = N.clamp;

  // Wilson スコア区間（z=1.645 → 90%）
  UQ.wilson = (k, n, z = 1.645) => {
    if (!n) return { p: 0, lo: 0, hi: 1, n };
    const p = k / n, z2 = z * z;
    const den = 1 + z2 / n;
    const c = p + z2 / (2 * n);
    const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return { p, lo: Math.max(0, (c - half) / den), hi: Math.min(1, (c + half) / den), n };
  };

  // 危険度ピーク → 「30秒内ゴール」の粗い確率写像（表示・Brier用の単調写像）
  const pmap = (peak) => clamp(Math.pow(peak / 100, 1.6) * 0.5, 0.02, 0.98);

  /* ゴール窓警報の評価（全試合・決定論）
     正例: 各ゴールの [t-30, t+2] / 負例: 120秒格子（ゴール±60s除外）×両チーム */
  UQ.evaluate = (matches, opts = {}) => {
    const thr = opts.thr ?? D.CRIT_AT;
    const step = 8;
    let tp = 0, fn = 0, fp = 0, tn = 0;
    let se = 0, seBase = 0, nAll = 0, nPos = 0;
    const rows = [];
    const samples = [];   // {p, y}
    for (const m of matches) {
      const sc = E.actualScenario(m);
      const pts = D.curve(m, sc, { step, includeGK: false });
      const at = (t, team) => {
        const i = Math.max(0, Math.min(pts.length - 1, Math.round((t - pts[0].t) / step)));
        return pts[i].v[team];
      };
      const peakIn = (t0, t1, team) => {
        let p = 0;
        for (let t = t0; t <= t1; t += 4) p = Math.max(p, at(t, team));
        return p;
      };
      const goals = m.events.filter(e => e.type === "goal");
      for (const g of goals) {
        const pk = peakIn(g.t - 30, g.t + 2, g.team);
        samples.push({ p: pmap(pk), y: 1 });
        if (pk >= thr) tp++; else fn++;
        rows.push({ match: m.meta.id, min: g.min, team: g.team, peak: pk });
      }
      const range = E.playedRange(m);
      for (let t = range.t0 + 90; t < range.t1 - 40; t += 120) {
        if (goals.some(g => Math.abs(g.t - t) < 60)) continue;
        for (const team of E.teamKeys(m)) {
          const pk = peakIn(t - 30, t + 2, team);
          samples.push({ p: pmap(pk), y: 0 });
          if (pk >= thr) fp++; else tn++;
        }
      }
    }
    nPos = tp + fn;
    nAll = samples.length;
    const base = nPos / nAll;
    for (const s of samples) {
      se += (s.p - s.y) ** 2;
      seBase += (base - s.y) ** 2;
    }
    const brier = se / nAll, brierBase = seBase / nAll;
    return {
      thr, tp, fn, fp, tn,
      tpr: UQ.wilson(tp, tp + fn),
      fpr: UQ.wilson(fp, fp + tn),
      brier, brierBase,
      skill: brierBase > 0 ? 1 - brier / brierBase : 0,
      rows,
    };
  };

  // しきい値スイープ（ROC点）: 警報閾値を変えると TPR/FPR がどうトレードオフするか。
  // 予測ではなく記述的（現収録試合での警報の効き方）。閾値↑で TPR/FPR は単調非増加。
  UQ.sweep = (matches, thresholds = [45, 55, 65, 75, 85]) => {
    return thresholds.map(thr => {
      const r = UQ.evaluate(matches, { thr });
      return { thr, tpr: r.tpr.p, fpr: r.fpr.p, tp: r.tp, fn: r.fn, fp: r.fp, tn: r.tn };
    });
  };

  // 表示用テキスト（区間つきの「責任ある断定」形式）
  UQ.reportText = (r) => {
    const pct = (w) => `${Math.round(w.p * 100)}%（90%CI ${Math.round(w.lo * 100)}–${Math.round(w.hi * 100)}%・n=${w.n}）`;
    return [
      `警報しきい値 CRITICAL ≥ ${r.thr}`,
      `ゴール検知率 TPR = ${pct(r.tpr)}`,
      `誤警報率 FPR = ${pct(r.fpr)}`,
      `Brier ${r.brier.toFixed(4)} / ベースライン ${r.brierBase.toFixed(4)} → スキル ${(r.skill * 100).toFixed(1)}%`,
      `注: 評価世界はゴール再現アンカーを含む（真の予測力の検証には実測トラッキングが必要 — #7/#12）`,
    ].join("\n");
  };
})();
