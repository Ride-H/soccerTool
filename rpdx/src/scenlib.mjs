/* =========================================================================
   RPDX.scenlib — シナリオ・ライブラリ & バッチ・シミュレーション（Issue #34 v1）
   ---------------------------------------------------------------------------
   決定論エンジンの強み＝「同じシナリオは何度でも同じ結果」を運用へ:
     - シナリオの最小表現（直列化/復元・URL/ファイル共有）
     - 多数シナリオの一括実行と結果集計（スコア再構成・危険度平均・フェーズ配分）
     - パラメータ格子（例: 交代分スイープ）の生成ヘルパ
   すべて純関数・乱数なし。CLI は rpdx/tools/batch.mjs、UI は ?scenario= 読込。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const SCN = (R.scenlib = {});
  const F = R.formations;

  /* ---- 直列化（最小表現・決定論） ---- */
  SCN.serialize = (scenario) => {
    const o = { l: scenario.label || "" };
    if (scenario.subs) {
      const subs = {};
      for (const [k, arr] of Object.entries(scenario.subs)) {
        if (arr && arr.length) subs[k] = arr.map(s => [s.t, s.out, s.in]);
      }
      if (Object.keys(subs).length) o.s = subs;
    }
    if (scenario.lineup) o.u = scenario.lineup;
    if (scenario.tweaks) o.w = scenario.tweaks;
    if (scenario.opponentHt) o.h = scenario.opponentHt;
    if (scenario.outages) {                                   // #81: 退場 [t,no,kind,reshape?]
      const g = {};
      for (const [k, arr] of Object.entries(scenario.outages))
        if (arr && arr.length) g[k] = arr.map(x => [x.t, x.no, x.kind || "red-card", x.reshape || null]);
      if (Object.keys(g).length) o.g = g;
    }
    if (scenario.shockGoals && scenario.shockGoals.length)    // #80: 外的失点 [t,team,kind]
      o.q = scenario.shockGoals.map(x => [x.t, x.team, x.kind || "deflection"]);
    return JSON.stringify(o);
  };

  SCN.parse = (match, str) => {
    const S = R.subs, E = R.engine;
    const o = typeof str === "string" ? JSON.parse(str) : str;
    const subs = {};
    for (const k of E.teamKeys(match)) {
      subs[k] = ((o.s && o.s[k]) || []).map(([t, out, inn]) => ({ t, out, in: inn }));
    }
    const sc = S.createScenario(match, o.l || "imported", { subs, lineup: o.u || null, tweaks: o.w || null });
    if (o.h) sc.opponentHt = o.h;
    if (o.g) {                                                // #81: 退場の復元
      sc.outages = {};
      for (const [k, arr] of Object.entries(o.g))
        sc.outages[k] = arr.map(([t, no, kind, reshape]) => ({ t, no, kind: kind || "red-card", ...(reshape ? { reshape } : {}) }));
    }
    if (o.q) sc.shockGoals = o.q.map(([t, team, kind]) => ({ t, team, kind: kind || "deflection" }));  // #80
    const validation = S.validateScenario(match, sc);
    return { scenario: sc, validation };
  };

  /* ---- バッチ実行（決定論・読み取り） ----
     entries: [{name, scenario}] → 行: 結果スコア・ゴール増減・危険度平均・首位フェーズ */
  SCN.batch = (match, entries) => {
    const E = R.engine, D = R.danger, SIM = R.sim, T = R.tactics;
    const keys = E.teamKeys(match);
    const rows = [];
    for (const { name, scenario } of entries) {
      const oc = scenario.actual ? null : SIM.outcome(match, scenario);
      const score = {};
      if (oc) for (const k of keys) score[k] = oc.score[k];
      else for (const k of keys) score[k] = match.events.filter(e => e.type === "goal" && e.team === k).length;
      const pts = D.curve(match, scenario, { step: 8, includeGK: false });
      const dMean = {};
      for (const k of keys) dMean[k] = pts.reduce((a, p) => a + p.v[k], 0) / pts.length;
      const shares = T.phaseShares(match, scenario);
      const topPhase = {};
      for (const k of keys) {
        topPhase[k] = T.PHASES.reduce((best, ph) =>
          shares[k][ph] > shares[k][best] ? ph : best, T.PHASES[0]);
      }
      rows.push({
        name,
        score: keys.map(k => `${k} ${score[k]}`).join(" - "),
        added: oc ? oc.events.filter(e => e.sim).length : 0,
        dangerMean: Object.fromEntries(keys.map(k => [k, +dMean[k].toFixed(1)])),
        topPhase,
      });
    }
    return rows;
  };

  /* ---- 編集フレームの直列化（#82・座標スナップショットの保存/共有） ---- */
  // 最小表現: 選手[team,no,x,y]・ボール[x,y]・審判[x,y]・時刻。JSON/フォルダ/URLで共有。
  SCN.serializeFrame = (frame) => {
    const r2 = (v) => Math.round(v * 100) / 100;
    return JSON.stringify({
      v: 1, t: r2(frame.t ?? 0),
      p: frame.players.filter(p => p.onPitch).map(p => [p.team, p.no, r2(p.x), r2(p.y)]),
      b: frame.ball ? [r2(frame.ball.x), r2(frame.ball.y)] : null,
      r: (frame.referees || []).map(rf => [r2(rf.x), r2(rf.y)]),
    });
  };
  SCN.parseFrame = (match, str, baseScenario) => {
    const E = R.engine;
    const o = typeof str === "string" ? JSON.parse(str) : str;
    // baseFrame（editFrameAt）に上書き — 属性・役割は合成フレームから引き継ぐ
    const base = E.editFrameAt(match, baseScenario || E.actualScenario(match), o.t || 0);
    const byKey = new Map(base.players.map(p => [p.team + ":" + p.no, p]));
    for (const [team, no, x, y] of (o.p || [])) {
      const pl = byKey.get(team + ":" + no);
      if (pl) { pl.x = x; pl.y = y; }
    }
    if (o.b && base.ball) { base.ball.x = o.b[0]; base.ball.y = o.b[1]; }
    base.referees = (o.r || []).map(([x, y]) => ({ x, y }));
    base.edited = true;
    return base;
  };

  /* ---- #83: 編集フレーム → 制約(editAnchors) → 再合成シナリオ（中間路） ----
     編集位置を「その時刻を通過するガウス窓アンカー」に翻訳し、以降を既存エンジンで再合成。
     σ は編集前 stateAt 位置からの移動距離に比例（速度上限を構成的に保証: 0.61·d/σ ≤ 3.2m/s）。
     編集は scenario 級 → actual/既定world・golden は不変。ball 保持の再合成は将来（残）。 */
  SCN.scenarioFromFrame = (match, frame, baseScenario) => {
    const E = R.engine, S = R.subs;
    const base = baseScenario || E.actualScenario(match);
    const natural = E.stateAt(match, base, frame.t);   // 編集前の合成位置（移動距離の基準）
    const natBy = new Map(natural.players.map(p => [p.team + ":" + p.no, p]));
    const editAnchors = [];
    for (const p of frame.players) {
      if (!p.onPitch) continue;
      const nat = natBy.get(p.team + ":" + p.no);
      const d = nat ? Math.hypot(p.x - nat.x, p.y - nat.y) : 0;
      if (d < 0.05) continue;                          // 動かしていない選手はアンカー不要
      editAnchors.push({ t: frame.t, team: p.team, no: p.no, x: p.x, y: p.y, sigma: Math.max(4, d * 0.19) });
    }
    const sc = S.createScenario(match, "編集フレーム再合成 @" + Math.round(frame.t) + "s", base);
    sc.editAnchors = editAnchors;
    sc.editFrom = frame.t;
    return { scenario: sc, validation: S.validateScenario(match, sc), moved: editAnchors.length };
  };

  /* ---- #91: ロスター/シナリオ/フレームの JSON 往復（統合スキーマ・取込→反映→書出） ----
     すべて端末内で完結（送信・サーバ蓄積なし）。上書きは scenario 級のみ＝match/golden は不変。
     スキーマ（最小・後方互換）:
       { v:1, kind:"rpdx-bundle", match, label,
         overrides?: { subs?, lineup?, tweaks?, opponentHt?, attrOverrides?, nameOverrides?, editAnchors?, editFrom? },
         roster?: { TEAM: { name?, players:[{no,label?,name?,ja?,attrs?}] } },   // 能力値/名前を no でマッチ→上書きへ翻訳
         frame?: <serializeFrame の中身> }                                        // 任意の編集フレーム座標 */
  const ATTR_RANGE = { pac: [40, 99], sta: [40, 99], def: [20, 99], att: [20, 99], tec: [40, 99], aer: [30, 99] };

  SCN.serializeBundle = (match, scenario, editFrame) => {
    const ov = {};
    if (scenario.subs) {
      const subs = {};
      for (const [k, arr] of Object.entries(scenario.subs))
        if (arr && arr.length) subs[k] = arr.map(s => [s.t, s.out, s.in]);
      if (Object.keys(subs).length) ov.subs = subs;
    }
    if (scenario.lineup) ov.lineup = scenario.lineup;
    if (scenario.tweaks) ov.tweaks = scenario.tweaks;
    if (scenario.opponentHt) ov.opponentHt = scenario.opponentHt;
    if (scenario.attrOverrides) ov.attrOverrides = scenario.attrOverrides;
    if (scenario.nameOverrides) ov.nameOverrides = scenario.nameOverrides;
    if (scenario.editAnchors && scenario.editAnchors.length) {
      ov.editAnchors = scenario.editAnchors;
      if (scenario.editFrom != null) ov.editFrom = scenario.editFrom;
    }
    if (scenario.outages) ov.outages = scenario.outages;      // #81
    if (scenario.shockGoals && scenario.shockGoals.length) ov.shockGoals = scenario.shockGoals;  // #80
    const bundle = { v: 1, kind: "rpdx-bundle", match: match.meta.id, label: scenario.label || "", overrides: ov };
    // #91残: 未較正（テンプレ/カスタム）試合はロスター（名前/背番号/pos/能力値/XI/チーム名）を
    //   customMatch として同梱 → 再読込時に generic.createMatch で完全再構築できる。
    //   収録実試合（較正済み）は同梱しない＝公式記録・golden の非改変を構成的に保証。
    if (match.meta.calibrated === false) {
      const teamCfg = (k) => {
        const T = match.teams[k];
        return {
          code: T.code, name: T.name, nameEn: T.nameEn, coach: T.coach,
          formation: T.phases[0].shape, color: T.color, colorDeep: T.colorDeep,
          kit: T.kit, captainOrder: T.captainOrder, xi: { ...T.phases[0].assign },
          squad: T.squad.map(p => ({ no: p.no, pos: p.pos, name: p.name, ja: p.ja, label: p.label, attrs: { ...p.attrs } })),
        };
      };
      const [ha, aw] = match.teamOrder;
      bundle.customMatch = {
        seed: match.meta.id.replace(/^custom-/, ""),
        competition: match.meta.competition, stage: match.meta.stage, venue: match.meta.venue,
        home: teamCfg(ha), away: teamCfg(aw),
      };
    }
    if (editFrame) bundle.frame = JSON.parse(SCN.serializeFrame(editFrame));
    return JSON.stringify(bundle, null, 2);
  };

  SCN.parseBundle = (match, input) => {
    const S = R.subs, E = R.engine;
    let o;
    try { o = typeof input === "string" ? JSON.parse(input) : input; }
    catch (e) { return { error: "JSON 解析に失敗: " + (e && e.message || e) }; }
    if (!o || typeof o !== "object") return { error: "不正な形式（オブジェクトではありません）" };
    const keys = E.teamKeys(match);
    const keySet = new Set(keys);
    const ov = o.overrides || {};

    // 交代（配列 [t,out,in] / オブジェクト両対応）
    const subs = {};
    for (const k of keys)
      subs[k] = ((ov.subs && ov.subs[k]) || []).map(s =>
        Array.isArray(s) ? { t: s[0], out: s[1], in: s[2] } : { t: s.t, out: s.out, in: s.in });
    const sc = S.createScenario(match, o.label || "取込シナリオ", { subs, lineup: ov.lineup || null, tweaks: ov.tweaks || null });
    if (ov.opponentHt) sc.opponentHt = ov.opponentHt;

    // 能力値・名前の上書き（clamp・no でマッチ・未知チーム/属性は無視）
    const clampAttr = (kk, v) => {
      const r = ATTR_RANGE[kk]; if (!r || typeof v !== "number" || !isFinite(v)) return null;
      return Math.max(r[0], Math.min(r[1], Math.round(v)));
    };
    const ao = {}, nm = {};
    const putAttr = (team, no, attrs) => {
      if (!keySet.has(team) || attrs == null || typeof attrs !== "object") return;
      const dst = {};
      for (const kk of Object.keys(ATTR_RANGE)) {
        const c = clampAttr(kk, attrs[kk]);
        if (c != null) dst[kk] = c;
      }
      if (Object.keys(dst).length) { (ao[team] ??= {}); ao[team][no] = { ...(ao[team][no] || {}), ...dst }; }
    };
    const putName = (team, no, src) => {
      if (!keySet.has(team) || !src) return;
      const dst = {};
      if (src.name) dst.name = String(src.name);
      if (src.ja) dst.ja = String(src.ja);
      if (src.label) dst.label = String(src.label);
      if (Object.keys(dst).length) { (nm[team] ??= {}); nm[team][no] = { ...(nm[team][no] || {}), ...dst }; }
    };
    if (ov.attrOverrides) for (const t of Object.keys(ov.attrOverrides))
      for (const no of Object.keys(ov.attrOverrides[t])) putAttr(t, +no, ov.attrOverrides[t][no]);
    if (ov.nameOverrides) for (const t of Object.keys(ov.nameOverrides))
      for (const no of Object.keys(ov.nameOverrides[t])) putName(t, +no, ov.nameOverrides[t][no]);
    // roster 形式（能力値/名前を選手行から翻訳・能力値なしは既存squad既定のまま＝上書きしない）
    if (o.roster) for (const [team, r] of Object.entries(o.roster)) {
      for (const pl of ((r && r.players) || [])) {
        if (pl == null || pl.no == null) continue;
        if (pl.attrs) putAttr(team, +pl.no, pl.attrs);
        putName(team, +pl.no, pl);
      }
    }
    if (Object.keys(ao).length) sc.attrOverrides = ao;
    if (Object.keys(nm).length) sc.nameOverrides = nm;

    // 編集アンカー（#83 再合成の制約）
    if (Array.isArray(ov.editAnchors) && ov.editAnchors.length) {
      sc.editAnchors = ov.editAnchors.filter(a => a && keySet.has(a.team));
      sc.editFrom = ov.editFrom != null ? ov.editFrom : ov.editAnchors[0].t;
    }
    // #80: 外的失点（未知チームは無視・検証は validateScenario 側）
    if (Array.isArray(ov.shockGoals) && ov.shockGoals.length)
      sc.shockGoals = ov.shockGoals.filter(x => x && keySet.has(x.team))
        .map(x => ({ t: +x.t, team: x.team, kind: x.kind || "deflection" }));
    // #81: 退場（未知チームは無視・検証は validateScenario 側）
    if (ov.outages && typeof ov.outages === "object") {
      const g = {};
      for (const [tm, arr] of Object.entries(ov.outages))
        if (keySet.has(tm) && Array.isArray(arr) && arr.length)
          g[tm] = arr.map(x => ({ t: +x.t, no: +x.no, kind: x.kind || "red-card", ...(x.reshape ? { reshape: x.reshape } : {}) }));
      if (Object.keys(g).length) sc.outages = g;
    }

    const validation = S.validateScenario(match, sc);
    const frame = o.frame ? SCN.parseFrame(match, o.frame, sc) : null;
    return { scenario: sc, validation, frame, match: o.match || null };
  };

  /* ---- #80(B): 巻き返しシナリオ・ビルダー ----
     ビハインド中のチームに対し、回復プラン候補（攻撃的シフト/攻撃的交代/複合）を
     決定論生成し、目的関数 = 10·Δ(得点差) + Δ攻撃危険度% − max(0, Δ被危険度%) で降順ランク。
     断定ではなくモデル上の比較（#62 と同型・#34 バッチ互換の entries を返す）。 */
  SCN.recoveryPlans = (match, baseScenario) => {
    const E = R.engine, S = R.subs, SIM = R.sim;
    const base = baseScenario && !baseScenario.actual ? baseScenario : null;
    const mk = () => S.fork(match, base || S.fromActual(match, "巻き返し"));
    // 現況スコアとビハインド側の特定（base の outcome 世界）
    const ocBase = SIM.outcome(match, mk());
    const keys = E.teamKeys(match);
    const score = ocBase ? ocBase.score : null;
    if (!score) return { trailer: null, plans: [] };
    const [a, b] = keys;
    const trailer = score[a] < score[b] ? a : score[b] < score[a] ? b : null;
    if (!trailer) return { trailer: null, plans: [] };
    // トリガ: 最終ビハインド区間の開始（そこから巻き返しに入るのが最も時間を使える）
    const evs = (ocBase.events || []).filter(e => e.type === "goal");
    let trig = 0, diff = 0, inBehind = false;
    for (const g of evs) {
      diff += g.team === trailer ? 1 : -1;
      if (diff < 0 && !inBehind) { trig = g.t; inBehind = true; }
      if (diff >= 0) inBehind = false;
    }
    const min0 = Math.min(85, Math.max(2, S.tToMinute(match, trig) + 1));
    const baseDiff = score[trailer] - score[E.oppOf(match, trailer)];
    const baseDelta = ocBase.teamDelta || {};
    const cur = E.rosterAt(match, mk(), trailer, S.minuteToT(match, min0)).shape;
    const atkShape = ["343", "3421", "433", "4231", "442"].find(sh => sh !== cur) || "442";

    const cands = [];
    { // 1) 攻撃的シフト
      const r = S.withFormation(match, mk(), trailer, min0, atkShape);
      if (r.validation.ok) cands.push({ id: "attack-shift", label: `攻撃的シフト ${F.SHAPE_LABELS?.[atkShape] || atkShape}（${min0}'）`, scenario: r.scenario });
    }
    { // 2) 攻撃的交代（アドバイザ最上位）
      const scx = mk();
      const adv = S.advise(match, scx, S.minuteToT(match, min0), trailer, {});
      const sug = adv && adv.suggestions && adv.suggestions[0];
      if (sug) {
        const r = S.withSub(match, scx, trailer, { t: S.minuteToT(match, min0), out: sug.out, in: sug.in });
        if (r.validation.ok) cands.push({ id: "attack-sub", label: `攻撃的交代 ${sug.outJa}→${sug.inJa}（${min0}'）`, scenario: r.scenario });
      }
    }
    { // 3) 複合（シフト+交代）
      let r = S.withFormation(match, mk(), trailer, min0, atkShape);
      if (r.validation.ok) {
        const adv = S.advise(match, r.scenario, S.minuteToT(match, min0), trailer, {});
        const sug = adv && adv.suggestions && adv.suggestions[0];
        if (sug) {
          const r2 = S.withSub(match, r.scenario, trailer, { t: S.minuteToT(match, min0), out: sug.out, in: sug.in });
          if (r2.validation.ok) r = r2;
        }
        cands.push({ id: "combined", label: `複合（シフト+交代・${min0}'）`, scenario: r.scenario });
      }
    }
    const opp = E.oppOf(match, trailer);
    const plans = cands.map(c => {
      const oc = SIM.outcome(match, c.scenario);
      const d = oc.score[trailer] - oc.score[opp];
      const atk = ((oc.teamDelta[trailer]?.deltaPct || 0) - (baseDelta[trailer]?.deltaPct || 0)) / 10;
      const risk = Math.max(0, ((oc.teamDelta[opp]?.deltaPct || 0) - (baseDelta[opp]?.deltaPct || 0)) / 10);
      const objective = +(10 * (d - baseDiff) + atk - risk).toFixed(2);
      return { ...c, validation: { ok: true, errors: [] }, objective,
        score: oc.score, scoreDiff: d, atkGainPct: Math.round(atk * 10), riskPct: Math.round(risk * 10) };
    }).sort((x, y) => y.objective - x.objective);
    return { trailer, trigger: trig, minute: min0, baseScore: score, plans };
  };

  /* ---- 格子生成: 交代分スイープ（idx番目の交代の分を動かす） ---- */
  SCN.subMinuteGrid = (match, base, team, subIdx, minutes) => {
    const S = R.subs;
    const out = [];
    for (const min of minutes) {
      const sc = S.fork(match, base);
      const arr = sc.subs[team] || [];
      if (!arr[subIdx]) continue;
      arr[subIdx] = { ...arr[subIdx], t: S.minuteToT(match, min) };
      sc.label = `${team} sub#${subIdx} @${min}'`;
      const validation = S.validateScenario(match, sc);
      if (validation.ok) out.push({ name: sc.label, scenario: sc });
    }
    return out;
  };
})();
