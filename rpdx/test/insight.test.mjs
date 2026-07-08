// Issue #9/#11/#13/#14 + #2 out-of-sample — 新解析APIの性質テスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger, PSY = RPDX.psy;
const act = (m) => E.actualScenario(m);

/* ---------- #13 幾何のみモード ---------- */
test("#13: 幾何のみモードで危険度・ゾーン支配が変化し、戻すと完全一致", () => {
  const sc = act(MATCH);
  // 複数時刻をスキャンして効果量を確認（pace分布の効く局面で差が出る）
  let maxDiff = 0, tAt = 0;
  for (let t = 400; t < 6000; t += 400) {
    const a = D.indexAt(MATCH, sc, t);
    D.setGeomOnly(true);
    const g = D.indexAt(MATCH, sc, t);
    D.setGeomOnly(false);
    for (const k of E.teamKeys(MATCH)) {
      const d = Math.abs(a[k].total - g[k].total);
      if (d > maxDiff) { maxDiff = d; tAt = t; }
    }
  }
  assert.ok(maxDiff > 0.5, `効果量 max|Δ|=${maxDiff.toFixed(3)}`);
  // ゾーン支配のセル所有も変わる（influence の直接の利用箇所）
  const st = E.stateAt(MATCH, sc, 3000);
  const z1 = D.zoneField(MATCH, st);
  D.setGeomOnly(true);
  const z2 = D.zoneField(MATCH, st);
  D.setGeomOnly(false);
  let own = 0;
  for (let i = 0; i < z1.owner.length; i++) if (z1.owner[i] !== z2.owner[i]) own++;
  assert.ok(own > 5, `所有変化セル ${own}`);
  // 既定モードへ戻すと完全一致（決定論）
  const a1 = D.indexAt(MATCH, sc, tAt);
  const a2 = D.indexAt(MATCH, sc, tAt);
  assert.deepEqual(a1[E.teamKeys(MATCH)[0]].total, a2[E.teamKeys(MATCH)[0]].total);
});

test("#13: 幾何のみモードでも決定論・曲線キャッシュが混ざらない", () => {
  D.setGeomOnly(true);
  const c1 = D.curve(MATCH, act(MATCH), { step: 8, includeGK: false });
  const c1b = D.curve(MATCH, act(MATCH), { step: 8, includeGK: false });
  assert.equal(c1, c1b, "同一モードはキャッシュ命中");
  D.setGeomOnly(false);
  const c0 = D.curve(MATCH, act(MATCH), { step: 8, includeGK: false });
  assert.notEqual(c0, c1, "モード別に別曲線");
});

/* ---------- #9 意思決定困難度 ---------- */
test("#9: 意思決定負荷 — 値域・決定論・フライト時はnull", () => {
  const sc = act(MATCH);
  let holds = 0;
  for (let t = 200; t < 6000; t += 157) {
    const dd = PSY.decisionAt(MATCH, sc, t);
    const c = E.carrierAt(MATCH, sc, t);
    if (!c || c.mode !== "hold") { assert.equal(dd, null); continue; }
    assert.ok(dd.dd >= 0 && dd.dd <= 100);
    assert.ok(Number.isInteger(dd.options) && dd.options >= 0);
    assert.ok(dd.presserDist > 0);
    const dd2 = PSY.decisionAt(MATCH, sc, t);
    assert.deepEqual(dd, dd2);
    holds++;
  }
  assert.ok(holds > 15, `hold sample ${holds}`);
});

/* ---------- #14 保持シーケンス蓄積 ---------- */
test("#14: シーケンス — ターンオーバーで開始時刻がリセットされ、蓄積は非負", () => {
  const m = MATCHES["wc2026-r16-arg-egy"];
  const sc = act(m);
  let flips = 0, prev = null;
  for (let t = 100; t < 6000; t += 23) {
    const sq = D.seqAccumAt(m, sc, t, { includeGK: false });
    if (!sq) { prev = null; continue; }
    assert.ok(sq.accum >= 0 && sq.passes >= 1);
    assert.ok(sq.t0 <= t + 1e-9);
    if (prev && prev.team !== sq.team) {
      assert.ok(sq.t0 >= prev.t0, "新シーケンスは後から始まる");
      flips++;
    }
    prev = sq;
  }
  assert.ok(flips > 10, `ターンオーバー検出 ${flips}`);
});

/* ---------- #11 パスネットワーク ---------- */
test("#11: パスネットワーク — 次数総和=2×パス数・決定論・上位ペア降順", () => {
  const range = E.playedRange(MATCH);
  const net = E.passNetwork(MATCH, act(MATCH), range.t1);
  for (const k of E.teamKeys(MATCH)) {
    const T = net[k];
    assert.ok(T.total > 50, `${k} パス数 ${T.total}`);
    let dgSum = 0;
    for (const [, dg] of T.degree) dgSum += dg;
    assert.equal(dgSum, 2 * T.total);
    for (let i = 1; i < T.pairs.length; i++) assert.ok(T.pairs[i - 1].n >= T.pairs[i].n);
    // 全ノードがスカッドに実在
    for (const { a, b } of T.pairs) {
      assert.ok(MATCH.teams[k].squad.some(p => p.no === a));
      assert.ok(MATCH.teams[k].squad.some(p => p.no === b));
    }
  }
  const net2 = E.passNetwork(MATCH, act(MATCH), range.t1);
  assert.equal(net, net2, "キャッシュ命中（決定論）");
});

/* ---------- #2 out-of-sample: 較正外試合での挙動 ---------- */
test("#2: ARG-EGY（較正未使用）でも全ゴール直前にCRITICAL到達・低ベースレート維持", () => {
  const m = MATCHES["wc2026-r16-arg-egy"];
  const sc = act(m);
  const pts = D.curve(m, sc, { step: 8, includeGK: false });
  const at = (t, team) => {
    const i = Math.max(0, Math.min(pts.length - 1, Math.round((t - pts[0].t) / 8)));
    return pts[i].v[team];
  };
  for (const ev of m.events) {
    if (ev.type !== "goal") continue;
    let peak = 0;
    for (let t = ev.t - 32; t <= ev.t + 4; t += 4) peak = Math.max(peak, at(t, ev.team));
    assert.ok(peak >= D.CRIT_AT, `${ev.min} ${ev.team} 直前ピーク ${peak.toFixed(1)} < CRIT`);
  }
  // 判別性: CRITICAL は稀（≤2%）— 常時鳴る警報ではない
  let crit = 0;
  for (const p of pts) for (const k of Object.keys(p.v)) if (p.v[k] >= D.CRIT_AT) crit++;
  assert.ok(crit / (pts.length * 2) <= 0.02, `CRITICAL率 ${(100 * crit / (pts.length * 2)).toFixed(1)}%`);
});
