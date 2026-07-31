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

/* ---------------------------------------------------------------------------
   帯の定義と判定（#175）
   基準値をここ 1 か所に置き、CLI もプロパティゲートも同じ定義を使う。
   判定は 3 値にする: ok（帯の中）/ out（帯の外）/ unmeasured（標本不足で測れていない）。
   「測れていない」を「基準内」と一緒にすると、局面が発生しない試合で検査が静かに
   消えるのに緑になる（決勝の ESP 守備・ARG 攻撃がまさにそれだった）。
   --------------------------------------------------------------------------- */
export const MIN_N = 8;   // これ未満の標本数では統計的に判定しない

export const BANDS = [
  { key: "atkLine",    stat: "p50",          lo: 35, hi: 50, label: "攻撃時の最終ライン",     issue: 138 },
  { key: "defFront",   stat: "p50",                  hi: 45, label: "守備時の前線",           issue: 136 },
  { key: "defCompact", stat: ["p10", "p90"], lo: 25, hi: 40, label: "守備時コンパクトネス",   issue: 137 },
  { key: "allCompact", stat: "mean",                 hi: 45, label: "全局面コンパクトネス",   issue: 137 },
];

// 1 試合ぶんの判定。返値: [{ team, key, label, issue, n, values, verdict, detail }]
export const shapeVerdicts = (match, opts = {}) => {
  const agg = opts.agg || shapeProbe(match, opts);
  const rows = [];
  for (const team of E.teamKeys(match)) {
    for (const b of BANDS) {
      const a = agg[team][b.key];
      const stats = Array.isArray(b.stat) ? b.stat : [b.stat];
      const values = stats.map((k) => a[k]);
      let verdict = "ok", detail = "";
      if (a.n < MIN_N || values.some((v) => !Number.isFinite(v))) {
        verdict = "unmeasured";
        detail = `標本 ${a.n} 件（必要 ${MIN_N}）— この試合ではこの局面がほとんど発生しない`;
      } else {
        const bad = [];
        if (b.lo != null && Math.min(...values) < b.lo) bad.push(`下限 ${b.lo} を割る`);
        if (b.hi != null && Math.max(...values) > b.hi) bad.push(`上限 ${b.hi} を超える`);
        if (bad.length) { verdict = "out"; detail = bad.join(" / "); }
      }
      rows.push({ team, key: b.key, label: b.label, issue: b.issue, n: a.n,
        values: values.map((v) => (Number.isFinite(v) ? +v.toFixed(1) : null)), verdict, detail });
    }
  }
  return rows;
};

// 表示用: 値か「測定不能」か
export const fmt = (row) => (row.verdict === "unmeasured" ? `測定不能(n=${row.n})` : row.values.join("–"));

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const json = process.argv.includes("--json");
  const all = [];
  for (const m of Object.values(MATCHES)) for (const r of shapeVerdicts(m)) all.push({ match: m.meta.id, ...r });
  if (json) { console.log(JSON.stringify(all, null, 1)); }
  else {
    console.log("# 形状プローブ（判定: ✓帯の中 / ✖帯の外 / ?標本不足で測れていない）");
    for (const b of BANDS) {
      const lim = `${b.lo != null ? `${b.lo}–` : "≤"}${b.hi}m`;
      console.log(`\n## ${b.label}（基準 ${lim}・#${b.issue}）`);
      for (const r of all.filter((r) => r.key === b.key)) {
        const mark = r.verdict === "ok" ? "✓" : r.verdict === "out" ? "✖" : "?";
        console.log(`  ${mark} ${r.match.padEnd(22)} ${r.team.padEnd(4)} ${fmt(r).padStart(14)}  ${r.detail}`);
      }
    }
    const n = (v) => all.filter((r) => r.verdict === v).length;
    console.log(`\n判定: 帯の中 ${n("ok")} / 帯の外 ${n("out")} / 測れていない ${n("unmeasured")}`);
  }
}
