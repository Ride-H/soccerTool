/* =========================================================================
   RPDX.policy — 決定論ポリシー探索（Issue #45 research・軽量v1・読み取り専用）
   ---------------------------------------------------------------------------
   決定論エンジン（同一入力=同一出力）を「意思決定の探索」に使う研究用レイヤ。
   陣形×交代分の格子を張り、各候補シナリオを決定論目的値で評価してランク付けする。

   ★ これは【モデル上の探索】であり、実試合の予測ではない。目的値は本ツールの
     結果再構成（SIM.outcome）と危険度場（D.curve）というモデル出力に対する順序付け
     であって、現実の戦術的優劣を主張するものではない。乱数なし・同一入力=同一出力。

     envSpec(match, team)          … 行動空間メタ（利用可能な陣形・交代枠・分レンジ）
     objective(match, scenario, team)
                                   … 決定論目的値 = 得失点差(再構成) + 小さな危険度差の項
     gridSearch(match, team, opts, topK)
                                   … 陣形×分の格子から validator 通過候補を生成し降順ランク
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const P = (R.policy = {});
  const E = R.engine, S = R.subs, F = R.formations, D = R.danger, SIM = R.sim, SCN = R.scenlib;

  // 危険度差の重み: 得失点差（整数）に対し従属的な「小項」（タイブレーク相当）。
  //   value = (score[team]-score[opp]) + W_DANGER*(dangerMean[team]-dangerMean[opp])
  //   危険度平均差は概ね ±30 程度 → 寄与は ±0.3 に収まり、整数の得失点差を覆さない。
  const W_DANGER = 0.01;
  const DANGER_STEP = 12;   // 目的値用の粗い決定論サンプル（実行時間<30s の予算内）

  const defaultTeam = (match, team) =>
    team || match.possessionPlus || E.teamKeys(match)[0];

  // 結果再構成のシナリオ単位メモ（objective と score の二重計算を避ける・決定論不変）
  const ocCache = new WeakMap();
  const outcomeOf = (match, scenario) => {
    if (scenario.actual) return null;
    if (ocCache.has(scenario)) return ocCache.get(scenario);
    const oc = SIM.outcome(match, scenario);
    ocCache.set(scenario, oc);
    return oc;
  };
  const scoreMap = (match, scenario) => {
    const keys = E.teamKeys(match), oc = outcomeOf(match, scenario), s = {};
    if (oc) for (const k of keys) s[k] = oc.score[k];
    else for (const k of keys) s[k] = match.events.filter(e => e.type === "goal" && e.team === k).length;
    return s;
  };

  // 行動空間メタ（探索の定義域）
  P.envSpec = (match, team) => {
    team = defaultTeam(match, team);
    const range = E.playedRange(match);
    const t1min = Math.floor((range.t1 / 60));
    const subsUsed = (match.subsActual && match.subsActual[team]) ? match.subsActual[team].length : 0;
    return {
      team,
      formations: Object.keys(F.SHAPES),        // 利用可能な陣形キー
      minutesRange: [1, Math.min(90, t1min)],   // 陣形適用/交代の分レンジ
      subWindows: 3,                            // FIFA: 交代機会（HT除く）
      subsActual: subsUsed,                     // 実試合で使った交代枠
    };
  };

  // 決定論目的値（team 視点・省略時は優勢側）
  P.objective = (match, scenario, team) => {
    team = defaultTeam(match, team);
    const opp = E.oppOf(match, team);
    // 得失点差: what-if は結果再構成 / actual は記録スコア
    const score = scoreMap(match, scenario);
    const goalDiff = score[team] - score[opp];
    // 平均危険度差（小項）
    const pts = D.curve(match, scenario, { step: DANGER_STEP, includeGK: false });
    const mean = (k) => pts.reduce((a, p) => a + p.v[k], 0) / pts.length;
    const dangerDiff = mean(team) - mean(opp);
    return goalDiff + W_DANGER * dangerDiff;
  };

  // スコア文字列（表示・比較用）
  const scoreOf = (match, scenario) => {
    const s = scoreMap(match, scenario);
    return E.teamKeys(match).map(k => `${k} ${s[k]}`).join(" - ");
  };

  /* 格子探索: 陣形×分の全組合せ（validator 通過のみ）を objective で降順ランク。
     opts = { formations?, minutes?, subIdx? }。基準として実試合の what-if コピーを常に含める。
     返り値 [{ label, scenario, value, score }]（value 降順・同値は label 昇順で安定）。 */
  P.gridSearch = (match, team, opts = {}, topK = 5) => {
    team = defaultTeam(match, team);
    const spec = P.envSpec(match, team);
    const formations = opts.formations || spec.formations;
    const minutes = opts.minutes || [46, 60, 70];
    const base = S.fromActual(match, "policy-base");   // actual:false（結果再構成が有効）

    const cands = [{ label: `${team} 実試合（基準）`, scenario: base }];
    for (const shape of formations) {
      for (const min of minutes) {
        const r = S.withFormation(match, base, team, min, shape);
        if (r.validation.ok) cands.push({ label: `${team} ${shape}@${min}'`, scenario: r.scenario });
      }
    }
    // 任意: 交代分スイープ（idx 番目の交代の分を動かす）
    if (opts.subIdx != null) {
      for (const g of SCN.subMinuteGrid(match, base, team, opts.subIdx, minutes)) cands.push(g);
    }

    const ranked = cands.map(c => ({
      label: c.label,
      scenario: c.scenario,
      value: P.objective(match, c.scenario, team),
      score: scoreOf(match, c.scenario),
    })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

    return ranked.slice(0, topK);
  };
})();
