/* =========================================================================
   RPDX.quality — 品質ティア＆滑らかさ守衛（#152・VIS-00）
   - 二層ティア（cinematic / lightweight）の判定・数値予算・自動劣化の
     「唯一の情報源」。視覚系機能は RPDX.quality.flags を読むだけで、
     独自トグルを新設しない（#151 横断AC）。
   - 主目的は滑らかさの死守: フレーム時間の中央値を監視し、持続超過で
     1段ずつ機能を落とす。昇格はヒステリシス（長い持続＋ロックアウト）。
   - DOM 非依存: 判定・予算・ラダー・ガバナは env 注入の純ロジックで、
     node --test で決定論テストできる（ブラウザ固有の参照は init 内のみ）。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});

  /* ---------------- 数値予算（#152 基準表）----------------
     【暫定・要再検証】実機プロファイリング前の提案値。キャリブレーション
     実装後に実測で更新する（更新時はこの表とテストを同時に直す）。 */
  const BUDGETS = {
    lightweight: {
      frameBudgetMs: 33.4, frameFloorMs: 41.7,      // 30fps目標・24fps床
      cpuAnimBudgetMs: 6,                            // 22人分のIK/ブレンド合計
      shadowMap: false, shadowMapRes: 0, ssao: false,
      bloom: false, bloomPasses: 0, hdrTonemap: false, dof: false,
      crowd3D: false, crowdInstances: 2000,
      playerTriBudget: 2500, playerBoneBudget: 12,
      textureMemBudgetMB: 64, drawCallBudget: 400,
      animIkFull: true, animUpdateStride: 1,
    },
    cinematic: {
      frameBudgetMs: 16.7, frameFloorMs: 33.4,      // 60fps目標
      cpuAnimBudgetMs: 3,
      shadowMap: true, shadowMapRes: 2048, ssao: false,   // SSAO/DOFは任意機能（既定OFF・許可はtier）
      bloom: true, bloomPasses: 3, hdrTonemap: true, dof: false,
      crowd3D: true, crowdInstances: 5000,
      playerTriBudget: 15000, playerBoneBudget: 24,
      textureMemBudgetMB: 512, drawCallBudget: 1500,
      animIkFull: true, animUpdateStride: 1,
    },
  };
  const flagsFor = (tier) => Object.assign({}, BUDGETS[tier] || BUDGETS.lightweight);

  /* ---------------- 劣化ラダー（#152 仕様順）----------------
     ① DOF ② bloomパス数 ③ シャドウ解像度→OFF ④ SSAO ⑤ 群衆
     ⑥ プレイヤーLOD ⑦ アニメCPU（IK簡略化→更新間引き）。
     各段は「変化が無ければ no-op」— applyLadder が実効段だけを数える。 */
  const LADDER = [
    { id: "dof-off",         apply: (f) => f.dof && ((f.dof = false), true) },
    { id: "bloom-passes-1",  apply: (f) => f.bloom && f.bloomPasses > 1 && ((f.bloomPasses = 1), true) },
    { id: "bloom-off",       apply: (f) => f.bloom && ((f.bloom = false), (f.bloomPasses = 0), true) },
    { id: "shadow-res-1024", apply: (f) => f.shadowMap && f.shadowMapRes > 1024 && ((f.shadowMapRes = 1024), true) },
    { id: "shadow-off",      apply: (f) => f.shadowMap && ((f.shadowMap = false), (f.shadowMapRes = 0), true) },
    { id: "ssao-off",        apply: (f) => f.ssao && ((f.ssao = false), true) },
    { id: "crowd-half",      apply: (f) => f.crowdInstances > 800 && ((f.crowdInstances = Math.round(f.crowdInstances / 2)), true) },
    { id: "crowd-3d-off",    apply: (f) => f.crowd3D && ((f.crowd3D = false), true) },
    { id: "player-lod",      apply: (f) => f.playerTriBudget > 2500 && ((f.playerTriBudget = 2500), (f.playerBoneBudget = 12), true) },
    { id: "anim-ik-simple",  apply: (f) => f.animIkFull && ((f.animIkFull = false), true) },
    { id: "anim-stride-2",   apply: (f) => f.animUpdateStride < 2 && ((f.animUpdateStride = 2), true) },
  ];
  // base に先頭 level 段を適用した実効フラグ（純関数・no-op も1段と数える）
  const applyLadder = (base, level) => {
    const f = Object.assign({}, base);
    for (let i = 0; i < Math.min(level, LADDER.length); i++) LADDER[i].apply(f);
    return f;
  };
  const sameFlags = (a, b) => {
    for (const k in a) if (a[k] !== b[k]) return false;
    return true;
  };
  // 現 level から実際にフラグが変わる次/前の level（無ければ現状維持）
  const nextEffective = (base, level) => {
    const cur = applyLadder(base, level);
    for (let L = level + 1; L <= LADDER.length; L++)
      if (!sameFlags(applyLadder(base, L), cur)) return L;
    return level;
  };
  const prevEffective = (base, level) => {
    const cur = applyLadder(base, level);
    for (let L = level - 1; L >= 0; L--)
      if (!sameFlags(applyLadder(base, L), cur)) return L;
    return level;
  };

  /* ---------------- tier 判定（起動時ヒューリスティック）----------------
     保守的に決める: 迷ったら lightweight（#152）。実効性能はガバナが守る。 */
  const decideTier = (env) => {
    const e = env || {};
    if (e.override === "cinematic" || e.override === "lightweight")
      return { tier: e.override, source: "override", reasons: ["override:" + e.override] };
    const gpu = String(e.gpu || "").toLowerCase();
    const reasons = [];
    const software = /swiftshader|llvmpipe|softpipe|software|basic render/.test(gpu);
    const mobileGpu = /\b(mali|adreno|powervr)\b/.test(gpu) ||
      (/apple gpu/.test(gpu) && !/apple m\d/.test(gpu));   // "apple gpu"=iOS系 / "apple m+数字"=Mac系（入力は小文字化済み）
    const minDim = Math.min(e.width || 0, e.height || 0);
    if (software) reasons.push("gpu:software");
    if (mobileGpu) reasons.push("gpu:mobile");
    if (e.coarse) reasons.push("pointer:coarse");
    if (minDim < 700) reasons.push("screen:small(" + minDim + ")");
    if ((e.cores || 0) > 0 && e.cores <= 3) reasons.push("cores:" + e.cores);
    const lw = software || mobileGpu || !!e.coarse || minDim < 700 || ((e.cores || 0) > 0 && e.cores <= 3);
    if (!lw) reasons.push("desktop-class");
    return { tier: lw ? "lightweight" : "cinematic", source: "auto", reasons };
  };

  /* ---------------- 滑らかさ守衛（フレームバジェット監視）----------------
     決定論の状態機械: tick(frameMs, tSec) の入力列が同じなら遷移も同じ。 */
  const GOV = {
    WINDOW: 60,               // 中央値ウィンドウ（直近Nフレーム）
    SHORT: 12,                // 発火時の鮮度確認用の短期ウィンドウ（負荷変化直後の持ち越し誤発火を防ぐ）
    WARMUP: 45,               // 判断開始前の最少サンプル数
    SPIKE_MS: 400,            // これ超は停止/タブ切替とみなし標本から除外
    SLACK: 1.06,              // 予算×6%の猶予を超えたら「超過」
    DEGRADE_DWELL_S: 2.0,     // 超過がこの秒数続いたら1段劣化
    DEGRADE_DWELL_FAST_S: 0.7,// 床(frameFloorMs)超過時の短縮ドウェル
    PROMOTE_HEADROOM: 0.70,   // 予算×70%未満が続けば昇格候補
    PROMOTE_DWELL_S: 8,       // 昇格に要する持続（劣化より長い=ヒステリシス）
    PROMOTE_LOCKOUT_S: 15,    // 直近の劣化からこの秒数は昇格禁止
    CHANGE_COOLDOWN_S: 1.5,   // 連続変更の最短間隔
  };
  const createGovernor = ({ base, budgetMs, floorMs }) => {
    const ring = new Float64Array(GOV.WINDOW);
    let n = 0, head = 0;
    let level = 0, breachSince = null, headroomSince = null;
    let lastChangeT = -1e9, lastDegradeT = -1e9;
    const medOf = (a) => {
      const m = a.length;
      a.sort((x, y) => x - y);
      return m ? (m % 2 ? a[(m - 1) >> 1] : (a[m / 2 - 1] + a[m / 2]) / 2) : 0;
    };
    const median = () => medOf(Array.from(ring.slice(0, Math.min(n, GOV.WINDOW))));
    const shortMedian = () => {           // 直近 SHORT 標本のみ（リングの新しい側から遡る）
      const m = Math.min(n, GOV.SHORT), a = [];
      for (let i = 1; i <= m; i++) a.push(ring[(head - i + GOV.WINDOW) % GOV.WINDOW]);
      return medOf(a);
    };
    return {
      tick(frameMs, tSec) {
        if (!(frameMs > 0)) return { changed: false, level };
        if (frameMs > GOV.SPIKE_MS) {              // 停止/タブ切替: 標本除外＋持続タイマもリセット
          breachSince = null; headroomSince = null;
          return { changed: false, level };
        }
        ring[head] = frameMs; head = (head + 1) % GOV.WINDOW; n++;
        if (n < GOV.WARMUP) return { changed: false, level };
        const med = median();
        let changed = false;
        const canChange = tSec - lastChangeT >= GOV.CHANGE_COOLDOWN_S;
        if (med > budgetMs * GOV.SLACK) {
          headroomSince = null;
          if (breachSince === null) breachSince = tSec;
          const dwell = med > floorMs ? GOV.DEGRADE_DWELL_FAST_S : GOV.DEGRADE_DWELL_S;
          // 鮮度ガード: 発火時点でも直近標本が超過していること（負荷が既に下がった後の持ち越し劣化を防ぐ）
          if (tSec - breachSince >= dwell && canChange && shortMedian() > budgetMs * GOV.SLACK) {
            const L = nextEffective(base, level);
            if (L !== level) { level = L; changed = true; lastChangeT = tSec; lastDegradeT = tSec; }
            breachSince = null;                    // 次の1段はあらためて持続を要求
          }
        } else if (level > 0 && med < budgetMs * GOV.PROMOTE_HEADROOM) {
          breachSince = null;
          if (headroomSince === null) headroomSince = tSec;
          if (tSec - headroomSince >= GOV.PROMOTE_DWELL_S &&
              tSec - lastDegradeT >= GOV.PROMOTE_LOCKOUT_S && canChange &&
              shortMedian() < budgetMs * GOV.PROMOTE_HEADROOM) {   // 鮮度ガード（対称）
            const L = prevEffective(base, level);
            if (L !== level) { level = L; changed = true; lastChangeT = tSec; }
            headroomSince = null;
          }
        } else {
          breachSince = null; headroomSince = null;
        }
        return { changed, level };
      },
      level: () => level,
      medianMs: () => median(),
      samples: () => Math.min(n, GOV.WINDOW),
      reset() { n = 0; head = 0; level = 0; breachSince = null; headroomSince = null; lastChangeT = -1e9; lastDegradeT = -1e9; },
    };
  };

  /* ---------------- シングルトン（RPDX.quality）---------------- */
  const S = {
    inited: false, tier: "lightweight", source: "auto", reasons: [],
    env: null, base: flagsFor("lightweight"), gov: null,
    flags: flagsFor("lightweight"),   // 安定参照: 利用側はこのオブジェクトを保持してよい（中身を書き換える）
    listeners: new Set(),
  };
  const setFlagsInPlace = (next) => {
    for (const k of Object.keys(S.flags)) if (!(k in next)) delete S.flags[k];
    Object.assign(S.flags, next);
  };
  const notify = () => { for (const cb of S.listeners) { try { cb(state()); } catch (_) { /* listener例外は隔離 */ } } };
  const applyTier = (tier, source, reasons) => {
    S.tier = tier; S.source = source; S.reasons = reasons || [];
    S.base = flagsFor(tier);
    S.gov = createGovernor({ base: S.base, budgetMs: S.base.frameBudgetMs, floorMs: S.base.frameFloorMs });
    setFlagsInPlace(applyLadder(S.base, 0));
    notify();
  };
  const state = () => ({
    tier: S.tier, source: S.source, reasons: S.reasons.slice(),
    level: S.gov ? S.gov.level() : 0,
    medianMs: S.gov ? S.gov.medianMs() : 0,
    samples: S.gov ? S.gov.samples() : 0,
    flags: Object.assign({}, S.flags),
  });

  // ブラウザ環境の収集（Node では env を明示注入する）
  const collectEnv = () => {
    const g = globalThis;
    const env = { cores: 0, width: 0, height: 0, dpr: 1, coarse: false, gpu: "", override: null };
    try {
      if (g.navigator) env.cores = g.navigator.hardwareConcurrency || 0;
      if (typeof g.innerWidth === "number") { env.width = g.innerWidth; env.height = g.innerHeight; }
      if (typeof g.devicePixelRatio === "number") env.dpr = g.devicePixelRatio;
      if (g.matchMedia) env.coarse = g.matchMedia("(pointer:coarse)").matches;
      const q = g.location ? new g.URLSearchParams(g.location.search) : null;
      const urlTier = q && q.get("tier");
      let lsTier = null;
      try { lsTier = g.localStorage ? g.localStorage.getItem("rpdx_tier_v1") : null; } catch (_) { /* 不可環境 */ }
      const pick = (v) => (v === "cinematic" || v === "lightweight" ? v : null);
      env.override = pick(urlTier) || pick(lsTier);
    } catch (_) { /* 収集失敗は保守既定（lightweight）に落ちる */ }
    return env;
  };

  R.quality = {
    BUDGETS, GOV, ladderIds: LADDER.map((s) => s.id),
    decideTier, flagsFor, applyLadder, createGovernor,
    flags: S.flags, state,
    onChange(cb) { S.listeners.add(cb); return () => S.listeners.delete(cb); },
    init(env) {
      S.env = env || collectEnv();
      const d = decideTier(S.env);
      S.inited = true;
      applyTier(d.tier, d.source, d.reasons);
      return state();
    },
    // GPU文字列による補正（レンダラ生成後）: 保守側=降格のみ。昇格はしない。
    refineGpu(gpuStr) {
      if (!S.inited || S.source === "override") return state();
      S.env = Object.assign({}, S.env, { gpu: String(gpuStr || "") });
      const d = decideTier(S.env);
      if (S.tier === "cinematic" && d.tier === "lightweight") applyTier("lightweight", "auto", d.reasons);
      else { S.reasons = d.reasons; }
      return state();
    },
    // 手動オーバーライド: "auto" | "cinematic" | "lightweight"（端末内保存は呼び出し側）
    setOverride(mode) {
      if (!S.inited) this.init();
      const env = Object.assign({}, S.env, { override: mode === "auto" ? null : mode });
      S.env = env;
      const d = decideTier(env);
      applyTier(d.tier, d.source, d.reasons);
      return state();
    },
    // 毎フレーム呼ぶ（frameMs=直前フレーム所要ms・tSec=現在秒）。変化時のみ通知。
    tick(frameMs, tSec) {
      if (!S.inited || !S.gov) return false;
      const r = S.gov.tick(frameMs, tSec);
      if (r.changed) { setFlagsInPlace(applyLadder(S.base, r.level)); notify(); }
      return r.changed;
    },
  };
})();
