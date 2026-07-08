/* =========================================================================
   RPDX.physio — 運動生理・代謝負荷（Issue #21 v1・異分野輸入）
   ---------------------------------------------------------------------------
   di Prampero らの「等価傾斜」モデルで加速度ランニングのエネルギーコストを推定:
     ES = a/g（等価傾斜） / EC(ES) = 155.4ES⁵ −30.4ES⁴ −43.3ES³ +46.3ES² +19.5ES +3.6 [J/kg/m]
     P = EC × v [W/kg]（メタボリックパワー）
   出典: di Prampero et al. 2005 / Osgnach et al. 2010（係数は文献値・モデル推定表示）。
   位置は合成モデル由来 — 値は「推定」であり実測GPS/LPSの代替ではない。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const PHYS = (R.physio = {});
  const E = R.engine, N = R.noise;
  const clamp = N.clamp;

  PHYS.HSR_MS = 5.5;        // 高強度走行 19.8km/h
  PHYS.SPRINT_MS = 7.0;     // スプリント 25.2km/h（進入） / 6.2 で解除
  PHYS.STEP = 3;            // サンプリング[s]

  // 等価傾斜のエネルギーコスト [J/kg/m]（文献多項式・|ES|は現実域にクランプ）
  PHYS.ecCost = (es) => {
    es = clamp(es, -0.45, 0.45);
    return clamp(
      155.4 * es ** 5 - 30.4 * es ** 4 - 43.3 * es ** 3 + 46.3 * es ** 2 + 19.5 * es + 3.6,
      0.8, 14);
  };

  const cache = new Map();
  PHYS.clearCaches = () => cache.clear();

  // 選手の試合内サマリ: { avgP, peakP, hsr, sprints, peakV, mins, n }
  // avgP/peakP [W/kg], hsr [m], peakV [m/s]。決定論・presence範囲のみ。
  PHYS.summary = (match, scenario, team, no, opts = {}) => {
    scenario = scenario || E.actualScenario(match);
    const step = opts.step || PHYS.STEP;
    const key = `${match.meta.id}|${E.scenarioKey(scenario)}|${team}|${no}|${step}`;
    if (cache.has(key)) return cache.get(key);
    const pr = E.presenceOf(match, scenario, team, no);
    if (!pr) return null;
    let vPrev = 0, sumP = 0, peakP = 0, hsr = 0, sprints = 0, peakV = 0, n = 0, eJ = 0;
    let inSprint = false;
    for (let t = pr.from + 1; t <= pr.to; t += step) {
      const v = E.speedKmh(match, scenario, team, no, t) / 3.6;
      const a = n === 0 ? 0 : (v - vPrev) / step;
      const P = PHYS.ecCost(a / 9.81) * v;
      sumP += P; peakP = Math.max(peakP, P);
      eJ += P * step;                            // ∫P dt [J/kg] — セッション代謝負荷
      if (v >= PHYS.HSR_MS) hsr += v * step;
      if (!inSprint && v >= PHYS.SPRINT_MS) { inSprint = true; sprints++; }
      else if (inSprint && v < PHYS.SPRINT_MS - 0.8) inSprint = false;
      peakV = Math.max(peakV, v);
      vPrev = v; n++;
    }
    const out = {
      avgP: n ? sumP / n : 0, peakP, hsr, sprints, peakV,
      loadKJ: eJ / 1000,                         // 代謝負荷 [kJ/kg]（HR不要の負荷代替・TRIMPの代役）
      mins: (pr.to - pr.from) / 60, n,
    };
    cache.set(key, out);
    return out;
  };

  // UI向け: チャンク計算（メインスレッドを塞がない）。cb(summary) を完了時に呼ぶ。
  PHYS.summaryAsync = (match, scenario, team, no, cb, opts = {}) => {
    scenario = scenario || E.actualScenario(match);
    const step = opts.step || PHYS.STEP;
    const key = `${match.meta.id}|${E.scenarioKey(scenario)}|${team}|${no}|${step}`;
    if (cache.has(key)) { cb(cache.get(key)); return; }
    const pr = E.presenceOf(match, scenario, team, no);
    if (!pr) { cb(null); return; }
    let t = pr.from + 1, vPrev = 0, sumP = 0, peakP = 0, hsr = 0, sprints = 0, peakV = 0, n = 0, eJ = 0;
    let inSprint = false;
    const chunk = () => {
      const t1 = Math.min(t + 240, pr.to);
      for (; t <= t1; t += step) {
        const v = E.speedKmh(match, scenario, team, no, t) / 3.6;
        const a = n === 0 ? 0 : (v - vPrev) / step;
        const P = PHYS.ecCost(a / 9.81) * v;
        sumP += P; peakP = Math.max(peakP, P);
        eJ += P * step;
        if (v >= PHYS.HSR_MS) hsr += v * step;
        if (!inSprint && v >= PHYS.SPRINT_MS) { inSprint = true; sprints++; }
        else if (inSprint && v < PHYS.SPRINT_MS - 0.8) inSprint = false;
        peakV = Math.max(peakV, v);
        vPrev = v; n++;
      }
      if (t <= pr.to) { setTimeout(chunk, 0); return; }
      const out = { avgP: n ? sumP / n : 0, peakP, hsr, sprints, peakV, loadKJ: eJ / 1000, mins: (pr.to - pr.from) / 60, n };
      cache.set(key, out);
      cb(out);
    };
    chunk();
  };
})();
