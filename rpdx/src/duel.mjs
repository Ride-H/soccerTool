/* =========================================================================
   RPDX.duel — 接触・デュエル（Issue #22 v1）
   ---------------------------------------------------------------------------
   チェーンのターンオーバー（奪取フライト）から「接触」を決定論抽出する純関数層。
   位置・イベント・危険度には影響しない（描画のスタンブル/シールド演出が消費）。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const DUEL = (R.duel = {});
  const E = R.engine;

  // 現在時刻がタックル/インターセプト直後なら {t0, winner, loser, u} を返す
  // u ∈ (0,1]: 接触からの経過（1=接触直後 → 0=収束）。リスタートは接触ではない。
  DUEL.tackleAt = (match, scenario, t, windowSec = 1.3) => {
    scenario = scenario || E.actualScenario(match);
    const c = E.carrierAt(match, scenario, t);
    if (!c || !c.seg || c.seg.restart) return null;
    const s = c.seg;
    if (!s.from || s.from.team === s.team) return null;      // 奪取ではない
    const dt = t - s.t0;
    if (dt < 0 || dt > windowSec) return null;
    return {
      t0: s.t0,
      winner: { team: s.team, no: s.no },
      loser: { team: s.from.team, no: s.from.no },
      u: 1 - dt / windowSec,
    };
  };

  // シールド判定（保持者が最近接プレッサーから体を入れるべきか）— 描画用幾何
  DUEL.shieldAt = (state) => {
    const c = state.carrier;
    if (!c || c.mode !== "hold" || c.restart) return null;
    const holder = state.players.find(p => p.onPitch && p.team === c.team && p.no === c.no);
    if (!holder) return null;
    let presser = null, dn = 1e9;
    for (const p of state.players) {
      if (!p.onPitch || p.team === c.team || p.role === "GK") continue;
      const d = Math.hypot(p.x - holder.x, p.y - holder.y);
      if (d < dn) { dn = d; presser = p; }
    }
    if (!presser || dn > 4.5) return null;
    return { holder: { team: holder.team, no: holder.no }, presser: { team: presser.team, no: presser.no }, dist: dn };
  };
})();
