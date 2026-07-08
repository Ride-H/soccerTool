// ボール⇄保持者バインディング — ×1実時間再生でも足元に付く（全パック・ブレンド窓含む）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine, S = RPDX.subs;

const bindCheck = (m, sc, ts, tag) => {
  let checked = 0;
  for (const t of ts) {
    const st = E.stateAt(m, sc, t);
    const c = st.carrier;
    if (!c || c.mode !== "hold" || c.u < 0.7) continue;
    if (st.ball.free < 0.9) continue;                    // アンカー再現中は対象外
    if (c.restart && t <= c.tf + c.rdelay + 1.4) continue;   // リスタート静止〜復帰ブレンド中
    const p = st.players.find(q => q.onPitch && q.team === c.team && q.no === c.no);
    assert.ok(p, `${tag} t=${t} 保持者がピッチ上にいない`);
    const d = Math.hypot(p.x - st.ball.x, p.y - st.ball.y);
    assert.ok(d < 1.6, `${tag} t=${t} 保持者${c.team}#${c.no} とボール距離 ${d.toFixed(2)}m`);
    assert.ok(p.hasBall, `${tag} t=${t} hasBall フラグ`);
    checked++;
  }
  return checked;
};

for (const m of Object.values(MATCHES)) {
  test(`binding[${m.meta.id}]: 実試合 — ホールド中のボールは保持者の足元(<1.6m)`, () => {
    const sc = E.actualScenario(m);
    const range = E.playedRange(m);
    const ts = [];
    for (let t = range.t0 + 30; t < range.t1; t += 41) ts.push(t);
    const n = bindCheck(m, sc, ts, m.meta.id);
    assert.ok(n > 30, `検証サンプル数 ${n}`);
  });
}

test("binding: フェーズ切替ブレンド窓(45s)の間も保持者に付く（×1で見えていたズレ）", () => {
  const m = RPDX.data.MATCH;
  // 50分に日本を4-4-2へ変更 → 切替直後45秒はスロット位置がブレンドされる
  let sc = S.fromActual(m, "blend-test");
  const r = S.withFormation(m, sc, "JPN", 50, "442");
  assert.ok(r.validation.ok);
  const t0 = S.minuteToT(m, 50);
  const ts = [];
  for (let t = t0 + 1; t < t0 + 45; t += 2.3) ts.push(t);
  bindCheck(m, r.scenario, ts, "blend");
});

test("binding: アンカー再現（ゴール前後）はボールが吸着されない（free≈0）", () => {
  const m = RPDX.data.MATCH;
  const sc = E.actualScenario(m);
  // 佐野ゴールの瞬間: ボールはネット位置アンカーに従う
  const st = E.stateAt(m, sc, 28 * 60 + 53);
  assert.ok(st.ball.free < 0.1, `free=${st.ball.free}`);
  assert.ok(Math.abs(st.ball.x - (-52.2)) < 1.5, "ボールはネット位置");
});

test("binding: 決定論 — 吸着後も同一時刻は同一状態", () => {
  const m = MATCHES["wc2026-r16-arg-egy"];
  const sc = E.actualScenario(m);
  for (const t of [500, 2000, 4500, 6000]) {
    const a = E.stateAt(m, sc, t);
    const b = E.stateAt(m, sc, t);
    assert.deepEqual([a.ball.x, a.ball.y, a.ball.free], [b.ball.x, b.ball.y, b.ball.free]);
  }
});
