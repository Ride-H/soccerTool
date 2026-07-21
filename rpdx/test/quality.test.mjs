// #152 品質ティア＆滑らかさ守衛 — tier判定 / 予算表 / 劣化ラダー / ガバナ状態機械
// app/quality.mjs は DOM 非依存（環境は注入）なので Node で直接評価してテストする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
(0, eval)(readFileSync(join(root, "app", "quality.mjs"), "utf8"));
const Q = globalThis.RPDX.quality;

// GPU文字列は decideTier 側で小文字比較されるため、フィクスチャも小文字で与える
const DESKTOP = { cores: 10, width: 1680, height: 1050, dpr: 2, coarse: false, gpu: "angle (apple, angle metal renderer: apple m2 gpu)" };
const PHONE = { cores: 6, width: 390, height: 844, dpr: 3, coarse: true, gpu: "Apple GPU" };

test("#152 tier判定: デスクトップ=cinematic / モバイル=lightweight / 迷ったら軽量", () => {
  assert.equal(Q.decideTier(DESKTOP).tier, "cinematic");
  assert.equal(Q.decideTier(PHONE).tier, "lightweight");
  assert.equal(Q.decideTier({ ...DESKTOP, gpu: "Google SwiftShader" }).tier, "lightweight", "ソフトウェア描画は軽量");
  assert.equal(Q.decideTier({ ...DESKTOP, gpu: "ANGLE (Qualcomm, Adreno (TM) 740)" }).tier, "lightweight", "モバイルGPUは軽量");
  assert.equal(Q.decideTier({}).tier, "lightweight", "情報なしは保守的に軽量");
  assert.equal(Q.decideTier({ ...DESKTOP, cores: 2 }).tier, "lightweight", "低コア数は軽量");
  const ov = Q.decideTier({ ...PHONE, override: "cinematic" });
  assert.equal(ov.tier, "cinematic");
  assert.equal(ov.source, "override", "オーバーライドが最優先");
  assert.ok(Q.decideTier(DESKTOP).reasons.length > 0, "判定理由が残る");
});

test("#152 予算表: 基準値が仕様どおり（暫定・要再検証の提案値）", () => {
  const lw = Q.flagsFor("lightweight"), cin = Q.flagsFor("cinematic");
  // Lightweight（#152 基準表・boneBudget は #154 実装実測で 12→16 に改定）
  assert.equal(lw.playerTriBudget, 2500); assert.equal(lw.playerBoneBudget, 16);
  assert.equal(lw.drawCallBudget, 400); assert.equal(lw.textureMemBudgetMB, 64);
  assert.equal(lw.cpuAnimBudgetMs, 6);
  assert.equal(lw.shadowMap, false); assert.equal(lw.bloom, false);
  assert.equal(lw.hdrTonemap, false); assert.equal(lw.crowd3D, false);
  assert.ok(Math.abs(lw.frameBudgetMs - 33.4) < 0.2 && lw.frameFloorMs > lw.frameBudgetMs, "30fps目標・24fps床");
  // Cinematic（#152 基準表）
  assert.equal(cin.playerTriBudget, 15000); assert.equal(cin.playerBoneBudget, 24);
  assert.equal(cin.drawCallBudget, 1500); assert.equal(cin.textureMemBudgetMB, 512);
  assert.equal(cin.cpuAnimBudgetMs, 3);
  assert.equal(cin.shadowMap, true); assert.equal(cin.shadowMapRes, 2048);
  assert.equal(cin.bloom, true); assert.equal(cin.bloomPasses, 3); assert.equal(cin.hdrTonemap, true);
  assert.ok(Math.abs(cin.frameBudgetMs - 16.7) < 0.2, "60fps目標");
});

test("#152 劣化ラダー: 仕様順（DOF→bloom→shadow→SSAO→群衆→LOD→アニメ）・no-opはスキップ", () => {
  // DOF/SSAO を有効化した cinematic 基点で、全実効段が仕様順に現れる
  const base = Object.assign(Q.flagsFor("cinematic"), { dof: true, ssao: true });
  const seen = [];
  let prev = Q.applyLadder(base, 0);
  for (let L = 1; L <= Q.ladderIds.length; L++) {
    const cur = Q.applyLadder(base, L);
    if (JSON.stringify(cur) !== JSON.stringify(prev)) seen.push(Q.ladderIds[L - 1]);
    prev = cur;
  }
  assert.deepEqual(seen, Q.ladderIds, "DOF/SSAO有効基点では全11段が実効・仕様順どおり");
  // 底状態: 全段適用後は最軽量（影/bloom/DOF/SSAO/3D群衆すべてOFF・LOD/アニメ簡略）
  const floor = Q.applyLadder(base, Q.ladderIds.length);
  assert.equal(floor.shadowMap, false); assert.equal(floor.bloom, false);
  assert.equal(floor.dof, false); assert.equal(floor.ssao, false); assert.equal(floor.crowd3D, false);
  assert.equal(floor.playerTriBudget, 2500); assert.equal(floor.animIkFull, false); assert.equal(floor.animUpdateStride, 2);
  // lightweight 基点は大半が no-op でもエラーなく単調
  const lwFloor = Q.applyLadder(Q.flagsFor("lightweight"), Q.ladderIds.length);
  assert.equal(lwFloor.animUpdateStride, 2);
});

// 合成フレーム列を流すヘルパ（60fps相当で tSec を frameMs ぶん進める）
const feed = (gov, frameMs, seconds, t0) => {
  let t = t0;
  const changes = [];
  const n = Math.round((seconds * 1000) / frameMs);
  for (let i = 0; i < n; i++) {
    t += frameMs / 1000;
    const r = gov.tick(frameMs, t);
    if (r.changed) changes.push({ t, level: r.level });
  }
  return { t, changes };
};

test("#152 ガバナ: 持続超過で1段ずつ劣化・単発スパイクは無視", () => {
  const base = Object.assign(Q.flagsFor("cinematic"), { dof: true });
  const gov = Q.createGovernor({ base, budgetMs: base.frameBudgetMs, floorMs: base.frameFloorMs });
  // 快適域では変化しない
  let r = feed(gov, 12, 3, 0);
  assert.equal(gov.level(), 0, "予算内では劣化しない");
  // 単発スパイク（タブ切替相当）は無視される
  gov.tick(1200, r.t + 0.02);
  r = feed(gov, 12, 2, r.t + 0.04);
  assert.equal(gov.level(), 0, "スパイクでは劣化しない");
  // 持続的な超過 → 1段ずつ・最短間隔以上をあけて劣化
  const { changes } = feed(gov, 24, 12, r.t);
  assert.ok(gov.level() >= 3, `12秒の持続超過で複数段劣化（level=${gov.level()}）`);
  for (let i = 1; i < changes.length; i++) {
    assert.ok(changes[i].t - changes[i - 1].t >= Q.GOV.CHANGE_COOLDOWN_S - 1e-9,
      `変更間隔がクールダウン以上（${(changes[i].t - changes[i - 1].t).toFixed(2)}s）`);
    assert.equal(changes[i].level, changes[i - 1].level + 1, "1段ずつ");
  }
});

test("#152 ガバナ: 昇格はヒステリシス（持続8s+ロックアウト15s）・チラつかない", () => {
  const base = Object.assign(Q.flagsFor("cinematic"), { dof: true });
  const gov = Q.createGovernor({ base, budgetMs: base.frameBudgetMs, floorMs: base.frameFloorMs });
  // まず1段劣化させる
  let r = feed(gov, 24, 5, 0);
  const degraded = gov.level();
  assert.ok(degraded >= 1, "劣化済み");
  const tDeg = r.changes[r.changes.length - 1].t;   // 実際の劣化発生時刻（ロックアウトの基準）
  // 直後に快適でも、ロックアウト内は昇格しない
  r = feed(gov, 8, 10, r.t);
  assert.equal(gov.level(), degraded, "ロックアウト中は昇格しない");
  // 十分な持続で1段昇格する
  r = feed(gov, 8, 12, r.t);
  assert.equal(gov.level(), degraded - 1, "持続ヘッドルームで1段昇格");
  assert.ok(r.changes.length === 1 && r.changes[0].t - tDeg >= Q.GOV.PROMOTE_LOCKOUT_S - 1e-9, "昇格はロックアウト後");
  // 振動負荷（3s毎に交互）でフリップフロップしない: 逆方向の変更が10秒以内に対で起きない
  const gov2 = Q.createGovernor({ base, budgetMs: base.frameBudgetMs, floorMs: base.frameFloorMs });
  let t = 0; const all = [];
  for (let k = 0; k < 20; k++) {
    const ms = k % 2 === 0 ? 24 : 8;
    const rr = feed(gov2, ms, 3, t); t = rr.t;
    for (const c of rr.changes) all.push({ ...c, dir: Math.sign(c.level - (all.length ? all[all.length - 1].level : 0)) });
  }
  for (let i = 1; i < all.length; i++) {
    if (all[i].dir !== all[i - 1].dir) {
      assert.ok(all[i].t - all[i - 1].t >= 10, `方向反転は10s以上あく（${(all[i].t - all[i - 1].t).toFixed(1)}s）`);
    }
  }
});

test("#152 ガバナ: 決定論 — 同一入力列で同一遷移", () => {
  const base = Q.flagsFor("cinematic");
  const run = () => {
    const gov = Q.createGovernor({ base, budgetMs: base.frameBudgetMs, floorMs: base.frameFloorMs });
    const trace = [];
    let t = 0;
    const seq = [[12, 2], [24, 6], [40, 3], [8, 25], [24, 4]];
    for (const [ms, sec] of seq) { const r = feed(gov, ms, sec, t); t = r.t; trace.push(gov.level(), Math.round(gov.medianMs() * 100)); }
    return trace.join(",");
  };
  assert.equal(run(), run(), "ビット同一の遷移");
});

test("#152 init/refineGpu: 環境注入で公開・GPU補正は降格のみ・flagsは安定参照", () => {
  const st = Q.init({ ...DESKTOP, gpu: "" });
  assert.equal(st.tier, "cinematic");
  const flagsRef = Q.flags;                      // 利用側が保持する参照
  assert.equal(flagsRef.playerTriBudget, 15000);
  // ソフトウェア描画検出 → 軽量へ降格（同一オブジェクトが書き換わる）
  const st2 = Q.refineGpu("Google SwiftShader 4.1");
  assert.equal(st2.tier, "lightweight");
  assert.equal(Q.flags, flagsRef, "flags は同一オブジェクト");
  assert.equal(flagsRef.playerTriBudget, 2500, "中身は軽量予算へ更新");
  // 軽量 → デスクトップGPU文字列でも昇格しない（保守側のみ）
  const st3 = Q.refineGpu("NVIDIA GeForce RTX 4070");
  assert.equal(st3.tier, "lightweight", "昇格はしない");
  // オーバーライドは refine より優先
  Q.init({ ...PHONE, override: "cinematic" });
  const st4 = Q.refineGpu("Google SwiftShader");
  assert.equal(st4.tier, "cinematic", "override 中は補正しない");
  // setOverride("auto") で自動判定へ戻る
  const st5 = Q.setOverride("auto");
  assert.equal(st5.tier, "lightweight");
  assert.equal(st5.source, "auto");
});

test("#152 ガバナ実効: tick が flags を書き換え・onChange が飛ぶ", () => {
  Q.init({ ...DESKTOP, gpu: "" });
  let events = 0;
  const off = Q.onChange(() => events++);
  let t = 0;
  for (let i = 0; i < 60 * 20; i++) { t += 24 / 1000; Q.tick(24, t); }
  assert.ok(Q.state().level >= 1, "シングルトンでも劣化が働く");
  assert.ok(events >= 1, "変更通知が飛ぶ");
  assert.equal(Q.flags.bloomPasses <= 1 || Q.flags.shadowMapRes <= 1024 || Q.flags.bloom === false, true, "実フラグが劣化");
  off();
});

test("#152 build: APP に quality.mjs が render3d より前に含まれ core を汚染しない", () => {
  const src = readFileSync(join(root, "build.mjs"), "utf8");
  const appLine = src.match(/const APP = \[(.*?)\]/s)[1];
  assert.ok(appLine.includes("app/quality.mjs"), "APP に quality.mjs");
  assert.ok(appLine.indexOf("app/quality.mjs") < appLine.indexOf("app/render3d.mjs"), "render3d より前");
  const coreLine = src.match(/const CORE = \[(.*?)\]/s)[1];
  assert.ok(!coreLine.includes("quality"), "CORE には含めない（Worker 層を汚染しない）");
});
