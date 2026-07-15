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

  // #89: 選手能力値・名前のシナリオ級上書き（無ければ squad 由来・golden安全）
  E.attrsOf = (match, scenario, team, no) => {
    const p = match.teams[team].squad.find(q => q.no === no);
    const base = p ? p.attrs : { pac: 75, sta: 75, def: 60, att: 60, tec: 60, aer: 60 };
    const ov = scenario && scenario.attrOverrides && scenario.attrOverrides[team] && scenario.attrOverrides[team][no];
    return ov ? { ...base, ...ov } : base;
  };
  E.nameOverrideOf = (match, scenario, team, no) =>
    (scenario && scenario.nameOverrides && scenario.nameOverrides[team] && scenario.nameOverrides[team][no]) || null;
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
  // 内容ベースのハッシュ: 実試合と「実試合と同一内容のシナリオ」は同じ世界になる
  // （同一 subs/lineup/tweaks → 同一チェーン・同一危険度 → 結果不変が構成的に成立）
  E.scenarioHash = (scenario) => {
    if (!scenario) return 0;
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
    // #81: 退場は在場人員＝世界（チェーン/位置）を変える → 世界シードに含める。
    //   未指定なら混合ゼロ＝従来ハッシュ不変（golden安全）。
    if (scenario.outages) {
      for (const tm of Object.keys(scenario.outages).sort())
        for (const o of scenario.outages[tm] || [])
          mix(N.seedOf(tm + (o.kind || "red-card") + (o.reshape || "")) ^ (o.t * 17 + o.no * 523));
    }
    return h || 1;
  };
  // キャッシュ・キー: outcome の有無で世界（アンカー/イベント）が変わる。
  // opponentHt（#61 HT修正ハンディ）は「表示・ブレンドの変調」であり世界シード
  //（scenarioHash→チェーン）には入れない。ただし位置・危険度が変わるため
  // キャッシュ・キーには含めて衝突を防ぐ。
  E.scenarioKey = (scenario) => {
    const ht = scenario && scenario.opponentHt
      ? `${scenario.opponentHt.team}:${scenario.opponentHt.archetype || ""}:${scenario.opponentHt.staff || 0}:${scenario.opponentHt.stages || 0}`
      : "";
    // #83: editAnchors はキャッシュ・キーに含める（位置が変わる）。世界シードには入れない。
    const ea = scenario && scenario.editAnchors && scenario.editAnchors.length
      ? "e" + scenario.editFrom + ":" + scenario.editAnchors.length + ":" + Math.round((scenario.editAnchors[0].x + scenario.editAnchors[0].y) * 10) : "";
    // #89: 能力値上書きは危険度/位置(fatigue)に効く → キャッシュ・キーに含める（世界シードには入れない）
    let ao = "";
    if (scenario && scenario.attrOverrides) {
      for (const tm of Object.keys(scenario.attrOverrides).sort())
        for (const no of Object.keys(scenario.attrOverrides[tm]).sort()) {
          const o = scenario.attrOverrides[tm][no];
          ao += tm + no + ":" + ["pac","sta","def","att","tec","aer"].map(k => o[k] ?? "").join(",") + ";";
        }
    }
    let nm = "";
    if (scenario && scenario.nameOverrides) {
      for (const tm of Object.keys(scenario.nameOverrides).sort())
        nm += tm + Object.keys(scenario.nameOverrides[tm]).sort().join(",") + "|";
    }
    return `${E.scenarioHash(scenario)}|${scenario && scenario.outcome ? scenario.outcome.sig : 0}|${ht}|${ea}|${ao}|${nm}`;
  };

  // #61: HT修正力ハンディ — scenario.opponentHt = {team, archetype?|staff/stages/toolShare/fieldShare}
  // 指定チームの「HT近傍のフェーズ切替」を、体制脆弱性に応じて遅延・鈍化させる。
  // 飽和(backlog)は actual 世界の前半から算出（what-if 自身を参照しない — 再帰回避）。
  const htCorrCache = new Map();
  E.htCorrectionOf = (match, scenario, team) => {
    const o = scenario && scenario.opponentHt;
    if (!o || o.team !== team || !R.opponent) return null;
    const key = match.meta.id + "|" + E.scenarioKey(scenario) + "|" + team;
    const hit = htCorrCache.get(key);
    if (hit !== undefined) return hit;
    const base = o.archetype && R.opponent.ARCHETYPES[o.archetype] ? R.opponent.ARCHETYPES[o.archetype] : {};
    const setup = { ...base, ...o };
    const prof = R.opponent.profile(setup);
    const sat = R.opponent.htSaturation(match, E.actualScenario(match), setup);
    const delayMin = clamp(((prof.scores.overall - 1) / 4) * 7 + sat.backlog * 1.5, 0, 10);
    const out = {
      delaySec: delayMin * 60,
      blendSec: 45 * (1 + ((prof.scores.sway - 1) / 4) * 2),   // 45〜135s（浸透の鈍さ）
      profile: prof,
    };
    if (htCorrCache.size > 64) htCorrCache.clear();
    htCorrCache.set(key, out);
    return out;
  };

  // 布陣フェーズ（シナリオ上書き優先）
  E.phasesOf = (match, scenario, team) =>
    (scenario && scenario.lineup && scenario.lineup[team] && scenario.lineup[team].phases) ||
    match.teams[team].phases;
  E.tweakOf = (scenario, team, slotId) =>
    (scenario && scenario.tweaks && scenario.tweaks[team] && scenario.tweaks[team][slotId]) || null;

  // #81: 数的不利（退場/交代枠なし負傷）— team別 sorted リスト
  E.outagesOf = (match, scenario, team) =>
    ((scenario && scenario.outages && scenario.outages[team]) || []);

  // #81: 退場後の10人リシェイプ（役割適合の貪欲再割当・決定論・メモ化）
  //   subs.withFormation と同じ採点式（共有 F.tagsOfPos）。GKは常にGKスロットへ。
  const outageReshapeCache = new WeakMap();   // scenario → Map(key → {assign, shape})
  const reshapeToTen = (match, scenario, team, assign11, fromShape, outage, subsApplied) => {
    let m = outageReshapeCache.get(scenario);
    if (!m) { m = new Map(); outageReshapeCache.set(scenario, m); }
    const shapeId = outage.reshape || F.tenManShapeFor(fromShape);
    const key = `${team}|${outage.t}|${outage.no}|${shapeId}|${fromShape}|${subsApplied}`;
    const hit = m.get(key);
    if (hit) return hit;
    const T = match.teams[team];
    const slots = F.SHAPES[shapeId];
    const fromSlots = F.SHAPES[fromShape];
    const pool = [];
    for (const [slotId, no] of Object.entries(assign11)) {
      if (no === outage.no) continue;                      // 退場者を除外 → 10人
      const cur = fromSlots.find(s => s.id === slotId);
      const p = T.squad.find(q => q.no === no);
      pool.push({ no, tags: cur ? cur.tags : F.tagsOfPos(p), p });
    }
    const out = {};
    for (const slot of slots) {
      let best = null, bestScore = -1;
      for (const c of pool) {
        const isGKp = c.p.pos === "GK";
        if ((slot.role === "GK") !== isGKp) continue;
        const aff = Math.max(F.roleAffinity(slot.tags, c.tags), F.roleAffinity(slot.tags, F.tagsOfPos(c.p)));
        const attr = slot.role === "ST" || slot.role === "W" || slot.role === "AM"
          ? c.p.attrs.att : slot.role === "CB" || slot.role === "DM" ? c.p.attrs.def : (c.p.attrs.sta + c.p.attrs.tec) / 2;
        const sc = aff * 100 + attr * 0.3;
        if (sc > bestScore) { bestScore = sc; best = c; }
      }
      if (!best) best = pool[0];
      if (best) { out[slot.id] = best.no; pool.splice(pool.indexOf(best), 1); }
    }
    const res = { assign: out, shape: shapeId };
    m.set(key, res);
    return res;
  };

  // ある時刻のスロット割当を解決（フェーズ + 交代スワップ + #81 退場リシェイプ）
  E.rosterAt = (match, scenario, team, t) => {
    const phases = E.phasesOf(match, scenario, team);
    let phase = phases[0];
    for (const ph of phases) if (ph.from <= t) phase = ph;
    let assign = { ...phase.assign };
    // フェーズ開始前の交代を反映（新フェーズの assign はスタメン番号基準のため
    // 既に OUT した選手を IN 選手へ差し替える）
    const allSubs = (scenario.subs[team] || []).slice().sort((a, b) => a.t - b.t);
    const entered = {};
    let subsApplied = 0;
    for (const s of allSubs) {
      if (s.t > t) break;
      subsApplied++;
      for (const slot in assign) if (assign[slot] === s.out) {
        assign[slot] = s.in;
        if (s.t > phase.from) entered[s.in] = s.t;
        break;
      }
    }
    let shape = phase.shape, phaseFrom = phase.from, outage = null;
    // #81: 発生済み退場を適用（v1: チーム毎1件）— 10人シェイプへ決定論リシェイプ
    for (const o of E.outagesOf(match, scenario, team)) {
      if (o.t > t) break;
      if (!Object.values(assign).includes(o.no)) continue;   // 既に不在（検証で防止済み）
      const r = reshapeToTen(match, scenario, team, assign, shape, o, subsApplied);
      assign = { ...r.assign };
      shape = r.shape;
      phaseFrom = Math.max(phaseFrom, o.t);                  // 切替ブレンドの起点
      outage = o;
    }
    return { assign, shape, phaseFrom, entered, outage };
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
    // #81: 退場/交代なし負傷はそこで在場終了（交代より早ければ優先）
    for (const o of E.outagesOf(match, scenario, team))
      if (o.no === no && (off == null || o.t < off)) off = o.t;
    if (on == null) return null;
    return { from: on, to: off ?? range.t1 };
  };

  /* --------------------- ポゼッション波形 P(t) ∈ [-1,1] --------------------- */
  // P>0: possessionPlus チームの攻勢。KPスプライン + 小ノイズ（帯域制限）
  E.possessionAt = (match, t, scenario) => {
    const base = N.spline(match.possessionKP, t)[0];
    const n = 0.10 * N.vnoise1(N.seedOf(match.meta.id + "poss"), t, 37);
    let p = base + n;
    // #81: 数的不利の保持シフト — 退場チームから相手側へ（2分ランプで浸透・決定論）。
    //   scenario 未指定/outages 無しは従来値と完全一致（golden安全）。
    if (scenario && scenario.outages) {
      for (const tm of Object.keys(scenario.outages)) {
        for (const o of scenario.outages[tm] || []) {
          if (t <= o.t) continue;
          const u = N.smooth(clamp((t - o.t) / 120));
          const sign = tm === match.possessionPlus ? -1 : +1;   // 退場側の保持を減らす
          p += sign * 0.28 * u;
        }
      }
    }
    return clamp(p, -1, 1);
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
  // チェーン生成中はチェーン由来アンカー（リスタート/タックル）を注入しない
  // — 生成がアンカーに依存すると循環するため。ガードは常に生成時のみ真＝決定論。
  let chainBuilding = false;
  const playerAnchorsOf = (match, scenario) => {
    const oc = scenario && scenario.outcome;
    let base = !oc
      ? match.playerAnchors
      : match.playerAnchors.filter(a => !inWindows(a.t, oc.suppress)).concat(oc.playerAnchors || []);
    // #83: 編集フレームの再合成 — scenario.editAnchors（scenario級・match非改変）
    if (scenario && scenario.editAnchors && scenario.editAnchors.length) base = base.concat(scenario.editAnchors);
    if (chainBuilding) return base;
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    if (panchorCache.has(key)) return panchorCache.get(key);
    // チェーンのリスタート/タックル・アンカーを合流（buildChain はガード下で base のみ参照）
    const chain = buildChain(match, scenario);
    const list = chain.anchors && chain.anchors.length ? base.concat(chain.anchors) : base;
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
  // 保持の持続性（マルコフ）: k_keep = 1 − τ·(1−π)。定常分布は π（=実測支配率）のまま、
  // 平均連続保持 ≈ 1/(τ·(1−π)) 本 — 優勢側 ~7本 / 劣勢側 ~3.4本（実試合水準）。
  const TURNOVER_TAU = 0.42;
  // アウトオブプレー率（セグメント境界あたり）→ 1試合 ~60回のリスタート
  const P_OUT = 0.052;
  const chainCache = new Map();

  // 基礎位置のメモ（#39）: separationAt / pressRankAt / defensiveLineAt / 本体が
  // 同一 (scenario, t) で同じ選手の基礎位置を重複評価する（実測で ~38回/係数）。
  // 純関数なのでメモは値を一切変えない（ゴールデンマスターがビット同一を保証）。
  // 注意: lineComputing 中はライン同期/ランが無効化された「別の値」になるため
  // キーに含めて分離する（混ぜると再帰ガードが壊れる）。
  const basePosCache = new Map();
  // シナリオ→短トークン（ホットパスで scenarioHash の再計算を避ける）
  const scenTokMap = new WeakMap();
  let scenTokSeq = 0;
  const scenTok = (sc) => {
    let tok = scenTokMap.get(sc);
    if (tok === undefined) { tok = ++scenTokSeq; scenTokMap.set(sc, tok); }
    return tok;
  };
  const basePosOf = (match, scenario, team, no, slot, t) => {
    // chainBuilding 中はラン(#30)が無効化された「別の値」— メモを迂回して混入を防ぐ
    // （チェーン構築はシナリオ毎に1回きり・キャッシュ済みなのでメモ価値も低い）
    if (chainBuilding) {
      const half0 = E.halfOf(match, t);
      return basePlayerPos(match, scenario, team, no, slot, t, {
        half: half0, dir: match.dir[team][half0 === 1 ? "h1" : "h2"],
        P: E.possessionAt(match, t, scenario), ballS: E.ballSlowAt(match, t),
      });
    }
    const key = scenTok(scenario) + "|" + team + no + "|" + slot.id + "|" + t + "|" + (lineComputing ? 1 : 0);
    const hit = basePosCache.get(key);
    if (hit !== undefined) return hit;
    const half = E.halfOf(match, t);
    const dir = match.dir[team][half === 1 ? "h1" : "h2"];
    const bctx = {
      half, dir,
      P: E.possessionAt(match, t, scenario),
      ballS: E.ballSlowAt(match, t),
    };
    const out = basePlayerPos(match, scenario, team, no, slot, t, bctx);
    if (basePosCache.size > 120000) basePosCache.clear();
    basePosCache.set(key, out);
    return out;
  };

  /* ============ 協調ラインコントロール & オフサイド（#27・純関数・ガード付き） ============
     lineComputing ガード: ライン計算中は basePlayerPos のライン同期項を無効化して
     再帰を避ける（chainBuilding と同型）。lineCache は 0.25s バケットでキャッシュ。 */
  let lineComputing = false;
  const lineCache = new Map();
  const LINE_ROLES = { CB: 1, FB: 1, WB: 1 };
  const LINE_SYNC = 0.34;                  // 最終ラインを合意 x へ引き寄せる重み（同期昇降）

  // 自チーム最終ラインの合意 x（同期前の生 base x の平均）
  E.defensiveLineAt = (match, scenario, team, t) => {
    scenario = scenario || E.actualScenario(match);
    const key = match.meta.id + "|" + E.scenarioKey(scenario) + "|L|" + team + "|" + t;
    const hit = lineCache.get(key); if (hit) return hit;
    const half = E.halfOf(match, t);
    const dir = match.dir[team][half === 1 ? "h1" : "h2"];
    lineComputing = true;
    let sum = 0, nn = 0;
    try {
      const roster = E.rosterAt(match, scenario, team, t);
      const shape = F.SHAPES[roster.shape];
      for (const slot of shape) {
        if (!LINE_ROLES[slot.role]) continue;
        const no = roster.assign[slot.id]; if (no == null) continue;
        sum += basePosOf(match, scenario, team, no, slot, t).x; nn++;
      }
    } finally { lineComputing = false; }
    const out = { lineX: nn ? sum / nn : -dir * 30, dir, count: nn };
    if (lineCache.size > 6000) lineCache.clear();
    lineCache.set(key, out);
    return out;
  };

  // attackingTeam の攻撃者が越えるとオフサイドになる境界の「深さ」(= dir·x)。
  // 慣習: 相手の後方から2人目の守備者（GK含む近似）とボールの、より手前(浅い)側。
  E.offsideLineAt = (match, scenario, attackingTeam, t) => {
    scenario = scenario || E.actualScenario(match);
    const opp = E.oppOf(match, attackingTeam);
    const key = match.meta.id + "|" + E.scenarioKey(scenario) + "|O|" + attackingTeam + "|" + t;
    const hit = lineCache.get(key); if (hit) return hit;
    const half = E.halfOf(match, t);
    const dir = match.dir[attackingTeam][half === 1 ? "h1" : "h2"];   // 攻撃方向（深さ=dir·x）
    lineComputing = true;
    const depths = [];
    try {
      const roster = E.rosterAt(match, scenario, opp, t);
      const shape = F.SHAPES[roster.shape];
      for (const slot of shape) {
        const no = roster.assign[slot.id]; if (no == null) continue;
        depths.push(dir * basePosOf(match, scenario, opp, no, slot, t).x);
      }
    } finally { lineComputing = false; }
    depths.sort((a, b) => b - a);                    // 深い(自ゴール側)順
    const secondLast = depths.length >= 2 ? depths[1] : (depths[0] ?? dir * 52.5);
    const ballDepth = dir * E.ballSlowAt(match, t).x;
    // オフサイド境界: 「ボールと2nd-lastの両方より前」＝ 深い方（max）を越えるとオフサイド
    const out = { offsideDepth: Math.max(secondLast, ballDepth), dir };
    if (lineCache.size > 6000) lineCache.clear();
    lineCache.set(key, out);
    return out;
  };

  // 攻撃者 (team) がオフサイド位置か（読み取り専用の判定・可視化/ラインブレイクに使用）
  E.isOffsidePos = (match, scenario, team, x, t) => {
    const o = E.offsideLineAt(match, scenario, team, t);
    return o.dir * x > o.offsideDepth + 0.3;         // 境界より深ければオフサイド（0.3m許容）
  };

  // 現時刻にオフサイド位置にいる team の攻撃者（背番号配列・読み取り専用）
  // ＝相手の最終ラインを破って背後に抜けた選手。可視化・ラインブレイク検出に。
  E.offsideAttackersAt = (match, scenario, team, t) => {
    scenario = scenario || E.actualScenario(match);
    const o = E.offsideLineAt(match, scenario, team, t);
    const roster = E.rosterAt(match, scenario, team, t);
    const shape = F.SHAPES[roster.shape];
    const out = [];
    lineComputing = true;
    try {
      for (const slot of shape) {
        if (slot.role === "GK") continue;
        const no = roster.assign[slot.id]; if (no == null) continue;
        const p = basePosOf(match, scenario, team, no, slot, t);
        if (o.dir * p.x > o.offsideDepth + 0.3) out.push(no);
      }
    } finally { lineComputing = false; }
    return out;
  };

  const buildChain = (match, scenario) => {
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    if (chainCache.has(key)) return chainCache.get(key);
    chainBuilding = true;   // 生成中はチェーン由来アンカーを参照しない（循環回避・決定論）
    try {
    const range = E.playedRange(match);
    const seed = N.seedOf(match.meta.id + "chain") ^ E.scenarioHash(scenario);
    const keys = E.teamKeys(match);
    const plus = match.possessionPlus || keys[0];
    const minus = keys.find(k => k !== plus);
    // セグメント境界を跨げない時刻（交代・フェーズ切替・ハーフ・保持台本の境界）
    const cuts = [range.ht];
    for (const k of keys) {
      for (const s of scenario.subs[k] || []) cuts.push(s.t);
      for (const ph of E.phasesOf(match, scenario, k)) if (ph.from > 0) cuts.push(ph.from);
    }
    if (match.chainForce) for (const w of match.chainForce) { cuts.push(w.t0); cuts.push(w.t1); }
    cuts.sort((a, b) => a - b);

    const segs = [];
    const anchors = [];     // リスタート/タックルの再現アンカー（生成後に注入される）
    // 記録イベントの直前窓では保持チームを事実へ拘束（ゴール直前に得点チームが
    // ボールを持っていないと危険度・保持文脈が崩れる — アンカーと同じ「記録優先」原則）
    const forcedWins = [];
    // データ駆動の保持台本（最優先）: パスカット等の実況ストーリーをパックが指定できる
    // 形式: match.chainForce = [{t0, t1, team, no?}] — no 指定でその選手が持ち続ける
    if (match.chainForce) for (const w of match.chainForce) forcedWins.push({ ...w });
    // ゴール後キックオフ窓（#51）は shot/save 等の記録窓より先に積む（forcedWinAt は
    // 先勝ちのため、後置すると終盤の shot 窓に失点側再開が奪われる）
    for (const ev of E.eventsOf(match, scenario)) {
      if (ev.type !== "goal") continue;
      let rt = null;
      for (const r of restartWindows(match, scenario)) if (r > ev.t && r <= ev.t + 130) { rt = r; break; }
      if (rt == null) continue;
      const concede = ev.team === plus ? minus : plus;
      forcedWins.push({ t0: rt - 1, t1: rt + 6, team: concede, kickoff: true });
      cuts.push(rt - 1); cuts.push(rt + 6);
    }
    cuts.sort((a, b) => a - b);
    for (const ev of E.eventsOf(match, scenario)) {
      if (ev.type === "goal") forcedWins.push({ t0: ev.t - 24, t1: ev.t + 1, team: ev.team });
      else if (ev.type === "shot") forcedWins.push({ t0: ev.t - 12, t1: ev.t + 1, team: ev.team });
      else if (ev.type === "save" && ev.team) {
        const opp = ev.team === plus ? minus : plus;
        forcedWins.push({ t0: ev.t - 12, t1: ev.t + 1, team: opp });
      } else if (ev.type === "yellow" && ev.team) {
        // FK: 被ファウル側がボールを持つ（テイカーがスポットに立つ — 吸着と併せて再現）
        const opp = ev.team === plus ? minus : plus;
        forcedWins.push({ t0: ev.t + 0.5, t1: ev.t + 16, team: opp });
      }
    }
    const forcedWinAt = (tt) => {
      for (const w of forcedWins) if (tt >= w.t0 && tt < w.t1) return w;   // 半開区間（境界の重複回避）
      return null;
    };
    // ゴール後の祝祭〜再開はプレー停止 — タックル/リスタートのアンカーを重ねない
    // （祝祭引力と加算されて速度上限を破るのを構成的に防ぐ）
    const goalTs = [];
    for (const ev of E.eventsOf(match, scenario)) if (ev.type === "goal") goalTs.push(ev.t);
    // 祝祭45s + キックオフ窓±2s は接触/ランダム再開を抑制（#51 — 窓境界の
    // ターンオーバーにタックルアンカーが乗ると速度上限を破る）
    const koWins = forcedWins.filter(w => w.kickoff);
    const inCalm = (tt) => goalTs.some(g => tt >= g && tt <= g + 45)
      || koWins.some(w => tt >= w.t0 - 1 && tt <= w.t1 + 2);
    let t = range.t0 + 2;   // キックオフ・アンカー後から
    let idx = 0;
    let prev = null;        // {team,no,slot,pos}
    let forceTeam = null;   // 直前リスタートの投げ先/蹴り先は同チーム（スローを敵に渡さない）
    let forceRef = null;    // コーナー後の受け手参照点（ゴール前 = クロスの落下点）
    const shareGain = match.possessionShareGain ?? 0.385;  // パック毎の較正ノブ
    while (t < range.t1 - 1) {
      const P = E.possessionAt(match, t, scenario);
      const share = clamp(0.5 + P * shareGain, 0.07, 0.93); // 実測支配率へ較正（定常分布）
      const u = N.hash2(seed, idx * 17 + 3);
      // 持続性マルコフ: 独立抽選だと1本ごとに敵味方が入れ替わって見える（実測で平均1.4本）。
      // k_keep = 1−τ(1−π) は定常分布 π を保ったまま連続保持を実試合水準へ伸ばす。
      const forced = forcedWinAt(t);
      let team;
      if (forced) team = forced.team;
      else if (forceTeam) { team = forceTeam; }
      else if (!prev) team = u < share ? plus : minus;
      else {
        const pi = prev.team === plus ? share : 1 - share;
        team = u < 1 - TURNOVER_TAU * (1 - pi) ? prev.team : (prev.team === plus ? minus : plus);
      }
      let isTurnover = !!prev && team !== prev.team;

      // ---- アウトオブプレー（スローイン / コーナー / ゴールキック） ----
      // 記録イベントの拘束窓ではリスタートを生成しない（ゴール前にスローインを挟まない）
      let restart = null;
      if (prev && !forced && !forceTeam && !forceRef && !inCalm(t) && N.hash2(seed, idx * 29 + 11) < P_OUT) {
        const half = E.halfOf(match, t);
        const dirPrev = match.dir[prev.team][half === 1 ? "h1" : "h2"];
        const inAttackHalf = dirPrev * prev.pos.x > 8;    // 敵陣ならCK/GKもあり得る
        const rr = N.hash2(seed, idx * 31 + 7);
        const side = prev.pos.y >= 0 ? 1 : -1;
        if (inAttackHalf && rr < 0.42) {
          // コーナー: 攻撃側（=直前保持チーム）が保持継続。ボールはコーナーアークへ
          team = prev.team;
          restart = { type: "corner", x: dirPrev * 52.3, y: side * 33.8, delay: 6 + 2.5 * N.hash2(seed, idx * 41 + 5) };
        } else if (inAttackHalf && rr < 0.72) {
          // ゴールキック: 守備側GKへ（守備側の自ゴール = dirPrev 方向の先）
          team = prev.team === plus ? minus : plus;
          restart = { type: "goalkick", x: dirPrev * 46.5, y: (rr < 0.63 ? 1 : -1) * 8, delay: 5 + 2 * N.hash2(seed, idx * 41 + 5), gk: true };
        } else {
          // スローイン: 保持チームはマルコフ抽選の結果どおり（拮抗）。ボールはライン上
          restart = {
            type: "throwin",
            x: clamp(prev.pos.x + (N.hash2(seed, idx * 43 + 3) * 10 - 5), -49, 49),
            y: side * 34.0, delay: 4 + 2 * N.hash2(seed, idx * 41 + 5),
          };
        }
        isTurnover = false;   // リスタートは接触奪取ではない
      }
      // ---- ゴール後キックオフ（#51）: 失点側が中央から再開・ボールはセンターにピン ----
      if (!restart && forced && forced.kickoff) {
        restart = { type: "kickoff", x: 0, y: 0, delay: Math.max(1.2, forced.t1 - t - 1.2) };
        isTurnover = false;
      }

      // ---- 保持者選定 ----
      // パス: 中距離カーネル（自己再抽選は除外 — 除外しないと保持の55%が同一選手に戻り、
      // 実質のパスがターンオーバー時にしか発生しない）。
      // 奪取: 前保持者の近傍（タックル/インターセプト = 接触点の近く）。
      // リスタート: 地点への近接で決定論選択（ジッターなし — WBがスローインを取る）。
      const roster = E.rosterAt(match, scenario, team, t);
      const shape = F.SHAPES[roster.shape];
      const half = E.halfOf(match, t);
      const dir = match.dir[team][half === 1 ? "h1" : "h2"];
      const align = Math.max(0, E.attackSign(match, team) * P);
      // 受け手参照点: コーナー直後はゴール前（クロスの落下点）/ リスタートは地点 / 通常は前保持者
      const ref = restart ? { x: restart.x, y: restart.y }
        : forceRef ? forceRef
        : (prev ? prev.pos : E.ballSlowAt(match, t));
      const kernel = restart ? 9 : forceRef ? 10 : isTurnover ? 6 : 14;
      let best = null, bestW = -1;
      for (const slot of shape) {
        const no = roster.assign[slot.id];
        if (no == null) continue;
        const entT = roster.entered[no];
        if (entT != null && t - entT < 35) continue;      // 入場走り込み中は除外
        if (restart) {
          if (restart.gk ? slot.role !== "GK" : slot.role === "GK") continue;
        } else if (forced && forced.no != null) {
          if (no !== forced.no) continue;                  // 台本指定選手のみ（自己継続=ドリブル）
        } else if (prev && team === prev.team && no === prev.no) {
          continue;                                        // 自己パス排除
        }
        const pos = basePosOf(match, scenario, team, no, slot, t);
        const d = Math.hypot(pos.x - ref.x, pos.y - ref.y);
        const progress = (dir * pos.x + HALF_W) / 105;    // 0=自陣奥 → 1=敵陣奥
        const w = restart
          ? Math.exp(-d / kernel)
          : Math.exp(-d / kernel)
            * (chainRoleW[slot.role] ?? 1)
            * (0.55 + 0.9 * N.hash2(seed, idx * 97 + no))
            * (1 + 0.55 * align * progress);
        if (w > bestW) { bestW = w; best = { team, no, slot, pos }; }
      }
      if (!best) { t += 4; idx++; continue; }
      // フライト（前保持者 → 新保持者 / リスタートは地点まで）
      let fDur = 0;
      if (prev) {
        const target = restart ? restart : best.pos;
        const d = Math.hypot(target.x - prev.pos.x, target.y - prev.pos.y);
        fDur = restart ? clamp(d / 18, 0.5, 1.4) : clamp(d / 16, 0.45, 1.3);
      }
      let hold = 2.4 + 4.2 * N.hash2(seed, idx * 53 + 7);
      // リスタートは「静止 → 投げる/蹴る」で区間終了 — 次のフライトがスロー/クロスになる
      // （旧実装はテイカーが通常ホールドを続け、自分にパスしたように見えた）
      if (restart) hold = restart.delay + 0.5 + 0.7 * N.hash2(seed, idx * 59 + 13);
      // 台本指定選手（独走等）は窓終端まで1本のホールド — 区間切替でu(保持確度)が
      // 波打つとボール吸着が緩んでドリブルが途切れて見える
      else if (forced && forced.no != null) hold = Math.max(hold, forced.t1 - (t + fDur) - 0.2);
      // カット時刻を跨がない（フライト中に交代/フェーズ境界が落ちる場合も打ち切る —
      // 跨ぐと交代でピッチを離れた選手が保持者として残る）
      let end = t + fDur + hold;
      for (const c of cuts) if (c > t + 0.3 && c < end) { end = c; break; }
      hold = Math.max(0.3, end - t - fDur);
      segs.push({
        t0: t, tf: t + fDur, t1: end,
        team: best.team, no: best.no, slot: best.slot,
        from: prev ? { team: prev.team, no: prev.no, slot: prev.slot } : null,
        restart: restart ? restart.type : null,
        // リスタート中のボール・ピン留め用（地点と静止時間）
        rx: restart ? restart.x : 0, ry: restart ? restart.y : 0,
        rdelay: restart ? Math.max(0.3, Math.min(hold - 0.4, restart.delay)) : 0,
      });
      // 次セグメントの拘束: スロー/GKは同チームの別選手へ、コーナーはゴール前へクロス
      forceTeam = null; forceRef = null;
      if (restart) {
        if (restart.type === "throwin" || restart.type === "goalkick" || restart.type === "kickoff")
          forceTeam = best.team;   // キックオフの蹴り出しは味方へ
        if (restart.type === "corner") {
          forceRef = { x: Math.sign(restart.x) * 44, y: restart.y >= 0 ? 3 : -3 };
        }
      }
      // ---- 再現アンカー（σは引き距離に比例 — ガウス窓速度 0.61·d/σ ≤ 3.2m/s を構成的に保証） ----
      if (restart) {
        const rx = clamp(restart.x, -52.1, 52.1), ry = clamp(restart.y, -33.6, 33.6);
        const dPull = Math.hypot(rx - best.pos.x, ry - best.pos.y);
        anchors.push({
          t: t + fDur + Math.min(hold, restart.delay) * 0.4,
          team: best.team, no: best.no, x: rx, y: ry,
          sigma: Math.max(3.5, dPull * 0.19),
        });
        // コーナーの密集: 攻撃4人がボックスへ・守備5人がマーク（クロスの競り合いの絵）
        if (restart.type === "corner") {
          const gx = Math.sign(restart.x) * HALF_W;
          const tCross = t + fDur + Math.min(hold, restart.delay) * 0.85;
          const crowd = (teamK, roles, nMax, atk) => {
            const ros = E.rosterAt(match, scenario, teamK, t);
            const shp = F.SHAPES[ros.shape];
            let placed = 0;
            for (const role of roles) {
              for (const sl of shp) {
                if (placed >= nMax) return;
                if (sl.role !== role) continue;
                const pno = ros.assign[sl.id];
                if (pno == null || (teamK === best.team && pno === best.no)) continue;
                const pos = basePosOf(match, scenario, teamK, pno, sl, t);
                const jx = N.hash2(seed, idx * 131 + pno) - 0.5;
                const jy = N.hash2(seed, idx * 137 + pno) - 0.5;
                const ax = gx - Math.sign(gx) * (atk ? 6.5 + Math.abs(jx) * 7 : 4.5 + Math.abs(jx) * 6);
                const ay = clamp(jy * (atk ? 17 : 15), -14, 14);
                const dp = Math.hypot(ax - pos.x, ay - pos.y);
                anchors.push({ t: tCross, team: teamK, no: pno, x: ax, y: ay, sigma: Math.max(3.5, dp * 0.19) });
                placed++;
              }
            }
          };
          crowd(best.team, ["ST", "AM", "CB", "W", "CM"], 4, true);
          crowd(best.team === plus ? minus : plus, ["CB", "FB", "DM", "WB", "CM"], 5, false);
        }
      } else if (isTurnover && !inCalm(t)) {
        // タックル/インターセプト: 奪取者が接触点へ収束（引き距離は9m以内に制限）
        let cx = prev.pos.x, cy = prev.pos.y;
        const d = Math.hypot(cx - best.pos.x, cy - best.pos.y);
        if (d > 9) { const u9 = 9 / d; cx = best.pos.x + (cx - best.pos.x) * u9; cy = best.pos.y + (cy - best.pos.y) * u9; }
        anchors.push({ t, team: best.team, no: best.no, x: cx, y: cy, sigma: 2.4 });
      }
      prev = best;
      // 次セグメントの参照位置を保持者のホールド終了時位置へ更新
      prev.pos = restart
        ? { x: clamp(restart.x, -52.1, 52.1), y: clamp(restart.y, -33.6, 33.6) }
        : basePosOf(match, scenario, best.team, best.no, best.slot, Math.min(end, range.t1 - 0.5));
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
    const chain = { segs, plus, minus, anchors };
    chainCache.set(key, chain);
    return chain;
    } finally { chainBuilding = false; }
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

  // 保持者情報: {team, no, u(確度0..1), mode:"hold"|"flight", seg, restart}
  E.carrierAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const chain = buildChain(match, scenario);
    const s = segAt(chain, t);
    if (!s) return null;
    if (t < s.tf) {
      const u = N.smooth(clamp((t - s.t0) / Math.max(0.001, s.tf - s.t0)));
      return { team: s.team, no: s.no, u, mode: "flight", seg: s, restart: s.restart || null };
    }
    // 両端フルランプ（プレッサー引力の連続性 = 速度上限の保証に必須）
    const uIn = N.smooth(clamp((t - s.tf) / 0.6));
    const uOut = N.smooth(clamp((s.t1 - t) / 0.6));
    return { team: s.team, no: s.no, u: uIn * uOut, mode: "hold", seg: s, restart: s.restart || null };
  };

  // チェーン品質統計（テスト・検証用）: 連続保持・ターンオーバー・リスタート数
  E.chainStats = (match, scenario) => {
    scenario = scenario || E.actualScenario(match);
    const chain = buildChain(match, scenario);
    const out = {
      segments: chain.segs.length, turnovers: 0, selfConsecutive: 0, passes: 0,
      restarts: { throwin: 0, corner: 0, goalkick: 0 },
      runs: {},
    };
    for (const k of E.teamKeys(match)) out.runs[k] = [];
    let run = null;
    for (let i = 0; i < chain.segs.length; i++) {
      const s = chain.segs[i], p = chain.segs[i - 1];
      if (s.restart) out.restarts[s.restart]++;
      if (p) {
        if (p.team !== s.team) { if (!s.restart) out.turnovers++; }
        else if (p.no === s.no) out.selfConsecutive++;
        else if (!s.restart) out.passes++;
      }
      if (!run || run.team !== s.team) {
        if (run) out.runs[run.team].push(run.n);
        run = { team: s.team, n: 0 };
      }
      run.n++;
    }
    if (run) out.runs[run.team].push(run.n);
    for (const k of E.teamKeys(match)) {
      const rs = out.runs[k];
      out.runs[k] = {
        count: rs.length,
        avg: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
        max: rs.length ? Math.max(...rs) : 0,
      };
    }
    return out;
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

  // 現在の連続保持シーケンス（同一チームのチェーン連続区間 / Issue #14）
  // 返値: { team, t0(シーケンス開始), passes(この流れの保持者数) } / チェーン外は null
  E.sequenceAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const chain = buildChain(match, scenario);
    const s = segAt(chain, t);
    if (!s) return null;
    const segs = chain.segs;
    let lo = 0, hi = segs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (segs[m].t0 <= t) lo = m; else hi = m; }
    let i = segs[lo] === s ? lo : hi;
    let i0 = i;
    while (i0 > 0 && segs[i0 - 1].team === s.team) i0--;
    return { team: s.team, t0: segs[i0].t0, passes: i - i0 + 1 };
  };

  // パスネットワーク（Issue #11）: 保持チェーンの同一チーム連続遷移を「パス」と数える。
  // モデル生成チェーン由来の推定であり、実パス記録ではない（表示側で明示すること）。
  const pnetCache = new Map();
  E.passNetwork = (match, scenario, upTo) => {
    scenario = scenario || E.actualScenario(match);
    const key = `${match.meta.id}|${E.scenarioKey(scenario)}|${Math.round(upTo / 30)}`;
    if (pnetCache.has(key)) return pnetCache.get(key);
    const chain = buildChain(match, scenario);
    const out = {};
    for (const k of E.teamKeys(match)) out[k] = { edges: new Map(), degree: new Map(), total: 0 };
    for (const s of chain.segs) {
      if (s.t0 > upTo) break;
      if (!s.from || s.from.team !== s.team) continue;
      if (s.from.no === s.no) continue;         // 自己継続（ドリブル）はパスに数えない
      if (s.restart) continue;                  // リスタートはパスに数えない
      const T = out[s.team];
      const ek = `${s.from.no}>${s.no}`;
      T.edges.set(ek, (T.edges.get(ek) || 0) + 1);
      T.degree.set(s.from.no, (T.degree.get(s.from.no) || 0) + 1);
      T.degree.set(s.no, (T.degree.get(s.no) || 0) + 1);
      T.total++;
    }
    // 表示用: 上位ペア（方向統合）と次数中心性（正規化）
    for (const k of E.teamKeys(match)) {
      const T = out[k];
      const und = new Map();
      for (const [ek, n] of T.edges) {
        const [a, b] = ek.split(">").map(Number);
        const uk = a < b ? `${a}-${b}` : `${b}-${a}`;
        und.set(uk, (und.get(uk) || 0) + n);
      }
      T.pairs = [...und.entries()]
        .map(([uk, n]) => { const [a, b] = uk.split("-").map(Number); return { a, b, n }; })
        .sort((x, y) => y.n - x.n);
      T.central = [...T.degree.entries()]
        .map(([no, dg]) => ({ no, c: T.total ? dg / (2 * T.total) : 0 }))
        .sort((x, y) => y.c - x.c);
    }
    pnetCache.set(key, out);
    return out;
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
    // フライト所要時間の下限（#50）: 窓が短くても距離/速度上限より速く飛ばない。
    // 未到達ならホールド/ピン窓へ連続に持ち越す（C0 — 瞬間移動を根絶）。
    // リスタートは「運搬」なので遅め(12m/s)、通常パスは強いパス上限(24m/s)。
    // 発進点 = 前セグメントの「実ボール位置」（1段だけ再帰）— 前フライトがカットで
    // 分断されても、次フライトは実位置から発進する（全境界でC0）。
    const posOf = (seg, tt, depth) => {
      let travelT = 0, src = null;
      if (seg.from) {
        const prevSeg = depth < 1 ? segAt(chain, seg.t0 - 0.01) : null;
        src = (prevSeg && prevSeg !== seg)
          ? posOf(prevSeg, seg.t0, depth + 1)
          : holderPos({ team: seg.from.team, no: seg.from.no, slot: seg.from.slot }, seg.t0);
        const b0 = seg.restart ? { x: seg.rx, y: seg.ry } : holderPos(seg, seg.t0);
        const vcap = seg.restart ? 12 : 24;
        travelT = Math.max(seg.tf - seg.t0, Math.hypot(b0.x - src.x, b0.y - src.y) / vcap, 0.001);
      }
      const inTransit = seg.from && (tt - seg.t0) < travelT;
      if (!inTransit) {
        // 到達済み: リスタートはピン静止 → 保持者の足元へスムーズ復帰。
        // 解放ブレンドはセグメント終端までに必ず完了させる（#50）
        if (seg.restart && tt >= seg.tf) {
          const relT = Math.max(0.25, Math.min(1.2, (seg.t1 ?? Infinity) - (seg.tf + seg.rdelay)));
          const uOut = N.smooth(clamp((tt - (seg.tf + seg.rdelay)) / relT));
          if (uOut < 1) {
            const p = holderPos(seg, tt);
            return { x: lerp(seg.rx, p.x, uOut), y: lerp(seg.ry, p.y, uOut), z: 0.11 };
          }
        }
        const p = holderPos(seg, tt);
        return { x: p.x, y: p.y, z: 0.11 + 0.05 * Math.abs(N.vnoise1(9917, tt, 1.7)) };
      }
      // フライト: 発進点(固定) → 受け手位置(tt) / リスタートは地点へ
      const u = N.smooth(clamp((tt - seg.t0) / travelT));
      const b = (seg.restart && tt <= seg.tf + seg.rdelay) ? { x: seg.rx, y: seg.ry } : holderPos(seg, tt);
      const dist = Math.hypot(b.x - src.x, b.y - src.y);
      const zArc = dist > 17 ? Math.sin(Math.PI * u) * Math.min(2.4, dist * 0.07) : Math.sin(Math.PI * u) * 0.25;
      return { x: lerp(src.x, b.x, u), y: lerp(src.y, b.y, u), z: 0.11 + zArc };
    };
    return posOf(s, t, 0);
  };

  /* ---- ボール物理（#46・決定論・閉形式・スクラブ完全一致） ----
     反発バウンド: 飛球は接地で反発係数 e により高さを失いながら跳ねる。
     正規化時刻 u∈[0,1] を幾何級数のホップ（各ホップは放物線）に分割して高さを与える。
     マグヌス曲がり: 速い飛球に飛行方向直交の弓なりオフセット（横ズレ = カーブ）。
     いずれもアンカー端点（x,y の目標）は保存し、区間内の見えを豊かにする。 */
  const BALL_PHYS = { REST: 0.52, MAX_BOW: 1.4, BOW_K: 0.012, HOPS: 3, LOFT_H: 2.2 };
  const bounceHeight = (u, h, e, hops) => {
    let acc = 0;
    for (let k = 0; k < hops; k++) {
      const d = (k === hops - 1) ? (1 - acc) : (1 - e) * Math.pow(e, k);   // 最終ホップが残りを吸収
      if (u <= acc + d || k === hops - 1) {
        const tau = d > 1e-9 ? clamp((u - acc) / d) : 0;
        const hk = h * Math.pow(e, 2 * k);                                 // 反発でピーク高が e² 減衰
        return 0.11 + 4 * hk * tau * (1 - tau);                            // 放物線（τ=0.5 で頂点）
      }
      acc += d;
    }
    return 0.11;
  };
  E.ballBounceHeight = bounceHeight;   // テスト・検証用（純関数）
  E.BALL_PHYS = BALL_PHYS;

  // 後方互換: E.ballAt(match, t) / E.ballAt(match, scenario, t)
  // 返値の free ∈ [0,1]: 1=チェーン駆動（保持者の足元）/ 0=アンカー駆動（得点再現等）。
  // stateAt はこれを使い、ホールド中のボールを描画済み保持者位置へ吸着させる。
  E.ballAt = (match, a, b) => {
    let scenario, t;
    if (typeof a === "number") { t = a; scenario = b || E.actualScenario(match); }
    else { scenario = a || E.actualScenario(match); t = b; }
    const track = buildBallTrack(match, scenario);
    const n = track.length;
    let pos, segLen = 0, segSpeed = 0, zChain = null, free = 0;
    if (n === 0) { const f = chainBall(match, scenario, t); return { ...f, free: 1 }; }
    if (t <= track[0].t) pos = { x: track[0].x, y: track[0].y };
    else if (t >= track[n - 1].t) {
      const f = chainBall(match, scenario, t), a2 = track[n - 1];
      const u = N.smooth(clamp((t - a2.t) / 12));
      pos = { x: lerp(a2.x, f.x, u), y: lerp(a2.y, f.y, u) };
      zChain = f.z;
      free = u;
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
          free = u;
        } else if (t > b2.t - W) {
          const u = N.smooth((b2.t - t) / W);
          pos = { x: lerp(b2.x, f.x, u), y: lerp(b2.y, f.y, u) };
          free = u;
        } else { pos = f; free = 1; }
        zChain = f.z;
        segSpeed = 0; segLen = 0;
      }
    }
    // 高さ + マグヌス曲がり: 速い飛球はバウンド放物線 + 横カーブ、通常は転がり
    let z, ox = 0, oy = 0;
    if (zChain != null) z = zChain;
    else if (segLen > 14 && segSpeed > 7) {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (track[m].t <= t) lo = m; else hi = m; }
      const a2 = track[lo], b2 = track[hi];
      const u = clamp((t - a2.t) / ((b2.t - a2.t) || 1));
      const h = Math.min(3.2, segLen * (segSpeed > 16 ? 0.03 : 0.12));
      const hops = h > BALL_PHYS.LOFT_H ? 1 : BALL_PHYS.HOPS;   // ロフト=単アーク / 低い弾道=バウンド
      z = bounceHeight(u, h, BALL_PHYS.REST, hops);
      // マグヌス: 飛行方向直交の弓なり（回転符号はセグメント決定・端点は不変）
      const dx = (b2.x - a2.x) / segLen, dy = (b2.y - a2.y) / segLen;
      const spin = N.hash2(N.seedOf(match.meta.id + "spin"), lo) < 0.5 ? -1 : 1;
      const bow = spin * Math.min(BALL_PHYS.MAX_BOW, segLen * BALL_PHYS.BOW_K) * Math.sin(Math.PI * u);
      ox = -dy * bow; oy = dx * bow;
    } else {
      z = 0.11 + 0.05 * Math.abs(N.vnoise1(9917, t, 1.7));
    }
    return { x: pos.x + ox, y: pos.y + oy, z, free };
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
    const y = dir * my * HALF_H * 0.97;   // タッチライン際まで使う（WB/Wで|y|≈29+ノイズ）
    return { x, y };
  };

  E.fatigueOf = (match, scenario, team, no, t) => {
    const pr = E.presenceOf(match, scenario, team, no);
    if (!pr || t < pr.from) return 0;
    const mins = (Math.min(t, pr.to) - pr.from) / 60;
    const sta = E.attrsOf(match, scenario, team, no).sta;
    return clamp((mins / 95) * (1.45 - (sta / 100) * 0.75));
  };

  /* ---- ラン保護窓（#30）: 記録イベント近傍でオフボールランを止める（縁4sスムーズ） ---- */
  const protectCache = new Map();
  const runProtectAt = (match, scenario, t) => {
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    let wins = protectCache.get(key);
    if (!wins) {
      wins = [];
      for (const ev of E.eventsOf(match, scenario)) {
        if (ev.type === "goal") wins.push({ a: ev.t - 32, b: ev.t + 3 });
        else if (ev.type === "shot" || ev.type === "save") wins.push({ a: ev.t - 16, b: ev.t + 2 });
      }
      if (protectCache.size > 40) protectCache.clear();
      protectCache.set(key, wins);
    }
    let g = 0;
    for (const w of wins) {
      if (t < w.a - 4 || t > w.b + 4) continue;
      const inn = (t >= w.a && t <= w.b) ? 1
        : t < w.a ? N.smooth((t - (w.a - 4)) / 4) : N.smooth(((w.b + 4) - t) / 4);
      if (inn > g) g = inn;
    }
    return g;
  };

  /* 基礎位置（純関数・ボール実位置に非依存 — チェーン生成の土台） */
  const basePlayerPos = (match, scenario, team, no, slot, t, bctx) => {
    const { half, dir, P, ballS } = bctx;   // half はFK/セットピース処理で使用
    const role = slot.role;
    const g0 = E.attackSign(match, team) * P;                 // 自チーム攻勢度
    const g = clamp(g0 + 0.12 * N.vnoise1(N.seedOf(team + "g"), t, 53), -1, 1);
    const tw = E.tweakOf(scenario, team, slot.id);

    // 1) フォーメーション・スロット（攻守モーフ + 配置微調整）
    let { x, y } = slotWorld(slot, g, dir, tw);

    // スタミナ→行動フィードバック（#44）: 疲労は走行頻度だけでなく
    // 「ブロック追従・集団サージ・プレス・ラン」の強度を落とす（終盤の質的変化）。
    // 交代のフレッシュな脚は fatigueOf が presence 起点なので自然に回復する。
    const fat = E.fatigueOf(match, scenario, team, no, t);

    // 2) ブロック連動（平滑ボールへスライド — 守備ブロックの本質・疲労で緩む=ライン間延び）
    const cw = (F.chaseWeight[role] ?? 0.3) * (1 - 0.22 * fat);
    x += (ballS.x - x * 0.2) * cw * 0.55;
    y += (ballS.y - y * 0.25) * cw * 0.75;

    // 2.5) 集団サージ（カウンター/ビルドアップの「勢い」）:
    // ポゼッション基調波の微分 dP/dt で、攻勢転換時は全体が押し上がり、
    // 喪失時は全体が一斉に撤退する。ノイズを除いたスプライン差分＝純関数・低速率。
    {
      const dPs = (N.spline(match.possessionKP, t + 2)[0] - N.spline(match.possessionKP, t - 2)[0]) / 4;
      const myTrend = E.attackSign(match, team) * dPs;   // >0: 自チームへ流れが来ている
      if (Math.abs(myTrend) > 0.004) {
        const S_ATK = { GK: 0.05, CB: 0.35, FB: 0.6, WB: 0.75, DM: 0.7, CM: 0.85, AM: 1.0, W: 1.0, ST: 1.0 };
        const S_DEF = { GK: 0.05, CB: 0.9, FB: 1.0, WB: 1.0, DM: 1.0, CM: 0.95, AM: 0.8, W: 0.8, ST: 0.55 };
        const scale = (myTrend > 0 ? (S_ATK[role] ?? 0.7) : (S_DEF[role] ?? 0.8)) * (1 - 0.3 * fat);
        x += dir * clamp(180 * myTrend, -7, 7) * scale;
      }
    }

    // 2.6) 協調ラインコントロール（#27）: 最終ライン(CB/FB/WB)を合意 x へ同期させ、
    // 「1枚のラインとして」上下動させる。lineComputing 中は無効（再帰回避）。
    if (!lineComputing && LINE_ROLES[role]) {
      const line = E.defensiveLineAt(match, scenario, team, t);
      x = lerp(x, line.lineX, LINE_SYNC);
    }

    // 2.7) 意図的オフボールラン（#30）— すべて連続ゲート（速度上限を破らない）
    // 記録イベント（ゴール/ショット/セーブ）窓は保護: 較正済みの再現局面を乱さない
    // (a) オーバーラップ: 攻勢×ボールが自分のサイド×前進局面で、FB/WB がボールを
    //     追い越して幅を取る（後方からの追い越しラン）
    // (b) 裏抜け: ST/W/AM が相手最終ライン（オフサイド境界）の手前 0.8m まで depth を
    //     取る。周期ノイズで「繰り返しのラン」（張り付きではなく出入り）
    if (!lineComputing && !chainBuilding) {
      // chainBuilding 中は無効: ランは「表示上の走り」であり、保持列の選定
      //（=較正済みの世界）を変えてはならない
      const gAtk = N.smooth(clamp(g0 * 2.2)) * (1 - runProtectAt(match, scenario, t)) * (1 - 0.4 * fat);
      const progBall = (dir * ballS.x + HALF_W) / 105;             // ボール前進度 0..1
      if (gAtk > 0.02 && (role === "FB" || role === "WB")) {
        const sameFlank = N.smooth(clamp((ballS.y * Math.sign(y || 1)) / 16));
        const wOv = gAtk * sameFlank * N.smooth(clamp((progBall - 0.5) / 0.14));
        if (wOv > 0.02) {
          x += dir * 5 * wOv;                                      // ボールの先へ
          y += Math.sign(y || 1) * 2 * wOv;                        // タッチライン側へ幅
        }
      }
      if (gAtk > 0.02 && (role === "ST" || role === "W" || role === "AM")) {
        const roleW = role === "ST" ? 1 : role === "W" ? 0.8 : 0.5;
        const pulse = 0.5 + 0.5 * N.vnoise1(N.seedOf(team + no + "run"), t, 23);  // 繰り返しのラン
        const wRib = gAtk * roleW * Math.max(0, pulse)
          * N.smooth(clamp((progBall - 0.42) / 0.16));
        if (wRib > 0.02) {
          const off = E.offsideLineAt(match, scenario, team, t);
          // 境界の手前まで（ただしGK域=ゴール前8mへは走り込まない・引き距離は8mまで）
          const targetDepth = Math.min(off.offsideDepth - 0.8, HALF_W - 8);
          const gap = clamp(targetDepth - dir * x, 0, 8);
          x += dir * gap * 0.4 * wRib;
        }
      }
    }

    // 3) 個体ノイズ（帯域制限・疲労で減衰）
    const amp = (F.noiseAmp[role] ?? 7) * (1 - 0.35 * fat);
    const ps = N.seedOf(match.meta.id + team + no);
    x += N.fbm1(ps, t, [
      { amp: amp * 0.5, period: 42 }, { amp: amp * 0.42, period: 14 },
      { amp: amp * 0.5, period: 5.6 }, { amp: amp * 0.28, period: 3.1 }]);
    y += N.fbm1(ps + 77, t, [
      { amp: amp * 0.55, period: 39 }, { amp: amp * 0.42, period: 13 },
      { amp: amp * 0.5, period: 5.3 }, { amp: amp * 0.28, period: 3.0 }]);

    // 4) GK 守備幾何則（#31）: 角度圧縮 + スイーパー飛び出し。
    //    ボール→ゴールの二等分線上に立ち（角を狭める）、至近/自陣深部ほど前へ出る。
    //    純関数（ballS のみ依存）で speedKmh/軌跡と完全整合・帯域制限で速度上限を保つ。
    if (role === "GK") {
      const gx = -dir * HALF_W;                              // 自ゴール
      const bx = ballS.x, by = ballS.y;
      const dGoal = Math.hypot(gx - bx, by) || 1;            // ボール〜自ゴール距離
      const prog = dir * bx + HALF_W;                        // 0=自ゴール … 105=敵ゴール
      const closeness = clamp(1 - dGoal / 62);               // 至近ほど前へ（角度圧縮）
      // スイーパー: ボールが自陣深く近い＝ハイライン背後想定 → さらに飛び出す
      const sweep = N.smooth(clamp((30 - prog) / 22)) * N.smooth(clamp((55 - dGoal) / 30));
      let depth = 1.8 + 7.5 * closeness + 7 * sweep;         // ライン際1.8m 〜 最大 ~16m
      depth = Math.min(depth, Math.max(0.6, dGoal - 1.2));  // ボールを追い越さない（ネット内でも負にしない）
      const ux = (bx - gx) / dGoal, uy = by / dGoal;         // ゴール→ボールの単位ベクトル
      x = gx + ux * depth;                                   // 二等分線上（角を狭める）
      y = uy * depth;
      x += dir * 0.8 * Math.abs(N.fbm1(ps + 301, t, [{ amp: 1.3, period: 15 }, { amp: 0.6, period: 5.0 }]));
      y += N.fbm1(ps, t, [{ amp: 0.5, period: 11 }, { amp: 0.4, period: 4.5 }]);
      y = clamp(y, -8, 8);
    }

    // 5) イベント・アンカー（得点再現など — ガウス窓・シナリオ実効）
    // sigmaL/sigmaR で非対称窓: 到達を鋭く・解放を緩やかに（またはその逆）できる。
    // 対称ガウスだと「シュート後の受け」が時間を遡って走路を先食いしてしまう。
    for (const a of playerAnchorsOf(match, scenario)) {
      if (a.team !== team || a.no !== no) continue;
      const sg = t < a.t ? (a.sigmaL ?? a.sigma ?? 6) : (a.sigmaR ?? a.sigma ?? 6);
      const w = N.gauss(t, a.t, sg);
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

    // 6.5) 直接FK（警告イベント）: 攻撃ゴール38m以内なら守備側が壁・攻撃側がボール周辺へ
    for (const ev of E.eventsOf(match, scenario)) {
      if (ev.type !== "yellow" || !ev.team) continue;
      const dtEv = t - ev.t;
      if (dtEv < 1 || dtEv > 20) continue;
      const spot = trackPosNear(match, scenario, ev.t + 2);
      if (!spot) continue;
      const atkTeam = E.oppOf(match, ev.team);            // 被ファウル側が蹴る
      const dirA = match.dir[atkTeam][half === 1 ? "h1" : "h2"];
      const gxF = dirA * HALF_W;
      const dGoal = Math.hypot(gxF - spot.x, spot.y);
      if (dGoal > 38 || dGoal < 6) continue;
      const wWin = N.smooth(clamp((dtEv - 1) / 9)) * (1 - N.smooth(clamp((dtEv - 14) / 6)));
      if (wWin < 0.02) continue;
      const ux = (gxF - spot.x) / dGoal, uy = (0 - spot.y) / dGoal;
      if (team === ev.team && (role === "CB" || role === "DM" || role === "CM")) {
        // 壁: スポットから9.15m、シュートコース上に横並び
        const lane = ((N.hash2(N.seedOf(team + no), ev.t | 0) * 4) | 0) - 1.5;
        const wx = spot.x + ux * 9.15 - uy * lane * 0.75;
        const wy = spot.y + uy * 9.15 + ux * lane * 0.75;
        x = lerp(x, wx, wWin * 0.9); y = lerp(y, wy, wWin * 0.9);
      } else if (team === atkTeam && (role === "ST" || role === "AM")) {
        const s2 = N.hash2(N.seedOf(team + no), (ev.t | 0) + 7) * 2 - 1;
        x = lerp(x, spot.x - ux * 2.2 + s2, wWin * 0.6);
        y = lerp(y, spot.y - uy * 2.2 + s2 * 2, wWin * 0.6);
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

    // 8) 再開（キックオフ）整列 — 全員自陣（競技規則）。
    // 台形窓: rt−10 から集合を始め、rt+2.5 まで**保持**してから解放 —
    // 「帰陣が終わる前に試合が始まる」のを構成的に防ぐ（ボール側も hold 6s）。
    for (const rt of restartWindows(match, scenario)) {
      if (t < rt - 13 || t > rt + 12) continue;
      const inU = N.smooth(clamp((t - (rt - 12)) / 9));
      const outU = 1 - N.smooth(clamp((t - (rt + 2.5)) / 8));
      const w = Math.min(inU, outU);
      if (w > 0.01) {
        const base = slotWorld(slot, -0.05, dir, tw);
        if (dir > 0) base.x = Math.min(base.x, -0.8);
        else base.x = Math.max(base.x, 0.8);
        x = lerp(x, base.x, w * 0.94); y = lerp(y, base.y, w * 0.94);
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

    // GK: 実ボール角へ微補正（#31・base の角度圧縮を実ボールで研ぐ・帯域内）
    // ※深度は base（平滑ボール基準）に委ねる。シュートは GK を置き去りにし得るため
    //   実ボールへの深度クランプはしない（速度上限を破らないための設計）。
    if (slot.role === "GK" && ball) {
      const gx = -ctx.dir * HALF_W;
      const dG = Math.hypot(gx - ball.x, ball.y) || 1;
      const depth = Math.hypot(gx - x, y);                  // 現在の飛び出し量
      const ty = clamp((ball.y / dG) * depth, -8, 8);       // 実ボール二等分線の横位置
      y = lerp(y, ty, 0.45);
    }

    // プレッシング: 相手保持者への寄せ（階層化 — 最近接は強く速く、2番手はカバー）
    // 立ち上がりを1.4sに緩めた uPress で強い重みでも速度上限を構成的に維持する。
    const c = ctx.carrier;
    if (c && c.mode === "hold" && c.team !== team && slot.role !== "GK" && ctx.carrierPos) {
      const cp = ctx.carrierPos;
      const d = Math.hypot(cp.x - x, cp.y - y);
      const rank = ctx.pressRank ? ctx.pressRank.ranks.get(no) : undefined;
      // トリガ（#29）: 相手のビルドアップで自チームのプレスが点灯（連続 level）
      const trig = ctx.trigger && ctx.trigger.team === team ? ctx.trigger.level : 0;
      let wBase = 0.22, sig = 10;
      if (rank === 0) { wBase = 0.52 + 0.14 * trig; sig = 7.5 + 3 * trig; }    // 1st: 密着（トリガで増圧）
      else if (rank === 1) { wBase = 0.32 + 0.12 * trig; sig = 9 + 6 * trig; }  // 2nd: カバー（トリガで遠くから連動）
      else if (rank === 2) { wBase = 0.22 + 0.16 * trig; sig = 10 + 5 * trig; } // 3rd: トリガで連動
      const gate = Math.exp(-(d * d) / (2 * sig * sig));
      // 疲労でプレス強度が落ちる（#44・終盤は寄せ切れない）
      const fatP = E.fatigueOf(match, scenario, team, no, ctx.t);
      wBase *= (1 - 0.35 * fatP);
      let uPress = Math.min(c.u, N.smooth(clamp((ctx.t - c.seg.tf) / 1.4)));
      // キックオフ（#51）: ピン中は相手に寄せない（競技規則: 相手はセンターサークル外）。
      // 蹴り出し後に通常ランプで再開 → 窓境界の目標ジャンプによる速度スパイクも消える
      if (c.seg && c.seg.restart === "kickoff") {
        uPress = Math.min(uPress, N.smooth(clamp((ctx.t - (c.seg.tf + c.seg.rdelay)) / 2.2)));
      }
      const w = wBase * gate * uPress;
      if (w > 0.003) {
        // 寄せ位置: 保持者の自ゴール側（1st=0.9m密着 / 他=1.6m）
        const near = rank === 0 ? 0.9 : 1.6;
        const gx = -ctx.dir * HALF_W;
        const gl = Math.hypot(gx - cp.x, 0 - cp.y) || 1;
        let px = cp.x + ((gx - cp.x) / gl) * near;
        let py = cp.y + ((0 - cp.y) / gl) * near;
        // カバーシャドウ（#29）: トリガ中の2ndは保持者→支援重心のレーン上へ
        //（パスコースを消す）。trig 連続 → 目標も連続
        if (rank === 1 && ctx.pressRank.shadow) {
          const sh = ctx.pressRank.shadow;
          const uSh = Math.min(1, trig * 1.5);
          px = lerp(px, lerp(cp.x, sh.x, 0.4), uSh);
          py = lerp(py, lerp(cp.y, sh.y, 0.4), uSh);
        }
        x = lerp(x, px, w);
        y = lerp(y, py, w);
      }
    }

    // 相互分離（#28）: ランダムな重なりを解消する斥力変位（基礎位置から算出済み）
    if (ctx.sep) {
      const sp = ctx.sep.get(team + ":" + no);
      if (sp) { x += sp.dx; y += sp.dy; }
    }

    x = clamp(x, -HALF_W + 0.4, HALF_W - 0.4);
    y = clamp(y, -HALF_H + 0.4, HALF_H - 0.4);
    return { x, y };
  };

  /* ---------------- プレスランク（保持者への近さ順・純関数+memo） ---------------- */
  // 最近接=ファーストプレッサー/2番手=カバー。stateAt と stateFrozenPos の両方で
  // 同一値を使うこと（f(t) の一意性 — 速度・軌跡・走行距離の整合に必須）。
  const rankCache = new Map();
  const pressRankAt = (match, scenario, t, carrier, carrierPos) => {
    if (!carrier || carrier.mode !== "hold" || !carrierPos) return null;
    const key = match.meta.id + "|" + E.scenarioKey(scenario) + "|" + t;
    const hit = rankCache.get(key);
    if (hit !== undefined) return hit;
    const oppTeam = E.teamKeys(match).find(k => k !== carrier.team);
    const roster = E.rosterAt(match, scenario, oppTeam, t);
    const shape = F.SHAPES[roster.shape];
    const ds = [];
    for (const slot of shape) {
      if (slot.role === "GK") continue;
      const no = roster.assign[slot.id];
      if (no == null) continue;
      const p = basePosOf(match, scenario, oppTeam, no, slot, t);
      ds.push({ no, d: Math.hypot(p.x - carrierPos.x, p.y - carrierPos.y) });
    }
    ds.sort((a, b) => a.d - b.d || a.no - b.no);
    const m = new Map();
    ds.forEach((e, i) => m.set(e.no, i));
    // カバーシャドウの遮断対象（#29）: 保持者の支援味方の「連続な重心」
    // （最寄り1人だと支援者の入替で目標が跳ぶ → exp(-d/6) 重み付き重心で連続化）
    let shadow = null;
    {
      const rosterOwn = E.rosterAt(match, scenario, carrier.team, t);
      const shapeOwn = F.SHAPES[rosterOwn.shape];
      let sx = 0, sy = 0, sw = 0;
      for (const slot of shapeOwn) {
        if (slot.role === "GK") continue;
        const no2 = rosterOwn.assign[slot.id];
        if (no2 == null || no2 === carrier.no) continue;
        const p = basePosOf(match, scenario, carrier.team, no2, slot, t);
        const w = Math.exp(-Math.hypot(p.x - carrierPos.x, p.y - carrierPos.y) / 6);
        sx += p.x * w; sy += p.y * w; sw += w;
      }
      if (sw > 1e-9) shadow = { x: sx / sw, y: sy / sw };
    }
    const out = { ranks: m, shadow };
    if (rankCache.size > 8000) rankCache.clear();
    rankCache.set(key, out);
    return out;
  };

  /* ---------------- プレッシング・トリガ（#29・読み取り可・純関数） ---------------- */
  // 保持チームが自陣1/3でビルドアップしている局面で、相手の協調プレスが点灯する。
  // level は ballSlow に連続 → プレス強化も連続（速度上限を破らない）。
  E.pressTriggerAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const c = E.carrierAt(match, scenario, t);
    if (!c || c.mode !== "hold" || (c.seg && c.seg.restart)) return null;
    const half = E.halfOf(match, t);
    const dirH = match.dir[c.team][half === 1 ? "h1" : "h2"];
    const bs = E.ballSlowAt(match, t);
    const prog = dirH * bs.x + HALF_W;                 // 保持チームの前進度 0..105
    const level = N.smooth(clamp((42 - prog) / 18));   // 自陣~40%で点灯・連続
    if (level <= 0.02) return null;
    return { team: E.oppOf(match, c.team), level };
  };

  /* ---------------- 相互分離（#28・社会力の斥力項・純関数+memo） ---------------- */
  // 全選手の「基礎位置」から対毎の斥力変位を決定論算出し、playerPos が加算する。
  // 意図的な近接（プレス密着0.9m・タックル収束・祝祭）は基礎位置の後段で作られる
  // ため影響せず、ランダムな重なり（選手同士のすり抜け）だけを解消する。
  // stateAt / stateFrozenPos の両方で同一値を使うこと（f(t) の一意性）。
  const sepCache = new Map();
  const SEP_R = 1.5, SEP_K = 0.5, SEP_MAX = 0.8;
  const separationAt = (match, scenario, t) => {
    const key = match.meta.id + "|" + E.scenarioKey(scenario) + "|" + t;
    const hit = sepCache.get(key);
    if (hit !== undefined) return hit;
    const pts = [];
    for (const team of E.teamKeys(match)) {
      const roster = E.rosterAt(match, scenario, team, t);
      const shape = F.SHAPES[roster.shape];
      for (const slot of shape) {
        const no = roster.assign[slot.id];
        if (no == null) continue;
        const p = basePosOf(match, scenario, team, no, slot, t);
        pts.push({ k: team + ":" + no, x: p.x, y: p.y });
      }
    }
    const disp = new Map();
    const add = (k, dx, dy) => {
      const d = disp.get(k) || { dx: 0, dy: 0 };
      d.dx += dx; d.dy += dy; disp.set(k, d);
    };
    // 空間ハッシュ（#39）: セル4m（> SEP_R）に登録し、近傍9セルの候補ペアだけ評価。
    // 候補は (i,j) 昇順で処理 = 従来の全ペア走査と同じ加算順序（ビット同一）
    const CELL = 4;
    const grid = new Map();
    for (let i = 0; i < pts.length; i++) {
      const ck = ((pts[i].x / CELL) | 0) + ":" + ((pts[i].y / CELL) | 0);
      (grid.get(ck) || grid.set(ck, []).get(ck)).push(i);
    }
    const candidates = [];
    for (const [ck, idxs] of grid) {
      const [cx, cy] = ck.split(":").map(Number);
      for (const i of idxs) {
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
          const nb = grid.get((cx + ox) + ":" + (cy + oy));
          if (!nb) continue;
          for (const j of nb) if (j > i) candidates.push(i * 64 + j);
        }
      }
    }
    candidates.sort((a, b) => a - b);
    let prev = -1;
    for (const c of candidates) {
      if (c === prev) continue;   // 重複除去（同一ペアが複数セル走査で出得る）
      prev = c;
      const i = (c / 64) | 0, j = c % 64;
      const a = pts[i], b = pts[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= SEP_R) continue;
      if (d < 1e-6) { dx = 1; dy = 0; }                    // 完全一致は決定論の固定軸
      else { dx /= d; dy /= d; }
      const f = SEP_K * (SEP_R - d);                       // 接触ゼロ・境界C0
      add(a.k, -dx * f, -dy * f); add(b.k, dx * f, dy * f);
    }
    for (const d of disp.values()) {                       // 多体圧縮でも変位を有界に
      const m2 = Math.hypot(d.dx, d.dy);
      if (m2 > SEP_MAX) { d.dx *= SEP_MAX / m2; d.dy *= SEP_MAX / m2; }
    }
    if (sepCache.size > 6000) sepCache.clear();
    sepCache.set(key, disp);
    return disp;
  };

  /* ------------------------------ 状態合成 ------------------------------ */
  // 単一スロットmemo: 同一フレーム内の重複呼び出し（描画・PSY・ピック等）を1回に
  let stateMemo = null;
  E.stateAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const range = E.playedRange(match);
    t = clamp(t, range.t0, range.t1);
    const memoKey = match.meta.id + "|" + E.scenarioKey(scenario) + "|" + t;
    if (stateMemo && stateMemo.key === memoKey) return stateMemo.st;
    const half = E.halfOf(match, t);
    const P = E.possessionAt(match, t, scenario);
    const ball = E.ballAt(match, scenario, t);
    const ballS = E.ballSlowAt(match, t);
    const carrier = E.carrierAt(match, scenario, t);
    // 保持者の現在基礎位置（プレッサー目標）
    let carrierPos = null;
    if (carrier && carrier.mode === "hold") {
      carrierPos = basePosOf(match, scenario, carrier.team, carrier.no, carrier.seg.slot, t);
    }
    const pressRank = pressRankAt(match, scenario, t, carrier, carrierPos);
    const sep = separationAt(match, scenario, t);
    const trigger = E.pressTriggerAt(match, scenario, t);
    const players = [];

    for (const team of E.teamKeys(match)) {
      const dir = match.dir[team][half === 1 ? "h1" : "h2"];
      const roster = E.rosterAt(match, scenario, team, t);
      const shape = F.SHAPES[roster.shape];
      const ctx = { half, dir, P, ballS, ball, carrier, carrierPos, pressRank, sep, trigger, t };
      // フェーズ切替の平滑化（ハーフ開始時を除く）: 旧スロット→新スロットを45sブレンド。
      // #61: opponentHt 指定チームのHT近傍切替は delay 秒ホールド後、blendSec かけて浸透
      let rosterPrev = null, prevShape = null, blendU = 1;
      const dtPhase = t - roster.phaseFrom;
      const htMod = E.htCorrectionOf(match, scenario, team);
      const htNear = htMod && roster.phaseFrom > 0 && Math.abs(roster.phaseFrom - match.time.h2.start) < 121;
      const phDelay = htNear ? htMod.delaySec : 0;
      const phDur = htNear ? htMod.blendSec : 45;
      if (roster.phaseFrom > 0 && roster.phaseFrom !== match.time.h2.start && dtPhase < phDelay + phDur) {
        rosterPrev = E.rosterAt(match, scenario, team, roster.phaseFrom - 0.01);
        prevShape = F.SHAPES[rosterPrev.shape];
        blendU = N.smooth(clamp((dtPhase - phDelay) / phDur));
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
        const nmOv = E.nameOverrideOf(match, scenario, team, no);
        const effA = E.attrsOf(match, scenario, team, no);
        // #90: 危険度重み dw — 能力値の「上書き前からの差分」ベース（未編集=1.0で較正不変）。
        // att/tec は攻撃支配、def は守備支配。pac は influence(絶対値)で別途（既に較正済み）。
        const dAtk = clamp(((effA.att - p.attrs.att) + (effA.tec - p.attrs.tec)) / 2, -40, 40) / 100 * 0.6;
        const dDef = clamp(effA.def - p.attrs.def, -40, 40) / 100 * 0.6;
        players.push({
          team, no,
          name: (nmOv && nmOv.name) || p.name, ja: (nmOv && (nmOv.ja || nmOv.name)) || p.ja,
          label: (nmOv && nmOv.label) || p.label, pos2: p.pos,
          role: slot.role, slot: slot.id, x: pos.x, y: pos.y,
          onPitch: true, entering, attrs: effA, captain: false,
          dwAtk: 1 + dAtk, dwDef: 1 + dDef,   // 未編集は 1.0（golden不変）
          hasBall: false,   // ボール吸着の後段で確定（アンカー再現中は立たない）
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
      // #81: 退場（レッド/交代なし負傷）も同じ動線でピッチを去る
      for (const o of E.outagesOf(match, scenario, team)) {
        if (o.t <= t && t - o.t < 30) {
          const u = N.smooth(clamp((t - o.t) / 30));
          const last = E.stateFrozenPos(match, scenario, team, o.no, o.t);
          const p = match.teams[team].squad.find(q => q.no === o.no);
          if (!p) continue;
          players.push({
            team, no: o.no, name: p.name, ja: p.ja, label: p.label, pos2: p.pos,
            role: "OUT", slot: null,
            x: lerp(last.x, 0, u * 0.8), y: lerp(last.y, -(HALF_H + 2.5), u),
            onPitch: false, leaving: u, attrs: p.attrs, captain: false, dismissed: true,
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

    // ボール吸着: ホールド中はボールを「描画済みの保持者」の足元へ。
    // チェーンはベース位置基準のため、フェーズ切替ブレンド(45s)や入場アニメ中に
    // 描画位置とズレる — ×1実時間再生で見える保持の不正確さをここで解消する。
    // free（チェーン駆動度）と保持確度 u で重み付け — アンカー再現（得点等）は不変。
    const restPin = carrier && carrier.seg && carrier.seg.restart && t <= carrier.seg.tf + carrier.seg.rdelay + 1.2;
    if (carrier && carrier.mode === "hold" && !restPin) {
      const cp = players.find(q => q.onPitch && q.team === carrier.team && q.no === carrier.no);
      if (cp) {
        // 吸着重み: チェーン駆動度 free に加え、アンカー再現中でも保持者が4m以内なら
        // 足元へ引き寄せる（独走ドリブルやFKでボールと選手が離れて見えるのを防ぐ）。
        // シュート等でアンカーが選手から離れ出すと near が消えて自然にリリースされる。
        const dNow = Math.hypot(cp.x - ball.x, cp.y - ball.y);
        const near = N.smooth(clamp((5.2 - dNow) / 2.8));
        const w = Math.max(ball.free, near * 0.9) * N.smooth(clamp(carrier.u * 1.6));
        if (w > 0.02) {
          const dseed = N.seedOf(match.meta.id + "dribble");
          const ax = cp.x + 0.7 * N.vnoise1(dseed + carrier.no * 7, t, 2.9);
          const ay = cp.y + 0.7 * N.vnoise1(dseed + 31 + carrier.no * 7, t, 3.1);
          ball.x = lerp(ball.x, ax, w);
          ball.y = lerp(ball.y, ay, w);
        }
      }
    }
    // 保持フラグ（吸着後のボール位置で判定）
    if (carrier && carrier.mode === "hold") {
      const cp = players.find(q => q.onPitch && q.team === carrier.team && q.no === carrier.no);
      if (cp && Math.hypot(cp.x - ball.x, cp.y - ball.y) < 3.5) cp.hasBall = true;
    }

    const st = {
      t, half, clock: E.clockAt(match, t),
      score: E.scoreAt(match, t, scenario),
      possession: P, ball, players,
      carrier: carrier ? {
        team: carrier.team, no: carrier.no, mode: carrier.mode, u: carrier.u,
        restart: carrier.restart || null,
        tf: carrier.seg.tf, rdelay: carrier.seg.rdelay || 0,
        from: carrier.seg.from ? { team: carrier.seg.from.team, no: carrier.seg.from.no } : null,
      } : null,
      scenarioId: scenario.id || "actual",
    };
    stateMemo = { key: memoKey, st };
    return st;
  };

  // #82: 編集フレーム — stateAt を深いコピーした「編集可能な state」。
  // 選手/ボールの x,y を書き換えても合成 f(t) やキャッシュを汚さない（golden安全）。
  // referees[] を追加（解析には使わない・シーン要素）。fieldAt/描画がそのまま食える形。
  E.editFrameAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const st = E.stateAt(match, scenario, t);
    return {
      t: st.t, half: st.half, clock: st.clock, score: { ...st.score },
      possession: st.possession,
      players: st.players.map(p => ({ ...p, attrs: p.attrs })),
      ball: { ...st.ball },
      referees: [],
      carrier: null,
      edited: false,
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
      half, dir, P: E.possessionAt(match, tt, scenario),
      ballS: E.ballSlowAt(match, tt), ball: E.ballAt(match, scenario, tt),
      carrier, carrierPos,
      pressRank: pressRankAt(match, scenario, tt, carrier, carrierPos),
      sep: separationAt(match, scenario, tt),
      trigger: E.pressTriggerAt(match, scenario, tt), t: tt,
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
  // 瞬時速度[km/h]: 位置が純関数なので中央差分で厳密（速度上限9.9m/s≈35.6km/hを継承）
  E.speedKmh = (match, scenario, team, no, t) => {
    scenario = scenario || E.actualScenario(match);
    const pr = E.presenceOf(match, scenario, team, no);
    if (!pr || t < pr.from + 0.6 || t > pr.to) return 0;
    const dt = 0.5;
    const a = E.stateFrozenPos(match, scenario, team, no, t - dt);
    const b = E.stateFrozenPos(match, scenario, team, no, t);
    return (Math.hypot(b.x - a.x, b.y - a.y) / dt) * 3.6;
  };

  E.clearCaches = () => {
    distCache.clear(); chainCache.clear(); trackCache.clear();
    restartCache.clear(); celeCache.clear(); panchorCache.clear(); pnetCache.clear();
    rankCache.clear(); lineCache.clear(); sepCache.clear(); basePosCache.clear();
    stateMemo = null;
  };
})();
