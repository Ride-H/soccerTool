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
})();
