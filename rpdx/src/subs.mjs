/* =========================================================================
   RPDX.subs — 交代ルールエンジン / 布陣・配置編集 / 戦術アドバイザ / シナリオ管理
   ---------------------------------------------------------------------------
   ■ 不可侵レイヤ validatePlan: FIFA競技規則（5人・3窓・HT非カウント・
     再入場禁止・GK保証・ベンチ限定）を全交代プランに強制。
     シナリオが布陣（lineup）を上書きしている場合はそのスタメンを基準に検証。
   ■ 布陣編集: withFormation（分指定の陣形変更）/ withStarter（スタメン差替）/
     withSlotSwap（配置入替）/ withTweak（スロット微調整 — 正規化座標オフセット）。
     すべて不変編集で新シナリオを返し、規則検証を通す。
   ■ TacticalSubAdvisor: 疲労 × 危険度文脈 × スコア文脈 × 役割適合 ×
     警告リスクから (OUT, IN, 分) を採点する独自関数。出力は全て検証済み。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const S = (R.subs = {});
  const E = R.engine, D = R.danger, F = R.formations;
  const clamp = R.noise.clamp;

  S.MAX_SUBS = 5;
  S.MAX_WINDOWS = 3;
  S.TWEAK_X = 0.14;   // 配置微調整の可動域（正規化: x=105m基準）
  S.TWEAK_Y = 0.40;   // y=±31m基準

  /* ------------------------- 分 ⇄ 実プレー秒 ------------------------- */
  S.minuteToT = (match, min) => {
    const h1 = match.time.h1, h2 = match.time.h2;
    if (min <= 45) return clamp(min * 60, 0, h1.end);
    if (min <= 45 + h1.added) return clamp(2700 + (min - 45) * 60, 0, h1.end); // 45+X
    return clamp(h2.start + (min - 45) * 60, h2.start, h2.end);
  };
  S.tToMinute = (match, t) => {
    const c = E.clockAt(match, t);
    return Math.max(1, Math.ceil(c.clock / 60)); // 66:00 → 66'（公式記録の慣習）
  };
  S.tToLabel = (match, t) => {
    const c = E.clockAt(match, t);
    const base = c.half === 1 ? 2700 : 5400;
    if (c.clock > base) return `${c.half === 1 ? 45 : 90}+${Math.floor((c.clock - base - 0.001) / 60) + 1}'`;
    return `${Math.max(1, Math.ceil(c.clock / 60))}'`;
  };

  /* --------------------------- 検証（不可侵） --------------------------- */
  // lineup: シナリオの布陣上書き（省略時 match 既定）。スタメンはここから解決。
  S.validatePlan = (match, plan /* {TEAM:[{t,out,in}]} */, lineup) => {
    const errors = [];
    const info = {};
    for (const team of E.teamKeys(match)) {
      const T = match.teams[team];
      const squadNos = new Set(T.squad.map(p => p.no));
      const phases = (lineup && lineup[team] && lineup[team].phases) || T.phases;
      const starters = new Set(Object.values(phases[0].assign));
      const subs = [...(plan[team] || [])].sort((a, b) => a.t - b.t);
      const err = (m) => errors.push(`[${T.name}] ${m}`);

      if (starters.size !== 11) err(`スタメン ${starters.size}人 ≠ 11`);
      if (subs.length > S.MAX_SUBS) err(`交代人数 ${subs.length} が上限${S.MAX_SUBS}を超過`);

      // 交代窓: 同時刻グループ = 1窓。HT（後半開始時 t==h2.start）はカウント外
      const windows = new Set();
      for (const s of subs) if (s.t !== match.time.h2.start) windows.add(Math.round(s.t));
      if (windows.size > S.MAX_WINDOWS) err(`交代窓 ${windows.size} が上限${S.MAX_WINDOWS}を超過（HTは非カウント）`);

      const range = E.playedRange(match);
      const onPitch = new Set(starters);
      const used = new Set(starters);
      const isGK = (no) => T.squad.find(p => p.no === no)?.pos === "GK";
      for (const s of subs) {
        const pOut = T.squad.find(p => p.no === s.out), pIn = T.squad.find(p => p.no === s.in);
        if (!squadNos.has(s.out) || !pOut) { err(`#${s.out} はスカッド外（OUT指定不可）`); continue; }
        if (!squadNos.has(s.in) || !pIn) { err(`#${s.in} はスカッド外（IN指定不可）`); continue; }
        if (s.t < range.t0 || s.t > range.t1) err(`${pIn.ja} 投入時刻がタイムライン外`);
        if (!onPitch.has(s.out)) err(`${pOut.ja} はその時点でピッチ上にいない（OUT不可）`);
        if (used.has(s.in)) err(`${pIn.ja} は既に出場済み — 再入場は禁止`);
        if (isGK(s.out) !== isGK(s.in)) err(`GK交代はGK同士に限定（${pOut.ja} ⇄ ${pIn.ja} は不正）`);
        onPitch.delete(s.out); onPitch.add(s.in); used.add(s.in);
      }
      if (onPitch.size !== 11) err(`最終人数 ${onPitch.size} ≠ 11`);
      let gkCount = 0; for (const no of onPitch) if (isGK(no)) gkCount++;
      if (gkCount !== 1) err(`GK人数 ${gkCount} ≠ 1`);
      info[team] = { count: subs.length, windows: windows.size, remaining: S.MAX_SUBS - subs.length };
    }
    return { ok: errors.length === 0, errors, info };
  };
  S.validateScenario = (match, scenario) => S.validatePlan(match, scenario.subs, scenario.lineup);

  /* --------------------------- シナリオ管理 --------------------------- */
  let seq = 0;
  const cloneLineup = (lineup) => {
    if (!lineup) return null;
    const out = {};
    for (const k of Object.keys(lineup)) {
      out[k] = { phases: lineup[k].phases.map(ph => ({ from: ph.from, shape: ph.shape, assign: { ...ph.assign } })) };
    }
    return out;
  };
  const cloneTweaks = (tweaks) => {
    if (!tweaks) return null;
    const out = {};
    for (const k of Object.keys(tweaks)) {
      out[k] = {};
      for (const slot of Object.keys(tweaks[k])) out[k][slot] = { ...tweaks[k][slot] };
    }
    return out;
  };
  S.createScenario = (match, label, base) => {
    base = base || {};
    const srcSubs = base.subs || base;   // 旧署名（subs直渡し）互換
    const subs = {};
    for (const k of E.teamKeys(match)) subs[k] = (srcSubs[k] || []).map(s => ({ ...s }));
    return {
      id: `sim-${++seq}`, label: label || `シナリオ ${seq}`, actual: false,
      subs, lineup: cloneLineup(base.lineup), tweaks: cloneTweaks(base.tweaks),
      outcome: null,   // sim.mjs が決定論付与
    };
  };
  S.fromActual = (match, label) => {
    const subs = {};
    for (const k of E.teamKeys(match)) subs[k] = (match.subsActual[k] || []).map(s => ({ t: s.t, out: s.out, in: s.in }));
    return S.createScenario(match, label, { subs });
  };
  S.fork = (match, scenario, label) =>
    S.createScenario(match, label || scenario.label, scenario);

  // 不変編集: 交代の追加/削除
  S.withSub = (match, scenario, team, sub) => {
    const next = S.fork(match, scenario);
    next.subs[team] = [...next.subs[team], { ...sub }].sort((a, b) => a.t - b.t);
    return { scenario: next, validation: S.validateScenario(match, next) };
  };
  S.withoutSub = (match, scenario, team, idx) => {
    const next = S.fork(match, scenario);
    next.subs[team] = next.subs[team].filter((_, i) => i !== idx);
    return { scenario: next, validation: S.validateScenario(match, next) };
  };

  /* --------------------------- 布陣・配置編集 --------------------------- */
  const ensureLineup = (match, scenario, team) => {
    if (!scenario.lineup) scenario.lineup = {};
    if (!scenario.lineup[team]) {
      scenario.lineup[team] = {
        phases: E.phasesOf(match, { subs: scenario.subs, lineup: null }, team)
          .map(ph => ({ from: ph.from, shape: ph.shape, assign: { ...ph.assign } })),
      };
    }
    return scenario.lineup[team];
  };

  // 陣形変更: 分 min から shape へ。現時点の11人を役割適合で新スロットへ自動再配置。
  // min 以降の既存フェーズは破棄（そこからはユーザーの指揮）。min<=1 は初期陣形を差替。
  S.withFormation = (match, scenario, team, min, shape) => {
    if (!F.SHAPES[shape]) return { scenario, validation: { ok: false, errors: [`未知の陣形 ${shape}`], info: {} } };
    const next = S.fork(match, scenario);
    const lu = ensureLineup(match, next, team);
    const t = Math.max(0, S.minuteToT(match, min));
    const roster = E.rosterAt(match, next, team, Math.max(t, 0.01));
    const T = match.teams[team];
    // 現在の11人 → 新シェイプへ役割適合の貪欲割当
    const slots = F.SHAPES[shape];
    const pool = Object.entries(roster.assign).map(([slotId, no]) => {
      const curSlot = F.SHAPES[roster.shape].find(s => s.id === slotId);
      const p = T.squad.find(q => q.no === no);
      return { no, tags: curSlot ? curSlot.tags : S.tagsOfPos(p), p };
    });
    const assign = {};
    for (const slot of slots) {
      let best = null, bestScore = -1;
      for (const c of pool) {
        const isGKp = c.p.pos === "GK";
        if ((slot.role === "GK") !== isGKp) continue;
        const aff = Math.max(F.roleAffinity(slot.tags, c.tags), F.roleAffinity(slot.tags, S.tagsOfPos(c.p)));
        const attr = slot.role === "ST" || slot.role === "W" || slot.role === "AM"
          ? c.p.attrs.att : slot.role === "CB" || slot.role === "DM" ? c.p.attrs.def : (c.p.attrs.sta + c.p.attrs.tec) / 2;
        const sc = aff * 100 + attr * 0.3;
        if (sc > bestScore) { bestScore = sc; best = c; }
      }
      if (!best) best = pool[0];
      if (best) { assign[slot.id] = best.no; pool.splice(pool.indexOf(best), 1); }
    }
    if (t <= 1) {
      // 初期陣形の差替 — 以降の実試合フェーズは解除（ユーザーが指揮を執る）
      lu.phases = [{ from: 0, shape, assign }];
    } else {
      lu.phases = lu.phases.filter(ph => ph.from < t);
      lu.phases.push({ from: t, shape, assign });
    }
    return { scenario: next, validation: S.validateScenario(match, next) };
  };

  // フェーズ削除（from>0 のユーザーフェーズ）
  S.withoutPhase = (match, scenario, team, from) => {
    const next = S.fork(match, scenario);
    const lu = ensureLineup(match, next, team);
    lu.phases = lu.phases.filter(ph => ph.from === 0 || ph.from !== from);
    return { scenario: next, validation: S.validateScenario(match, next) };
  };

  // スタメン差替: phase0 の slotId に選手 no（既に他スロットにいる場合は入替）
  S.withStarter = (match, scenario, team, slotId, no) => {
    const next = S.fork(match, scenario);
    const lu = ensureLineup(match, next, team);
    const a = lu.phases[0].assign;
    const prevNo = a[slotId];
    const otherSlot = Object.keys(a).find(k => a[k] === no);
    if (otherSlot) a[otherSlot] = prevNo;   // 入替
    a[slotId] = no;
    return { scenario: next, validation: S.validateScenario(match, next) };
  };

  // 配置入替: 現行フェーズ（時刻t）の2スロットの担当を入替
  S.withSlotSwap = (match, scenario, team, t, slotA, slotB) => {
    const next = S.fork(match, scenario);
    const lu = ensureLineup(match, next, team);
    let phase = lu.phases[0];
    for (const ph of lu.phases) if (ph.from <= t) phase = ph;
    const a = phase.assign;
    if (a[slotA] == null || a[slotB] == null) {
      return { scenario, validation: { ok: false, errors: ["スロットが不正"], info: {} } };
    }
    [a[slotA], a[slotB]] = [a[slotB], a[slotA]];
    return { scenario: next, validation: S.validateScenario(match, next) };
  };

  // 配置微調整: 正規化オフセット（可動域クランプ）。null で解除。
  S.withTweak = (match, scenario, team, slotId, dx, dy) => {
    const next = S.fork(match, scenario);
    if (!next.tweaks) next.tweaks = {};
    if (!next.tweaks[team]) next.tweaks[team] = {};
    if (dx == null && dy == null) delete next.tweaks[team][slotId];
    else next.tweaks[team][slotId] = {
      dx: clamp(dx || 0, -S.TWEAK_X, S.TWEAK_X),
      dy: clamp(dy || 0, -S.TWEAK_Y, S.TWEAK_Y),
    };
    return { scenario: next, validation: S.validateScenario(match, next) };
  };

  S.clearLineup = (match, scenario, team) => {
    const next = S.fork(match, scenario);
    if (next.lineup) delete next.lineup[team];
    if (next.tweaks) delete next.tweaks[team];
    if (next.lineup && Object.keys(next.lineup).length === 0) next.lineup = null;
    if (next.tweaks && Object.keys(next.tweaks).length === 0) next.tweaks = null;
    return { scenario: next, validation: S.validateScenario(match, next) };
  };

  /* ----------------------- TacticalSubAdvisor ----------------------- */
  // 独自採点関数: 文脈（危険度トレンド・スコア・疲労・警告・役割適合）
  S.advise = (match, scenario, t, team, opts = {}) => {
    const T = match.teams[team];
    const opp = E.oppOf(match, team);
    const score = E.scoreAt(match, t, scenario);
    const diff = score[team] - score[opp];

    // 直近10分の危険度トレンド（受け/攻め）
    let oppDanger = 0, ownDanger = 0, n = 0;
    for (let tt = Math.max(0, t - 600); tt <= t; tt += 120) {
      const ix = D.indexAt(match, scenario, tt, opts);
      oppDanger += ix[opp].total; ownDanger += ix[team].total; n++;
    }
    oppDanger /= n; ownDanger /= n;

    // ニーズ算定: 守備補強 vs 攻撃補強（0..1）
    const needDef = clamp(oppDanger / 70 + (diff > 0 ? 0.25 : 0) - (diff < 0 ? 0.2 : 0));
    const needAtk = clamp((diff < 0 ? 0.55 : diff === 0 ? 0.35 : 0.1) + clamp((40 - ownDanger) / 80));

    const roster = E.rosterAt(match, scenario, team, t);
    const shape = F.SHAPES[roster.shape];
    const yellows = new Set(match.events.filter(e => e.type === "yellow" && e.team === team && e.t <= t).map(e => e.no));

    const validation0 = S.validateScenario(match, scenario);
    const remaining = validation0.info[team].remaining;
    if (remaining <= 0) return { suggestions: [], context: { needDef, needAtk, oppDanger, ownDanger, diff, remaining } };

    // 使用済み選手（IN済/OUT済/スタメン）
    const used = new Set(Object.values(E.phasesOf(match, scenario, team)[0].assign));
    for (const s of scenario.subs[team]) { used.add(s.in); }
    const outCandidates = [];
    for (const slot of shape) {
      const no = roster.assign[slot.id];
      if (no == null || slot.role === "GK") continue;
      const p = T.squad.find(q => q.no === no);
      const fat = E.fatigueOf(match, scenario, team, no, t);
      const yRisk = yellows.has(no) ? 0.7 : 0;
      // 役割ミスマッチ: 守備が必要なのに守備値の低い前線 等
      const mismatch = needDef * (1 - p.attrs.def / 100) * (slot.role === "W" || slot.role === "ST" || slot.role === "AM" ? 0.6 : 0.2)
        + needAtk * (1 - p.attrs.att / 100) * (slot.role === "ST" || slot.role === "W" ? 0.5 : 0.1);
      outCandidates.push({ no, p, slot, score: fat * 0.5 + yRisk * 0.22 + mismatch * 0.28, fat, yRisk });
    }
    outCandidates.sort((a, b) => b.score - a.score);

    const bench = T.squad.filter(p => !used.has(p.no) && p.pos !== "GK" &&
      !scenario.subs[team].some(s => s.out === p.no));

    const sugg = [];
    for (const oc of outCandidates.slice(0, 5)) {
      for (const b of bench) {
        const aff = F.roleAffinity(oc.slot.tags, tagsOfPos(b));
        if (aff < 0.3) continue;
        const attrFit = needDef * (b.attrs.def / 100) * 0.6 + needAtk * ((b.attrs.att + b.attrs.pac) / 200) * 0.7
          + (1 - needDef - needAtk < 0 ? 0 : 0.15) * (b.attrs.tec / 100);
        const fresh = 1 - E.fatigueOf(match, scenario, team, b.no, t);
        const total = oc.score * 0.42 + aff * 0.2 + attrFit * 0.26 + fresh * 0.12;
        // 規則検証（不可侵レイヤ通過必須）
        const trial = S.withSub(match, scenario, team, { t: t, out: oc.no, in: b.no });
        if (!trial.validation.ok) continue;
        sugg.push({
          out: oc.no, in: b.no, t, score: total,
          outJa: oc.p.ja, inJa: b.ja,
          reason: buildReason(oc, b, needDef, needAtk, diff),
        });
      }
    }
    sugg.sort((a, b) => b.score - a.score);
    // 同一OUT/同一INの重複を除いた上位
    const seen = new Set(), top = [];
    for (const s of sugg) {
      const k1 = `o${s.out}`, k2 = `i${s.in}`;
      if (seen.has(k1) || seen.has(k2)) continue;
      seen.add(k1); seen.add(k2); top.push(s);
      if (top.length >= 3) break;
    }
    return { suggestions: top, context: { needDef, needAtk, oppDanger, ownDanger, diff, remaining } };
  };

  const tagsOfPos = (p) => {
    if (p.pos === "GK") return ["GK"];
    if (p.pos === "DF") return p.attrs.pac >= 76 ? ["CB", "FB", "WB"] : ["CB", "FB"];
    if (p.pos === "MF") return p.attrs.att >= 80 ? ["CM", "AM", "W"] : ["CM", "DM", "WB"];
    return p.attrs.pac >= 85 ? ["ST", "W"] : ["ST"];
  };
  S.tagsOfPos = tagsOfPos;

  const buildReason = (oc, b, needDef, needAtk, diff) => {
    const parts = [];
    if (oc.fat > 0.55) parts.push(`${oc.p.ja}の推定疲労 ${Math.round(oc.fat * 100)}%`);
    if (oc.yRisk > 0) parts.push(`警告リスク管理`);
    if (needDef > 0.5) parts.push(`被危険度上昇局面 — 守備値${b.attrs.def}で封鎖`);
    if (needAtk > 0.45) parts.push(diff < 0 ? `ビハインド — 攻撃値${b.attrs.att}/速度${b.attrs.pac}で打開` : `速度${b.attrs.pac}でカウンターの出口を確保`);
    if (b.attrs.aer >= 84) parts.push(`空中戦${b.attrs.aer}`);
    if (parts.length === 0) parts.push(`役割適合とフレッシュネス`);
    return parts.join("・");
  };
})();
