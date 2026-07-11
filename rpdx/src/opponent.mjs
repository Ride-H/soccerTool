/* =========================================================================
   RPDX.opponent — 相手分析体制の脆弱性プロファイラ（Issue #59 v1・読み取り専用）
   ---------------------------------------------------------------------------
   「リアルタイムデータ解析 → ベンチ → 選手」というフィードバック体制そのものの
   組織的・技術的脆弱性（意思決定遅延・情報ノイズ・指揮系統・認知キャパ）を、
   宣言されたパラメータから決定論評価する。ピッチ解析（D²-Field）に対する
   「ベンチ・組織側」の解釈レイヤ。

   重要（責任ある表現）: これは実在の連盟・チームへの断定ではない。
   体制パラメータは「宣言された仮定」であり、出力はそのモデル評価にすぎない。
   マッチパックが teams[team].analysisSetup を宣言しない限り、実チームには
   何も帰属しない（UIはアーキタイプ比較のみを表示する）。

   パラメータ:
     staff      … 分析関与人数（アナリスト+コーチ）
     stages     … 情報がベンチへ届くまでの段数（収集→精査→合意→伝達…）
     toolShare  … 自動化・ツール/リモート依存度 0..1
     fieldShare … 現場の直感・属人依存度 0..1
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const OPP = (R.opponent = {});
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

  // 体制アーキタイプ（3類型のプリセット — 一般的な運用像の仮定値）
  OPP.ARCHETYPES = {
    mass:  { key: "mass",  label: "人海戦術型",     staff: 70, stages: 5, toolShare: 0.45, fieldShare: 0.35 },
    tech:  { key: "tech",  label: "AI・テック特化型", staff: 18, stages: 3, toolShare: 0.85, fieldShare: 0.20 },
    field: { key: "field", label: "現場主義型",     staff: 6,  stages: 2, toolShare: 0.15, fieldShare: 0.85 },
  };

  // HT15分の時間配分モデル [分]（収集/集計 → コーチ会議/合意 → 選手共有）
  OPP.htBudget = (setup) => {
    const s = { staff: 20, stages: 3, toolShare: 0.5, fieldShare: 0.5, ...setup };
    // 収集・集計: 人数の対数で増える（クリップ量↑・選別コスト↑）。ツール化で短縮
    const collect = clamp(1.2 + Math.log(s.staff / 6 + 1) * 2.1 * (1 - 0.35 * s.toolShare), 1, 8);
    // 会議・合意: 段数に線形 + データ派×現場派の対立（両依存が拮抗するほど長い）
    const conflict = 4 * s.toolShare * s.fieldShare;               // 0..1（0.5×0.5で最大1）
    const meeting = clamp(0.9 * s.stages * (1 + 0.6 * conflict), 1, 9);
    const share = clamp(15 - collect - meeting, 1, 12);            // 残りが選手共有
    return { collect, meeting, share };
  };

  // 4軸脆弱性スコア（1..5・大きいほど脆弱）
  OPP.profile = (setup) => {
    const s = { staff: 20, stages: 3, toolShare: 0.5, fieldShare: 0.5, ...setup };
    const b = OPP.htBudget(s);
    const to5 = (u) => Math.round(clamp(u) * 40) / 10 + 1;         // 0..1 → 1.0..5.0
    // 情報遅延: 収集+会議が15分を圧迫するほど危険
    const delay = to5((b.collect + b.meeting - 3) / 9);
    // 意思決定ブレ: 段数（伝言ゲーム）+ 派閥対立 + 属人依存（想定外に弱い）
    const sway = to5(((s.stages - 2) / 5) * 0.45 + (4 * s.toolShare * s.fieldShare) * 0.3
      + Math.max(0, s.fieldShare - 0.6) * 0.9);
    // システム依存: ツール/リモート依存（障害・遅延・プランB不足）
    const sysDep = to5(Math.pow(s.toolShare, 1.3));
    // 総合HT修正力の脆弱性: 共有時間の不足 × ブレ の合成
    const overall = to5(clamp((12 - b.share) / 10) * 0.55 + (sway - 1) / 4 * 0.45);
    return {
      params: s, budget: b,
      scores: { delay, sway, sysDep, overall },
      labels: { delay: "情報遅延リスク", sway: "意思決定ブレ度", sysDep: "システム依存度", overall: "HT修正力の脆弱性" },
    };
  };

  // パック宣言の取得（未宣言なら null — 実チームへの帰属はパックの明示宣言のみ）
  OPP.setupOf = (match, team) => {
    const t = match.teams && match.teams[team];
    if (!t || !t.analysisSetup) return null;
    const a = t.analysisSetup;
    const base = a.archetype && OPP.ARCHETYPES[a.archetype] ? OPP.ARCHETYPES[a.archetype] : {};
    return { ...base, ...a };
  };

  // 星表示ユーティリティ（UI用）
  OPP.stars = (v) => "★".repeat(Math.round(v)) + "☆".repeat(5 - Math.round(v));

  /* ---------------- リアルタイム意思決定負荷（Issue #60 v1） ----------------
     試合中にベンチの分析体制へかかる「情報フロー圧 IFL(t)」と、その体制の処理能力に
     対する飽和度を決定論算出する。IFL は試合そのものの性質（イベント密度・危険度の
     変動・局面切替の頻度）、処理能力は体制パラメータの関数。
     大人数体制は「自ら生成する情報も多い」ため、同じ試合でも飽和しやすい。 */

  const iflCache = new Map();
  OPP.clearCaches = () => iflCache.clear();

  // 試合固有の情報フロー圧（体制非依存の素点・0..~3）: 60秒窓
  OPP.iflAt = (match, scenario, t) => {
    const E = R.engine, T = R.tactics, D = R.danger;
    scenario = scenario || E.actualScenario(match);
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    let base = iflCache.get(key);
    if (!base) {
      // 8秒格子で全編を前計算（危険度曲線は既存キャッシュを再利用）
      const pts = D.curve(match, scenario, { step: 8, includeGK: false });
      const keys = E.teamKeys(match);
      const events = E.eventsOf(match, scenario).filter(e => e.type !== "kickoff");
      const ts = [], vals = [];
      let prevPhase = null;
      for (let i = 0; i < pts.length; i++) {
        const tt = pts[i].t;
        // (1) イベント密度: ±60秒内の記録イベント数
        const evd = events.reduce((a, e) => a + (Math.abs(e.t - tt) < 60 ? 1 : 0), 0);
        // (2) 危険度の変動: 直近60秒の両チーム危険度の振れ幅（クリップ対象の多さ）
        let hi = 0, lo = 100;
        for (let j = Math.max(0, i - 7); j <= i; j++) {
          for (const k of keys) { hi = Math.max(hi, pts[j].v[k]); lo = Math.min(lo, pts[j].v[k]); }
        }
        // (3) 局面切替: フェーズが直前サンプルから変わったか（切替率の proxy）
        const ph = T.phaseAt(match, scenario, tt).phase;
        const sw = prevPhase && ph !== prevPhase ? 1 : 0;
        prevPhase = ph;
        ts.push(tt);
        vals.push(clamp(evd / 3, 0, 1) * 0.4 + clamp((hi - lo) / 55, 0, 1) * 0.4 + sw * 0.2);
      }
      base = { ts, vals };
      if (iflCache.size > 12) iflCache.clear();
      iflCache.set(key, base);
    }
    // 最近傍サンプル（8s格子・決定論）
    let lo = 0, hi = base.ts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (base.ts[mid] <= t) lo = mid; else hi = mid; }
    return base.vals[Math.abs(base.ts[lo] - t) <= Math.abs(base.ts[hi] - t) ? lo : hi];
  };

  // 体制の処理能力: 段数がボトルネック・ツールで緩和（人数では増えない — 合意が律速）
  OPP.capacityOf = (setup) => {
    const s = { staff: 20, stages: 3, toolShare: 0.5, ...setup };
    return clamp((2.2 - 0.25 * s.stages) * (1 + 0.5 * s.toolShare), 0.3, 3);
  };
  // 体制の情報生成率: 大人数ほど自らクリップ/レポートを量産する
  OPP.genRateOf = (setup) => {
    const s = { staff: 20, ...setup };
    return 0.6 + 0.4 * Math.log(1 + s.staff / 8);
  };

  // 前半の飽和サマリ: {meanSat, backlog, shareEff} — HTへ持ち込む未処理情報量と
  // 実質共有時間（予算の share から backlog ペナルティを引く）
  OPP.htSaturation = (match, scenario, setup) => {
    const E = R.engine;
    scenario = scenario || E.actualScenario(match);
    const gen = OPP.genRateOf(setup), cap = OPP.capacityOf(setup);
    const htEnd = match.time.h1.end;
    let sat = 0, over = 0, n = 0;
    for (let t = 30; t < htEnd; t += 16) {
      const load = OPP.iflAt(match, scenario, t) * gen;
      sat += load / cap;
      over += Math.max(0, load - cap) * 16;   // 未処理の積分 [情報量·秒]
      n++;
    }
    const budget = OPP.htBudget(setup);
    const backlog = over / 60;                 // 分相当
    const shareEff = clamp(budget.share - backlog * 0.8, 0.5, budget.share);
    return { meanSat: sat / n, backlog, shareEff, share: budget.share };
  };

  /* ---------------- カウンタープラン（Issue #62 v1） ----------------
     相手体制の弱点タイプ → それをピッチ上で引き出す戦術テンプレ → 実行可能な
     what-if シナリオへ決定論変換。効果は evaluatePlans で「モデル上の比較」として
     数値化する（断定ではない）。生成物は既存のシナリオ規則検証を必ず通す。 */

  const altShapesOf = (match, team) => {
    const F = R.formations;
    const cur = match.teams[team].phases[0].shape;
    return Object.keys(F.SHAPES).filter(s => s !== cur).sort();
  };

  // 生成: [{id, label, desc, exploits, scenario, validation}]
  OPP.counterPlans = (match, opponentTeam) => {
    const E = R.engine, S = R.subs, F = R.formations;
    const my = E.oppOf(match, opponentTeam);
    const alts = altShapesOf(match, my);
    const mk = (label) => S.createScenario(match, label, E.actualScenario(match));
    const plans = [];
    // 1) 二段可変（情報過多型の集計をリセットさせる）: 25' と 65' で別システムへ
    if (alts.length >= 2) {
      let r = S.withFormation(match, mk(`${my} 二段可変 25'/65'`), my, 25, alts[0]);
      if (r.validation.ok) r = S.withFormation(match, r.scenario, my, 65, alts[1]);
      plans.push({ id: "two-stage", label: "二段システム可変（25'→65'）",
        desc: "前半と後半で全く別の可変システム — 相手の集計・クリップ分類を2度リセットさせる",
        exploits: "delay", scenario: r.scenario, validation: r.validation });
    }
    // 2) HT直前圧縮（共通）: 43' に布陣変更 — 相手のHT準備時間を新情報で圧迫
    if (alts.length >= 1) {
      const r = S.withFormation(match, mk(`${my} 43'可変`), my, 43, alts[0]);
      plans.push({ id: "pre-ht", label: "HT直前の可変（43'）",
        desc: "前半終了間際に新情報を注入 — 相手アナリストのHT集計・編集時間を物理的に奪う",
        exploits: "common", scenario: r.scenario, validation: r.validation });
    }
    // 3) ミスマッチ作出（現場主義の眼と直感を飽和させる）: 後半頭に前線スロットを入替
    {
      const shape = F.SHAPES[match.teams[my].phases[0].shape];
      const atk = shape.filter(s => ["ST", "W", "AM", "FB", "WB"].includes(s.role)).map(s => s.id).sort();
      if (atk.length >= 2) {
        const r = S.withSlotSwap(match, mk(`${my} 前線入替`), my, match.time.h2.start + 1, atk[0], atk[1]);
        plans.push({ id: "mismatch", label: "後半頭のミスマッチ作出（前線入替）",
          desc: "想定外の対面を作る — 属人的な読みと少数の眼を飽和させる",
          exploits: "sway", scenario: r.scenario, validation: r.validation });
      }
    }
    // 4) 非定型キックオフ（テック依存の自動分類の信頼度を下げる）: 開始から非典型システム
    if (alts.length >= 2) {
      const r = S.withFormation(match, mk(`${my} 非定型`), my, 0, alts[alts.length - 1]);
      plans.push({ id: "atypical", label: "非定型システムでの立ち上がり",
        desc: "パターン外の配置で開始 — 自動分析のテンプレ適合を外し、データと現場感覚の乖離を突く",
        exploits: "sysDep", scenario: r.scenario, validation: r.validation });
    }
    return plans.filter(p => p.validation && p.validation.ok);
  };

  // 評価: 各プランの「相手のHT情報環境への打撃」と「自軍の結果」を actual 比で数値化
  OPP.evaluatePlans = (match, plans, setup) => {
    const E = R.engine, SCN = R.scenlib;
    const base = OPP.htSaturation(match, E.actualScenario(match), setup);
    const batch = SCN.batch(match, [
      { name: "actual", scenario: E.actualScenario(match) },
      ...plans.map(p => ({ name: p.id, scenario: p.scenario })),
    ]);
    return plans.map((p, i) => {
      const sat = OPP.htSaturation(match, p.scenario, setup);
      return {
        id: p.id, label: p.label, exploits: p.exploits,
        dMeanSat: +(sat.meanSat - base.meanSat).toFixed(4),
        dBacklog: +(sat.backlog - base.backlog).toFixed(3),
        dShareEff: +(sat.shareEff - base.shareEff).toFixed(2),
        score: batch[i + 1].score, added: batch[i + 1].added,
        baseScore: batch[0].score,
      };
    });
  };

  // 選手認知キャパ: HTで伝わる変更点数（交代+布陣切替）が上限3を超えると過負荷
  OPP.htCognitive = (match, scenario, team) => {
    const E = R.engine;
    scenario = scenario || E.actualScenario(match);
    const htEnd = match.time.h1.end, h2 = match.time.h2.start;
    let changes = 0;
    for (const sub of (scenario.subs[team] || [])) if (sub.t >= htEnd - 60 && sub.t <= h2 + 90) changes++;
    const phases = E.phasesOf ? E.phasesOf(match, scenario, team) : [];
    for (const ph of phases) if (Math.abs(ph.from - h2) < 90 && ph.from > 0) changes++;
    return { changes, capacity: 3, overload: Math.max(0, changes - 3) };
  };
})();
