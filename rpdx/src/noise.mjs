/* =========================================================================
   RPDX.noise — 決定論・滑らか・帯域制限つきノイズ／スプライン基盤
   すべて純関数: 同じ入力 → 常に同じ出力（タイムラインをどこから叩いても一致）。
   周波数と振幅を明示制御することで選手速度の上限を構成的に保証する。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const N = (R.noise = {});

  // ---- 整数ハッシュ（決定論） ----
  N.hash = (n) => {
    n = (n ^ 61) ^ (n >>> 16);
    n = (n + (n << 3)) | 0;
    n = n ^ (n >>> 4);
    n = Math.imul(n, 0x27d4eb2d);
    n = n ^ (n >>> 15);
    return (n >>> 0) / 4294967295; // [0,1]
  };
  N.hash2 = (a, b) => N.hash((Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) | 0);

  // 文字列 → 32bit シード
  N.seedOf = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h | 0;
  };

  const smooth = (u) => u * u * (3 - 2 * u); // C1 連続・|d/du| ≤ 1.5

  // ---- 1D 値ノイズ: 周期 period 秒、値域 [-1,1]、|d/dt| ≤ 3/period ----
  N.vnoise1 = (seed, t, period) => {
    const x = t / period;
    const i = Math.floor(x);
    const u = smooth(x - i);
    const a = N.hash2(seed, i) * 2 - 1;
    const b = N.hash2(seed, i + 1) * 2 - 1;
    return a + (b - a) * u;
  };

  // オクターブ合成: 各項 amp_k·vnoise1(period_k)。最大微分 ≈ Σ 3·amp_k/period_k
  N.fbm1 = (seed, t, octaves /* [{amp, period}] */) => {
    let v = 0;
    for (let k = 0; k < octaves.length; k++) {
      v += octaves[k].amp * N.vnoise1((seed + k * 101) | 0, t + k * 977, octaves[k].period);
    }
    return v;
  };
  N.fbm1MaxSpeed = (octaves) => octaves.reduce((s, o) => s + (3 * o.amp) / o.period, 0);

  // ---- キーポイント・スプライン（単調時間, smoothstep補間） ----
  // kps: [[t, v...], ...] 時刻昇順。任意次元の値ベクトル。
  N.spline = (kps, t) => {
    const n = kps.length;
    if (t <= kps[0][0]) return kps[0].slice(1);
    if (t >= kps[n - 1][0]) return kps[n - 1].slice(1);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (kps[mid][0] <= t) lo = mid; else hi = mid;
    }
    const a = kps[lo], b = kps[hi];
    const u = smooth((t - a[0]) / (b[0] - a[0] || 1));
    const out = new Array(a.length - 1);
    for (let i = 1; i < a.length; i++) out[i - 1] = a[i] + (b[i] - a[i]) * u;
    return out;
  };

  // ---- ガウス時間窓（イベントアンカー用の引力重み） ----
  N.gauss = (t, center, sigma) => Math.exp(-((t - center) * (t - center)) / (2 * sigma * sigma));

  N.clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
  N.lerp = (a, b, u) => a + (b - a) * u;
  N.smooth = smooth;
})();
