// 異分野輸入モジュール（#19 uq / #20 filter / #21 physio / #22 duel）v1
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, UQ = RPDX.uq, FILTER = RPDX.filter, PHYS = RPDX.physio, DUEL = RPDX.duel;
const N = RPDX.noise;
const act = (m) => E.actualScenario(m);

/* ---------------- #19 UQ ---------------- */
test("#19 uq: Wilson区間 — 閉形式の基本性質（単調・被覆・n増で収縮）", () => {
  const w1 = UQ.wilson(8, 8);
  assert.ok(w1.p === 1 && w1.lo > 0.7 && w1.hi === 1);
  const w2 = UQ.wilson(4, 100);
  assert.ok(w2.lo < 0.04 && w2.hi > 0.04 && w2.hi < 0.10);
  const wSmall = UQ.wilson(4, 10), wBig = UQ.wilson(40, 100);
  assert.ok((wBig.hi - wBig.lo) < (wSmall.hi - wSmall.lo), "nが大きいほど区間が狭い");
});

test("#19 uq: 全収録試合の警報評価 — TPR=100%・FPR低・スキル正（区間つき断定の実体）", () => {
  const r = UQ.evaluate(Object.values(MATCHES));
  assert.equal(r.tp, 8, "8ゴール全て検知");
  assert.equal(r.fn, 0);
  assert.ok(r.fpr.p <= 0.10, `FPR ${r.fpr.p}`);
  assert.ok(r.skill > 0, `スキル ${r.skill}`);
  assert.ok(r.tpr.lo > 0.7, "TPR下限も高い（n=8のWilson下限）");
  // 決定論
  const r2 = UQ.evaluate(Object.values(MATCHES));
  assert.deepEqual(
    [r.tp, r.fp, r.brier.toFixed(10)],
    [r2.tp, r2.fp, r2.brier.toFixed(10)]);
  assert.ok(UQ.reportText(r).includes("90%CI"));
});

/* ---------------- #20 filter ---------------- */
test("#20 filter: α-β-γ — 決定論ノイズでRMSE改善・欠測コーストが破綻しない", () => {
  // 真値: 加速→等速→減速の1次元運動（y=0） + 決定論ノイズ
  const truth = [];
  let v = 0, x = 0;
  for (let i = 0; i < 240; i++) {
    const t = i * 0.1;
    const a = i < 80 ? 3 : i < 160 ? 0 : -2.5;
    v = Math.max(0, v + a * 0.1);
    x += v * 0.1;
    truth.push({ t, x, y: 0, v });
  }
  const noisy = truth.map((s, i) => ({
    t: s.t,
    x: (i >= 100 && i < 118) ? null : s.x + (N.hash2(42, i) * 2 - 1) * 1.2,   // 1.8s欠測
    y: (i >= 100 && i < 118) ? null : (N.hash2(77, i) * 2 - 1) * 1.2,
  }));
  const f = FILTER.abg(noisy);
  let seRaw = 0, seF = 0, nn = 0, coastErr = 0, nCoast = 0;
  for (let i = 10; i < truth.length; i++) {
    if (noisy[i].x != null) {
      seRaw += (noisy[i].x - truth[i].x) ** 2;
      seF += (f[i].x - truth[i].x) ** 2;
      nn++;
    } else {
      coastErr = Math.max(coastErr, Math.abs(f[i].x - truth[i].x));
      nCoast++;
      assert.ok(f[i].coast);
    }
  }
  const rmseRaw = Math.sqrt(seRaw / nn), rmseF = Math.sqrt(seF / nn);
  assert.ok(rmseF < rmseRaw * 0.75, `RMSE ${rmseF.toFixed(3)} vs raw ${rmseRaw.toFixed(3)}`);
  assert.ok(nCoast === 18 && coastErr < 3.5, `コースト最大誤差 ${coastErr.toFixed(2)}m`);
  // 決定論
  const f2 = FILTER.abg(noisy);
  assert.deepEqual(f.map(s => s.x), f2.map(s => s.x));
});

/* ---------------- #21 physio ---------------- */
test("#21 physio: ECコスト式 — 等速3.6・加速で増・減速はコスト減だが正", () => {
  const ec0 = PHYS.ecCost(0);
  assert.ok(Math.abs(ec0 - 3.6) < 0.01);
  assert.ok(PHYS.ecCost(0.2) > ec0);
  const dec = PHYS.ecCost(-0.2);
  assert.ok(dec > 0.5 && dec < ec0);
});

test("#21 physio: 佐野のサマリ — スプリント検出・妥当域・決定論", () => {
  const s = PHYS.summary(MATCH, act(MATCH), "JPN", 24);
  assert.ok(s.avgP >= 3 && s.avgP <= 14, `avgP ${s.avgP.toFixed(2)} W/kg`);
  assert.ok(s.peakV >= 5.4, `peakV ${(s.peakV * 3.6).toFixed(1)} km/h — 独走がスプリントとして出る`);
  assert.ok(s.hsr > 20, `HSR ${s.hsr.toFixed(0)}m`);   // 3秒サンプラの粗い推定（下限のみ）
  assert.ok(s.mins > 90);
  const s2 = PHYS.summary(MATCH, act(MATCH), "JPN", 24);
  assert.equal(s, s2, "キャッシュ命中（決定論）");
});

test("#21 physio: GKは低負荷・未出場はnull", () => {
  const gk = PHYS.summary(MATCH, act(MATCH), "JPN", 1);
  const cm = PHYS.summary(MATCH, act(MATCH), "BRA", 8);
  assert.ok(gk.avgP < cm.avgP, `GK ${gk.avgP.toFixed(2)} < CM ${cm.avgP.toFixed(2)}`);
  assert.equal(PHYS.summary(MATCH, act(MATCH), "JPN", 23), null);
});

/* ---------------- #22 duel ---------------- */
test("#22 duel: タックル抽出 — 発生・勝者敗者が異チーム・決定論・リスタート除外", () => {
  const m = MATCH;
  const sc = act(m);
  const range = E.playedRange(m);
  let found = 0;
  for (let t = range.t0 + 10; t < range.t1 && found < 40; t += 2) {
    const d = DUEL.tackleAt(m, sc, t);
    if (!d) continue;
    found++;
    assert.notEqual(d.winner.team, d.loser.team);
    assert.ok(d.u > 0 && d.u <= 1);
    const d2 = DUEL.tackleAt(m, sc, t);
    assert.deepEqual(d, d2);
  }
  assert.ok(found >= 20, `タックル検出 ${found}`);
});

test("#22 duel: シールド判定 — 保持者と最近接プレッサー・4.5m境界", () => {
  const m = MATCH;
  const sc = act(m);
  let n = 0;
  for (let t = 200; t < 5800 && n < 25; t += 37) {
    const st = E.stateAt(m, sc, t);
    const sh = DUEL.shieldAt(st);
    if (!sh) continue;
    n++;
    assert.ok(sh.dist <= 4.5);
    assert.notEqual(sh.holder.team, sh.presser.team);
  }
  assert.ok(n >= 10, `シールド局面 ${n}`);
});
