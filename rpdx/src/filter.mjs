/* =========================================================================
   RPDX.filter — 状態空間フィルタ（Issue #20 v1・異分野輸入）
   ---------------------------------------------------------------------------
   α-β-γ（定常ゲイン・カルマン等価）トラッキングフィルタ。
   実測トラッキング（#12）のノイズ平滑・欠測補間・速度/加速度の安定推定に使う。
   依存ゼロ・決定論。samples: [{t, x, y}]（x,y=null で欠測=コースト予測）。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const FILTER = (R.filter = {});

  // 標準ゲイン: 中程度の計測ノイズ（σ≈0.5-1.5m・~10Hzトラック）向け。
  // β/dt・2γ/dt² と増幅されるため高レートでは小さめが正しい。
  // α=位置補正 / β=速度補正 / γ=加速度補正（小さいほど滑らか・大きいほど追従）
  FILTER.DEFAULTS = { alpha: 0.30, beta: 0.055, gamma: 0.0035 };

  FILTER.abg = (samples, opts = {}) => {
    const { alpha, beta, gamma } = { ...FILTER.DEFAULTS, ...opts };
    const out = new Array(samples.length);
    let init = false;
    let x = 0, y = 0, vx = 0, vy = 0, ax = 0, ay = 0, tPrev = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const dt = init ? Math.max(1e-3, s.t - tPrev) : 0;
      if (!init) {
        if (s.x == null) { out[i] = { t: s.t, x: null, y: null, vx: 0, vy: 0, ax: 0, ay: 0, coast: true }; continue; }
        x = s.x; y = s.y; init = true; tPrev = s.t;
        out[i] = { t: s.t, x, y, vx: 0, vy: 0, ax: 0, ay: 0, coast: false };
        continue;
      }
      // 予測（等加速度）
      const xp = x + vx * dt + 0.5 * ax * dt * dt;
      const yp = y + vy * dt + 0.5 * ay * dt * dt;
      const vxp = vx + ax * dt, vyp = vy + ay * dt;
      if (s.x == null) {
        // 欠測: コースト（予測をそのまま採用・加速度は減衰）
        x = xp; y = yp; vx = vxp; vy = vyp; ax *= 0.9; ay *= 0.9;
        out[i] = { t: s.t, x, y, vx, vy, ax, ay, coast: true };
      } else {
        const rx = s.x - xp, ry = s.y - yp;
        x = xp + alpha * rx; y = yp + alpha * ry;
        vx = vxp + (beta / dt) * rx; vy = vyp + (beta / dt) * ry;
        ax += (2 * gamma / (dt * dt)) * rx; ay += (2 * gamma / (dt * dt)) * ry;
        out[i] = { t: s.t, x, y, vx, vy, ax, ay, coast: false };
      }
      tPrev = s.t;
    }
    return out;
  };
})();
