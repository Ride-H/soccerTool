#!/usr/bin/env node
// #140 形状プローブ（チーム幾何の妥当性計測・依存ゼロ・決定論）
//   node rpdx/tools/shape-probe.mjs [--json]
// ---------------------------------------------------------------------------
// エピック #135 の「サッカーとして破綻していない」公約を**形状面**で検証するための
// 計測器。各収録試合を 8 秒毎にサンプルし、局面（攻撃/守備）で条件分けして
//   ・最終ライン高さ = 自ゴールから遠い順で「低位 3 人」平均（＝自陣の守備ライン）
//   ・前線高さ       = 「高位 2 人」平均（＝最前列）
//   ・縦コンパクトネス = 前線 − 最終ライン
// を集計する。局面判定は平滑ボールの自ゴールからの縦深（攻撃=75m+ / 守備=≤30m）。
// 距離は「自ゴールからの縦深」= dir·x + 52.5（0=自ゴール … 105=敵ゴール）。
//
// 本モジュールは engine 出力の**読み取り専用**（世界状態を一切変えない）。
// エクスポート関数 shapeProbe() を #140 のプロパティゲートが利用する。
import { RPDX, MATCHES } from "../test/load.mjs";

const E = RPDX.engine;
const HALF_W = 52.5;

// パーセンタイル（線形補間・昇順配列）
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);

// 単一フレーム・単一チームのライン計測（GK除外・自ゴールからの縦深ベース）
// 返値: { last(最終ライン), front(前線), compact(縦コンパクトネス), depthBall } / 選手不足は null
export const frameLines = (match, state, team) => {
  const half = state.half;
  const dir = match.dir[team][half === 1 ? "h1" : "h2"];
  const outs = state.players.filter(p => p.onPitch && !p.entering && p.team === team && p.role !== "GK");
  if (outs.length < 5) return null;
  const depths = outs.map(p => dir * p.x + HALF_W).sort((a, b) => a - b);   // 昇順（自ゴール側から）
  const nLow = Math.min(3, depths.length);
  const nHigh = Math.min(2, depths.length);
  const last = mean(depths.slice(0, nLow));                 // 低位3人＝最終ライン
  const front = mean(depths.slice(depths.length - nHigh));  // 高位2人＝前線
  return { last, front, compact: front - last };
};

// 1試合の形状プローブ（8秒毎・局面条件分け・両チーム集計）
// opts.step（既定8）/ opts.scenario（既定 actual）
export const shapeProbe = (match, opts = {}) => {
  const step = opts.step ?? 8;
  const sc = opts.scenario || E.actualScenario(match);
  const range = E.playedRange(match);
  const out = {};
  for (const team of E.teamKeys(match)) {
    out[team] = {
      atkLast: [], defFront: [], defCompact: [], allCompact: [],
    };
  }
  for (let t = range.t0 + step; t < range.t1; t += step) {
    const st = E.stateAt(match, sc, t);
    for (const team of E.teamKeys(match)) {
      const lines = frameLines(match, st, team);
      if (!lines) continue;
      const half = st.half;
      const dir = match.dir[team][half === 1 ? "h1" : "h2"];
      const bs = E.ballSlowAt(match, t);
      const ballDepth = dir * bs.x + HALF_W;                // 自ゴールからのボール縦深
      out[team].allCompact.push(lines.compact);
      if (ballDepth >= 75) out[team].atkLast.push(lines.last);       // 攻撃局面: 最終ライン高さ
      else if (ballDepth <= 30) {                                    // 守備局面: 前線・コンパクトネス
        out[team].defFront.push(lines.front);
        out[team].defCompact.push(lines.compact);
      }
    }
  }
  // 集計（p10/p50/p90/mean）
  const agg = {};
  for (const team of E.teamKeys(match)) {
    const d = out[team];
    agg[team] = {
      atkLine:   { p50: pct(d.atkLast, 0.5), n: d.atkLast.length },
      defFront:  { p50: pct(d.defFront, 0.5), n: d.defFront.length },
      defCompact:{ p10: pct(d.defCompact, 0.1), p50: pct(d.defCompact, 0.5), p90: pct(d.defCompact, 0.9), n: d.defCompact.length },
      allCompact:{ mean: mean(d.allCompact), n: d.allCompact.length },
    };
  }
  return agg;
};

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const json = process.argv.includes("--json");
  const rows = [];
  for (const m of Object.values(MATCHES)) {
    const agg = shapeProbe(m);
    for (const team of E.teamKeys(m)) {
      const a = agg[team];
      rows.push({
        match: m.meta.id, team,
        atkLine_p50: +a.atkLine.p50.toFixed(1),
        defFront_p50: +a.defFront.p50.toFixed(1),
        defCompact_p10: +a.defCompact.p10.toFixed(1),
        defCompact_p50: +a.defCompact.p50.toFixed(1),
        defCompact_p90: +a.defCompact.p90.toFixed(1),
        allCompact_mean: +a.allCompact.mean.toFixed(1),
      });
    }
  }
  if (json) { console.log(JSON.stringify(rows, null, 1)); }
  else {
    console.log("# 形状プローブ（基準: 攻撃時最終ライン 35–50m / 守備時前線 ≤45m / 守備時コンパクトネス 25–38m）");
    console.log("match".padEnd(22), "team", "攻撃時LINE", "守備時FRONT", "守備compact(p10/p50/p90)", "全局面compact");
    for (const r of rows) {
      console.log(
        r.match.padEnd(22), r.team.padEnd(4),
        String(r.atkLine_p50).padStart(7),
        String(r.defFront_p50).padStart(9),
        `${r.defCompact_p10}/${r.defCompact_p50}/${r.defCompact_p90}`.padStart(18),
        String(r.allCompact_mean).padStart(10),
      );
    }
  }
}
