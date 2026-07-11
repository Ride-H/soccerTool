/* =========================================================================
   RPDX.tactics — 戦術フェーズ自動分類（Issue #32 v1・読み取り専用）
   ---------------------------------------------------------------------------
   合成状態から各時刻の「局面（フェーズ）」を決定論分類する解釈レイヤ。
   ヒューリスティックの決定木であり、実測ラベルの学習ではない（非予測・明示規律）。
   位置・イベント・危険度・結果には一切影響しない。

   タクソノミ（保持チーム視点 + 状況）:
     set-piece   … リスタート（スローイン/コーナー/ゴールキック/キックオフ）のピン〜再開
     transition  … 奪取直後（ターンオーバーから4秒・攻守が切り替わる過渡）
     build-up    … 保持チームが自陣~40%でボールを動かす
     progression … 中盤の前進（40〜75%）
     finishing   … 敵陣最終域（>75% またはゴール25m以内）
   press フラグ … 相手の協調プレスが点灯中（#29 pressTriggerAt・build-up等に重なる）
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const T = (R.tactics = {});
  const E = R.engine;
  const HALF_W = 52.5;

  T.PHASES = ["set-piece", "transition", "build-up", "progression", "finishing"];

  // 各時刻のフェーズ: { phase, team, press } / プレー外は null を返さず set-piece に含める
  T.phaseAt = (match, scenario, t) => {
    scenario = scenario || E.actualScenario(match);
    const c = E.carrierAt(match, scenario, t);
    if (!c) return { phase: "transition", team: null, press: false };
    const trig = E.pressTriggerAt(match, scenario, t);
    const press = !!(trig && trig.level > 0.5);
    // 1) セットピース: リスタート区間（運搬〜ピン〜解放直後）
    if (c.seg && c.seg.restart && t <= c.seg.tf + (c.seg.rdelay || 0) + 1.2)
      return { phase: "set-piece", team: c.team, press: false };
    // 2) トランジション: 奪取（相手からのターンオーバー）後4秒
    if (c.seg && c.seg.from && c.seg.from.team !== c.team && t - c.seg.t0 < 4)
      return { phase: "transition", team: c.team, press };
    // 3) 保持フェーズ: ボール前進度で3分割
    const half = E.halfOf(match, t);
    const dir = match.dir[c.team][half === 1 ? "h1" : "h2"];
    const bs = E.ballSlowAt(match, t);
    const prog = (dir * bs.x + HALF_W) / 105;            // 0=自ゴール … 1=敵ゴール
    const dGoal = Math.hypot(dir * HALF_W - bs.x, bs.y); // 敵ゴールまで
    const phase = (prog > 0.75 || dGoal < 25) ? "finishing"
      : prog < 0.40 ? "build-up" : "progression";
    return { phase, team: c.team, press };
  };

  // フェーズ別の時間集計 [秒]（チーム別・2s格子・シナリオ毎にキャッシュ）
  const shareCache = new Map();
  T.clearCaches = () => shareCache.clear();
  T.phaseShares = (match, scenario) => {
    scenario = scenario || E.actualScenario(match);
    const key = match.meta.id + "|" + E.scenarioKey(scenario);
    const hit = shareCache.get(key);
    if (hit) return hit;
    const range = E.playedRange(match);
    const out = {};
    for (const team of E.teamKeys(match)) {
      out[team] = {}; for (const ph of T.PHASES) out[team][ph] = 0;
      out[team].press = 0;
    }
    const STEP = 2;
    for (let t = range.t0 + 2; t < range.t1; t += STEP) {
      const p = T.phaseAt(match, scenario, t);
      if (!p.team) continue;
      out[p.team][p.phase] += STEP;
      if (p.press) {
        const opp = E.oppOf(match, p.team);
        out[opp].press += STEP;                          // プレスは守備側の実績
      }
    }
    if (shareCache.size > 16) shareCache.clear();
    shareCache.set(key, out);
    return out;
  };

  // タイムライン帯用の低解像度サンプル列 [{u(0..1), phase, team}]
  T.phaseStrip = (match, scenario, n = 240) => {
    scenario = scenario || E.actualScenario(match);
    const range = E.playedRange(match);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = range.t0 + ((i + 0.5) / n) * (range.t1 - range.t0);
      const p = T.phaseAt(match, scenario, t);
      out.push({ u: i / n, phase: p.phase, team: p.team });
    }
    return out;
  };
})();
