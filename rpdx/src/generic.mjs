/* =========================================================================
   RPDX.generic — 汎用試合ファクトリ
   ---------------------------------------------------------------------------
   過去データが無くても「選手情報（背番号・氏名・ポジション、任意で能力値）」
   だけから RPDX 互換の試合オブジェクトを決定論生成する。
   - 能力値未指定 → ポジション基準値 + 名前ハッシュの個体差
   - イベント未指定 → チーム強度から得点期待を算定し、決定論的に
     得点・ポゼッション波形・ボールアンカーを合成
   生成物は実試合と同じエンジン/危険度/交代シミュレーションで動作する。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const G = (R.generic = {});
  const N = R.noise, F = R.formations;
  const clamp = N.clamp;

  const BASE_ATTRS = {
    GK: [58, 70, 82, 28, 64, 82],
    DF: [72, 78, 82, 54, 72, 78],
    MF: [77, 82, 68, 76, 80, 62],
    FW: [83, 80, 52, 83, 77, 72],
  };

  const jitter = (seed, i, span = 7) => Math.round((N.hash2(seed, i) * 2 - 1) * span);

  G.normalizePlayer = (p, teamSeed, idx) => {
    const base = BASE_ATTRS[p.pos] || BASE_ATTRS.MF;
    const s = N.seedOf(teamSeed + p.name + p.no);
    const attrs = p.attrs || {};
    return {
      no: p.no, pos: p.pos, name: p.name,
      ja: p.ja || p.name, label: p.label || (p.ja || p.name).slice(0, 6),
      born: p.born || 1998, club: p.club || "-", caps: p.caps || 0, goals: p.goals || 0,
      captain: !!p.captain,
      attrs: {
        pac: clamp(attrs.pac ?? base[0] + jitter(s, 1), 40, 99),
        sta: clamp(attrs.sta ?? base[1] + jitter(s, 2), 40, 99),
        def: clamp(attrs.def ?? base[2] + jitter(s, 3), 20, 99),
        att: clamp(attrs.att ?? base[3] + jitter(s, 4), 20, 99),
        tec: clamp(attrs.tec ?? base[4] + jitter(s, 5), 40, 99),
        aer: clamp(attrs.aer ?? base[5] + jitter(s, 6), 30, 99),
      },
    };
  };

  // XI 自動選抜: シェイプの各スロットに役割適合×総合力で貪欲割当
  G.autoXI = (squad, shape) => {
    const shapeSlots = F.SHAPES[shape];
    const pool = [...squad];
    const assign = {};
    const overall = (p) => (p.attrs.pac + p.attrs.sta + p.attrs.def + p.attrs.att + p.attrs.tec + p.attrs.aer) / 6;
    for (const slot of shapeSlots) {
      let best = null, bestScore = -1;
      for (const p of pool) {
        const aff = F.roleAffinity(slot.tags, R.subs ? R.subs.tagsOfPos(p) : [p.pos === "GK" ? "GK" : "CM"]);
        if (slot.role === "GK" && p.pos !== "GK") continue;
        if (slot.role !== "GK" && p.pos === "GK") continue;
        const sc = aff * 60 + overall(p) * 0.55;
        if (aff >= 0.3 && sc > bestScore) { bestScore = sc; best = p; }
      }
      if (!best) { best = pool.find(p => (slot.role === "GK") === (p.pos === "GK")); }
      if (best) { assign[slot.id] = best.no; pool.splice(pool.indexOf(best), 1); }
    }
    return assign;
  };

  const teamStrength = (team) => {
    const xi = Object.values(team.phases[0].assign).map(no => team.squad.find(p => p.no === no));
    return xi.reduce((s, p) => s + p.attrs.att * 0.38 + p.attrs.tec * 0.32 + p.attrs.pac * 0.3, 0) / xi.length;
  };

  /* ---- 決定論ポアソン: strength差 → 得点数 ---- */
  const detPoisson = (lambda, u) => {
    let k = 0, p = Math.exp(-lambda), cum = p;
    while (u > cum && k < 6) { k++; p *= lambda / k; cum += p; }
    return k;
  };

  G.createMatch = (cfg) => {
    const seed = N.seedOf(cfg.seed || (cfg.home.code + cfg.away.code));
    const mk = (side, tcfg, fallbackColor) => {
      const squad = tcfg.squad.map((p, i) => G.normalizePlayer(p, tcfg.code, i));
      const shape = tcfg.formation || "442";
      const team = {
        code: tcfg.code, name: tcfg.name || tcfg.code, nameEn: tcfg.nameEn || tcfg.code,
        coach: tcfg.coach || "-",
        color: tcfg.color || fallbackColor, colorDeep: tcfg.colorDeep || "#101826",
        kit: tcfg.kit || { shirt: tcfg.color || fallbackColor, shorts: "#20242C", number: "#0D1117", gk: "#7E57C2", gkNumber: "#EDE7F6" },
        squad, phases: [], captainOrder: tcfg.captainOrder || squad.filter(p => p.captain).map(p => p.no),
      };
      team.phases = [{ from: 0, shape, assign: tcfg.xi || G.autoXI(squad, shape) }];
      return team;
    };
    const A = mk("home", cfg.home, "#E5533D");
    const B = mk("away", cfg.away, "#4FA3FF");
    const kA = A.code, kB = B.code;

    const h1Added = cfg.added1 ?? 2, h2Added = cfg.added2 ?? 5;
    const time = {
      h1: { start: 0, end: 2700 + h1Added * 60, clock0: 0, added: h1Added },
      h2: { start: 2700 + h1Added * 60, end: 2700 + h1Added * 60 + 2700 + h2Added * 60, clock0: 2700, added: h2Added },
    };
    const H2 = time.h2.start;

    const sA = teamStrength(A), sB = teamStrength(B);
    const bias = clamp((sA - sB) / 26, -0.55, 0.55);   // ポゼッション偏り

    // ---- 得点の決定論合成 ----
    const events = [{ t: 0, type: "kickoff", team: kA, label: "キックオフ" },
      { t: H2, type: "halftime", label: "前半終了" }, { t: H2, type: "kickoff", team: kB, label: "後半開始" }];
    const ballAnchors = [{ t: 0, x: 0, y: 0, hold: 6 }, { t: H2, x: 0, y: 0, hold: 6 }];
    const possessionKP = [[0, bias * 0.3]];
    const dir = { [kA]: { h1: +1, h2: -1 }, [kB]: { h1: -1, h2: +1 } };

    if (!cfg.events) {
      const gA = detPoisson(clamp(1.15 + (sA - sB) / 14, 0.25, 3.4), N.hash2(seed, 11));
      const gB = detPoisson(clamp(1.05 + (sB - sA) / 14, 0.2, 3.2), N.hash2(seed, 23));
      const goals = [];
      for (let i = 0; i < gA; i++) goals.push({ team: kA, u: N.hash2(seed, 101 + i) });
      for (let i = 0; i < gB; i++) goals.push({ team: kB, u: N.hash2(seed, 301 + i) });
      goals.sort((a, b) => a.u - b.u);
      let gi = 0;
      for (const g of goals) {
        const min = 6 + Math.floor(g.u * 82);                   // 6'..88'
        const t = min <= 45 ? min * 60 : H2 + (min - 45) * 60;
        const team = g.team === kA ? A : B;
        const d = dir[g.team][t < H2 ? "h1" : "h2"];
        // 得点者: 攻撃値重み付き決定論選択
        const xi = Object.entries(team.phases[0].assign)
          .map(([slot, no]) => ({ slot, p: team.squad.find(q => q.no === no) }))
          .filter(e => e.slot !== "GK");
        let wsum = 0; const ws = xi.map(e => { const w = Math.pow(e.p.attrs.att / 100, 3) + (e.slot.includes("S") || e.slot.includes("F") ? 0.25 : 0.02); wsum += w; return w; });
        let u = N.hash2(seed, 501 + gi) * wsum, scorer = xi[0].p;
        for (let i = 0; i < xi.length; i++) { u -= ws[i]; if (u <= 0) { scorer = xi[i].p; break; } }
        const gy = (N.hash2(seed, 601 + gi) * 2 - 1) * 3;
        events.push({
          t, type: "goal", team: g.team, no: scorer.no, assist: null,
          min: min <= 45 ? `${min}'` : `${min}'`,
          label: `GOAL ${scorer.ja}`, detail: "モデル生成イベント",
        });
        ballAnchors.push({ t: t - 9, x: d * 22, y: gy * 4 });
        ballAnchors.push({ t: t - 1.2, x: d * 40, y: gy * 2.2 });
        ballAnchors.push({ t: t, x: d * 52.2, y: gy, hold: 4 });
        ballAnchors.push({ t: Math.min(t + 55, time.h2.end - 5), x: 0, y: 0, hold: 6 });
        possessionKP.push([t - 60, (g.team === kA ? +1 : -1) * 0.55 + bias * 0.2]);
        possessionKP.push([t, (g.team === kA ? +1 : -1) * 0.95]);
        possessionKP.push([t + 90, bias * 0.3]);
        gi++;
      }
      possessionKP.push([time.h2.end, bias * 0.35]);
      possessionKP.sort((a, b) => a[0] - b[0]);
      events.push({ t: time.h2.end, type: "fulltime", label: "試合終了" });
    }

    const score = { [kA]: 0, [kB]: 0 };
    for (const ev of events) if (ev.type === "goal") score[ev.team]++;

    return {
      meta: {
        id: `custom-${cfg.seed || kA + kB}`,
        competition: cfg.competition || "カスタム・マッチ（モデル生成）",
        stage: cfg.stage || "シミュレーション", date: cfg.date || "-",
        venue: cfg.venue || "仮想スタジアム", attendance: cfg.attendance || 0,
        referee: cfg.referee || "-", score,
        note: "選手情報のみから決定論生成（RPDX.generic）",
      },
      time, dir, kickoffBy: { h1: kA, h2: kB },
      possessionPlus: kA, teamOrder: [kA, kB],
      teams: { [kA]: A, [kB]: B },
      subsActual: { [kA]: [], [kB]: [] },
      events: cfg.events || events,
      possessionKP: cfg.possessionKP || possessionKP,
      ballAnchors: cfg.ballAnchors || ballAnchors,
      playerAnchors: cfg.playerAnchors || [],
      stats: cfg.stats || [
        { key: "推定支配率", [kA]: `${Math.round(50 + bias * 40)}%`, [kB]: `${Math.round(50 - bias * 40)}%` },
        { key: "チーム強度（モデル）", [kA]: sA.toFixed(1), [kB]: sB.toFixed(1) },
      ],
    };
  };

  // 最小テンプレート（UIの「カスタム試合」初期値）
  G.template = () => ({
    seed: "demo-1",
    home: {
      code: "RED", name: "レッドスターズ", formation: "433", color: "#E5533D",
      squad: Array.from({ length: 18 }, (_, i) => ({
        no: i + 1, pos: i === 0 ? "GK" : i < 6 ? "DF" : i < 12 ? "MF" : "FW",
        name: `Red ${i + 1}`, ja: `レッド${i + 1}`,
      })),
    },
    away: {
      code: "SKY", name: "スカイユナイテッド", formation: "442", color: "#4FA3FF",
      squad: Array.from({ length: 18 }, (_, i) => ({
        no: i + 1, pos: i === 0 ? "GK" : i < 6 ? "DF" : i < 12 ? "MF" : "FW",
        name: `Sky ${i + 1}`, ja: `スカイ${i + 1}`,
      })),
    },
  });
})();
