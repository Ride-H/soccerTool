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

/* ================= v1.1 増分（自己完結・データ不要） ================= */

test("#19 uq: しきい値スイープ — TPR/FPR は閾値上昇で単調非増加（記述的ROC）", () => {
  const sw = UQ.sweep(Object.values(MATCHES), [45, 55, 65, 75, 85]);
  assert.equal(sw.length, 5);
  for (let i = 1; i < sw.length; i++) {
    assert.ok(sw[i].tpr <= sw[i - 1].tpr + 1e-9, `TPR単調 @${sw[i].thr}`);
    assert.ok(sw[i].fpr <= sw[i - 1].fpr + 1e-9, `FPR単調 @${sw[i].thr}`);
  }
  // 低閾値ほど検知は緩い（TPR高）— 45 で全ゴール検知
  assert.equal(sw[0].fn, 0, "閾値45でゴール見逃しゼロ");
});

test("#20 filter: Kalata θ ゲインが閉形式関係を満たし θ で単調・DEFAULTS はθ由来", () => {
  for (const th of [0.5, 0.7, 0.85, 0.95]) {
    const g = FILTER.gainsFromTheta(th);
    const om = 1 - th;
    assert.ok(Math.abs(g.alpha - (1 - th ** 3)) < 1e-12);
    assert.ok(Math.abs(g.beta - 1.5 * om * om * (1 + th)) < 1e-12);
    assert.ok(Math.abs(g.gamma - 0.5 * om ** 3) < 1e-12);
    assert.ok(g.alpha > 0 && g.alpha < 1 && g.beta >= 0 && g.gamma >= 0);
  }
  // θ が大きい（平滑重視）ほど α は小さい
  assert.ok(FILTER.gainsFromTheta(0.9).alpha < FILTER.gainsFromTheta(0.6).alpha);
  // DEFAULTS は既定 θ から導出されている
  const d = FILTER.gainsFromTheta(FILTER.DEFAULT_THETA);
  assert.deepEqual(
    [FILTER.DEFAULTS.alpha, FILTER.DEFAULTS.beta, FILTER.DEFAULTS.gamma],
    [d.alpha, d.beta, d.gamma]);
});

test("#20 filter: θ 指定でもノイズ平滑（RMSE < raw×0.8）", () => {
  const truth = []; let v = 0, x = 0;
  for (let i = 0; i < 240; i++) {
    const a = i < 80 ? 3 : i < 160 ? 0 : -2.5;
    v = Math.max(0, v + a * 0.1); x += v * 0.1;
    truth.push({ t: i * 0.1, x, y: 0 });
  }
  const noisy = truth.map((s, i) => ({ t: s.t, x: s.x + (N.hash2(9, i) * 2 - 1) * 1.2, y: (N.hash2(5, i) * 2 - 1) * 1.2 }));
  const f = FILTER.abg(noisy, { theta: 0.85 });
  let seRaw = 0, seF = 0, nn = 0;
  for (let i = 10; i < truth.length; i++) { seRaw += (noisy[i].x - truth[i].x) ** 2; seF += (f[i].x - truth[i].x) ** 2; nn++; }
  assert.ok(Math.sqrt(seF / nn) < Math.sqrt(seRaw / nn) * 0.8, "θ由来ゲインでも平滑する");
});

test("#21 physio: セッション代謝負荷 loadKJ — 正・妥当域・GK<CM・決定論", () => {
  const s = PHYS.summary(MATCH, act(MATCH), "JPN", 24);
  assert.ok(s.loadKJ > 0, `loadKJ ${s.loadKJ}`);
  // 合成速度は穏やかで実測より過小（相対負荷指標）。妥当な幅のみ確認。
  assert.ok(s.loadKJ > 10 && s.loadKJ < 500, `loadKJ域 ${s.loadKJ.toFixed(0)}`);
  const gk = PHYS.summary(MATCH, act(MATCH), "JPN", 1);
  assert.ok(gk.loadKJ < s.loadKJ, `GK ${gk.loadKJ.toFixed(0)} < CM ${s.loadKJ.toFixed(0)}`);
  assert.equal(PHYS.summary(MATCH, act(MATCH), "JPN", 24).loadKJ, s.loadKJ);
});

test("#22 duel: 空中戦 — コーナーで検出・勝者はaer優位・決定論・エンジン不変", () => {
  const m = MATCH, sc = act(m), range = E.playedRange(m);
  const snap = () => JSON.stringify(E.stateAt(m, sc, 1000).players.map(p => [p.no, p.x.toFixed(3)]));
  const before = snap();
  let found = 0;
  for (let t = range.t0 + 5; t < range.t1 && found < 3; t += 0.5) {
    const st = E.stateAt(m, sc, t);
    const a = DUEL.aerialAt(st);
    if (!a) continue;
    found++;
    assert.notEqual(a.winner.team, a.loser.team);
    assert.ok(a.u > 0 && a.u <= 1);
    // 勝者の aer は敗者以上（同値は攻撃側）
    const wp = st.players.find(p => p.team === a.winner.team && p.no === a.winner.no);
    const lp = st.players.find(p => p.team === a.loser.team && p.no === a.loser.no);
    assert.ok(wp.attrs.aer >= lp.attrs.aer - 1e-9, `aer 勝者${wp.attrs.aer} ≥ 敗者${lp.attrs.aer}`);
    const a2 = DUEL.aerialAt(E.stateAt(m, sc, t));
    assert.deepEqual(a, a2);
  }
  assert.ok(found >= 1, `空中戦検出 ${found}`);
  assert.equal(snap(), before, "aerialAt はエンジン出力を変えない");
});

/* ================= #43 ファウル・カードの創発（読み取り専用） ================= */

test("#43 fouls: 創発ファウルが現実域（10〜40件/試合）・警告相当≤6・場内・範囲内", () => {
  for (const m of Object.values(MATCHES)) {
    const fouls = DUEL.foulsOf(m);
    const range = E.playedRange(m);
    assert.ok(fouls.length >= 10 && fouls.length <= 40, `${m.meta.id} ファウル ${fouls.length}`);
    assert.ok(fouls.filter(f => f.card).length <= 6, `${m.meta.id} 警告相当`);
    for (const f of fouls) {
      assert.ok(f.t > range.t0 && f.t < range.t1, "時刻が試合内");
      assert.ok(Math.abs(f.x) <= 53 && Math.abs(f.y) <= 35, "場内");
      assert.notEqual(f.winner.team, f.loser.team, "異チーム接触");
      assert.ok(f.score >= 0.42 && f.score <= 1, `score ${f.score}`);
    }
    // 時刻昇順・重複なし
    for (let i = 1; i < fouls.length; i++) assert.ok(fouls[i].t > fouls[i - 1].t);
  }
});

test("#43 fouls: 決定論（キャッシュ有無で同一）・エンジン出力不変", () => {
  const m = MATCH;
  const a = DUEL.foulsOf(m);
  DUEL.clearCaches();
  const b = DUEL.foulsOf(m);
  assert.deepEqual(a, b, "決定論");
  // 読み取り専用: foulsOf の走査が世界を変えない
  const s1 = JSON.stringify(E.stateAt(m, act(m), 1234).players.map(p => [p.no, p.x.toFixed(4)]));
  DUEL.foulsOf(m);
  const s2 = JSON.stringify(E.stateAt(m, act(m), 1234).players.map(p => [p.no, p.x.toFixed(4)]));
  assert.equal(s1, s2, "エンジン出力不変");
});

/* ================= #59 相手分析体制の脆弱性プロファイラ ================= */

test("#59 opponent: HT予算は15分に整合・スコアは1..5・決定論", () => {
  const O = RPDX.opponent;
  for (const a of Object.values(O.ARCHETYPES)) {
    const p = O.profile(a);
    const sum = p.budget.collect + p.budget.meeting + p.budget.share;
    assert.ok(Math.abs(sum - 15) < 0.01 || p.budget.share === 1 || p.budget.share === 12,
      `${a.label} 予算計 ${sum.toFixed(2)}`);
    for (const k of ["delay", "sway", "sysDep", "overall"]) {
      assert.ok(p.scores[k] >= 1 && p.scores[k] <= 5, `${a.label} ${k}=${p.scores[k]}`);
    }
    assert.deepEqual(p, O.profile(a), "決定論");
  }
});

test("#59 opponent: 単調性 — 人数↑=遅延↑・段数↑=ブレ↑・ツール依存↑=システム依存↑", () => {
  const O = RPDX.opponent;
  const base = { staff: 20, stages: 3, toolShare: 0.5, fieldShare: 0.4 };
  assert.ok(O.profile({ ...base, staff: 90 }).scores.delay > O.profile({ ...base, staff: 8 }).scores.delay, "staff→delay");
  assert.ok(O.profile({ ...base, stages: 6 }).scores.sway > O.profile({ ...base, stages: 2 }).scores.sway, "stages→sway");
  assert.ok(O.profile({ ...base, toolShare: 0.9 }).scores.sysDep > O.profile({ ...base, toolShare: 0.1 }).scores.sysDep, "tool→sysDep");
  // 共有時間は人数・段数に単調減少
  assert.ok(O.htBudget({ ...base, staff: 90, stages: 6 }).share < O.htBudget({ ...base, staff: 8, stages: 2 }).share, "share単調");
});

test("#59 opponent: アーキタイプの署名 — 人海=遅延最大・テック=依存最大・現場=総合最小", () => {
  const O = RPDX.opponent;
  const ps = Object.fromEntries(Object.entries(O.ARCHETYPES).map(([k, a]) => [k, O.profile(a)]));
  assert.ok(ps.mass.scores.delay > ps.tech.scores.delay && ps.mass.scores.delay > ps.field.scores.delay, "mass=遅延最大");
  assert.ok(ps.tech.scores.sysDep > ps.mass.scores.sysDep && ps.tech.scores.sysDep > ps.field.scores.sysDep, "tech=依存最大");
  assert.ok(ps.field.scores.overall <= ps.mass.scores.overall && ps.field.scores.overall <= ps.tech.scores.overall, "field=総合最小");
});

test("#59 opponent: パック未宣言では実チームに何も帰属しない（setupOf=null）", () => {
  const O = RPDX.opponent;
  for (const m of Object.values(MATCHES)) {
    for (const team of E.teamKeys(m)) {
      assert.equal(O.setupOf(m, team), null, `${m.meta.id} ${team} は未宣言のはず`);
    }
  }
  // 宣言時はアーキタイプ既定値とマージされる
  const fake = { teams: { X: { analysisSetup: { archetype: "tech", staff: 30 } } } };
  const s = O.setupOf(fake, "X");
  assert.equal(s.staff, 30);
  assert.equal(s.toolShare, O.ARCHETYPES.tech.toolShare);
});

/* ================= #60 リアルタイム意思決定負荷 ================= */

test("#60 ifl: 情報フロー圧はイベント近傍で上がる・有界・決定論", () => {
  const O = RPDX.opponent;
  for (const m of Object.values(MATCHES)) {
    const range = E.playedRange(m);
    const goals = m.events.filter(e => e.type === "goal").map(e => e.t);
    let gSum = 0, gN = 0, qSum = 0, qN = 0;
    for (let t = 60; t < range.t1; t += 16) {
      const v = O.iflAt(m, null, t);
      assert.ok(v >= 0 && v <= 1.2, `IFL域 ${v}`);
      if (goals.some(g => Math.abs(t - g) < 50)) { gSum += v; gN++; }
      else if (goals.every(g => Math.abs(t - g) > 180)) { qSum += v; qN++; }
    }
    assert.ok(gSum / gN > qSum / qN + 0.05,
      `${m.meta.id} ゴール近傍IFL ${(gSum / gN).toFixed(3)} > 静穏 ${(qSum / qN).toFixed(3)}`);
    assert.equal(O.iflAt(m, null, 1234), O.iflAt(m, null, 1234), "決定論");
  }
});

test("#60 saturation: 人海戦術型が最も飽和・極端体制ではHT持ち込み(backlog)が発生", () => {
  const O = RPDX.opponent;
  const m = MATCH;
  const sat = (setup) => O.htSaturation(m, null, setup);
  const s = Object.fromEntries(Object.entries(O.ARCHETYPES).map(([k, a]) => [k, sat(a)]));
  assert.ok(s.mass.meanSat > s.tech.meanSat && s.mass.meanSat > s.field.meanSat,
    `mass最飽和 ${s.mass.meanSat.toFixed(2)} vs tech ${s.tech.meanSat.toFixed(2)} / field ${s.field.meanSat.toFixed(2)}`);
  // 極端体制（超大人数×多段）は処理が溢れ、HT実質共有時間が削られる
  const extreme = sat({ staff: 140, stages: 6, toolShare: 0.3, fieldShare: 0.4 });
  assert.ok(extreme.backlog > 0, `extreme backlog ${extreme.backlog.toFixed(2)}分`);
  assert.ok(extreme.shareEff < extreme.share, "実質共有 < 予算共有");
  // 飽和は人数に単調
  assert.ok(sat({ staff: 100, stages: 3 }).meanSat > sat({ staff: 8, stages: 3 }).meanSat, "staff単調");
});

test("#60 cognitive: HT変更点数の計上と過負荷判定（actualはキャパ内）", () => {
  const O = RPDX.opponent;
  const c = O.htCognitive(MATCH, null, "BRA");
  assert.ok(c.changes >= 1, `BRA HT変更 ${c.changes}（46'交代など）`);
  assert.equal(c.capacity, 3);
  assert.equal(c.overload, Math.max(0, c.changes - 3));
  // 交代を盛った what-if では過負荷が検出される
  const sc = structuredClone(E.actualScenario(MATCH));
  delete sc.actual; sc.id = "cog-test";
  const h2 = MATCH.time.h2.start;
  sc.subs.JPN = [
    { t: h2 + 10, out: 13, in: 8 }, { t: h2 + 20, out: 11, in: 25 },
    { t: h2 + 30, out: 14, in: 17 }, { t: h2 + 40, out: 15, in: 6 },
  ];
  const c2 = O.htCognitive(MATCH, sc, "JPN");
  assert.ok(c2.changes >= 4 && c2.overload >= 1, `過負荷検出 ${JSON.stringify(c2)}`);
});
