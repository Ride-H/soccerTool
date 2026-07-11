import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const E = RPDX.engine;
const actual = () => E.actualScenario(MATCH);

test("決定論: 同一時刻の二重評価が完全一致", () => {
  for (const t of [0, 700, 1733, 2879, 2881, 4140.5, 5908, 6119]) {
    const a = E.stateAt(MATCH, null, t);
    const b = E.stateAt(MATCH, null, t);
    assert.deepEqual(
      a.players.map(p => [p.team, p.no, p.x, p.y]),
      b.players.map(p => [p.team, p.no, p.x, p.y]),
      `t=${t}`
    );
  }
});

test("常時11人×2チーム・全員ピッチ内", () => {
  for (let t = 1; t <= 6119; t += 47) {
    const st = E.stateAt(MATCH, null, t);
    for (const k of ["JPN", "BRA"]) {
      const on = st.players.filter(p => p.team === k && p.onPitch);
      assert.equal(on.length, 11, `${k} @t=${t}`);
      const gks = on.filter(p => p.role === "GK");
      assert.equal(gks.length, 1, `${k} GK @t=${t}`);
      for (const p of on) {
        if (p.entering > 0) continue; // 入場中はタッチライン外から走り込む
        assert.ok(p.x >= -52.6 && p.x <= 52.6 && p.y >= -34.1 && p.y <= 34.1,
          `${k}#${p.no} bounds @t=${t} (${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      }
    }
  }
});

test("速度上限: 全選手 9.9m/s 以下（HT境界・入退場を除く）", () => {
  const DT = 0.5, VMAX = 9.9;
  let worst = { v: 0 };
  for (const [t0, t1] of [[2, 2878], [2882, 6118]]) {
    let prev = null;
    for (let t = t0; t <= t1; t += DT) {
      const st = E.stateAt(MATCH, null, t);
      const map = new Map();
      for (const p of st.players) if (p.onPitch && p.entering === 0) map.set(p.team + p.no, p);
      if (prev) {
        for (const [k, p] of map) {
          const q = prev.get(k);
          if (!q) continue;
          const v = Math.hypot(p.x - q.x, p.y - q.y) / DT;
          if (v > worst.v) worst = { v, k, t };
          assert.ok(v <= VMAX, `${k} v=${v.toFixed(2)}m/s @t=${t}`);
        }
      }
      prev = map;
    }
  }
  // 参考値をログ（キャリブレーション用）
  console.log(`    max speed observed: ${worst.v.toFixed(2)} m/s (${worst.k} @t=${worst.t})`);
});

test("ゴール再現: 得点者がシュート地点に到達している", () => {
  // 佐野 29' — PA手前
  const s1 = E.stateAt(MATCH, null, 28 * 60 + 52);
  const sano = s1.players.find(p => p.team === "JPN" && p.no === 24);
  assert.ok(Math.hypot(sano.x - (-31.5), sano.y - 1.5) < 7, `Sano at (${sano.x.toFixed(1)},${sano.y.toFixed(1)})`);
  // カゼミーロ 56' — ファーポスト
  const tCase = 2880 + (55 - 45) * 60 + 35;
  const s2 = E.stateAt(MATCH, null, tCase);
  const casemiro = s2.players.find(p => p.team === "BRA" && p.no === 5);
  assert.ok(Math.hypot(casemiro.x - (-50.8), casemiro.y - 3.8) < 7, `Casemiro at (${casemiro.x.toFixed(1)},${casemiro.y.toFixed(1)})`);
  // マルティネッリ 90+5 — PA左
  const tMart = 2880 + (94 - 45) * 60 + 39;
  const s3 = E.stateAt(MATCH, null, tMart);
  const mart = s3.players.find(p => p.team === "BRA" && p.no === 22);
  assert.ok(Math.hypot(mart.x - (-37.5), mart.y - (-12.5)) < 7, `Martinelli at (${mart.x.toFixed(1)},${mart.y.toFixed(1)})`);
});

test("交代の実効: OUTは退場・INは入場（実試合プラン）", () => {
  const t66 = 2880 + 21 * 60;
  const before = E.stateAt(MATCH, null, t66 - 10);
  assert.ok(before.players.find(p => p.team === "JPN" && p.no === 10 && p.onPitch), "堂安 on before 66'");
  assert.ok(!before.players.find(p => p.team === "JPN" && p.no === 2 && p.onPitch), "菅原 off before 66'");
  const after = E.stateAt(MATCH, null, t66 + 60);
  assert.ok(!after.players.find(p => p.team === "JPN" && p.no === 10 && p.onPitch), "堂安 off after 66'");
  assert.ok(after.players.find(p => p.team === "JPN" && p.no === 2 && p.onPitch), "菅原 on after 66'");
  assert.ok(after.players.find(p => p.team === "BRA" && p.no === 22 && p.onPitch), "マルティネッリ on after 66'");
  // 90+7 小川IN
  const late = E.stateAt(MATCH, null, 6100);
  assert.ok(late.players.find(p => p.team === "JPN" && p.no === 19 && p.onPitch));
  assert.ok(!late.players.find(p => p.team === "JPN" && p.no === 11 && p.onPitch));
  // エンドリッキはHTから
  const h2s = E.stateAt(MATCH, null, 2940);
  assert.ok(h2s.players.find(p => p.team === "BRA" && p.no === 19 && p.onPitch));
  assert.ok(!h2s.players.find(p => p.team === "BRA" && p.no === 20 && p.onPitch), "パケタはHTで交代済");
});

test("キックオフ時: 各チームが自陣に整列", () => {
  for (const [t, label] of [[0.5, "前半"], [2880.5, "後半"]]) {
    const st = E.stateAt(MATCH, null, t);
    const half = t < 2880 ? "h1" : "h2";
    for (const p of st.players) {
      if (!p.onPitch) continue;
      const dir = MATCH.dir[p.team][half];
      // 自陣 = 攻撃方向と逆側: dir=+1 → x<+3 (許容)
      assert.ok(dir > 0 ? p.x < 4 : p.x > -4, `${label} ${p.team}#${p.no} own half x=${p.x.toFixed(1)}`);
    }
  }
});

test("ボール: アンカー時刻で正確に一致・常にピッチ近傍", () => {
  const b1 = E.ballAt(MATCH, 0);
  assert.ok(Math.hypot(b1.x, b1.y) < 0.5, "kickoff center");
  const b2 = E.ballAt(MATCH, 28 * 60 + 53);
  assert.ok(Math.hypot(b2.x - (-52.2), b2.y - 2.9) < 0.6, `goal anchor (${b2.x.toFixed(1)},${b2.y.toFixed(1)})`);
  for (let t = 0; t <= 6120; t += 33) {
    const b = E.ballAt(MATCH, t);
    assert.ok(Math.abs(b.x) <= 53.5 && Math.abs(b.y) <= 35, `ball bounds t=${t}`);
    assert.ok(b.z >= 0 && b.z < 8, `ball z t=${t}`);
  }
});

test("走行距離: 単調増加・現実的レンジ", () => {
  const sc = actual();
  const d45 = E.distanceCovered(MATCH, sc, "JPN", 24, 2880);
  const d90 = E.distanceCovered(MATCH, sc, "JPN", 24, 6120);
  assert.ok(d90 >= d45, "monotone");
  assert.ok(d90 > 4000 && d90 < 16000, `Sano full match ${Math.round(d90)}m`);
  const gk = E.distanceCovered(MATCH, sc, "JPN", 1, 6120);
  assert.ok(gk > 800 && gk < 8000, `GK ${Math.round(gk)}m`);
  assert.ok(gk < d90, "GK < box-to-box CM");
  // 66分交代選手は出場時間相応
  const doan = E.distanceCovered(MATCH, sc, "JPN", 10, 6120);
  const sugawara = E.distanceCovered(MATCH, sc, "JPN", 2, 6120);
  assert.ok(doan > sugawara * 0.9, `66' OUT堂安(${Math.round(doan)}) ≳ 66' IN菅原(${Math.round(sugawara)})`);
  console.log(`    佐野 ${Math.round(d90)}m / GK鈴木 ${Math.round(gk)}m / 堂安 ${Math.round(doan)}m / 菅原 ${Math.round(sugawara)}m`);
});

test("疲労モデル: 出場時間とともに増加・交代INはフレッシュ", () => {
  const sc = actual();
  const f30 = E.fatigueOf(MATCH, sc, "JPN", 24, 1800);
  const f90 = E.fatigueOf(MATCH, sc, "JPN", 24, 5900);
  assert.ok(f90 > f30, "fatigue grows");
  const fIn = E.fatigueOf(MATCH, sc, "JPN", 2, 4200); // 菅原は66'IN直後
  assert.ok(fIn < 0.1, "fresh sub");
});

test("#39: 高速化（基礎位置メモ+空間ハッシュ）後も世界はビット同一", () => {
  const sc = E.actualScenario(MATCH);
  // 密集局面（コーナー）と通常局面で、キャッシュ有無の完全一致を確認
  for (const t of [492, 951, 2100, 3500]) {
    const a = E.stateAt(MATCH, sc, t).players.map(p => [p.team, p.no, p.x, p.y]);
    E.clearCaches();
    const b = E.stateAt(MATCH, sc, t).players.map(p => [p.team, p.no, p.x, p.y]);
    assert.deepEqual(a, b, `t=${t}`);
  }
});
