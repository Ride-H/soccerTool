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

// 「劣勢側=カウンター型」の物語性質は**支配が明確な試合（優勢側シェア≥55%）**の性質。
// 拮抗試合（例: 49/51 の FRA-ESP — ビハインド側が終盤に押し込みプレスを増やす）では
// 成立しないのが実態に忠実なため、支配度で場合分けする（既存2試合は従来どおり厳格適用）。
const dominantShare = (m) => {
  const st = E.possessionStats(m, act(m), E.playedRange(m).t1);
  return st[m.possessionPlus];
};

test("#32 phases: フェーズ配分が物語と整合（支配明確: 劣勢側=BT比高 / 拮抗: 健全域）", () => {
  for (const m of Object.values(MATCHES)) {
    const sh = T.phaseShares(m, act(m));
    const plus = m.possessionPlus;                 // 優勢側
    const minus = E.oppOf(m, plus);
    const frac = (team, ph) => {
      const s = sh[team]; const tot = T.PHASES.reduce((a, p) => a + s[p], 0);
      return s[ph] / tot;
    };
    const minusBT = frac(minus, "build-up") + frac(minus, "transition");
    const plusBT = frac(plus, "build-up") + frac(plus, "transition");
    if (dominantShare(m) >= 0.55) {
      // 劣勢側はビルドアップ+トランジションの比率が優勢側より高い（カウンター型）
      assert.ok(minusBT > plusBT, `${m.meta.id} 劣勢側BT ${minusBT.toFixed(2)} > 優勢側 ${plusBT.toFixed(2)}`);
      // 優勢側は前進+仕上げが過半
      assert.ok(frac(plus, "progression") + frac(plus, "finishing") > 0.5,
        `${m.meta.id} 優勢側の前進+仕上げ`);
    } else {
      // 拮抗試合: 両者のBT比が健全域（極端な一方向にならない）
      for (const [k, v] of [[plus, plusBT], [minus, minusBT]])
        assert.ok(v > 0.08 && v < 0.6, `${m.meta.id} ${k} BT比 ${v.toFixed(2)} 健全域`);
    }
    // 全フェーズ合計 ≈ 実プレー時間の大半（保持がどちらかに常にある）
    const total = E.teamKeys(m).reduce((a, k) => a + T.PHASES.reduce((x, p) => x + sh[k][p], 0), 0);
    const played = E.playedRange(m).t1 - E.playedRange(m).t0;
    assert.ok(total > played * 0.9, `${m.meta.id} 網羅 ${Math.round(total)}/${Math.round(played)}s`);
  }
});

test("#32 phases: プレス実績 — 支配明確な試合は優勢側に計上・拮抗試合は双方が有意", () => {
  for (const m of Object.values(MATCHES)) {
    const sh = T.phaseShares(m, act(m));
    const plus = m.possessionPlus, minus = E.oppOf(m, plus);
    if (dominantShare(m) >= 0.55) {
      assert.ok(sh[plus].press > sh[minus].press,
        `${m.meta.id} press ${plus}:${sh[plus].press}s > ${minus}:${sh[minus].press}s`);
    } else {
      // 拮抗試合（終盤に劣勢側が押し込む展開を含む）: 双方が有意にプレスする
      assert.ok(sh[plus].press > 30 && sh[minus].press > 30,
        `${m.meta.id} press ${plus}:${sh[plus].press}s / ${minus}:${sh[minus].press}s`);
    }
  }
});

test("#32 phases: phaseStrip がタイムライン描画用の完全な帯を返す", () => {
  const strip = T.phaseStrip(MATCH, act(MATCH), 120);
  assert.equal(strip.length, 120);
  for (const s of strip) assert.ok(T.PHASES.includes(s.phase));
  // 複数のフェーズが出現する（単色ではない）
  assert.ok(new Set(strip.map(s => s.phase)).size >= 4, "フェーズ多様性");
});

/* ================= #33 実効フォーメーション & 形メトリクス ================= */

test("#33 shape: 値域・ライン合計10人・決定論", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = E.actualScenario(m), range = E.playedRange(m);
    for (let t = range.t0 + 60; t < range.t1; t += 397) {
      for (const team of E.teamKeys(m)) {
        const st = E.stateAt(m, sc, t);
        const s = T.shapeFromState(m, st, team);
        // ラインは「その瞬間フィールド上の非GK・非入場中の選手」を過不足なく分割する。
        // 退場（10人）・交代の入場走り込み中はいずれも母集団が減る（#141 対応）。
        const outfield = st.players.filter(p => p.onPitch && !p.entering && p.team === team && p.role !== "GK").length;
        assert.ok(s.width > 15 && s.width < 70, `width ${s.width}`);
        assert.ok(s.depth > 10 && s.depth < 80, `depth ${s.depth}`);
        assert.ok(s.area > 200 && s.area < 4500, `area ${s.area}`);
        assert.equal(s.lines.reduce((a, b) => a + b, 0), outfield, "アウトフィールド人数(退場/入場反映)");
        assert.ok(/^\d+-\d+(-\d+)?$/.test(s.effShape), s.effShape);
        assert.deepEqual(s, T.shapeMetrics(m, sc, team, t), "決定論");
      }
    }
  }
});

test("#33 shape: 物語整合 — 守備側は攻撃側よりコンパクト（面積小・ライン間狭い）", () => {
  const m = MATCH, sc = E.actualScenario(m);
  let ok = 0, n = 0;
  for (const t of [1200, 2000, 3480, 4200, 5000]) {
    const j = T.shapeMetrics(m, sc, "JPN", t), b = T.shapeMetrics(m, sc, "BRA", t);
    n++;
    if (j.area < b.area && j.lineGap < b.lineGap) ok++;
  }
  assert.ok(ok / n >= 0.8, `コンパクト率 ${ok}/${n}`);
});

test("#33 voronoi: 占有は合計100%・優勢側が過半・決定論", () => {
  const m = MATCH, sc = E.actualScenario(m);
  for (const t of [800, 3480, 5200]) {
    const v = T.voronoiShare(m, sc, t);
    const keys = E.teamKeys(m);
    assert.ok(Math.abs(v[keys[0]] + v[keys[1]] - 1) < 1e-9, "合計100%");
    assert.deepEqual(v, T.voronoiShare(m, sc, t), "決定論");
  }
  let sum = 0, n = 0;
  for (let t = 300; t < 5000; t += 300) { sum += T.voronoiShare(m, sc, t).BRA; n++; }
  assert.ok(sum / n > 0.5, `BRA平均占有 ${(100 * sum / n).toFixed(0)}%`);
});
