#!/usr/bin/env node
// #140 形状プローブ（チーム幾何の妥当性計測・依存ゼロ・決定論）
//   node rpdx/tools/shape-probe.mjs [--json]
// ---------------------------------------------------------------------------
// エピック #135 の「サッカーとして破綻していない」公約を**形状面**で検証するための
// 計測器。各収録試合を 8 秒毎にサンプルし、局面（攻撃/守備）で条件分けして集計する。
// 距離は「自ゴールからの縦深」= dir·x + 52.5（0=自ゴール … 105=敵ゴール）。
//
// 本モジュールは engine 出力の**読み取り専用**（世界状態を一切変えない）。
// エクスポート関数 shapeProbe() を #140 のプロパティゲートが利用する。
//
// 【測る量の定義（2026-08-04 改訂・#135 一次量化）】
// 旧版は「前線 = 高位2人平均」を **≤45m** で判定していたが、45m は文献上
// **最終ライン（バックライン）の高さ**の数字であって前線の数字ではない。
// 前線に当てると「ローブロックでも FW が自ゴールから 45m 以内まで下がること」を
// 要求してしまい、実サッカーでは起こらない形を正解にしてしまう。
// ライン系の量は次のように**別々の量**として分けて測る:
//
//   1. 最終ライン高さ  DF(CB/FB/WB) の平均縦深 — 「ラインを上げ下げする」の対象
//   2. ブロック厚み    最深 DF → 最前 MF — 文献の「縦コンパクトネス」の定義そのもの
//   3. 前線高さ        高位 2 人平均 — アウトレット（前残り）を含む最前列
//   4. 後方人数        ボールより自ゴール側にいる非 GK 人数 — 「全員は戻らない」の定量
//
// 4 は #136 の設計に必須。ローブロックでも 1〜2 人は前線に残るのが普通で、
// 「10 人全員を自陣へ」は誤った目標になる。何人戻るかを測ってから帯を決める。
import { RPDX, MATCHES } from "../test/load.mjs";

const E = RPDX.engine;
const HALF_W = 52.5;

// ユニット分類（engine の LINE_ROLES と同じく WB は最終ライン側＝守備時は 5 バックに落ちる）
const DF_ROLES = { CB: 1, FB: 1, WB: 1 };
const MF_ROLES = { DM: 1, CM: 1, AM: 1 };

// 「ボールより後方の人数」を見るボール深さのビン（自ゴールからの縦深 m）
export const DEPTH_BINS = [[0, 20], [20, 30], [30, 40], [40, 52.5]];

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
// 返値: { last, front, compact, line, blockTop, block, interLine, behind, ahead } / 選手不足は null
export const frameLines = (match, state, team, ball) => {
  const half = state.half;
  const dir = match.dir[team][half === 1 ? "h1" : "h2"];
  const outs = state.players.filter(p => p.onPitch && !p.entering && p.team === team && p.role !== "GK");
  if (outs.length < 5) return null;
  const depthOf = (p) => dir * p.x + HALF_W;
  const depths = outs.map(depthOf).sort((a, b) => a - b);   // 昇順（自ゴール側から）
  const nLow = Math.min(3, depths.length);
  const nHigh = Math.min(2, depths.length);
  const last = mean(depths.slice(0, nLow));                 // 低位3人＝最終ライン（順位ベース）
  const front = mean(depths.slice(depths.length - nHigh));  // 高位2人＝前線（アウトレット込み）

  // ユニット別（役割ベース）— 順位ベースと違い、誰が高い位置に居ても定義がぶれない
  const df = outs.filter(p => DF_ROLES[p.role]).map(depthOf);
  const mf = outs.filter(p => MF_ROLES[p.role]).map(depthOf);
  const fw = outs.filter(p => !DF_ROLES[p.role] && !MF_ROLES[p.role]).map(depthOf);
  const line = df.length ? mean(df) : NaN;                          // 最終ライン高さ
  const blockTop = mf.length ? Math.max(...mf) : NaN;               // ブロック上端＝最前の中盤
  const block = df.length && mf.length ? blockTop - Math.min(...df) : NaN;   // ブロック厚み
  // ライン間距離: DF→MF→FW の重心間の平均ギャップ（存在するユニットだけで測る）
  const cs = [df, mf, fw].filter(u => u.length).map(mean);
  const interLine = cs.length > 1 ? (cs[cs.length - 1] - cs[0]) / (cs.length - 1) : NaN;

  // 「全員は戻らない」の定量: ボールより自ゴール側に何人いるか（GK は数えない＝標準的な定義）
  // ball を渡さない場合は state のボール。局面判定と同じ球を使うこと（別の球で測ると、
  // 「相手が深く持っている」と判定した瞬間に球だけ別の場所にある、という矛盾が入る）。
  const b = ball || state.ball;
  const ballDepth = b ? dir * b.x + HALF_W : NaN;
  const behind = Number.isFinite(ballDepth) ? outs.filter(p => depthOf(p) < ballDepth).length : NaN;
  const ahead = Number.isFinite(behind) ? outs.length - behind : NaN;

  return { last, front, compact: front - last, line, blockTop, block, interLine, behind, ahead };
};

// 1試合の形状プローブ（8秒毎・局面条件分け・両チーム集計）
// opts.step（既定8）/ opts.scenario（既定 actual）
export const shapeProbe = (match, opts = {}) => {
  const step = opts.step ?? 4;   // 保持条件を入れて標本が減ったぶん細かく刻む
  const sc = opts.scenario || E.actualScenario(match);
  const range = E.playedRange(match);
  const out = {};
  for (const team of E.teamKeys(match)) {
    out[team] = { atkLast: [], defFront: [], defLine: [], defBlock: [], defBehind: [], defAhead: [],
      interLine: [], defCompact: [], allCompact: [], behindByDepth: [], lineAll: [] };
  }
  for (let t = range.t0 + step; t < range.t1; t += step) {
    const st = E.stateAt(match, sc, t);
    const car = E.carrierAt(match, sc, t);
    for (const team of E.teamKeys(match)) {
      const bs = E.ballSlowAt(match, t);
      const lines = frameLines(match, st, team, bs);
      if (!lines) continue;
      const half = st.half;
      const dir = match.dir[team][half === 1 ? "h1" : "h2"];
      const ballDepth = dir * bs.x + HALF_W;                // 自ゴールからのボール縦深
      const d = out[team];
      d.allCompact.push(lines.compact);
      if (Number.isFinite(lines.line)) d.lineAll.push(lines.line);
      // 局面はボール位置だけでは決まらない。自陣にボールがあっても、**自分が持っていれば
      // ビルドアップ**で全員がボールより前に居るのが正しい。保持を条件に入れないと
      // 「後方人数 0 人」のような、守備の失敗に見える正常な形を拾ってしまう。
      const mine = car && car.team === team;
      // 後方人数だけは局面の窓が違う。文献の「8〜9 人がボールより後方」は
      // **相手が自陣でボールを持っている**局面の数字で、ボールが自ゴール 30m 以内という
      // 狭い窓の数字ではない（その帯に 9 人は物理的に入らない）。窓を合わせて測る。
      if (car && !mine && ballDepth <= HALF_W && Number.isFinite(lines.behind)) {
        d.behindByDepth.push({ depth: ballDepth, behind: lines.behind, ahead: lines.ahead });
        if (ballDepth <= 30) { d.defBehind.push(lines.behind); d.defAhead.push(lines.ahead); }
      }
      if (ballDepth >= 75 && mine) d.atkLast.push(lines.last);          // 攻撃局面
      else if (ballDepth <= 30 && car && !mine) {                       // 守備局面（相手保持）
        d.defFront.push(lines.front);
        d.defCompact.push(lines.compact);
        if (Number.isFinite(lines.interLine)) d.interLine.push(lines.interLine);
        if (Number.isFinite(lines.line)) d.defLine.push(lines.line);
        if (Number.isFinite(lines.block)) d.defBlock.push(lines.block);
      }
    }
  }
  // 集計（p10/p50/p90/mean）
  const agg = {};
  for (const team of E.teamKeys(match)) {
    const d = out[team];
    agg[team] = {
      lineAvg:   { mean: mean(d.lineAll), n: d.lineAll.length },
      atkLine:   { p50: pct(d.atkLast, 0.5), n: d.atkLast.length },
      defFront:  { p50: pct(d.defFront, 0.5), n: d.defFront.length },
      defLine:   { p50: pct(d.defLine, 0.5), n: d.defLine.length },
      defBlock:  { p10: pct(d.defBlock, 0.1), p50: pct(d.defBlock, 0.5), p90: pct(d.defBlock, 0.9), n: d.defBlock.length },
      defBehind: { p10: pct(d.defBehind, 0.1), p50: pct(d.defBehind, 0.5), n: d.defBehind.length },
      defAhead:  { p50: pct(d.defAhead, 0.5), p90: pct(d.defAhead, 0.9), n: d.defAhead.length },
      interLine: { p50: pct(d.interLine, 0.5), n: d.interLine.length },
      defCompact:{ p10: pct(d.defCompact, 0.1), p50: pct(d.defCompact, 0.5), p90: pct(d.defCompact, 0.9), n: d.defCompact.length },
      allCompact:{ mean: mean(d.allCompact), n: d.allCompact.length },
      // 「何人戻るか」はボールの深さの関数。1 つの数字に潰すと、
      // 「全員戻る／誰も戻らない」の二択しか設計できなくなる（#136 の設計材料）。
      behindByDepth: DEPTH_BINS.map(([lo, hi]) => {
        const v = d.behindByDepth.filter((r) => r.depth >= lo && r.depth < hi);
        return { lo, hi, n: v.length, behind: pct(v.map((r) => r.behind), 0.5), ahead: pct(v.map((r) => r.ahead), 0.5) };
      }),
    };
  }
  return agg;
};

/* ---------------------------------------------------------------------------
   帯の定義と判定（#175 / #135）
   基準値をここ 1 か所に置き、CLI もプロパティゲートも同じ定義を使う。

   【出典を必ず持たせる】各帯には src（何の数字か）を書く。出典の無い数字を基準に
   すると、実装がその数字に合わせて歪む。旧版の「守備時の前線 ≤45m」がまさにそれで、
   45m は最終ライン高さ（ミドルブロック 35–45m）の数字を前線に誤用していた。

   判定は 3 値: ok（帯の中）/ out（帯の外）/ unmeasured（標本不足で測れていない）。
   「測れていない」を「基準内」と一緒にすると、局面が発生しない試合で検査が静かに
   消えるのに緑になる（決勝の ESP 守備・ARG 攻撃がまさにそれだった）。
   --------------------------------------------------------------------------- */
export const MIN_N = 8;   // これ未満の標本数では統計的に判定しない

export const BANDS = [
  { key: "lineAvg", stat: "mean", lo: 22, hi: 55, label: "最終ライン高さ（試合平均）", issue: 138,
    src: "文献の平均ライン高さ: ローブロック 22–28m / ミドル 35–45m / ハイプレス 52–55m。"
      + "どの戦い方でもこの 22–55m に入る。**局面で条件付けた値にこの帯は当てられない**"
      + "（出典が試合平均の数字のため。ボール ≤30m 窓の値は帯なしで報告する）" },
  { key: "defBlock", stat: ["p10", "p90"], lo: 15, hi: 35, label: "守備時のブロック厚み（最深DF→最前MF）", issue: 137,
    src: "縦コンパクトネス = 最深守備者と最前中盤の距離 30–35m 以内。アトレティコの4バック↔2トップは 25m" },
  { key: "defFront", stat: "p50", hi: 55, label: "守備時の前線高さ（前残り込み）", issue: 136,
    src: "ローブロックでも FW はハーフウェー（52.5m）付近かそれ以下まで下がる。**≤45m は最終ラインの数字の誤用だった**" },
  { key: "defBehind", stat: "p50", lo: 7, hi: 10, label: "自ゴール30m以内を相手が持つ時のボール後方人数", issue: 136,
    src: "ローブロックでは非GK 8–9 人がボールより後方、1–2 人が前線に残る。"
      + "**全員は戻らない**ので上限は 10 人ちょうどではなく、下限 7 人（＝前残り 3 人まで許容）で見る。"
      + "窓を自ゴール 30m 以内に絞るのは、文献の 8–9 人が「押し込まれた状態」の数字だから。"
      + "20m 以内はこのエンジンでは標本が 0 件（＝そこまで深く運ばれない）ため、測れる最深の窓を採った" },
  { key: "atkLine", stat: "p50", lo: 35, hi: 55, label: "攻撃時の最終ライン高さ", issue: 138,
    src: "ミドルブロック 35–45m・ハイプレス時 52–55m。敵陣深部に運んでいる間はこの範囲まで押し上がる" },
  { key: "interLine", stat: "p50", lo: 6, hi: 16, label: "ライン間距離（ユニット重心間）", issue: 137,
    src: "ユニット間の適正距離 8–12m。ライン間で自由に受けられる距離を作らないための基準" },
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
  const aggs = {};
  for (const m of Object.values(MATCHES)) {
    aggs[m.meta.id] = shapeProbe(m);
    for (const r of shapeVerdicts(m, { agg: aggs[m.meta.id] })) all.push({ match: m.meta.id, ...r });
  }
  if (json) { console.log(JSON.stringify(all, null, 1)); }
  else {
    console.log("# 形状プローブ（判定: ✓帯の中 / ✖帯の外 / ?標本不足で測れていない）");
    for (const b of BANDS) {
      const lim = `${b.lo != null ? `${b.lo}–` : "≤"}${b.hi}`;
      console.log(`\n## ${b.label}（基準 ${lim}・#${b.issue}）\n   根拠: ${b.src}`);
      for (const r of all.filter((r) => r.key === b.key)) {
        const mark = r.verdict === "ok" ? "✓" : r.verdict === "out" ? "✖" : "?";
        console.log(`  ${mark} ${r.match.padEnd(22)} ${r.team.padEnd(4)} ${fmt(r).padStart(14)}  ${r.detail}`);
      }
    }
    // 前残りの人数は帯にしない（後方人数と同じ拘束の裏返しになるため）。
    // 代わりに**ボールの深さ別**に出す。#136 は「何人を、どこまで戻すか」をここから決める。
    console.log("\n## 参考: ボールの深さ別「ボールより後方にいる人数」中央値（帯なし・#136 の設計材料）");
    console.log("   相手が自陣でボールを持っている局面のみ。実サッカーは押し込まれるほど増え、20m 以内で 8–9 人。");
    const hdr = DEPTH_BINS.map(([lo, hi]) => `${lo}–${hi}m`.padStart(9)).join("");
    console.log(`    ${"".padEnd(27)}${hdr}`);
    for (const [id, agg] of Object.entries(aggs))
      for (const team of Object.keys(agg)) {
        const cells = agg[team].behindByDepth
          .map((b) => (b.n >= MIN_N ? `${b.behind.toFixed(1)}人` : "—").padStart(9)).join("");
        console.log(`    ${(id + " " + team).padEnd(27)}${cells}`);
      }
    const n = (v) => all.filter((r) => r.verdict === v).length;
    console.log(`\n判定: 帯の中 ${n("ok")} / 帯の外 ${n("out")} / 測れていない ${n("unmeasured")}`);
  }
}
