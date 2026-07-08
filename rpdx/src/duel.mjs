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

  // 空中戦（コーナー/クロスの競り合い）— 決定論。クロス到達直後の窓で、
  // ボール周辺の最高 aer の攻撃側 vs 守備側を競らせ、aer で勝者を決める（同値は攻撃側）。
  // 位置・イベント・危険度は不変（描画のジャンプ/ヘッド演出が消費する読み取り専用層）。
  // 返値: { winner, loser, x, y, u(1→0), attackerWon } / なければ null
  DUEL.aerialAt = (state) => {
    const c = state.carrier;
    if (!c || c.restart !== "corner") return null;
    const crossT = (c.tf || 0) + (c.rdelay || 0);   // 静止が明けてクロスが入る時刻
    const dt = (state.t ?? 0) - crossT;
    if (dt < -0.2 || dt > 0.9) return null;          // 配球窓（コーナー区間の末尾に収まる）
    // 競り合い点はコーナー弧のボールではなく「ゴール前の箱」（クロスの落下点）
    const b = state.ball;
    const gx = Math.sign(b.x || 1) * 52.5;
    const cx = gx - Math.sign(gx) * 7, cy = 0;       // ゴール前 ~7m 中央
    let atk = null, aA = -1, def = null, aD = -1;
    for (const p of state.players) {
      if (!p.onPitch || p.role === "GK") continue;
      if (Math.hypot(p.x - cx, p.y - cy) > 16) continue;
      const aer = (p.attrs && p.attrs.aer) || 60;
      if (p.team === c.team) { if (aer > aA || (aer === aA && (!atk || p.no < atk.no))) { aA = aer; atk = p; } }
      else { if (aer > aD || (aer === aD && (!def || p.no < def.no))) { aD = aer; def = p; } }
    }
    if (!atk || !def) return null;
    const attackerWon = aA >= aD;                    // 同値は攻撃側（決定論）
    const w = attackerWon ? atk : def, l = attackerWon ? def : atk;
    return {
      winner: { team: w.team, no: w.no }, loser: { team: l.team, no: l.no },
      x: (atk.x + def.x) / 2, y: (atk.y + def.y) / 2, u: 1 - Math.max(0, dt) / 0.9, attackerWon,
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
