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

  // ゲインの原理的決定（臨界減衰 α-β-γ / fading-memory）:
  //   単一の割引因子 θ∈(0,1) から閉形式で α,β,γ を導く（Brookner の g-h-k 関係）。
  //     α = 1 − θ³ ,  β = 1.5(1−θ)²(1+θ) ,  γ = 0.5(1−θ)³
  //   θ→0: 応答的（補正大）/ θ→1: 平滑重視。手調整の魔法数を1つの物理的ノブへ。
  FILTER.gainsFromTheta = (theta) => {
    const th = Math.min(Math.max(theta, 0.01), 0.99);
    const om = 1 - th;
    return { alpha: 1 - th ** 3, beta: 1.5 * om * om * (1 + th), gamma: 0.5 * om ** 3, theta: th };
  };
  // 既定 θ=0.85（~10Hz・σ≈1m の中庸）。DEFAULTS は θ から導出（原理式・魔法数なし）。
  FILTER.DEFAULT_THETA = 0.85;
  FILTER.DEFAULTS = FILTER.gainsFromTheta(FILTER.DEFAULT_THETA);

  //   opts.theta を渡すとその θ からゲインを導出（opts.alpha/beta/gamma 直接指定も可）。
  FILTER.abg = (samples, opts = {}) => {
    const base = opts.theta != null ? FILTER.gainsFromTheta(opts.theta) : FILTER.DEFAULTS;
    const { alpha, beta, gamma } = { ...base, ...opts };
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
