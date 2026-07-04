/* =========================================================================
   RPDX.engine — 決定論ムーブメント・エンジン v3
   ---------------------------------------------------------------------------
   設計原則:
   1. stateAt(match, scenario, t) は純関数 — どの時刻から呼んでも完全一致。
      （積分・内部状態なし。ノイズは帯域制限、アンカーはガウス窓/区分補間）
   2. 速度上限は「構成的」に保証: 各寄与項の周波数×振幅を制限。
      位置ブレンドは lerp（重み変化率×距離を制限）でのみ合成。
   3. 交代・布陣・配置微調整は scenario 解決で処理 — 常に各チーム11人。
   4. ポゼッション・チェーン: ボールは保持チームの選手の足元に付く。
      保持者列（ホールド→パス→ターンオーバー）を P(t) 波形と整合するよう
      決定論生成し、シナリオごとにキャッシュ。実測支配率と一致する。
   5. scenario.outcome（sim.mjs が付与）があれば、消滅/追加ゴールに応じて
      イベント・アンカー・祝祭・スコアの「世界」を再構成する。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const N = R.noise, F = R.formations;
  const E = (R.engine = {});

  const HALF_W = 52.5, HALF_H = 34;
  const clamp = N.clamp, lerp = N.lerp;

  /* ------------------------------ 時間軸 ------------------------------ */
  E.playedRange = (match) => ({ t0: match.time.h1.start, t1: match.time.h2.end, ht: match.time.h1.end });
  E.halfOf = (match, t) => (t < match.time.h1.end ? 1 : 2);
  // 表示時計: {half, clockSec, base, added, disp}
  E.clockAt = (match, t) => {
    const h = E.halfOf(match, t);
    const seg = h === 1 ? match.time.h1 : match.time.h2;
    const clock = seg.clock0 + (t - seg.start);
    const baseCap = h === 1 ? 2700 : 5400;
    const mm = Math.floor(clock / 60), ss = Math.floor(clock % 60);
    let disp;
    if (clock >= baseCap) {
      const am = Math.floor((clock - baseCap) / 60), as = Math.floor((clock - baseCap) % 60);
      disp = `${h === 1 ? 45 : 90}+${am}:${String(as).padStart(2, "0")}`;
    } else {
      disp = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    }
    return { half: h, clock, disp };
  };
  E.teamKeys = (match) => Object.keys(match.teams);
  E.oppOf = (match, team) => E.teamKeys(match).find(k => k !== team);
  // P>0 が指すチーム（既定 possessionPlus）に対する符号
  E.attackSign = (match, team) => (team === (match.possessionPlus || E.teamKeys(match)[0]) ? +1 : -1);

  /* --------------------- イベント（シナリオ実効） --------------------- */
  // scenario.outcome があれば再構成イベント（消滅/追加ゴール反映）を返す
  E.eventsOf = (match, scenario) =>
    (scenario && scenario.outcome && scenario.outcome.events) || match.events;

  E.scoreAt = (match, t, scenario) => {
    const s = {};
    for (const k of E.teamKeys(match)) s[k] = 0;
    for (const ev of E.eventsOf(match, scenario)) if (ev.type === "goal" && ev.t <= t) s[ev.team]++;
    return s;
  };

  /* --------------------------- シナリオ解決 --------------------------- */
  // scenario: { subs, lineup?, tweaks?, outcome? } / null → 実試合
  E.actualScenario = (match) => {
    const subs = {};
    for (const k of E.teamKeys(match)) subs[k] = (match.subsActual[k] || []).map(s => ({ ...s }));
    return { id: "actual", label: "実試合", actual: true, subs, lineup: null, tweaks: null };
  };
  E.scenarioHash = (scenario) => {
    if (!scenario || scenario.actual) return 0;
    let h = 7;
    const mix = (v) => { h = (Math.imul(h, 31) + v) | 0; };
    for (const tm of Object.keys(scenario.subs).sort())
      for (const s of scenario.subs[tm] || [])
        mix(s.t * 7 + s.out * 131 + s.in * 977);
    if (scenario.lineup) {
      for (const tm of Object.keys(scenario.lineup).sort()) {
        for (const ph of scenario.lineup[tm].phases || []) {
          mix(N.seedOf(ph.shape) ^ (ph.from | 0));
          for (const slot of Object.keys(ph.assign).sort()) mix(N.seedOf(slot) ^ (ph.assign[slot] * 389));
        }
      }
    }
    if (scenario.tweaks) {
      for (const tm of Object.keys(scenario.tweaks).sort()) {
        for (const slot of Object.keys(scenario.tweaks[tm]).sort()) {
          const tw = scenario.tweaks[tm][slot];
          mix(N.seedOf(tm + slot) ^ (Math.round(tw.dx * 1000) * 37 + Math.round(tw.dy * 1000)));
        }
      }
    }
    return h || 1;
  };
  // キャッシュ・キー: outcome の有無で世界（アンカー/イベント）が変わる
  E.scenarioKey = (scenario) =>
    `${E.scenarioHash(scenario)}|${scenario && scenario.outcome ? scenario.outcome.sig : 0}`;

  // 布陣フェーズ（シナリオ上書き優先）
  E.phasesOf = (match, scenario, team) =>
    (scenario && scenario.lineup && scenario.lineup[team] && scenario.lineup[team].phases) ||
    match.teams[team].phases;
  E.tweakOf = (scenario, team, slotId) =>
    (scenario && scenario.tweaks && scenario.tweaks[team] && scenario.tweaks[team][slotId]) || null;

  // ある時刻のスロット割当を解決（フェーズ + 交代スワップ）
  E.rosterAt = (match, scenario, team, t) => {
    const phases = E.phasesOf(match, scenario, team);
    let phase = phases[0];
    for (const ph of phases) if (ph.from <= t) phase = ph;
    const assign = { ...phase.assign };
    // フェーズ開始前の交代を反映（新フェーズの assign はスタメン番号基準のため
    // 既に OUT した選手を IN 選手へ差し替える）
    const allSubs = (scenario.subs[team] || []).slice().sort((a, b) => a.t - b.t);
    const entered = {};
    for (const s of allSubs) {
      if (s.t > t) break;
      for (const slot in assign) if (assign[slot] === s.out) {
        assign[slot] = s.in;
        if (s.t > phase.from) entered[s.in] = s.t;
        break;
      }
    }
    return { assign, shape: phase.shape, phaseFrom: phase.from, entered };
  };

  // 選手の在場区間（分数計算・入退場アニメ・妥当性検証に使用）
  E.presenceOf = (match, scenario, team, no) => {
    const range = E.playedRange(match);
    const subs = scenario.subs[team] || [];
    const starters = Object.values(E.phasesOf(match, scenario, team)[0].assign);
    let on = starters.includes(no) ? range.t0 : null;
    let off = null;
    for (const s of subs) {
      if (s.in === no) on = s.t;
      if (s.out === no) off = s.t;
    }
    if (on == null) return null;
    return { from: on, to: off ?? range.t1 };
  };

  /* --------------------- ポゼッション波形 P(t) ∈ [-1,1] --------------------- */
  // P>0: possessionPlus チームの攻勢。KPスプライン + 小ノイズ（帯域制限）
  E.possessionAt = (match, t) => {
    const base = N.spline(match.possessionKP, t)[0];
    const n = 0.10 * N.vnoise1(N.seedOf(match.meta.id + "poss"), t, 37);
    return clamp(base + n, -1, 1);
  };

  /* ------------------- アンカー（シナリオ実効） ------------------- */
  const inWindows = (t, windows) => {
    if (!windows) return false;
    for (const w of windows) if (t >= w.t0 && t <= w.t1) return true;
    return false;
  };
  const ballAnchorsOf = (match, scenario) => {
    const oc = scenario && scenario.outcome;
    if (!oc) return match.ballAnchors;
    const list = match.ballAnchors.filter(a => !inWindows(a.t, oc.suppress));
    return list.concat(oc.ballAnchors || []).sort((a, b) => a.t - b.t);
  };
  const panchorCache = new Map();
  const playerAnchorsOf = (match, scenario) => {
    const oc = scenario && scenario.outcome;
    if (!oc) return match.playerAnchors;
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    if (panchorCache.has(key)) return panchorCache.get(key);
    const list = match.playerAnchors.filter(a => !inWindows(a.t, oc.suppress))
      .concat(oc.playerAnchors || []);
    panchorCache.set(key, list);
    return list;
  };

  /* ------------------------------ ボール ------------------------------ */
  const trackCache = new Map();
  const buildBallTrack = (match, scenario) => {
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    if (trackCache.has(key)) return trackCache.get(key);
    const list = [];
    for (const a of ballAnchorsOf(match, scenario)) {
      list.push({ t: a.t, x: a.x, y: a.y });
      if (a.hold) list.push({ t: a.t + a.hold, x: a.x, y: a.y });
    }
    list.sort((a, b) => a.t - b.t);
    trackCache.set(key, list);
    return list;
  };

  // ブロック移動用の平滑ボール（帯域制限 — 速度寄与を抑える・シナリオ非依存）
  E.ballSlowAt = (match, t) => {
    const seed = N.seedOf(match.meta.id + "ball");
    const P = E.possessionAt(match, t);
    const half = E.halfOf(match, t);
    const plus = match.possessionPlus || E.teamKeys(match)[0];
    const dirB = match.dir[plus][half === 1 ? "h1" : "h2"];
    const x = clamp(P * 28 * dirB + N.fbm1(seed, t, [{ amp: 9, period: 33 }]), -46, 46);
    const y = clamp(N.fbm1(seed + 5, t, [{ amp: 13, period: 47 }]), -26, 26);
    return { x, y };
  };

  /* =================== ポゼッション・チェーン（保持者列） =================== */
  // 決定論生成: セグメント列 [{t0,t1,team,no,slot,fT(フライト開始),from:{team,no,slot}}]
  // ボールは保持者の基礎位置（basePlayerPos）に付く。パス/奪取はフライト補間。
  const chainRoleW = { GK: 0.03, CB: 0.75, FB: 1.05, WB: 1.15, DM: 1.25, CM: 1.35, AM: 1.35, W: 1.25, ST: 1.0 };
  const chainCache = new Map();

  const basePosOf = (match, scenario, team, no, slot, t) => {
    const half = E.halfOf(match, t);
    const dir = match.dir[team][half === 1 ? "h1" : "h2"];
    const bctx = {
      half, dir,
      P: E.possessionAt(match, t),
      ballS: E.ballSlowAt(match, t),
    };
    return basePlayerPos(match, scenario, team, no, slot, t, bctx);
  };

  const buildChain = (match, scenario) => {
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    if (chainCache.has(key)) return chainCache.get(key);
    const range = E.playedRange(match);
    const seed = N.seedOf(match.meta.id + "chain") ^ E.scenarioHash(scenario);
    const keys = E.teamKeys(match);
    const plus = match.possessionPlus || keys[0];
    const minus = keys.find(k => k !== plus);
    // セグメント境界を跨げない時刻（交代・フェーズ切替・ハーフ）
    const cuts = [range.ht];
    for (const k of keys) {
      for (const s of scenario.subs[k] || []) cuts.push(s.t);
      for (const ph of E.phasesOf(match, scenario, k)) if (ph.from > 0) cuts.push(ph.from);
    }
    cuts.sort((a, b) => a - b);

    const segs = [];
    let t = range.t0 + 2;   // キックオフ・アンカー後から
    let idx = 0;
    let prev = null;        // {team,no,slot,pos}
    while (t < range.t1 - 1) {
      const P = E.possessionAt(match, t);
      const share = clamp(0.5 + P * 0.385, 0.07, 0.93);   // 実測支配率69/31に較正
      const team = N.hash2(seed, idx * 17 + 3) < share ? plus : minus;
      // 保持者選定: 近接 × 役割 × 前進バイアス × ジッター
      const roster = E.rosterAt(match, scenario, team, t);
      const shape = F.SHAPES[roster.shape];
      const half = E.halfOf(match, t);
      const dir = match.dir[team][half === 1 ? "h1" : "h2"];
      const align = Math.max(0, E.attackSign(match, team) * P);
      const ref = prev ? prev.pos : E.ballSlowAt(match, t);
      let best = null, bestW = -1;
      for (const slot of shape) {
        const no = roster.assign[slot.id];
        if (no == null) continue;
        const entT = roster.entered[no];
        if (entT != null && t - entT < 35) continue;      // 入場走り込み中は除外
        const pos = basePosOf(match, scenario, team, no, slot, t);
        const d = Math.hypot(pos.x - ref.x, pos.y - ref.y);
        const progress = (dir * pos.x + HALF_W) / 105;    // 0=自陣奥 → 1=敵陣奥
        const w = Math.exp(-d / 13)
          * (chainRoleW[slot.role] ?? 1)
          * (0.55 + 0.9 * N.hash2(seed, idx * 97 + no))
          * (1 + 0.55 * align * progress);
        if (w > bestW) { bestW = w; best = { team, no, slot, pos }; }
      }
      if (!best) { t += 4; idx++; continue; }
      // フライト（前保持者 → 新保持者）
      let fDur = 0;
      if (prev) {
        const d = Math.hypot(best.pos.x - prev.pos.x, best.pos.y - prev.pos.y);
        fDur = clamp(d / 16, 0.45, 1.3);
      }
      let hold = 2.4 + 4.2 * N.hash2(seed, idx * 53 + 7);
      // カット時刻を跨がない
      let end = t + fDur + hold;
      for (const c of cuts) if (c > t + fDur + 0.3 && c < end) { end = c; break; }
      hold = Math.max(0.3, end - t - fDur);
      segs.push({
        t0: t, tf: t + fDur, t1: end,
        team: best.team, no: best.no, slot: best.slot,
        from: prev ? { team: prev.team, no: prev.no, slot: prev.slot } : null,
      });
      prev = best;
      // 次セグメントの参照位置を保持者のホールド終了時位置へ更新
      prev.pos = basePosOf(match, scenario, best.team, best.no, best.slot, Math.min(end, range.t1 - 0.5));
      t = end;
      idx++;
    }
    // 累積保持秒（支配率表示用プレフィクス和）
    let accP = 0, accM = 0;
    for (const s of segs) {
      const d = s.t1 - s.t0;
      if (s.team === plus) accP += d; else accM += d;
      s.accPlus = accP; s.accMinus = accM;
    }
    const chain = { segs, plus, minus };
    chainCache.set(key, chain);
    return chain;
  };

  const segAt = (chain, t) => {
    const segs = chain.segs;
    if (segs.length === 0) return null;
    let lo = 0, hi = segs.length - 1;
    if (t < segs[0].t0 || t > segs[hi].t1) return null;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (segs[m].t0 <= t) lo = m; else hi = m; }
    const s = segs[lo].t1 >= t ? segs[lo] : segs[hi];
    return (t >= s.t0 && t <= s.t1) ? s : null;
  };

  // 保持者情報: {team, no, u(確度0..1), mode:"hold"|"flight", seg}
  E.carrierAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const chain = buildChain(match, scenario);
    const s = segAt(chain, t);
    if (!s) return null;
    if (t < s.tf) {
      const u = N.smooth(clamp((t - s.t0) / Math.max(0.001, s.tf - s.t0)));
      return { team: s.team, no: s.no, u, mode: "flight", seg: s };
    }
    // 両端フルランプ（プレッサー引力の連続性 = 速度上限の保証に必須）
    const uIn = N.smooth(clamp((t - s.tf) / 0.6));
    const uOut = N.smooth(clamp((s.t1 - t) / 0.6));
    return { team: s.team, no: s.no, u: uIn * uOut, mode: "hold", seg: s };
  };

  // 累積支配率（チェーン基準・実測波形と整合）
  E.possessionStats = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const chain = buildChain(match, scenario);
    const segs = chain.segs;
    if (!segs.length) return { [chain.plus]: 0.5, [chain.minus]: 0.5 };
    let lo = 0, hi = segs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (segs[m].t0 <= t) lo = m; else hi = m; }
    const s = segs[lo];
    let aP = lo > 0 ? segs[lo - 1].accPlus : 0;
    let aM = lo > 0 ? segs[lo - 1].accMinus : 0;
    const d = clamp(t - s.t0, 0, s.t1 - s.t0);
    if (s.team === chain.plus) aP += d; else aM += d;
    if (aP + aM < 5) return { [chain.plus]: 0.5, [chain.minus]: 0.5 };
    const tot = aP + aM;
    return { [chain.plus]: aP / tot, [chain.minus]: aM / tot };
  };

  // チェーンによる自由ボール位置（アンカー外区間で使用）
  const chainBall = (match, scenario, t) => {
    const chain = buildChain(match, scenario);
    const s = segAt(chain, t);
    if (!s) {
      const bs = E.ballSlowAt(match, t);
      return { x: bs.x, y: bs.y, z: 0.11 };
    }
    const seed = N.seedOf(match.meta.id + "dribble");
    const holderPos = (seg, tt) => {
      const p = basePosOf(match, scenario, seg.team, seg.no, seg.slot, tt);
      return {
        x: p.x + 0.7 * N.vnoise1(seed + seg.no * 7, tt, 2.9),
        y: p.y + 0.7 * N.vnoise1(seed + 31 + seg.no * 7, tt, 3.1),
      };
    };
    if (t >= s.tf || !s.from) {
      const p = holderPos(s, t);
      return { x: p.x, y: p.y, z: 0.11 + 0.05 * Math.abs(N.vnoise1(9917, t, 1.7)) };
    }
    // フライト: 送り手位置(t) → 受け手位置(t) の移動目標補間
    const u = N.smooth(clamp((t - s.t0) / Math.max(0.001, s.tf - s.t0)));
    const a = holderPos({ team: s.from.team, no: s.from.no, slot: s.from.slot }, t);
    const b = holderPos(s, t);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const zArc = dist > 17 ? Math.sin(Math.PI * u) * Math.min(2.4, dist * 0.07) : Math.sin(Math.PI * u) * 0.25;
    return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: 0.11 + zArc };
  };

  // 後方互換: E.ballAt(match, t) / E.ballAt(match, scenario, t)
  E.ballAt = (match, a, b) => {
    let scenario, t;
    if (typeof a === "number") { t = a; scenario = b || E.actualScenario(match); }
    else { scenario = a || E.actualScenario(match); t = b; }
    const track = buildBallTrack(match, scenario);
    const n = track.length;
    let pos, segLen = 0, segSpeed = 0, zChain = null;
    if (n === 0) return chainBall(match, scenario, t);
    if (t <= track[0].t) pos = { x: track[0].x, y: track[0].y };
    else if (t >= track[n - 1].t) {
      const f = chainBall(match, scenario, t), a2 = track[n - 1];
      const u = N.smooth(clamp((t - a2.t) / 12));
      pos = { x: lerp(a2.x, f.x, u), y: lerp(a2.y, f.y, u) };
      zChain = f.z;
    } else {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (track[m].t <= t) lo = m; else hi = m; }
      const a2 = track[lo], b2 = track[hi];
      const G = b2.t - a2.t || 1e-6;
      segLen = Math.hypot(b2.x - a2.x, b2.y - a2.y);
      segSpeed = segLen / G;
      if (G <= 25) {
        const u = N.smooth((t - a2.t) / G);
        pos = { x: lerp(a2.x, b2.x, u), y: lerp(a2.y, b2.y, u) };
      } else {
        // 長い区間: アンカー → チェーン（保持者の足元） → アンカー
        const W = 10;
        const f = chainBall(match, scenario, t);
        if (t < a2.t + W) {
          const u = N.smooth((t - a2.t) / W);
          pos = { x: lerp(a2.x, f.x, u), y: lerp(a2.y, f.y, u) };
        } else if (t > b2.t - W) {
          const u = N.smooth((b2.t - t) / W);
          pos = { x: lerp(b2.x, f.x, u), y: lerp(b2.y, f.y, u) };
        } else pos = f;
        zChain = f.z;
        segSpeed = 0; segLen = 0;
      }
    }
    // 高さ: 速い区間は放物線アーク（クロス/シュート）、通常は転がり
    let z;
    if (zChain != null) z = zChain;
    else if (segLen > 14 && segSpeed > 7) {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (track[m].t <= t) lo = m; else hi = m; }
      const a2 = track[lo], b2 = track[hi];
      const u = clamp((t - a2.t) / ((b2.t - a2.t) || 1));
      const h = Math.min(3.2, segLen * (segSpeed > 16 ? 0.03 : 0.12));
      z = 0.11 + Math.sin(Math.PI * u) * h;
    } else {
      z = 0.11 + 0.05 * Math.abs(N.vnoise1(9917, t, 1.7));
    }
    return { ...pos, z };
  };

  /* --------------------- 再開（キックオフ）と祝祭の窓 --------------------- */
  const restartCache = new Map();
  const restartWindows = (match, scenario) => {
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    if (restartCache.has(key)) return restartCache.get(key);
    const rs = [];
    for (const a of ballAnchorsOf(match, scenario)) if (a.x === 0 && a.y === 0) rs.push(a.t);
    restartCache.set(key, rs);
    return rs;
  };
  const celeCache = new Map();
  // 祝祭位置はアンカー・トラックから直接参照（chainBall再帰を回避）
  const trackPosNear = (match, scenario, t) => {
    const track = buildBallTrack(match, scenario);
    let best = null, bd = 1e9;
    for (const p of track) { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = p; } }
    return bd < 6 ? best : null;
  };
  const goalCelebrations = (match, scenario) => {
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    if (celeCache.has(key)) return celeCache.get(key);
    const cs = [];
    for (const ev of E.eventsOf(match, scenario)) if (ev.type === "goal") {
      const b = trackPosNear(match, scenario, ev.t) || { x: Math.sign(ev.t) * HALF_W, y: 0 };
      cs.push({ t: ev.t, team: ev.team, no: ev.no, gx: Math.sign(b.x || 1) * HALF_W, gy: b.y });
    }
    celeCache.set(key, cs);
    return cs;
  };

  /* ------------------------- 選手位置の合成 ------------------------- */
  const slotWorld = (slot, g, dir, tw) => {
    // g ∈ [-1..1] 攻守モーフ → 正規化 → ワールド座標（tw: 配置微調整）
    let mx = g >= 0 ? lerp(slot.x, slot.att.x, g) : lerp(slot.x, slot.def.x, -g);
    let my = g >= 0 ? lerp(slot.y, slot.att.y, g) : lerp(slot.y, slot.def.y, -g);
    if (tw) { mx = clamp(mx + tw.dx, 0.02, 0.98); my = clamp(my + tw.dy, -1, 1); }
    const x = dir > 0 ? mx * 105 - HALF_W : HALF_W - mx * 105;
    const y = dir * my * HALF_H * 0.92;
    return { x, y };
  };

  E.fatigueOf = (match, scenario, team, no, t) => {
    const pr = E.presenceOf(match, scenario, team, no);
    if (!pr || t < pr.from) return 0;
    const mins = (Math.min(t, pr.to) - pr.from) / 60;
    const p = match.teams[team].squad.find(q => q.no === no);
    const sta = p ? p.attrs.sta : 75;
    return clamp((mins / 95) * (1.45 - (sta / 100) * 0.75));
  };

  /* 基礎位置（純関数・ボール実位置に非依存 — チェーン生成の土台） */
  const basePlayerPos = (match, scenario, team, no, slot, t, bctx) => {
    const { half, dir, P, ballS } = bctx;
    const T = match.teams[team];
    const role = slot.role;
    const g0 = E.attackSign(match, team) * P;                 // 自チーム攻勢度
    const g = clamp(g0 + 0.12 * N.vnoise1(N.seedOf(team + "g"), t, 53), -1, 1);
    const tw = E.tweakOf(scenario, team, slot.id);

    // 1) フォーメーション・スロット（攻守モーフ + 配置微調整）
    let { x, y } = slotWorld(slot, g, dir, tw);

    // 2) ブロック連動（平滑ボールへスライド — 守備ブロックの本質）
    const cw = F.chaseWeight[role] ?? 0.3;
    x += (ballS.x - x * 0.2) * cw * 0.55;
    y += (ballS.y - y * 0.25) * cw * 0.75;

    // 3) 個体ノイズ（帯域制限・疲労で減衰）
    const amp = (F.noiseAmp[role] ?? 7) * (1 - 0.35 * E.fatigueOf(match, scenario, team, no, t));
    const ps = N.seedOf(match.meta.id + team + no);
    x += N.fbm1(ps, t, [
      { amp: amp * 0.5, period: 42 }, { amp: amp * 0.42, period: 14 },
      { amp: amp * 0.5, period: 5.6 }, { amp: amp * 0.28, period: 3.1 }]);
    y += N.fbm1(ps + 77, t, [
      { amp: amp * 0.55, period: 39 }, { amp: amp * 0.42, period: 13 },
      { amp: amp * 0.5, period: 5.3 }, { amp: amp * 0.28, period: 3.0 }]);

    // 4) GK 特別則: ゴールライン近傍で平滑ボール角を追従
    if (role === "GK") {
      const gx = -dir * HALF_W;                              // 自ゴール
      const push = clamp(0.5 - g0 * 0.5);                    // 攻勢時は少し前へ
      x = gx + dir * (2.5 + 9 * (1 - push) * clamp(1 - Math.abs(ballS.x - gx) / 105));
      x = gx + dir * clamp(Math.abs(x - gx), 1.5, 14);
      x += dir * Math.abs(N.fbm1(ps + 301, t, [{ amp: 3.2, period: 15 }, { amp: 1.7, period: 5.0 }]));
      y = clamp(ballS.y * 0.28, -8, 8)
        + N.fbm1(ps, t, [{ amp: 1.2, period: 23 }, { amp: 2.8, period: 7.5 }, { amp: 1.3, period: 3.3 }]);
    }

    // 5) イベント・アンカー（得点再現など — ガウス窓・シナリオ実効）
    for (const a of playerAnchorsOf(match, scenario)) {
      if (a.team !== team || a.no !== no) continue;
      const w = N.gauss(t, a.t, a.sigma || 6);
      if (w > 0.004) { x = lerp(x, a.x, w); y = lerp(y, a.y, w); }
    }

    // 6) コーナー時のボックス集結
    for (const ev of E.eventsOf(match, scenario)) {
      if (ev.type !== "corner") continue;
      const w = N.gauss(t, ev.t + 4, 7);
      if (w < 0.01) continue;
      const atk = ev.team === team;
      const cb = trackPosNear(match, scenario, ev.t + 1) || ballS;
      const bx = Math.sign(cb.x) * (HALF_W - 8);
      const seedy = N.hash2(N.seedOf(team + no), ev.t | 0) * 2 - 1;
      if (atk && (role === "CB" || role === "ST" || role === "AM" || role === "CM")) {
        x = lerp(x, bx, w * 0.9); y = lerp(y, seedy * 12, w * 0.9);
      } else if (!atk && role !== "GK" && role !== "ST") {
        x = lerp(x, bx, w * 0.85); y = lerp(y, seedy * 14, w * 0.85);
      }
    }

    // 7) ゴール祝祭（得点チームはコーナー付近へ、失点側はセンターへ戻る）
    for (const c of goalCelebrations(match, scenario)) {
      const dtc = t - c.t;
      if (dtc < 1.5 || dtc > 40) continue;
      const w = N.smooth(clamp((dtc - 1.5) / 9)) * N.smooth(clamp((40 - dtc) / 12));
      if (role === "GK") continue;
      if (c.team === team) {
        const isScorer = no === c.no;
        const dist = Math.hypot(x - c.gx, y - c.gy);
        const nearF = isScorer ? 1 : N.smooth(clamp((48 - dist) / 20));
        if (nearF > 0.01) {
          const cy = c.gy > 0 ? HALF_H - 6 : -(HALF_H - 6);
          const ww = w * nearF * (isScorer ? 0.95 : 0.72);
          x = lerp(x, c.gx * 0.86, ww);
          y = lerp(y, cy * 0.9, ww);
        }
      } else {
        const back = slotWorld(slot, -0.3, dir, tw);
        x = lerp(x, back.x, w * 0.6); y = lerp(y, back.y, w * 0.6);
      }
    }

    // 8) 再開（キックオフ）整列 — 全員自陣（競技規則）
    for (const rt of restartWindows(match, scenario)) {
      const w = N.gauss(t, rt + 1, 6.5);
      if (w > 0.01) {
        const base = slotWorld(slot, -0.05, dir, tw);
        if (dir > 0) base.x = Math.min(base.x, -0.8);
        else base.x = Math.max(base.x, 0.8);
        x = lerp(x, base.x, w * 0.92); y = lerp(y, base.y, w * 0.92);
      }
    }

    // ピッチ内クランプ
    x = clamp(x, -HALF_W + 0.4, HALF_W - 0.4);
    y = clamp(y, -HALF_H + 0.4, HALF_H - 0.4);
    return { x, y };
  };

  // 最終位置 = 基礎位置 + ボール文脈調整（GK追従・プレッシング）
  // 調整はすべて lerp ブレンド + 平滑ゲートで速度上限を保つ
  const playerPos = (match, scenario, team, no, slot, t, ctx) => {
    const bctx = { half: ctx.half, dir: ctx.dir, P: ctx.P, ballS: ctx.ballS };
    let { x, y } = basePlayerPos(match, scenario, team, no, slot, t, bctx);
    const ball = ctx.ball;

    // GK: 実ボールの左右へ微調整（帯域内）
    if (slot.role === "GK" && ball) {
      const ty = clamp(ball.y * 0.28, -8, 8);
      y = lerp(y, ty, 0.5);
    }

    // プレッシング: 相手保持者への寄せ（最近接ほど強く・連続ゲート）
    const c = ctx.carrier;
    if (c && c.mode === "hold" && c.team !== team && slot.role !== "GK" && ctx.carrierPos) {
      const cp = ctx.carrierPos;
      const d = Math.hypot(cp.x - x, cp.y - y);
      const gate = Math.exp(-(d * d) / (2 * 10 * 10));       // σ=10m
      const w = 0.22 * gate * c.u;
      if (w > 0.003) {
        // 寄せ位置: 保持者の自ゴール側 1.4m
        const gx = -ctx.dir * HALF_W;
        const gl = Math.hypot(gx - cp.x, 0 - cp.y) || 1;
        const px = cp.x + ((gx - cp.x) / gl) * 1.4;
        const py = cp.y + ((0 - cp.y) / gl) * 1.4;
        x = lerp(x, px, w);
        y = lerp(y, py, w);
      }
    }

    x = clamp(x, -HALF_W + 0.4, HALF_W - 0.4);
    y = clamp(y, -HALF_H + 0.4, HALF_H - 0.4);
    return { x, y };
  };

  /* ------------------------------ 状態合成 ------------------------------ */
  E.stateAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const range = E.playedRange(match);
    t = clamp(t, range.t0, range.t1);
    const half = E.halfOf(match, t);
    const P = E.possessionAt(match, t);
    const ball = E.ballAt(match, scenario, t);
    const ballS = E.ballSlowAt(match, t);
    const carrier = E.carrierAt(match, scenario, t);
    // 保持者の現在基礎位置（プレッサー目標）
    let carrierPos = null;
    if (carrier && carrier.mode === "hold") {
      carrierPos = basePosOf(match, scenario, carrier.team, carrier.no, carrier.seg.slot, t);
    }
    const players = [];

    for (const team of E.teamKeys(match)) {
      const dir = match.dir[team][half === 1 ? "h1" : "h2"];
      const roster = E.rosterAt(match, scenario, team, t);
      const shape = F.SHAPES[roster.shape];
      const ctx = { half, dir, P, ballS, ball, carrier, carrierPos };
      // フェーズ切替の平滑化（ハーフ開始時を除く）: 旧スロット→新スロットを45sブレンド
      let rosterPrev = null, prevShape = null, blendU = 1;
      const dtPhase = t - roster.phaseFrom;
      if (roster.phaseFrom > 0 && roster.phaseFrom !== match.time.h2.start && dtPhase < 45) {
        rosterPrev = E.rosterAt(match, scenario, team, roster.phaseFrom - 0.01);
        prevShape = F.SHAPES[rosterPrev.shape];
        blendU = N.smooth(clamp(dtPhase / 45));
      }
      // 現在ピッチ上の11人
      for (const slot of shape) {
        const no = roster.assign[slot.id];
        if (no == null) continue;
        const p = match.teams[team].squad.find(q => q.no === no);
        if (!p) continue;
        let pos = playerPos(match, scenario, team, no, slot, t, ctx);
        if (rosterPrev) {
          const prevSlotId = Object.keys(rosterPrev.assign).find(k => rosterPrev.assign[k] === no);
          if (prevSlotId && prevSlotId !== slot.id) {
            const prevSlot = prevShape.find(s => s.id === prevSlotId);
            if (prevSlot) {
              const posPrev = playerPos(match, scenario, team, no, prevSlot, t, ctx);
              pos = { x: lerp(posPrev.x, pos.x, blendU), y: lerp(posPrev.y, pos.y, blendU) };
            }
          }
        }
        // 入場アニメ: 交代直後はタッチラインから走り込む
        let entering = 0;
        const entT = roster.entered[no];
        if (entT != null && t - entT < 32) {
          const u = N.smooth(clamp((t - entT) / 32));
          const sideY = -(HALF_H + 2.5);
          pos.x = lerp(clamp(pos.x, -18, 18), pos.x, u);
          pos.y = lerp(sideY, pos.y, u);
          entering = 1 - u;
        }
        players.push({
          team, no, name: p.name, ja: p.ja, label: p.label, pos2: p.pos,
          role: slot.role, slot: slot.id, x: pos.x, y: pos.y,
          onPitch: true, entering, attrs: p.attrs, captain: false,
          // アンカー再現中（ボールが保持者から離れている間）はフラグを立てない
          hasBall: !!(carrier && carrier.mode === "hold" && carrier.team === team && carrier.no === no
            && Math.hypot(pos.x - ball.x, pos.y - ball.y) < 3.5),
        });
      }
      // 退場アニメ: 交代でOUTした選手（30秒だけベンチへ歩く）
      for (const s of scenario.subs[team] || []) {
        if (s.t <= t && t - s.t < 30) {
          const u = N.smooth(clamp((t - s.t) / 30));
          const last = E.stateFrozenPos(match, scenario, team, s.out, s.t);
          const p = match.teams[team].squad.find(q => q.no === s.out);
          if (!p) continue;
          players.push({
            team, no: s.out, name: p.name, ja: p.ja, label: p.label, pos2: p.pos,
            role: "OUT", slot: null,
            x: lerp(last.x, 0, u * 0.8), y: lerp(last.y, -(HALF_H + 2.5), u),
            onPitch: false, leaving: u, attrs: p.attrs, captain: false,
          });
        }
      }
      // キャプテンマーク
      const order = match.teams[team].captainOrder || [];
      for (const cno of order) {
        const pl = players.find(q => q.team === team && q.no === cno && q.onPitch);
        if (pl) { pl.captain = true; break; }
      }
    }

    return {
      t, half, clock: E.clockAt(match, t),
      score: E.scoreAt(match, t, scenario),
      possession: P, ball, players,
      carrier: carrier ? { team: carrier.team, no: carrier.no, mode: carrier.mode, u: carrier.u } : null,
      scenarioId: scenario.id || "actual",
    };
  };

  // 特定選手の位置を直接評価（退場アニメ始点・軌跡・距離積分）
  E.stateFrozenPos = (match, scenario, team, no, t) => {
    scenario = scenario || E.actualScenario(match);
    const half = E.halfOf(match, t - 0.01);
    const dir = match.dir[team][half === 1 ? "h1" : "h2"];
    const roster = E.rosterAt(match, scenario, team, t - 0.01);
    const shape = F.SHAPES[roster.shape];
    let slot = shape.find(s => roster.assign[s.id] === no);
    if (!slot) slot = shape[Math.min(5, shape.length - 1)];
    const tt = t - 0.01;
    const carrier = E.carrierAt(match, scenario, tt);
    let carrierPos = null;
    if (carrier && carrier.mode === "hold") {
      carrierPos = basePosOf(match, scenario, carrier.team, carrier.no, carrier.seg.slot, tt);
    }
    const ctx = {
      half, dir, P: E.possessionAt(match, tt),
      ballS: E.ballSlowAt(match, tt), ball: E.ballAt(match, scenario, tt),
      carrier, carrierPos,
    };
    return playerPos(match, scenario, team, no, slot, tt, ctx);
  };

  /* --------------------------- 走行距離・速度 --------------------------- */
  const distCache = new Map();
  E.distanceCovered = (match, scenario, team, no, t) => {
    const key = `${E.scenarioKey(scenario)}|${team}|${no}`;
    let arr = distCache.get(key);
    const STEP = 1;   // 最速オクターブ(3.1s)を確実にサンプル
    if (!arr) { arr = { ts: [0], ds: [0] }; distCache.set(key, arr); }
    const pr = E.presenceOf(match, scenario, team, no);
    if (!pr) return 0;
    const upto = Math.min(t, pr.to);
    let lastT = arr.ts[arr.ts.length - 1], acc = arr.ds[arr.ds.length - 1];
    if (upto > lastT) {
      let prev = null;
      for (let tt = lastT; tt <= upto; tt += STEP) {
        if (tt < pr.from) { arr.ts.push(tt); arr.ds.push(acc); continue; }
        const st = E.stateFrozenPos(match, scenario, team, no, Math.max(tt, pr.from + 0.02));
        if (prev) acc += Math.min(Math.hypot(st.x - prev.x, st.y - prev.y), 9.8 * STEP);
        prev = st;
        arr.ts.push(tt); arr.ds.push(acc);
      }
    }
    // 二分探索で t 位置の値
    const ts = arr.ts; let lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= upto) lo = m; else hi = m; }
    return arr.ds[lo];
  };
  E.clearCaches = () => {
    distCache.clear(); chainCache.clear(); trackCache.clear();
    restartCache.clear(); celeCache.clear(); panchorCache.clear();
  };
})();
