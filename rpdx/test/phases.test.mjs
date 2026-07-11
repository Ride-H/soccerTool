// #32 戦術フェーズ自動分類 — 網羅性・決定論・物語整合
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES, MATCH } from "./load.mjs";

const E = RPDX.engine, T = RPDX.tactics;
const act = (m) => E.actualScenario(m);

test("#32 phases: 全時刻に単一フェーズが決定論で割り当たる（網羅・排他）", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = act(m), range = E.playedRange(m);
    for (let t = range.t0 + 5; t < range.t1; t += 13) {
      const p = T.phaseAt(m, sc, t);
      assert.ok(T.PHASES.includes(p.phase), `t=${t.toFixed(0)} phase=${p.phase}`);
      assert.deepEqual(p, T.phaseAt(m, sc, t), "決定論");
    }
  }
});

test("#32 phases: セットピース局面はリスタート保持と整合", () => {
  const m = MATCH, sc = act(m), range = E.playedRange(m);
  let spOk = 0, spAll = 0;
  for (let t = range.t0 + 5; t < range.t1; t += 3) {
    const c = E.carrierAt(m, sc, t);
    if (!(c && c.seg && c.seg.restart && t <= c.seg.tf + (c.seg.rdelay || 0))) continue;
    spAll++;
    if (T.phaseAt(m, sc, t).phase === "set-piece") spOk++;
  }
  assert.ok(spAll > 30 && spOk === spAll, `set-piece整合 ${spOk}/${spAll}`);
});

test("#32 phases: フェーズ配分が物語と整合（劣勢側=ビルドアップ/トランジション比が高い）", () => {
  for (const m of Object.values(MATCHES)) {
    const sh = T.phaseShares(m, act(m));
    const plus = m.possessionPlus;                 // 優勢側
    const minus = E.oppOf(m, plus);
    const frac = (team, ph) => {
      const s = sh[team]; const tot = T.PHASES.reduce((a, p) => a + s[p], 0);
      return s[ph] / tot;
    };
    // 劣勢側はビルドアップ+トランジションの比率が優勢側より高い（カウンター型）
    const minusBT = frac(minus, "build-up") + frac(minus, "transition");
    const plusBT = frac(plus, "build-up") + frac(plus, "transition");
    assert.ok(minusBT > plusBT, `${m.meta.id} 劣勢側BT ${minusBT.toFixed(2)} > 優勢側 ${plusBT.toFixed(2)}`);
    // 優勢側は前進+仕上げが過半
    assert.ok(frac(plus, "progression") + frac(plus, "finishing") > 0.5,
      `${m.meta.id} 優勢側の前進+仕上げ`);
    // 全フェーズ合計 ≈ 実プレー時間の大半（保持がどちらかに常にある）
    const total = E.teamKeys(m).reduce((a, k) => a + T.PHASES.reduce((x, p) => x + sh[k][p], 0), 0);
    const played = E.playedRange(m).t1 - E.playedRange(m).t0;
    assert.ok(total > played * 0.9, `${m.meta.id} 網羅 ${Math.round(total)}/${Math.round(played)}s`);
  }
});

test("#32 phases: プレス実績は優勢側に計上される（相手ビルドアップ時に点灯するため）", () => {
  for (const m of Object.values(MATCHES)) {
    const sh = T.phaseShares(m, act(m));
    const plus = m.possessionPlus, minus = E.oppOf(m, plus);
    assert.ok(sh[plus].press > sh[minus].press,
      `${m.meta.id} press ${plus}:${sh[plus].press}s > ${minus}:${sh[minus].press}s`);
  }
});

test("#32 phases: phaseStrip がタイムライン描画用の完全な帯を返す", () => {
  const strip = T.phaseStrip(MATCH, act(MATCH), 120);
  assert.equal(strip.length, 120);
  for (const s of strip) assert.ok(T.PHASES.includes(s.phase));
  // 複数のフェーズが出現する（単色ではない）
  assert.ok(new Set(strip.map(s => s.phase)).size >= 4, "フェーズ多様性");
});
