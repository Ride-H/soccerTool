/* =========================================================================
   RPDX.scenlib — シナリオ・ライブラリ & バッチ・シミュレーション（Issue #34 v1）
   ---------------------------------------------------------------------------
   決定論エンジンの強み＝「同じシナリオは何度でも同じ結果」を運用へ:
     - シナリオの最小表現（直列化/復元・URL/ファイル共有）
     - 多数シナリオの一括実行と結果集計（スコア再構成・危険度平均・フェーズ配分）
     - パラメータ格子（例: 交代分スイープ）の生成ヘルパ
   すべて純関数・乱数なし。CLI は rpdx/tools/batch.mjs、UI は ?scenario= 読込。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const SCN = (R.scenlib = {});

  /* ---- 直列化（最小表現・決定論） ---- */
  SCN.serialize = (scenario) => {
    const o = { l: scenario.label || "" };
    if (scenario.subs) {
      const subs = {};
      for (const [k, arr] of Object.entries(scenario.subs)) {
        if (arr && arr.length) subs[k] = arr.map(s => [s.t, s.out, s.in]);
      }
      if (Object.keys(subs).length) o.s = subs;
    }
    if (scenario.lineup) o.u = scenario.lineup;
    if (scenario.tweaks) o.w = scenario.tweaks;
    if (scenario.opponentHt) o.h = scenario.opponentHt;
    return JSON.stringify(o);
  };

  SCN.parse = (match, str) => {
    const S = R.subs, E = R.engine;
    const o = typeof str === "string" ? JSON.parse(str) : str;
    const subs = {};
    for (const k of E.teamKeys(match)) {
      subs[k] = ((o.s && o.s[k]) || []).map(([t, out, inn]) => ({ t, out, in: inn }));
    }
    const sc = S.createScenario(match, o.l || "imported", { subs, lineup: o.u || null, tweaks: o.w || null });
    if (o.h) sc.opponentHt = o.h;
    const validation = S.validateScenario(match, sc);
    return { scenario: sc, validation };
  };

  /* ---- バッチ実行（決定論・読み取り） ----
     entries: [{name, scenario}] → 行: 結果スコア・ゴール増減・危険度平均・首位フェーズ */
  SCN.batch = (match, entries) => {
    const E = R.engine, D = R.danger, SIM = R.sim, T = R.tactics;
    const keys = E.teamKeys(match);
    const rows = [];
    for (const { name, scenario } of entries) {
      const oc = scenario.actual ? null : SIM.outcome(match, scenario);
      const score = {};
      if (oc) for (const k of keys) score[k] = oc.score[k];
      else for (const k of keys) score[k] = match.events.filter(e => e.type === "goal" && e.team === k).length;
      const pts = D.curve(match, scenario, { step: 8, includeGK: false });
      const dMean = {};
      for (const k of keys) dMean[k] = pts.reduce((a, p) => a + p.v[k], 0) / pts.length;
      const shares = T.phaseShares(match, scenario);
      const topPhase = {};
      for (const k of keys) {
        topPhase[k] = T.PHASES.reduce((best, ph) =>
          shares[k][ph] > shares[k][best] ? ph : best, T.PHASES[0]);
      }
      rows.push({
        name,
        score: keys.map(k => `${k} ${score[k]}`).join(" - "),
        added: oc ? oc.events.filter(e => e.sim).length : 0,
        dangerMean: Object.fromEntries(keys.map(k => [k, +dMean[k].toFixed(1)])),
        topPhase,
      });
    }
    return rows;
  };

  /* ---- 編集フレームの直列化（#82・座標スナップショットの保存/共有） ---- */
  // 最小表現: 選手[team,no,x,y]・ボール[x,y]・審判[x,y]・時刻。JSON/フォルダ/URLで共有。
  SCN.serializeFrame = (frame) => {
    const r2 = (v) => Math.round(v * 100) / 100;
    return JSON.stringify({
      v: 1, t: r2(frame.t ?? 0),
      p: frame.players.filter(p => p.onPitch).map(p => [p.team, p.no, r2(p.x), r2(p.y)]),
      b: frame.ball ? [r2(frame.ball.x), r2(frame.ball.y)] : null,
      r: (frame.referees || []).map(rf => [r2(rf.x), r2(rf.y)]),
    });
  };
  SCN.parseFrame = (match, str, baseScenario) => {
    const E = R.engine;
    const o = typeof str === "string" ? JSON.parse(str) : str;
    // baseFrame（editFrameAt）に上書き — 属性・役割は合成フレームから引き継ぐ
    const base = E.editFrameAt(match, baseScenario || E.actualScenario(match), o.t || 0);
    const byKey = new Map(base.players.map(p => [p.team + ":" + p.no, p]));
    for (const [team, no, x, y] of (o.p || [])) {
      const pl = byKey.get(team + ":" + no);
      if (pl) { pl.x = x; pl.y = y; }
    }
    if (o.b && base.ball) { base.ball.x = o.b[0]; base.ball.y = o.b[1]; }
    base.referees = (o.r || []).map(([x, y]) => ({ x, y }));
    base.edited = true;
    return base;
  };

  /* ---- #83: 編集フレーム → 制約(editAnchors) → 再合成シナリオ（中間路） ----
     編集位置を「その時刻を通過するガウス窓アンカー」に翻訳し、以降を既存エンジンで再合成。
     σ は編集前 stateAt 位置からの移動距離に比例（速度上限を構成的に保証: 0.61·d/σ ≤ 3.2m/s）。
     編集は scenario 級 → actual/既定world・golden は不変。ball 保持の再合成は将来（残）。 */
  SCN.scenarioFromFrame = (match, frame, baseScenario) => {
    const E = R.engine, S = R.subs;
    const base = baseScenario || E.actualScenario(match);
    const natural = E.stateAt(match, base, frame.t);   // 編集前の合成位置（移動距離の基準）
    const natBy = new Map(natural.players.map(p => [p.team + ":" + p.no, p]));
    const editAnchors = [];
    for (const p of frame.players) {
      if (!p.onPitch) continue;
      const nat = natBy.get(p.team + ":" + p.no);
      const d = nat ? Math.hypot(p.x - nat.x, p.y - nat.y) : 0;
      if (d < 0.05) continue;                          // 動かしていない選手はアンカー不要
      editAnchors.push({ t: frame.t, team: p.team, no: p.no, x: p.x, y: p.y, sigma: Math.max(4, d * 0.19) });
    }
    const sc = S.createScenario(match, "編集フレーム再合成 @" + Math.round(frame.t) + "s", base);
    sc.editAnchors = editAnchors;
    sc.editFrom = frame.t;
    return { scenario: sc, validation: S.validateScenario(match, sc), moved: editAnchors.length };
  };

  /* ---- 格子生成: 交代分スイープ（idx番目の交代の分を動かす） ---- */
  SCN.subMinuteGrid = (match, base, team, subIdx, minutes) => {
    const S = R.subs;
    const out = [];
    for (const min of minutes) {
      const sc = S.fork(match, base);
      const arr = sc.subs[team] || [];
      if (!arr[subIdx]) continue;
      arr[subIdx] = { ...arr[subIdx], t: S.minuteToT(match, min) };
      sc.label = `${team} sub#${subIdx} @${min}'`;
      const validation = S.validateScenario(match, sc);
      if (validation.ok) out.push({ name: sc.label, scenario: sc });
    }
    return out;
  };
})();
