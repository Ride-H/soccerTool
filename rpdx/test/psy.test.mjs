// PSY レイヤー v1 — 決定論・値域・形状性質・エンジン不変
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const E = RPDX.engine, PSY = RPDX.psy;
const act = () => E.actualScenario(MATCH);
const T_SANO_GOAL = 28 * 60 + 52;      // 29' 佐野
const T_CASEMIRO = 2880 + (55 - 45) * 60 + 36; // 56' カゼミーロ

test("psy: 決定論 — 同一時刻は常に同一値（キャッシュ破棄後も）", () => {
  const a = PSY.playerAt(MATCH, act(), "JPN", 24, 3000);
  const m1 = PSY.momentumAt(MATCH, act(), 3000);
  PSY.clearCaches();
  const b = PSY.playerAt(MATCH, act(), "JPN", 24, 3000);
  const m2 = PSY.momentumAt(MATCH, act(), 3000);
  assert.deepEqual(a, b);
  assert.deepEqual(m1, m2);
});

test("psy: 値域 — 全指標が定義域に収まる（全選手×5分刻み）", () => {
  const range = E.playedRange(MATCH);
  for (const team of E.teamKeys(MATCH)) {
    for (const p of MATCH.teams[team].squad) {
      for (let t = range.t0; t <= range.t1; t += 300) {
        const st = PSY.playerAt(MATCH, act(), team, p.no, t);
        if (!st) continue;
        assert.ok(st.mf >= 0 && st.mf <= 100, `mf ${st.mf}`);
        assert.ok(st.ar >= 0 && st.ar <= 100, `ar ${st.ar}`);
        assert.ok(st.cn >= 0 && st.cn <= 100, `cn ${st.cn}`);
        assert.ok(st.hrv >= 0 && st.hrv <= 135, `hrv ${st.hrv}`);
        assert.ok(st.sns >= 0 && st.sns <= 1 && st.pns >= 0 && st.pns <= 1);
        assert.ok(Math.abs(st.ans) <= 1);
      }
    }
  }
});

test("psy: モメンタム — 佐野の先制点で日本が正・ブラジルが負に振れる", () => {
  const before = PSY.momentumAt(MATCH, act(), T_SANO_GOAL - 60);
  const after = PSY.momentumAt(MATCH, act(), T_SANO_GOAL + 45);
  assert.ok(after.JPN > before.JPN + 0.5, `JPN ${before.JPN} -> ${after.JPN}`);
  assert.ok(after.BRA < before.BRA - 0.3, `BRA ${before.BRA} -> ${after.BRA}`);
  assert.ok(after.JPN > 0 && after.BRA < 0);
});

test("psy: モメンタム — 忘却減衰（イベント5分後は振れが半分以下）", () => {
  const at1 = PSY.momentumAt(MATCH, act(), T_SANO_GOAL + 10).JPN;
  const at2 = PSY.momentumAt(MATCH, act(), T_SANO_GOAL + 360).JPN;
  assert.ok(at2 < at1 * 0.55, `${at1} -> ${at2}`);
});

test("psy: 覚醒 — 失点直後に守備側の覚醒が上がる（activation）", () => {
  const before = PSY.playerAt(MATCH, act(), "JPN", 22, T_CASEMIRO - 60);
  const after = PSY.playerAt(MATCH, act(), "JPN", 22, T_CASEMIRO + 30);
  assert.ok(after.ar > before.ar + 8, `${before.ar} -> ${after.ar}`);
});

test("psy: 得点者本人の覚醒スパイクはチームメイトより大きい", () => {
  const scorer = PSY.playerAt(MATCH, act(), "JPN", 24, T_SANO_GOAL + 30);
  const mate = PSY.playerAt(MATCH, act(), "JPN", 3, T_SANO_GOAL + 30);
  assert.ok(scorer.ar > mate.ar, `${scorer.ar} vs ${mate.ar}`);
});

test("psy: 精神疲労 — HTで部分回復し、後半終盤が前半終盤を上回る", () => {
  const h1end = PSY.playerAt(MATCH, act(), "JPN", 24, 2870).mf;
  const h2start = PSY.playerAt(MATCH, act(), "JPN", 24, 2940).mf;
  const h2end = PSY.playerAt(MATCH, act(), "JPN", 24, 6100).mf;
  assert.ok(h2start < h1end, `HT回復 ${h1end} -> ${h2start}`);
  assert.ok(h2end > h1end, `終盤蓄積 ${h1end} -> ${h2end}`);
});

test("psy: 集中力 — Yerkes-Dodson 逆U字（至適60が過小/過大覚醒を上回る）", () => {
  const lo = PSY.cnOf(20, 0.2, 0.2, 75);
  const mid = PSY.cnOf(60, 0.2, 0.2, 75);
  const hi = PSY.cnOf(95, 0.2, 0.2, 75);
  assert.ok(mid > lo && mid > hi, `${lo} / ${mid} / ${hi}`);
  // 技術が高いほど過覚醒に強い（至適域が広い）
  assert.ok(PSY.cnOf(90, 0.2, 0.2, 95) > PSY.cnOf(90, 0.2, 0.2, 55));
});

test("psy: 集中力 — 精神疲労で上限が下がる", () => {
  assert.ok(PSY.cnOf(60, 0.8, 0.2, 75) < PSY.cnOf(60, 0.1, 0.2, 75));
});

test("psy: HRVプロキシ — 覚醒+疲労で安静基準より低下する", () => {
  const calm = PSY.playerAt(MATCH, act(), "JPN", 24, 120);
  const stressed = PSY.playerAt(MATCH, act(), "JPN", 24, 6100);
  assert.ok(stressed.hrv < calm.hrv, `${calm.hrv} -> ${stressed.hrv}`);
});

test("psy: 未出場選手は null / 途中出場者は入場前 on=false", () => {
  assert.equal(PSY.playerAt(MATCH, act(), "JPN", 23, 3000), null); // 第3GK
  const ogawa = PSY.playerAt(MATCH, act(), "JPN", 19, 1000);       // 90+7 IN
  assert.equal(ogawa.on, false);
  const late = PSY.playerAt(MATCH, act(), "JPN", 19, 6100);
  assert.equal(late.on, true);
});

test("psy: チーム集計 — 両チーム11人・モメンタムが個別APIと一致", () => {
  const tm = PSY.teamAt(MATCH, act(), 4000);
  const mom = PSY.momentumAt(MATCH, act(), 4000);
  for (const k of E.teamKeys(MATCH)) {
    assert.equal(tm[k].n, 11);
    assert.equal(tm[k].momentum, mom[k]);
    assert.ok(tm[k].cn > 0 && tm[k].mf >= 0);
  }
});

test("psy: 読み取り専用 — psy呼び出し前後で stateAt/danger が不変", () => {
  const snap = () => JSON.stringify(E.stateAt(MATCH, act(), 1733));
  const before = snap();
  PSY.teamAt(MATCH, act(), 1733);
  PSY.playerAt(MATCH, act(), "JPN", 24, 1733);
  PSY.momentumCurve(MATCH, act());
  assert.equal(snap(), before);
});

test("engine: speedKmh — 速度上限を破らない・移動中は正", () => {
  let maxV = 0;
  for (let t = 100; t < 6000; t += 97) {
    const v = E.speedKmh(MATCH, act(), "JPN", 24, t);
    maxV = Math.max(maxV, v);
    assert.ok(v >= 0 && v < 35.7, `v=${v} at ${t}`);
  }
  assert.ok(maxV > 3, `max ${maxV}`);
});
