// リプレイ評価ハーネス — 収録試合を頭から終わりまで「時間軸に沿って」走らせ、
// 見た目ではなく振る舞いを採点する。
//
//   実行: node rpdx/tools/replay-eval.mjs                （全試合・既定の粗さ）
//         node rpdx/tools/replay-eval.mjs --dt=0.25      （細かく刻む）
//         node rpdx/tools/replay-eval.mjs --match=wc2026-final-esp-arg
//         node rpdx/tools/replay-eval.mjs --json=out.json（機械可読の出力＝前回との差分用）
//
// なぜ要るか: 単体テストは「ある時刻」を点で見る。画面キャプチャは「ある一枚」を見る。
// どちらも、試合が進むあいだに起きる破綻（危険度が飛ぶ・保持者がちらつく・助言が固まる・
// 実時間に間に合わない）を捕まえられない。ここは時系列そのものを検査する。
//
// 判定は 2 種類:
//   NG   … 破綻。終了コードに数える（NaN・場外・速度超過・人数欠け・瞬間移動 等）
//   WARN … 帯を外れているが仕様として未充足と分かっているもの（形状帯 #136-138 など）
import { readFileSync, writeFileSync } from "node:fs";
import { RPDX, MATCHES } from "../test/load.mjs";
import { isKnown } from "../spec/replay-known.mjs";

const { engine: E, danger: D, tactics: T } = RPDX;
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const DT = Number(arg("dt", 0.5));          // 運動学の刻み[s]
const DT_SLOW = Number(arg("dtSlow", 6));   // 危険度・助言の刻み[s]（重いので粗く）
const ONLY = arg("match", null);
const JSON_OUT = arg("json", null);

const PITCH_X = 52.5 + 3, PITCH_Y = 34 + 3;   // 場外判定の許容（タッチライン外の助走を許す）
const V_MAX = 9.9;

const report = { generatedAt: new Date().toISOString(), dt: DT, matches: [] };
let ngTotal = 0, warnTotal = 0;

for (const [id, match] of Object.entries(MATCHES)) {
  if (ONLY && id !== ONLY) continue;
  const sc = E.actualScenario(match);
  const range = E.playedRange(match);
  const keys = E.teamKeys(match);
  const ng = [], warn = [];
  const add = (list, msg) => { if (list.length < 8) list.push(msg); };   // 同種の洪水を防ぐ

  /* ---- 1) 運動学の走査（毎 DT 秒）---- */
  let prev = null, prevBall = null, samples = 0;
  let vMaxSeen = 0, ballMaxStep = 0, minPair = 1e9, minPairAt = "";
  const wall0 = process.hrtime.bigint();
  for (let t = range.t0; t <= range.t1; t += DT) {
    const st = E.stateAt(match, sc, t);
    samples++;
    // 交代の前後は退く選手と入る選手が同時に players に載る。ピッチ上の 11 人だけを見る
    // （ここを取り違えると「12 人居る」と誤検出する。入場中はタッチライン外から走り込む）。
    const on = st.players.filter((p) => p.onPitch);
    for (const k of keys) {
      const n = on.filter((p) => p.team === k).length;
      // 退場があれば 10 人が正しい。エンジン自身の名簿（rosterAt）と突き合わせる
      const want = Object.keys(E.rosterAt(match, sc, k, Math.max(t, 0.01)).assign || {}).length;
      if (n !== want) add(ng, `t=${t.toFixed(0)} ${k} が ${n} 人（名簿は ${want} 人）`);
      if (on.filter((p) => p.team === k && p.role === "GK").length !== 1) add(ng, `t=${t.toFixed(0)} ${k} の GK が 1 人でない`);
    }
    for (const p of on) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { add(ng, `t=${t.toFixed(0)} ${p.team}#${p.no} の座標が NaN`); continue; }
      if (p.entering > 0) continue;
      if (Math.abs(p.x) > PITCH_X || Math.abs(p.y) > PITCH_Y) add(ng, `t=${t.toFixed(0)} ${p.team}#${p.no} が場外 (${p.x.toFixed(1)},${p.y.toFixed(1)})`);
    }
    if (!Number.isFinite(st.ball.x) || !Number.isFinite(st.ball.y) || !Number.isFinite(st.ball.z))
      add(ng, `t=${t.toFixed(0)} ボール座標が NaN`);
    // 速度上限（ハーフ境界と入退場をまたぐ組は除外）
    if (prev && Math.abs(t - prev.t - DT) < 1e-9 && st.half === prev.half) {
      const byNo = new Map(prev.players.filter((p) => p.onPitch && !p.entering).map((p) => [p.team + p.no, p]));
      for (const p of on) {
        if (p.entering > 0) continue;
        const q = byNo.get(p.team + p.no); if (!q) continue;
        const v = Math.hypot(p.x - q.x, p.y - q.y) / DT;
        vMaxSeen = Math.max(vMaxSeen, v);
        if (v > V_MAX + 0.05) add(ng, `t=${t.toFixed(0)} ${p.team}#${p.no} が ${v.toFixed(2)}m/s（上限 ${V_MAX}）`);
      }
      const bs = Math.hypot(st.ball.x - prevBall.x, st.ball.y - prevBall.y);
      ballMaxStep = Math.max(ballMaxStep, bs / DT);
    }
    // すり抜け（最小ペア距離）は重いので 30 秒ごとに抜き取り
    if (Math.abs(t % 30) < DT / 2) {
      const live = on.filter((p) => !p.entering);
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const d = Math.hypot(live[i].x - live[j].x, live[i].y - live[j].y);
        if (d < minPair) { minPair = d; minPairAt = `t=${t.toFixed(0)} ${live[i].team}#${live[i].no}/${live[j].team}#${live[j].no}`; }
      }
    }
    prev = st; prevBall = st.ball;
  }
  const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
  const simSec = range.t1 - range.t0;
  const rtFactor = simSec / (wallMs / 1000);   // 1 を超えれば実時間より速く回せる

  /* ---- 2) 解釈レイヤーの走査（毎 DT_SLOW 秒）---- */
  let prevIdx = null, maxIdxJump = 0, holderFlips = 0, prevHolder = null;
  const adviceKinds = new Set();
  let adviceEmpty = 0, adviceSamples = 0;
  for (let t = range.t0; t <= range.t1; t += DT_SLOW) {
    const ix = D.indexAt(match, sc, t);
    for (const k of keys) {
      const v = ix[k].total;
      if (!Number.isFinite(v)) { add(ng, `t=${t.toFixed(0)} 危険度が NaN（${k}）`); continue; }
      if (v < 0 || v > 100) add(ng, `t=${t.toFixed(0)} 危険度が範囲外 ${v.toFixed(1)}（${k}）`);
      if (prevIdx) maxIdxJump = Math.max(maxIdxJump, Math.abs(v - prevIdx[k].total));
    }
    prevIdx = ix;
    const st = E.stateAt(match, sc, t);
    const holder = st.carrier ? `${st.carrier.team}#${st.carrier.no}` : null;
    if (prevHolder !== null && holder !== prevHolder) holderFlips++;
    prevHolder = holder;
    for (const team of keys) {
      const a = T.frameAnalysis(match, st, { team });
      adviceSamples++;
      if (!a || !a.suggestions || !a.suggestions.length) { adviceEmpty++; continue; }
      for (const s of a.suggestions) {
        adviceKinds.add(s.exploits);
        if (!Number.isFinite(s.severity)) add(ng, `t=${t.toFixed(0)} 助言の severity が NaN（${team}）`);
        if (typeof s.text !== "string" || !s.text) add(ng, `t=${t.toFixed(0)} 助言の本文が空（${team}）`);
      }
    }
  }
  if (adviceEmpty) add(ng, `助言が空の標本が ${adviceEmpty}/${adviceSamples} 件`);
  if (adviceKinds.size <= 1) add(warn, `助言の種類が ${adviceKinds.size} 種しか出ない（固まっている疑い）`);

  /* ---- 3) 記録イベントとの整合（全ゴールの直前が CRITICAL）---- */
  for (const ev of match.events.filter((e) => e.type === "goal")) {
    // ピークは鋭いので 1 秒刻みで見る（粗く刻むと山を跨いで見落とす）
    let peak = 0;
    for (let t = Math.max(range.t0, ev.t - 14); t <= ev.t + 1; t += 1) peak = Math.max(peak, D.indexAt(match, sc, t)[ev.team].total);
    if (peak < D.CRIT_AT) add(ng, `${ev.min} のゴール直前に CRITICAL へ達していない（peak ${peak.toFixed(1)} < ${D.CRIT_AT}）`);
  }

  /* ---- 4) 形状帯（#135 エピック・未充足なので WARN）---- */
  const shape = {};
  try {
    const probe = (await import("./shape-probe.mjs")).shapeProbe;
    const agg = probe(match);
    for (const k of keys) {
      const a = agg[k]; if (!a) continue;
      shape[k] = { attLine: a.attLine?.p50, defFront: a.defFront?.p50, defCompact: a.defCompact?.p50 };
      if (a.defFront?.p50 > 45) add(warn, `${k} 守備時の前線 ${a.defFront.p50.toFixed(1)}m（基準 ≤45・#136）`);
      if (a.defCompact?.p50 > 40) add(warn, `${k} 守備時コンパクトネス ${a.defCompact.p50.toFixed(1)}m（基準 25–40・#137）`);
      if (a.attLine?.p50 < 35) add(warn, `${k} 攻撃時の最終ライン ${a.attLine.p50.toFixed(1)}m（基準 35–50・#138）`);
    }
  } catch (e) { add(warn, `形状プローブを実行できない: ${e.message}`); }

  // 既知の破綻（原因特定済み・台帳に登録）は「新規」に数えない
  const fresh = ng.filter((m) => !isKnown(m));
  const known = ng.filter((m) => isKnown(m));
  ngTotal += fresh.length; warnTotal += warn.length;
  report.matches.push({
    id, samples, simSec: +simSec.toFixed(0), wallMs: +wallMs.toFixed(0), rtFactor: +rtFactor.toFixed(1),
    vMaxSeen: +vMaxSeen.toFixed(2), ballMaxStep: +ballMaxStep.toFixed(2), minPair: +minPair.toFixed(2), minPairAt,
    maxIdxJump: +maxIdxJump.toFixed(1), holderFlips, adviceKinds: [...adviceKinds], shape, ng: fresh, known, warn,
  });
}

/* ---- 出力 ---- */
console.log(`# リプレイ評価（刻み ${DT}s / 解釈 ${DT_SLOW}s）`);
for (const m of report.matches) {
  console.log(`\n## ${m.id}`);
  console.log(`  走査 ${m.samples} 点（試合 ${m.simSec}s を ${(m.wallMs / 1000).toFixed(1)}s で計算 = 実時間の ${m.rtFactor}倍速）`);
  console.log(`  最大選手速度 ${m.vMaxSeen}m/s（上限 ${V_MAX}） / ボール最大 ${m.ballMaxStep}m/s / 最小ペア距離 ${m.minPair}m（${m.minPairAt}）`);
  console.log(`  危険度の最大跳び ${m.maxIdxJump}（${DT_SLOW}s あたり） / 保持者の交代 ${m.holderFlips} 回 / 助言の種類 ${m.adviceKinds.length}`);
  for (const k of Object.keys(m.shape)) {
    const s = m.shape[k];
    console.log(`  形状 ${k}: 攻撃時ライン ${s.attLine?.toFixed?.(1) ?? "—"} / 守備時前線 ${s.defFront?.toFixed?.(1) ?? "—"} / 守備compact ${s.defCompact?.toFixed?.(1) ?? "—"}`);
  }
  for (const w of m.warn) console.log(`  △ ${w}`);
  for (const k of m.known) console.log(`  ・既知 ${isKnown(k).id}: ${k}`);
  for (const g of m.ng) console.log(`  ✖ ${g}`);
}
const knownTotal = report.matches.reduce((s2, m) => s2 + m.known.length, 0);
console.log(`\nリプレイ評価: 新規の破綻 ${ngTotal} 件 / 既知 ${knownTotal} 件 / 未充足の帯 ${warnTotal} 件`);
if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(report, null, 1)); console.log(`JSON: ${JSON_OUT}`); }
process.exit(ngTotal);
