/* =========================================================================
   RPDX.sim — 結果再構成エンジン（What-if Outcome）
   ---------------------------------------------------------------------------
   交代・布陣・配置の変更が「試合結果そのもの」を変える層。完全決定論:
   同じシナリオは何度計算しても同じ結果になる（ハッシュ駆動・乱数なし）。

   3つの機構:
   ■ ゴール消滅 — 実ゴールは次の条件を失うと消える:
       (a) 得点者/アシスト者がその時刻にピッチ上にいない
       (b) 得点直前24秒の攻撃危険度がシナリオ世界で実試合比 0.55 未満に低下
   ■ ゴール追加 — 危険度曲線の増分 ∫max(0, sim−actual)dt から期待値 λ を
       算定し、決定論ポアソンで本数を決定。発生時刻は増分の極大点、
       得点者は攻撃値の重み付き決定論選択。
   ■ 世界再構成 — 消滅ゴールの再現アンカー/祝祭/キックオフを窓ごと抑制し、
       追加ゴールには合成アンカー（進入→ネット→再開）を注入。
       エンジンはこの outcome を通じてイベント・スコア・動きを再構成する。

   判定は「シナリオ付与前」の危険度曲線（=プロセス曲線）に基づく一段確定。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const SIM = (R.sim = {});
  const N = R.noise, E = R.engine, D = R.danger;
  const clamp = N.clamp;
  const HALF_W = 52.5;

  const KAPPA = 6.0;        // 絶対増分積分 → λ 変換係数（較正値）
  const KAPPA_R = 0.8;      // 相対増分（scen/act−1） → λ 変換係数
  const EPS_I = 1500;       // 相対比のゼロ割ガード（pt·s）
  const RATIO_KEEP = 0.55;  // ゴール保持に必要な攻撃危険度比
  const STEP = 8;

  // 決定論ポアソン
  const detPoisson = (lambda, u) => {
    let k = 0, p = Math.exp(-lambda), cum = p;
    while (u > cum && k < 3) { k++; p *= lambda / k; cum += p; }
    return k;
  };

  const curveVal = (pts, t, team) => {
    if (!pts || !pts.length) return 0;
    const i = clamp(Math.round((t - pts[0].t) / STEP), 0, pts.length - 1);
    return pts[i].v[team] || 0;
  };

  // ゴール直後の再開アンカー（センターキックオフ）時刻
  const restartAfter = (match, t) => {
    for (const a of match.ballAnchors) {
      if (a.x === 0 && a.y === 0 && a.t > t && a.t <= t + 130) return a.t;
    }
    return t + 55;
  };

  /* ---------------- 本体: outcome(match, scenario) ---------------- */
  SIM.outcome = (match, scenario, opts = {}) => {
    if (!scenario || scenario.actual) return null;
    const sHash = E.scenarioHash(scenario);
    // プロセス曲線は outcome 付与前の世界で評価（一段確定）
    const saved = scenario.outcome;
    scenario.outcome = null;
    const co = { step: STEP, includeGK: !!opts.includeGK };
    const act = D.curve(match, E.actualScenario(match), co);
    const scen = D.curve(match, scenario, co);
    scenario.outcome = saved;

    const range = E.playedRange(match);
    const keys = E.teamKeys(match);
    const removed = [], suppress = [];

    /* --- 1) 実ゴールの保持/消滅判定 --- */
    for (const ev of match.events) {
      if (ev.type !== "goal") continue;
      const T = match.teams[ev.team];
      const parts = [ev.no, ev.assist].filter(n => n != null);
      let absent = null;
      for (const no of parts) {
        const pr = E.presenceOf(match, scenario, ev.team, no);
        if (!pr || ev.t < pr.from + 1 || ev.t > pr.to) { absent = no; break; }
      }
      // 直前24秒の攻撃危険度比（シナリオ/実試合）
      let rs = 0, ra = 0, n = 0;
      for (let tt = Math.max(range.t0, ev.t - 24); tt <= ev.t; tt += STEP) {
        rs += curveVal(scen, tt, ev.team); ra += curveVal(act, tt, ev.team); n++;
      }
      const ratio = (rs / n + 5) / (ra / n + 5);
      if (absent != null) {
        const p = T.squad.find(q => q.no === absent);
        removed.push({ ev, reason: `${p ? p.ja : "#" + absent} がこのシナリオではピッチ外`, ratio });
      } else if (ratio < RATIO_KEEP) {
        removed.push({ ev, reason: `攻撃脅威が実試合比 ${Math.round(ratio * 100)}% に低下`, ratio });
      }
    }
    for (const r of removed) {
      suppress.push({ t0: r.ev.t - 26, t1: restartAfter(match, r.ev.t) + 3 });
    }

    /* --- 2) 追加ゴール（危険度増分 → 決定論ポアソン） --- */
    const added = [], ballAnchors = [], playerAnchors = [];
    const keptGoalTs = match.events
      .filter(e => e.type === "goal" && !removed.some(r => r.ev === e))
      .map(e => e.t);
    const teamDelta = {};
    keys.forEach((team, ti) => {
      let gainI = 0, actI = 0, scenI = 0;
      const gains = [];
      for (const pt of scen) {
        const a = curveVal(act, pt.t, team);
        const s = pt.v[team];
        actI += a * STEP; scenI += s * STEP;
        const g = Math.max(0, s - a);
        gainI += g * STEP;
        gains.push({ t: pt.t, g });
      }
      // 絶対増分 + 相対増分（低ベースラインのチームでも攻勢転換が結果に効く）
      const ratioI = (scenI + EPS_I) / (actI + EPS_I);
      const lambda = Math.min(2.2,
        KAPPA * gainI / (100 * (range.t1 - range.t0)) + KAPPA_R * Math.max(0, ratioI - 1));
      const nAdd = detPoisson(lambda, N.hash2(sHash, ti * 77 + 13));
      teamDelta[team] = {
        lambda, added: 0,
        deltaPct: actI > 1 ? Math.round(100 * (scenI - actI) / actI) : 0,
      };
      if (nAdd <= 0) return;
      // 候補時刻: 増分の極大（分離240s・既存ゴール±90s回避・端回避）
      const cands = [];
      for (let i = 2; i < gains.length - 2; i++) {
        const g = gains[i];
        if (g.g < 8) continue;
        if (g.g < gains[i - 1].g || g.g < gains[i + 1].g) continue;
        if (g.t < range.t0 + 300 || g.t > range.t1 - 90) continue;
        if (keptGoalTs.some(gt => Math.abs(gt - g.t) < 90)) continue;
        if (suppress.some(w => g.t >= w.t0 - 30 && g.t <= w.t1 + 30)) continue;
        cands.push(g);
      }
      cands.sort((a, b) => b.g - a.g);
      const picked = [];
      for (const c of cands) {
        if (picked.some(p => Math.abs(p.t - c.t) < 240)) continue;
        picked.push(c);
        if (picked.length >= nAdd) break;
      }
      picked.sort((a, b) => a.t - b.t);
      const T = match.teams[team];
      picked.forEach((c, gi) => {
        const t = Math.round(c.t);
        const half = E.halfOf(match, t);
        const d = match.dir[team][half === 1 ? "h1" : "h2"];
        // 得点者: その時刻のピッチ上11人から攻撃値重みで決定論選択（GK除外）
        const roster = E.rosterAt(match, scenario, team, t);
        const xi = Object.entries(roster.assign)
          .map(([slot, no]) => ({ slot, p: T.squad.find(q => q.no === no) }))
          .filter(e => e.p && e.slot !== "GK");
        let wsum = 0;
        const ws = xi.map(e => {
          const w = Math.pow(e.p.attrs.att / 100, 3)
            + (e.slot.includes("S") || e.slot.includes("F") || e.slot.includes("W") ? 0.22 : 0.02);
          wsum += w; return w;
        });
        let u = N.hash2(sHash, ti * 511 + gi * 31 + 7) * wsum;
        let scorer = xi[0].p;
        for (let i = 0; i < xi.length; i++) { u -= ws[i]; if (u <= 0) { scorer = xi[i].p; break; } }
        const gy = (N.hash2(sHash, ti * 601 + gi * 47 + 3) * 2 - 1) * 2.8;
        const label = R.subs ? R.subs.tToLabel(match, t) : `${Math.ceil(t / 60)}'`;
        added.push({
          t, type: "goal", team, no: scorer.no, assist: null, sim: true,
          min: label,
          label: `GOAL〔SIM〕 ${scorer.ja} — シナリオ攻勢からの得点`,
          detail: `危険度増分の極大（+${c.g.toFixed(0)}pt）から決定論生成。交代・布陣変更が生んだ得点機会。`,
        });
        ballAnchors.push(
          { t: t - 9, x: d * 20, y: gy * 4 },
          { t: t - 1.2, x: d * 40, y: gy * 2.2 },
          { t: t, x: d * 52.2, y: gy, hold: 4 },
          { t: Math.min(t + 55, range.t1 - 5), x: 0, y: 0, hold: 2 },
        );
        playerAnchors.push(
          { t: t - 8, team, no: scorer.no, x: d * 24, y: gy * 3, sigma: 7 },
          { t: t - 1, team, no: scorer.no, x: d * 44, y: gy * 1.6, sigma: 5 },
        );
        teamDelta[team].added++;
      });
    });

    /* --- 3) イベント再構成 + スコア --- */
    const events = match.events
      .filter(ev => !removed.some(r => r.ev === ev))
      .concat(added)
      .sort((a, b) => a.t - b.t);
    const score = {};
    for (const k of keys) score[k] = 0;
    for (const ev of events) if (ev.type === "goal") score[ev.team]++;

    // 変更シグネチャ（キャッシュキー用・変更なしなら0）
    let sig = 0;
    const mix = (v) => { sig = (Math.imul(sig, 31) + v) | 0; };
    for (const r of removed) mix(r.ev.t | 0);
    for (const a of added) mix(a.t * 7 + a.no * 131 + N.seedOf(a.team));
    if (removed.length + added.length > 0 && sig === 0) sig = 1;

    return {
      sig, events, score,
      removed: removed.map(r => ({ t: r.ev.t, team: r.ev.team, no: r.ev.no, min: r.ev.min, label: r.ev.label, reason: r.reason })),
      added, suppress, ballAnchors, playerAnchors, teamDelta,
      actualScore: (() => { const s = {}; for (const k of keys) s[k] = 0; for (const ev of match.events) if (ev.type === "goal") s[ev.team]++; return s; })(),
    };
  };

  // シナリオへ outcome を付与（エンジンの世界再構成を有効化）し、要約を返す
  SIM.attach = (match, scenario, opts = {}) => {
    if (!scenario || scenario.actual) return null;
    const oc = SIM.outcome(match, scenario, opts);
    scenario.outcome = oc;
    return oc;
  };
})();
