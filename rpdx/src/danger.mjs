/* =========================================================================
   RPDX.danger — D²-Field v2（距離 × 人数 × 時間の危険度場）
   ---------------------------------------------------------------------------
   v1（距離のみ）の4モジュールを、人数・時間を組み込んだ6モジュールへ拡張:

     ── 空間・距離（瞬時） ──────────────────────────────
     [SDI] 空間支配侵蝕 — Σ ctrl(cell)·T(cell) / Σ T(cell)
     [CPR] 保持者圧迫余裕 — T(ball) × (1 − exp(−(d_最近守備者/7)²)) × 保持度
     [PLV] パスレーン開通 — max_受け手 [レーン開通度 × T(受け手) × 受け手余裕]
     ── 人数（瞬時） ────────────────────────────────
     [OVL] 局所数的優位 — ボール周辺16mの攻守人数差 σ + 最終ライン人数不足
            （守備者のゴール側カバー数 < 2.8 で欠員ペナルティ）
     ── 時間（履歴・変化率） ─────────────────────────
     [TPA] 持続圧力 — 圧力原値の32秒減衰積分（波状攻撃で蓄積・決定論格子）
     [TRV] 侵攻速度 — ボールのゴール接近速度（速攻・カウンターで急伸）

     T(x,y): ゴール距離減衰 × シュート角開口 の脅威面（解析形）
     KIKEN = 100·(.18·SDI + .15·CPR + .13·PLV + .22·OVL + .20·TPA + .12·TRV)^γ·G
     WARNING ≥ 45 / CRITICAL ≥ 75（γ,G は実3失点がCRITICALに達するよう較正）

   保持判定はエンジンのポゼッション・チェーン（保持者列）を第一情報源とし、
   決定論・スケール不変・スクラブ完全一致を維持する。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const D = (R.danger = {});
  const N = R.noise, E = R.engine;
  const HALF_W = 52.5, HALF_H = 34;
  const clamp = N.clamp;

  D.WARN_AT = 45; D.CRIT_AT = 75;
  D.WEIGHTS = { SDI: 0.18, CPR: 0.15, PLV: 0.13, OVL: 0.22, TPA: 0.20, TRV: 0.12 };
  D.MODULES = ["SDI", "CPR", "PLV", "OVL", "TPA", "TRV"];
  // 較正パラメータ（scratchpad/calibrate.mjs で決定: 実3失点→CRITICAL・WARNING率≈6%）
  D.GAMMA = 0.66; D.GAIN = 1.60;

  /* ---- 脅威面 T(x,y): 攻撃方向 dir のゴール (dir·52.5, 0) に対して ---- */
  D.threatAt = (x, y, dir) => {
    const gx = dir * HALF_W;
    const dx = Math.abs(gx - x), dy = y;
    const d = Math.hypot(dx, dy);
    const decay = Math.exp(-Math.pow(d / 24, 1.7));
    // シュート角開口（ゴールマウス7.32m）
    const a1 = Math.atan2(3.66 - dy, Math.max(dx, 0.5));
    const a2 = Math.atan2(-3.66 - dy, Math.max(dx, 0.5));
    const open = clamp(Math.abs(a1 - a2) / 0.62);
    return clamp(decay * (0.35 + 0.65 * open));
  };

  // 空間支配核の半径: 既定は速度属性（モデル推定レーティング）依存 σ = 5.5 + pac/100×3。
  // Issue #13: 推定属性への依存を分離できるよう「幾何のみモード」（全員一律 σ=7.0）を提供。
  let GEOM_ONLY = false;
  D.setGeomOnly = (v) => { GEOM_ONLY = !!v; D.clearCaches(); };
  D.isGeomOnly = () => GEOM_ONLY;
  const influence = (p) => GEOM_ONLY ? 7.0 : 5.5 + (p.attrs ? p.attrs.pac / 100 : 0.75) * 3;

  // セル支配率: 攻撃側スコア / (攻+守)
  const ctrlAt = (cx, cy, atk, def) => {
    let sa = 0, sd = 0;
    for (let i = 0; i < atk.length; i++) {
      const p = atk[i], dx = cx - p.x, dy = cy - p.y;
      const s = influence(p);
      sa += Math.exp(-(dx * dx + dy * dy) / (s * s)) * (p.dwAtk ?? 1);   // #90: att/tec 重み（未編集1.0）
    }
    for (let i = 0; i < def.length; i++) {
      const p = def[i], dx = cx - p.x, dy = cy - p.y;
      const s = influence(p);
      sd += Math.exp(-(dx * dx + dy * dy) / (s * s)) * (p.dwDef ?? 1);   // #90: def 重み（未編集1.0）
    }
    return sa / (sa + sd + 1e-6);
  };

  const splitTeams = (state, atkTeam, includeGK) => {
    const atk = [], def = [];
    for (const p of state.players) {
      if (!p.onPitch) continue;
      const isGK = p.role === "GK";
      if (p.team === atkTeam) { if (!isGK || includeGK) atk.push(p); }
      else { if (!isGK || includeGK) def.push(p); }
    }
    return { atk, def };
  };

  // 保持度: チェーン保持者（state.carrier）を第一情報源に、波形で補完
  const hasBallOf = (match, state, atkTeam, atk, def) => {
    const ball = state.ball;
    if (state.carrier) {
      const c = state.carrier;
      const u = c.mode === "hold" ? 0.5 + 0.5 * c.u : 0.35 + 0.45 * c.u;
      return c.team === atkTeam ? clamp(0.3 + 0.7 * u) : clamp(0.3 * (1 - u * 0.8));
    }
    const P = state.possession;
    const align = E.attackSign(match, atkTeam) * P;
    let dnAtk = 1e9, dnDef = 1e9;
    for (const p of atk) { const d = Math.hypot(p.x - ball.x, p.y - ball.y); if (d < dnAtk) dnAtk = d; }
    for (const p of def) { const d = Math.hypot(p.x - ball.x, p.y - ball.y); if (d < dnDef) dnDef = d; }
    return clamp(0.5 + 0.5 * align + 0.25 * Math.sign(dnDef - dnAtk));
  };

  /* ---- [OVL] 局所数的優位: ボール周辺の人数差 + 最終ライン欠員 ---- */
  const ovlOf = (state, atk, def, dir, hasBall) => {
    const ball = state.ball;
    const T = D.threatAt(ball.x, ball.y, dir);
    if (T < 0.02) return 0;
    // ボール16m圏の実効人数（滑らかな所属度 — 距離の4乗フォールオフ）
    let nA = 0, nD = 0;
    for (const p of atk) {
      const d = Math.hypot(p.x - ball.x, p.y - ball.y);
      nA += Math.exp(-Math.pow(d / 16, 4));
    }
    for (const p of def) {
      const d = Math.hypot(p.x - ball.x, p.y - ball.y);
      nD += Math.exp(-Math.pow(d / 16, 4));
    }
    const sup = 1 / (1 + Math.exp(-1.15 * (nA - nD)));      // 人数差シグモイド
    // 最終ライン: ボールよりゴール側にいる守備者の実効数（2.8人を基準線）
    const gx = dir * HALF_W;
    const dBall = Math.hypot(gx - ball.x, ball.y);
    let cover = 0;
    for (const p of def) {
      const dDef = Math.hypot(gx - p.x, p.y);
      cover += N.smooth(clamp((dBall - dDef) / 8 + 0.5));
    }
    const deficit = clamp((2.8 - cover) / 2.8);
    return clamp(0.55 * sup + 0.45 * deficit) * clamp(T * 2.2) * (0.35 + 0.65 * hasBall);
  };

  /* ---- チーム指数 + モジュール内訳 + 選手別寄与（瞬時4モジュール） ---- */
  D.indexFor = (match, state, atkTeam, opts = {}) => {
    const includeGK = !!opts.includeGK;
    const half = state.half;
    const dir = match.dir[atkTeam][half === 1 ? "h1" : "h2"];
    const { atk, def } = splitTeams(state, atkTeam, includeGK);
    const ball = state.ball;

    // --- SDI: 脅威加重・空間支配（攻撃側ゴール周辺グリッド） ---
    const NX = 13, NY = 9;
    let num = 0, den = 0;
    const x0 = dir > 0 ? 0 : -HALF_W, x1 = dir > 0 ? HALF_W : 0; // 敵陣半面
    for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
      const cx = x0 + ((i + 0.5) / NX) * (x1 - x0);
      const cy = -HALF_H + ((j + 0.5) / NY) * (2 * HALF_H);
      const T = D.threatAt(cx, cy, dir);
      if (T < 0.015) continue;
      num += ctrlAt(cx, cy, atk, def) * T;
      den += T;
    }
    const SDI = den > 0 ? num / den : 0;

    // --- 保持判定（チェーン第一・波形補完） ---
    const hasBall = hasBallOf(match, state, atkTeam, atk, def);
    let dnAtk = 1e9, carrier = null;
    for (const p of atk) { const d = Math.hypot(p.x - ball.x, p.y - ball.y); if (d < dnAtk) { dnAtk = d; carrier = p; } }
    let dnDef = 1e9, presser = null;
    for (const p of def) { const d = Math.hypot(p.x - ball.x, p.y - ball.y); if (d < dnDef) { dnDef = d; presser = p; } }

    // --- CPR: 保持者の圧迫余裕 × ボール地点脅威 ---
    // #106: 守備者の def は実効距離（dwDef>1 = 同じ距離でも圧が強い）、保持者の att/tec は脅威係数。
    //   dw は #90 と同じ差分ベース（未編集=1.0）→ 収録パックはビット不変（較正保護）。
    const dwP = Math.min(1.24, Math.max(0.76, (presser && presser.dwDef) || 1));
    const dnEff = dnDef / dwP;
    const freedom = 1 - Math.exp(-(dnEff * dnEff) / 49);
    const CPR = D.threatAt(ball.x, ball.y, dir) * freedom * hasBall
      * Math.min(1.24, Math.max(0.76, (carrier && carrier.dwAtk) || 1));

    // --- PLV: パスレーン開通（ボール → 各受け手） ---
    let plv1 = 0, plv2 = 0, plvTarget = null;
    for (const rec of atk) {
      if (rec === carrier) continue;
      const lx = rec.x - ball.x, ly = rec.y - ball.y;
      const len = Math.hypot(lx, ly);
      if (len < 3 || len > 55) continue;
      let lane = 1;
      for (const d of def) {
        const u = clamp(((d.x - ball.x) * lx + (d.y - ball.y) * ly) / (len * len));
        const px = ball.x + u * lx, py = ball.y + u * ly;
        // #106: def が高い守備者はレーン・シャドウが広い（実効距離・未編集=1.0）
        const dd = Math.hypot(d.x - px, d.y - py) / Math.min(1.24, Math.max(0.76, d.dwDef || 1));
        lane *= 1 - Math.exp(-(dd * dd) / 9);
        if (lane < 0.02) break;
      }
      let dRec = 1e9;
      for (const d of def) {
        const dd = Math.hypot(d.x - rec.x, d.y - rec.y) / Math.min(1.24, Math.max(0.76, d.dwDef || 1));
        if (dd < dRec) dRec = dd;
      }
      const recFree = 1 - Math.exp(-(dRec * dRec) / 36);
      // #106: 受け手の att/tec は「同じ位置でも脅威が大きい」係数（未編集=1.0）
      const v = lane * D.threatAt(rec.x, rec.y, dir) * (0.4 + 0.6 * recFree)
        * Math.min(1.24, Math.max(0.76, rec.dwAtk || 1));
      if (v > plv1) { plv2 = plv1; plv1 = v; plvTarget = rec; }
      else if (v > plv2) plv2 = v;
    }
    const PLV = clamp(plv1 + 0.5 * plv2) * hasBall;

    // --- OVL: 局所数的優位（人数） ---
    const OVL = ovlOf(state, atk, def, dir, hasBall);

    // --- 選手別寄与（攻撃側: 脅威生成 / 表示・リング用） ---
    const contrib = atk.map(p => {
      let dDef = 1e9;
      for (const d of def) { const dd = Math.hypot(d.x - p.x, d.y - p.y); if (dd < dDef) dDef = dd; }
      const free = 1 - Math.exp(-(dDef * dDef) / 36);
      const v = D.threatAt(p.x, p.y, dir) * (0.45 + 0.55 * free)
        + (p === carrier ? CPR * 0.4 : 0) + (p === plvTarget ? 0.12 : 0);
      return { team: p.team, no: p.no, label: p.label, val: v };
    }).sort((a, b) => b.val - a.val);

    // --- #106: GK 抑制係数 — 守備側GKの def/aer の**上書き差分**（未編集=1.0・±約16%有界）
    //   収録パックの危険度・OOS・golden は不変（#90 と同じ較正保護の設計）。
    let gkF = 1;
    {
      const gk = state.players.find(q => q.onPitch && q.team !== atkTeam && q.role === "GK");
      if (gk) {
        const base = match.teams[gk.team].squad.find(q => q.no === gk.no);
        if (base && base.attrs) {
          const dlt = Math.max(-40, Math.min(40,
            ((gk.attrs.def - base.attrs.def) + (gk.attrs.aer - base.attrs.aer)) / 2)) / 100 * 0.4;
          gkF = 1 / (1 + dlt);
        }
      }
    }

    // 瞬時4モジュールのみの暫定合成（時間系は indexAt が付与）
    const W = D.WEIGHTS;
    const instW = W.SDI + W.CPR + W.PLV + W.OVL;
    const instRaw = (W.SDI * SDI + W.CPR * CPR + W.PLV * PLV + W.OVL * OVL) / instW;
    const total = clamp(Math.pow(clamp(instRaw), D.GAMMA) * D.GAIN * gkF) * 100;

    return {
      total, gkF, raw: { SDI, CPR, PLV, OVL },
      mods: { SDI: SDI * 100, CPR: CPR * 100, PLV: PLV * 100, OVL: OVL * 100 },
      hasBall, carrier: carrier ? carrier.no : null, presser: presser ? presser.no : null,
      plvTarget: plvTarget ? plvTarget.no : null, contrib,
      status: total >= D.CRIT_AT ? "CRITICAL" : total >= D.WARN_AT ? "WARNING" : "OK",
    };
  };

  /* ---- [TPA] 持続圧力の格子（決定論・4秒グリッド・遅延評価） ---- */
  // 圧力原値: CPR + OVL + ボール地点脅威（SDIグリッドを避けた軽量値）
  const pressLattice = new Map();
  const pressRawAt = (match, scenario, t, opts) => {
    const state = E.stateAt(match, scenario, t);
    const out = {};
    for (const k of E.teamKeys(match)) {
      const dir = match.dir[k][state.half === 1 ? "h1" : "h2"];
      const { atk, def } = splitTeams(state, k, !!opts.includeGK);
      const hb = hasBallOf(match, state, k, atk, def);
      const ball = state.ball;
      let dnDef = 1e9;
      for (const p of def) { const d = Math.hypot(p.x - ball.x, p.y - ball.y); if (d < dnDef) dnDef = d; }
      const freedom = 1 - Math.exp(-(dnDef * dnDef) / 49);
      const cpr = D.threatAt(ball.x, ball.y, dir) * freedom * hb;
      const ovl = ovlOf(state, atk, def, dir, hb);
      out[k] = clamp(0.42 * cpr + 0.42 * ovl + 0.16 * D.threatAt(ball.x, ball.y, dir) * hb);
    }
    return out;
  };
  const latticeAt = (match, scenario, gt, opts) => {
    const key = `${match.meta.id}|${E.scenarioKey(scenario)}|${opts.includeGK ? 1 : 0}|g${GEOM_ONLY ? 1 : 0}`;
    let m = pressLattice.get(key);
    if (!m) { m = new Map(); pressLattice.set(key, m); }
    if (m.has(gt)) return m.get(gt);
    const v = pressRawAt(match, scenario, gt, opts);
    m.set(gt, v);
    return v;
  };
  const TPA_STEP = 4, TPA_N = 8, TPA_DECAY = 0.85;
  const tpaOf = (match, scenario, t, opts) => {
    const range = E.playedRange(match);
    // ハーフ/延長ブレーク開始をまたいで圧力を持ち越さない（h3/h4 は #141・無ければ従来）
    const T = match.time;
    const hStart = T.h4 && t >= T.h4.start ? T.h4.start
      : T.h3 && t >= T.h3.start ? T.h3.start
      : t >= T.h2.start ? T.h2.start : range.t0;
    const out = {};
    for (const k of E.teamKeys(match)) out[k] = 0;
    let wsum = 0;
    for (let j = 0; j < TPA_N; j++) {
      const tj = t - j * TPA_STEP;
      if (tj < hStart) break;
      const w = Math.pow(TPA_DECAY, j);
      // 格子2点の線形補間（スクラブ完全一致・キャッシュ効率）
      const g0 = hStart + TPA_STEP * Math.floor((tj - hStart) / TPA_STEP);
      const g1 = Math.min(g0 + TPA_STEP, range.t1);
      const u = g1 > g0 ? (tj - g0) / (g1 - g0) : 0;
      const a = latticeAt(match, scenario, g0, opts);
      const b = u > 0 ? latticeAt(match, scenario, g1, opts) : a;
      for (const k of E.teamKeys(match)) out[k] += w * (a[k] + (b[k] - a[k]) * u);
      wsum += w;
    }
    if (wsum > 0) for (const k of E.teamKeys(match)) out[k] = clamp(out[k] / wsum * 1.35);
    return out;
  };

  /* ---- [TRV] 侵攻速度: ボールのゴール接近速度（3秒窓） ---- */
  const trvOf = (match, scenario, t, state, hasBallMap) => {
    const range = E.playedRange(match);
    const dt = 2.8;
    const tPrev = Math.max(range.t0, t - dt);
    if (t - tPrev < 0.5) { const o = {}; for (const k of E.teamKeys(match)) o[k] = 0; return o; }
    const bPrev = E.ballAt(match, scenario, tPrev);
    const bNow = state.ball;
    const out = {};
    for (const k of E.teamKeys(match)) {
      const dir = match.dir[k][state.half === 1 ? "h1" : "h2"];
      const gx = dir * HALF_W;
      const dPrev = Math.hypot(gx - bPrev.x, bPrev.y);
      const dNow = Math.hypot(gx - bNow.x, bNow.y);
      const v = (dPrev - dNow) / (t - tPrev);                // m/s（正=接近）
      out[k] = clamp(v / 7.5) * clamp(D.threatAt(bNow.x, bNow.y, dir) * 2.5) * (0.3 + 0.7 * hasBallMap[k]);
    }
    return out;
  };

  /* ---- 総合指数（6モジュール） ---- */
  D.indexAt = (match, scenario, t, opts = {}) => {
    scenario = scenario || E.actualScenario(match);
    const state = E.stateAt(match, scenario, t);
    const out = { t, state };
    const tpa = tpaOf(match, scenario, t, opts);
    const hasBallMap = {};
    const inst = {};
    for (const k of E.teamKeys(match)) {
      inst[k] = D.indexFor(match, state, k, opts);
      hasBallMap[k] = inst[k].hasBall;
    }
    const trv = trvOf(match, scenario, t, state, hasBallMap);
    const W = D.WEIGHTS;
    for (const k of E.teamKeys(match)) {
      const r = inst[k].raw;
      const raw = W.SDI * r.SDI + W.CPR * r.CPR + W.PLV * r.PLV + W.OVL * r.OVL
        + W.TPA * tpa[k] + W.TRV * trv[k];
      const total = clamp(Math.pow(clamp(raw), D.GAMMA) * D.GAIN * (inst[k].gkF || 1)) * 100;   // #106

      out[k] = {
        ...inst[k],
        total,
        mods: { ...inst[k].mods, TPA: tpa[k] * 100, TRV: trv[k] * 100 },
        status: total >= D.CRIT_AT ? "CRITICAL" : total >= D.WARN_AT ? "WARNING" : "OK",
      };
    }
    return out;
  };

  // 平滑版（表示用）: t, t-2.5, t-5 の決定論3点平均 — スクラブしても同一値
  D.indexSmooth = (match, scenario, t, opts = {}) => {
    const range = E.playedRange(match);
    const ts = [t, Math.max(range.t0, t - 2.5), Math.max(range.t0, t - 5)];
    const ks = E.teamKeys(match);
    const acc = {};
    let base = null;
    for (const tt of ts) {
      const ix = D.indexAt(match, scenario, tt, opts);
      if (!base) base = ix;
      for (const k of ks) {
        if (!acc[k]) { acc[k] = { total: 0, mods: {} }; for (const m of D.MODULES) acc[k].mods[m] = 0; }
        acc[k].total += ix[k].total / ts.length;
        for (const m of D.MODULES) acc[k].mods[m] += (ix[k].mods[m] || 0) / ts.length;
      }
    }
    for (const k of ks) {
      base[k] = {
        ...base[k],
        total: acc[k].total, mods: acc[k].mods,
        status: acc[k].total >= D.CRIT_AT ? "CRITICAL" : acc[k].total >= D.WARN_AT ? "WARNING" : "OK",
      };
    }
    return base;
  };

  /* ---- ヒートマップ場（面表示用）: 両方向の ctrl·T を符号付き合成 ---- */
  D.fieldAt = (match, state, opts = {}) => {
    const includeGK = !!opts.includeGK;
    const NXF = 42, NYF = 28;
    const grid = new Float32Array(NXF * NYF);       // >0: plus側脅威 / <0: minus側脅威
    const half = state.half;
    const [kPlus, kMinus] = (() => {
      const keys = E.teamKeys(match);
      const plus = match.possessionPlus || keys[0];
      return [plus, keys.find(k => k !== plus)];
    })();
    const dirP = match.dir[kPlus][half === 1 ? "h1" : "h2"];
    const dirM = -dirP;
    const sP = splitTeams(state, kPlus, includeGK);
    const sM = splitTeams(state, kMinus, includeGK);
    for (let j = 0; j < NYF; j++) for (let i = 0; i < NXF; i++) {
      const cx = -HALF_W + ((i + 0.5) / NXF) * 105;
      const cy = -HALF_H + ((j + 0.5) / NYF) * 68;
      const tP = D.threatAt(cx, cy, dirP);
      const tM = D.threatAt(cx, cy, dirM);
      let v = 0;
      if (tP > 0.02) v += ctrlAt(cx, cy, sP.atk, sP.def) * tP;
      if (tM > 0.02) v -= ctrlAt(cx, cy, sM.atk, sM.def) * tM;
      grid[j * NXF + i] = v;
    }
    return { grid, nx: NXF, ny: NYF, plus: kPlus, minus: kMinus };
  };

  /* ---- ゾーニング場: 全ピッチの支配（チーム符号 + セル所有選手） ---- */
  // 日本目線/ブラジル目線の両方を1回の計算で提供（符号 = plus正/minus負）
  D.zoneField = (match, state) => {
    const NXF = 48, NYF = 30;
    const grid = new Float32Array(NXF * NYF);       // 支配マージン [-1,+1]
    const conf = new Float32Array(NXF * NYF);       // 確度（選手不在の空域は0へ）
    const owner = new Int16Array(NXF * NYF);        // 所有選手 index into players
    const keys = E.teamKeys(match);
    const plus = match.possessionPlus || keys[0];
    const ps = state.players.filter(p => p.onPitch);
    for (let j = 0; j < NYF; j++) for (let i = 0; i < NXF; i++) {
      const cx = -HALF_W + ((i + 0.5) / NXF) * 105;
      const cy = -HALF_H + ((j + 0.5) / NYF) * 68;
      let sp = 0, sm = 0, bestS = -1, bestIdx = -1;
      for (let q = 0; q < ps.length; q++) {
        const p = ps[q];
        const s0 = influence(p) * (p.role === "GK" ? 0.8 : 1) * 1.6;   // ゾーン半径は広め
        const dx = cx - p.x, dy = cy - p.y;
        const s = Math.exp(-(dx * dx + dy * dy) / (s0 * s0));
        if (p.team === plus) sp += s; else sm += s;
        if (s > bestS) { bestS = s; bestIdx = q; }
      }
      const idx = j * NXF + i;
      grid[idx] = (sp - sm) / (sp + sm + 1e-6);
      conf[idx] = clamp(Math.pow((sp + sm) * 2.4, 0.55));
      owner[idx] = bestIdx;
    }
    return { grid, conf, owner, players: ps, nx: NXF, ny: NYF, plus, minus: keys.find(k => k !== plus) };
  };

  /* ---- タイムライン曲線（チャンク計算・キャッシュ） ---- */
  const curveCache = new Map();
  const curveKey = (match, scenario, step, opts) =>
    `${match.meta.id}|${E.scenarioKey(scenario)}|${step}|${opts.includeGK ? 1 : 0}|g${GEOM_ONLY ? 1 : 0}`;
  D.curve = (match, scenario, opts = {}) => {
    scenario = scenario || E.actualScenario(match);
    const step = opts.step || 6;
    const key = curveKey(match, scenario, step, opts);
    if (curveCache.has(key)) return curveCache.get(key);
    const range = E.playedRange(match);
    const keys = E.teamKeys(match);
    const pts = [];
    for (let t = range.t0; t <= range.t1; t += step) {
      const ix = D.indexAt(match, scenario, t, opts);
      const v = {};
      for (const k of keys) v[k] = ix[k].total;
      pts.push({ t, v });
    }
    curveCache.set(key, pts);
    return pts;
  };
  // 非同期チャンク版（UI用: フレームを塞がない）
  D.curveAsync = (match, scenario, opts, onProgress, onDone) => {
    scenario = scenario || E.actualScenario(match);
    const step = opts.step || 6;
    const key = curveKey(match, scenario, step, opts);
    if (curveCache.has(key)) { onDone(curveCache.get(key)); return; }
    const range = E.playedRange(match);
    const keys = E.teamKeys(match);
    const pts = [];
    let t = range.t0;
    const chunk = () => {
      const t1 = Math.min(t + 180, range.t1);
      for (; t <= t1; t += step) {
        const ix = D.indexAt(match, scenario, t, opts);
        const v = {};
        for (const k of keys) v[k] = ix[k].total;
        pts.push({ t, v });
      }
      onProgress && onProgress(t / range.t1);
      if (t <= range.t1) setTimeout(chunk, 0);
      else { curveCache.set(key, pts); onDone(pts); }
    };
    chunk();
  };
  D.curveKeyOf = curveKey;

  /* ---- 保持シーケンス単位の危険度蓄積（Issue #14） ----
     現在の連続保持（チェーンの同一チーム連続区間）における危険度の積分。
     TPA（32秒の減衰記憶）より長い「この攻撃の流れでどれだけ圧を築いたか」を表す。 */
  D.seqAccumAt = (match, scenario, t, opts = {}) => {
    scenario = scenario || E.actualScenario(match);
    const seq = E.sequenceAt(match, scenario, t);
    if (!seq) return null;
    const pts = D.curve(match, scenario, { step: opts.step || 8, includeGK: !!opts.includeGK });
    if (!pts.length) return { ...seq, accum: 0 };
    const step = opts.step || 8;
    let acc = 0;
    const i0 = Math.max(0, Math.round((seq.t0 - pts[0].t) / step));
    const i1 = Math.min(pts.length - 1, Math.round((t - pts[0].t) / step));
    for (let i = i0; i <= i1; i++) acc += pts[i].v[seq.team] * step;
    return { ...seq, accum: acc / 60 };   // pt·分（表示しやすい規模）
  };

  D.clearCaches = () => { curveCache.clear(); pressLattice.clear(); };
})();
