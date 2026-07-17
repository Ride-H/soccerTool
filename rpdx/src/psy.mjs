/* =========================================================================
   RPDX.psy — PSY レイヤー v1（精神疲労・覚醒水準・自律神経・集中力）
   ---------------------------------------------------------------------------
   ■ 位置づけ: 読み取り専用の「解釈支援」レイヤー。エンジン/危険度の公開出力
     のみを入力とし、位置・イベント・結果へは一切フィードバックしない
     （stateAt の出力は不変）。非予測・ヒューリスティック（Issue #3/#4/#15）。
   ■ 決定論: 全指標は t の純関数。イベント×指数減衰の閉形式と、TPAと同じ
     決定論格子（8秒グリッド+線形補間）のみで構成 — スクラブ完全一致。
   ■ アルゴリズム出典（形状のみ借用・効果量はヒューリスティック）:
     - 心理モメンタム: テニスの忘却係数付きイベント連鎖 M_i = f·M_{i-1} + ΔM
       （PMC11687916）→ 連続時間閉形式 M(t) = Σ w(ev)·exp(−Δt/τ)
     - 覚醒-遂行: Yerkes-Dodson 逆U字（過小/過大覚醒で集中力が落ちる）
     - 自律神経/HRV: 交感優位で HRV 低下・精神疲労は生理的覚醒の反応性を
       下げる（biorxiv 2020.08.24.264812 / PMC9855644）
     - 精神疲労: time-on-task の累積 + 認知負荷（被危険度曝露）(PMC8504464)
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const PSY = (R.psy = {});
  const N = R.noise, E = R.engine, D = R.danger;
  const clamp = N.clamp;

  /* ---------------- パラメータ（一元管理・出典コメント付き） ---------------- */
  PSY.PARAMS = {
    // モメンタム: イベント重み（テニス・モメンタム連鎖の正負イベント表を移植。
    // 得点者側+1.0/被弾側−0.85 の非対称はサーバー/レシーバー α=1.2/β=1.0 の類推）
    M_EV: {
      goal:   { own: +1.00, opp: -0.85 },
      save:   { own: +0.40, opp: -0.30 },   // 決定機を止めた側+/止められた側−
      shot:   { own: +0.25, opp: -0.05 },
      corner: { own: +0.10, opp: 0.00 },
      yellow: { own: -0.30, opp: +0.12 },
    },
    M_SUB: +0.10,          // 交代投入（フレッシュネス）
    M_TAU: 300,            // モメンタム忘却時定数[s]（f=0.6+0.4e^-λΔt の連続化）
    // 覚醒: イベントは valence でなく activation — 失点も警告も覚醒を上げる
    AR_EV: {
      goal:   { own: +18, opp: +22, scorer: +26 },
      save:   { own: +10, opp: +8 },
      shot:   { own: +8,  opp: +9 },
      corner: { own: +5,  opp: +5 },
      yellow: { own: +14, opp: +6, carded: +20 },
    },
    AR_SUB_SELF: +16,      // 自分の投入直後
    // #80: 外的失点（仮説）の心理増幅 — 理不尽な失点ほどスイングが大きい
    SHOCK_W: { "ref-penalty": 1.6, "ref-offside-missed": 1.5, "keeper-error": 1.45,
               "own-goal": 1.4, "deflection": 1.25, "set-piece": 1.15 },
    AR_TAU: 240,           // 覚醒インパルス減衰[s]
    AR_BASE: 48,
    AR_KICKOFF: 10,        // キックオフ直後の初期活性
    AR_CLUTCH: 14,         // 接戦×終盤の文脈活性（最大）
    AR_DANGER: 0.14,       // 現在危険度→活性（×指数0..100）
    AR_MF_DAMP: 0.40,      // 精神疲労による反応性低下（biorxiv: MF→低生理的覚醒）
    AR_MF_DROP: 12,        // 精神疲労によるベースライン低下
    // 精神疲労
    MF_TIME: 0.34,         // time-on-task 基本勾配（90分→約0.35）
    MF_TIME_STA: 0.12,     // 低スタミナの追加勾配
    MF_HT_KEEP: 0.70,      // HT を跨いだ time-on-task の持ち越し率（部分回復）
    MF_STRAIN_HT_KEEP: 0.55, // HT を跨いだ被危険度曝露の持ち越し率
    MF_STRAIN_TAU: 1500,   // 被危険度曝露の減衰時定数[s]（約25分）
    MF_STRAIN_RATE: 0.022, // 曝露の蓄積率（危険度45が続くと平衡≈0.25）
    MF_PHYS: 0.22,         // 身体疲労→精神疲労のクロス項
    MF_YELLOW: 0.07,       // 自分の警告ストレス（τ=900sで減衰）
    MF_CONCEDE: 0.05,      // 在場中の失点（τ=1200sで減衰）
    MF_TRAIL: 0.05,        // ビハインド時間の累積（30分で飽和）
    // 集中力: Yerkes-Dodson 逆U字
    CN_PEAK: 60,           // 至適覚醒
    CN_SIGMA0: 22,         // 逆U字の幅（基準）
    CN_SIGMA_TEC: 8,       // 技術が高いほど至適域が広い（tec=100で+8）
    CN_MF: 0.45,           // 精神疲労による上限低下
    CN_PHYS: 0.15,         // 身体疲労による上限低下
    // 自律神経
    SNS_BASE: 0.30, SNS_AR: 0.55, SNS_MF: 0.18,
    HRV_MF: 0.40,
    // 役割別の守備ストレス重み（被危険度曝露を最も受けるのは最終ライン）
    ROLE_W: { GK: 0.85, CB: 1.0, FB: 0.95, WB: 0.95, DM: 0.95, CM: 0.88, AM: 0.80, W: 0.80, ST: 0.75, OUT: 0.8 },
  };
  const P = PSY.PARAMS;

  const dispSign = (ev, team) => (ev.team === team ? "own" : "opp");

  /* ============ チーム心理モメンタム M(t) ∈ [-1.2, +1.2]（閉形式） ============ */
  const shockW = (ev) => (ev && ev.shock ? (PSY.PARAMS.SHOCK_W[ev.kind] || 1.3) : 1);   // #80

  PSY.momentumAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const out = {};
    const keys = E.teamKeys(match);
    for (const k of keys) out[k] = 0;
    for (const ev of E.eventsOf(match, scenario)) {
      if (ev.t > t) break;
      const w = P.M_EV[ev.type];
      if (!w || !ev.team) continue;
      const decay = Math.exp(-(t - ev.t) / P.M_TAU);
      for (const k of keys) out[k] += (w[dispSign(ev, k)] || 0) * shockW(ev) * decay;
    }
    for (const k of keys) {
      for (const s of scenario.subs[k] || []) {
        if (s.t <= t) out[k] += P.M_SUB * Math.exp(-(t - s.t) / P.M_TAU);
      }
      out[k] = clamp(out[k], -1.2, 1.2);
    }
    return out;
  };

  /* ============ 被危険度曝露 strain（決定論格子・TPAパターン） ============ */
  // D.curve（正準: step=8, GK除外）から S_i = S_{i-1}·e^(−Δ/τ) + v_opp·rate を
  // 前進蓄積した格子を築き、任意時刻は2点線形補間 — スクラブ完全一致。
  const strainCache = new Map();
  const strainGrid = (match, scenario) => {
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    if (strainCache.has(key)) return strainCache.get(key);
    const pts = D.curve(match, scenario, { step: 8, includeGK: false });
    const keys = E.teamKeys(match);
    const h2 = match.time.h2.start;
    const kDecay = Math.exp(-8 / P.MF_STRAIN_TAU);
    const grid = { ts: [], v: {} };
    for (const k of keys) grid.v[k] = [];
    const S = {};
    for (const k of keys) S[k] = 0;
    let prevT = null;
    for (const pt of pts) {
      if (prevT != null && prevT < h2 && pt.t >= h2) {
        for (const k of keys) S[k] *= P.MF_STRAIN_HT_KEEP;   // HT部分回復
      }
      for (const k of keys) {
        const opp = keys.find(q => q !== k);
        // 平衡値: 危険度45が続くと S∞ ≈ 0.25（τ=25分の一次系）
        S[k] = S[k] * kDecay + (pt.v[opp] / 100) * (8 / 60) * P.MF_STRAIN_RATE;
        grid.v[k].push(S[k]);
      }
      grid.ts.push(pt.t);
      prevT = pt.t;
    }
    strainCache.set(key, grid);
    return grid;
  };
  const strainAt = (match, scenario, team, t) => {
    const g = strainGrid(match, scenario);
    const ts = g.ts, vs = g.v[team];
    if (!ts.length) return 0;
    if (t <= ts[0]) return 0;
    if (t >= ts[ts.length - 1]) return vs[vs.length - 1];
    let lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
    const u = (t - ts[lo]) / (ts[hi] - ts[lo] || 1);
    return vs[lo] + (vs[hi] - vs[lo]) * u;
  };
  // 危険度の現在値（活性項用・正準曲線の補間）
  const dangerNow = (match, scenario, t) => {
    const pts = D.curve(match, scenario, { step: 8, includeGK: false });
    if (!pts.length) return {};
    const i = clamp(Math.round((t - pts[0].t) / 8), 0, pts.length - 1);
    return pts[i].v;
  };

  /* ---------------- ビハインド累積時間（分・イベント走査） ---------------- */
  const trailingMins = (match, scenario, team, from, t) => {
    const goals = E.eventsOf(match, scenario).filter(e => e.type === "goal" && e.t <= t);
    let diff = 0, acc = 0, seg0 = from;
    const keys = E.teamKeys(match);
    const opp = keys.find(k => k !== team);
    for (const g of goals) {
      const gt = Math.max(from, Math.min(g.t, t));
      if (diff < 0) acc += Math.max(0, gt - seg0);
      seg0 = gt;
      diff += g.team === team ? 1 : g.team === opp ? -1 : 0;
    }
    if (diff < 0) acc += Math.max(0, t - seg0);
    return acc / 60;
  };

  /* ============ 選手別 PSY 状態（すべて t の純関数） ============ */
  // 返値: { on, mf, ar, cn, sns, pns, ans, hrv, load } — mf/ar/cn/hrv は 0..100
  PSY.playerAt = (match, scenario, team, no, t) => {
    scenario = scenario || E.actualScenario(match);
    const pr = E.presenceOf(match, scenario, team, no);
    if (!pr) return null;
    const on = t >= pr.from && t <= pr.to;
    const te = clamp(t, pr.from, pr.to);          // 場外では入退場時点で凍結
    const p = match.teams[team].squad.find(q => q.no === no);
    if (!p) return null;
    const h2 = match.time.h2.start;

    /* --- 精神疲労 MF (0..1) --- */
    // time-on-task（HT持ち越し 0.7 = 部分回復）
    let minsH1 = 0, minsH2 = 0;
    if (pr.from < h2) { minsH1 = (Math.min(te, h2) - pr.from) / 60; }
    if (te > h2) { minsH2 = (te - Math.max(pr.from, h2)) / 60; }
    const timeTask = (te >= h2 ? minsH1 * P.MF_HT_KEEP : minsH1) + minsH2;
    const sta = p.attrs ? p.attrs.sta : 75;
    let mf = (timeTask / 95) * (P.MF_TIME + P.MF_TIME_STA * (1 - sta / 100) * 2);
    // 被危険度曝露 × 役割重み（在場中のみ蓄積された格子を参照）
    const roleW = P.ROLE_W[p.pos === "GK" ? "GK" : p.pos === "DF" ? "CB" : p.pos === "MF" ? "CM" : "ST"] || 0.9;
    mf += strainAt(match, scenario, team, te) * roleW * clamp((te - pr.from) / 900);
    // 身体疲労クロス項
    const load = E.fatigueOf(match, scenario, team, no, te);
    mf += P.MF_PHYS * load;
    // 警告ストレス・在場中の失点・ビハインド文脈
    const evs = E.eventsOf(match, scenario);
    for (const ev of evs) {
      if (ev.t > te) break;
      if (ev.type === "yellow" && ev.team === team && ev.no === no)
        mf += P.MF_YELLOW * Math.exp(-(te - ev.t) / 900);
      if (ev.type === "goal" && ev.team !== team && ev.t >= pr.from)
        mf += P.MF_CONCEDE * shockW(ev) * Math.exp(-(te - ev.t) / 1200);
    }
    mf += P.MF_TRAIL * N.smooth(clamp(trailingMins(match, scenario, team, pr.from, te) / 30));
    mf = clamp(mf);

    /* --- 覚醒水準 AR (0..100) --- */
    let imp = 0;
    for (const ev of evs) {
      if (ev.t > te) break;
      const w = P.AR_EV[ev.type];
      if (!w || !ev.team) continue;
      const decay = Math.exp(-(te - ev.t) / P.AR_TAU);
      let a = w[dispSign(ev, team)] || 0;
      if (ev.type === "goal" && ev.team === team && ev.no === no) a = w.scorer;
      if (ev.type === "yellow" && ev.team === team && ev.no === no) a = w.carded;
      imp += a * shockW(ev) * decay;
    }
    for (const s of scenario.subs[team] || []) {
      if (s.in === no && s.t <= te) imp += P.AR_SUB_SELF * Math.exp(-(te - s.t) / 300);
    }
    // キックオフ活性（両ハーフ）
    imp += P.AR_KICKOFF * Math.exp(-(te - E.playedRange(match).t0) / 180);
    if (te >= h2) imp += P.AR_KICKOFF * 0.6 * Math.exp(-(te - h2) / 180);
    // 接戦×終盤 clutch + 現在危険度
    const score = E.scoreAt(match, te, scenario);
    const keys = E.teamKeys(match);
    const opp = keys.find(k => k !== team);
    const diff = Math.abs(score[team] - score[opp]);
    const clock = E.clockAt(match, te).clock;
    const late = clamp((clock - 4320) / 1080);            // 72'→90' で 0→1
    let clutch = P.AR_CLUTCH * (1 - Math.min(diff, 2) / 2) * late;
    if (clock > 5400) clutch *= 1.25;                     // 90+ の AT
    const dNow = dangerNow(match, scenario, te);
    const act = P.AR_DANGER * Math.max(dNow[team] || 0, dNow[opp] || 0);
    // 精神疲労による反応性低下 + ベースライン低下
    let ar = P.AR_BASE + (imp + clutch + act) * (1 - P.AR_MF_DAMP * mf) - P.AR_MF_DROP * mf;
    ar = clamp(ar, 5, 98);

    /* --- 集中力 CN: Yerkes-Dodson 逆U字 × 疲労上限 --- */
    const cn = PSY.cnOf(ar, mf, load, p.attrs ? p.attrs.tec : 75);

    /* --- 自律神経: 交感/副交感・HRVプロキシ --- */
    const sns = clamp(P.SNS_BASE + P.SNS_AR * ar / 100 + P.SNS_MF * mf, 0, 1);
    const pns = 1 - sns;
    const hrvRaw = (1 - sns) * (1 - P.HRV_MF * mf);
    const hrv = clamp(hrvRaw / REST_HRV, 0, 1.35) * 100;  // 安静基準比%

    return {
      on, team, no,
      mf: mf * 100, ar, cn,
      sns, pns, ans: sns - pns,
      hrv, load: load * 100,
    };
  };

  // Yerkes-Dodson 逆U字（純形状関数 — テスト用に公開）
  PSY.cnOf = (ar, mf01orPct, load01orPct, tec) => {
    const mf = mf01orPct > 1 ? mf01orPct / 100 : mf01orPct;
    const load = load01orPct > 1 ? load01orPct / 100 : load01orPct;
    const sigma = P.CN_SIGMA0 + P.CN_SIGMA_TEC * clamp(((tec ?? 75) - 70) / 30, -1, 1);
    const shape = Math.exp(-Math.pow(ar - P.CN_PEAK, 2) / (2 * sigma * sigma));
    return clamp(shape * (1 - P.CN_MF * mf) * (1 - P.CN_PHYS * load)) * 100;
  };
  const REST_HRV = (1 - clamp(P.SNS_BASE + P.SNS_AR * P.AR_BASE / 100, 0, 1));

  /* ============ チーム集計（出場11人の平均 + モメンタム） ============ */
  PSY.teamAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const mom = PSY.momentumAt(match, scenario, t);
    const out = {};
    for (const team of E.teamKeys(match)) {
      const roster = E.rosterAt(match, scenario, team, t);
      let mf = 0, ar = 0, cn = 0, hrv = 0, n = 0;
      for (const slot in roster.assign) {
        const st = PSY.playerAt(match, scenario, team, roster.assign[slot], t);
        if (!st) continue;
        mf += st.mf; ar += st.ar; cn += st.cn; hrv += st.hrv; n++;
      }
      out[team] = {
        momentum: mom[team],
        mf: n ? mf / n : 0, ar: n ? ar / n : 0,
        cn: n ? cn / n : 0, hrv: n ? hrv / n : 0, n,
      };
    }
    return out;
  };

  /* ============ 意思決定困難度（Issue #9: 選択肢 × 時間 × プレッシャー） ============
     保持者の意思決定の難しさを距離・幾何のみから決定論算出するヒューリスティック。
     - 選択肢: 開通パスレーン数（守備者ガウス遮蔽の積 ≥ 0.25 の味方受け手）
     - 時間: 最近接プレッサーまでの距離（8mで正規化 — 到達猶予の代理）
     - プレッシャー: 半径8mガウスの守備者密度
     ※ 非予測の解釈支援。ターンオーバー確率等の予測値ではない。 */
  PSY.decisionAt = (match, scenario, t, stateOpt) => {
    scenario = scenario || E.actualScenario(match);
    const st = stateOpt || E.stateAt(match, scenario, t);
    const c = st.carrier;
    if (!c || c.mode !== "hold") return null;
    const me = st.players.find(p => p.onPitch && p.team === c.team && p.no === c.no);
    if (!me) return null;
    const mates = st.players.filter(p => p.onPitch && p.team === c.team && p.no !== c.no);
    const opps = st.players.filter(p => p.onPitch && p.team !== c.team && p.role !== "GK");
    // 選択肢（開通レーン数）
    let options = 0;
    for (const r of mates) {
      const lx = r.x - me.x, ly = r.y - me.y;
      const len = Math.hypot(lx, ly);
      if (len < 3 || len > 55) continue;
      let lane = 1;
      for (const d of opps) {
        const u = clamp(((d.x - me.x) * lx + (d.y - me.y) * ly) / (len * len));
        const px = me.x + u * lx, py = me.y + u * ly;
        const dd = Math.hypot(d.x - px, d.y - py);
        lane *= 1 - Math.exp(-(dd * dd) / 9);
        if (lane < 0.02) break;
      }
      if (lane >= 0.25) options++;
    }
    // 時間余裕とプレッシャー密度
    let dn = 1e9, press = 0;
    for (const d of opps) {
      const dd = Math.hypot(d.x - me.x, d.y - me.y);
      if (dd < dn) dn = dd;
      press += Math.exp(-(dd * dd) / (8 * 8));
    }
    const timeSlack = clamp(dn / 8);
    const dd100 = clamp(
      0.50 * (1 - timeSlack) +
      0.30 * clamp(press / 2.5) +
      0.20 * (1 - clamp(options / 5))) * 100;
    return { team: c.team, no: c.no, dd: dd100, options, presserDist: dn, press };
  };

  /* ---------------- モメンタム曲線（スパークライン用・キャッシュ） ---------------- */
  const mcurveCache = new Map();
  PSY.momentumCurve = (match, scenario, step = 12) => {
    scenario = scenario || E.actualScenario(match);
    const key = `${match.meta.id}|${E.scenarioKey(scenario)}|${step}`;
    if (mcurveCache.has(key)) return mcurveCache.get(key);
    const range = E.playedRange(match);
    const pts = [];
    for (let t = range.t0; t <= range.t1; t += step) {
      pts.push({ t, v: PSY.momentumAt(match, scenario, t) });
    }
    mcurveCache.set(key, pts);
    return pts;
  };

  PSY.clearCaches = () => { strainCache.clear(); mcurveCache.clear(); };

  /* ---------------- UI 向けの注記（非予測の明示） ---------------- */
  PSY.DISCLAIMER =
    "PSYレイヤーは位置・イベント・危険度から導く決定論ヒューリスティック推定です。" +
    "生体計測ではなく、心理状態の断定・予測でもありません（解釈支援）。";
})();
