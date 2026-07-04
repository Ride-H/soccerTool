import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const S = RPDX.subs, E = RPDX.engine, F = RPDX.formations;

test("陣形変更: 開始からの差替で11人維持・新シェイプが適用", () => {
  const sc = S.fromActual(MATCH, "日本442");
  const r = S.withFormation(MATCH, sc, "JPN", 0, "442");
  assert.ok(r.validation.ok, r.validation.errors.join("/"));
  const roster = E.rosterAt(MATCH, r.scenario, "JPN", 600);
  assert.equal(roster.shape, "442");
  assert.equal(Object.keys(roster.assign).length, 11);
  // 全スロットが埋まり重複なし
  const nos = Object.values(roster.assign);
  assert.equal(new Set(nos).size, 11);
  // GKは1人（鈴木彩艶#1が残る）
  const gkSlot = F.SHAPES["442"].find(s => s.role === "GK");
  assert.equal(roster.assign[gkSlot.id], 1);
});

test("陣形変更: 途中からの陣形はフェーズ境界で切替・以前は元シェイプ", () => {
  const sc = S.fromActual(MATCH, "日本後半532");
  const r = S.withFormation(MATCH, sc, "JPN", 60, "532");
  assert.ok(r.validation.ok, r.validation.errors.join("/"));
  const before = E.rosterAt(MATCH, r.scenario, "JPN", 2880 + 10 * 60); // 55'
  const after = E.rosterAt(MATCH, r.scenario, "JPN", 2880 + 20 * 60);  // 65'
  assert.equal(before.shape, "343", "60'前は元の3-4-3");
  assert.equal(after.shape, "532", "60'以降は5-3-2");
});

test("スタメン差替: withStarter は入替（重複を作らない）", () => {
  const sc = S.fromActual(MATCH, "先発差替");
  // 谷口(3, CB)を板倉(4)へ差替
  const r = S.withStarter(MATCH, sc, "JPN", "CB", 4);
  assert.ok(r.validation.ok, r.validation.errors.join("/"));
  const roster = E.rosterAt(MATCH, r.scenario, "JPN", 100);
  assert.equal(roster.assign.CB, 4, "板倉がCBに");
  const nos = Object.values(roster.assign);
  assert.equal(new Set(nos).size, 11, "重複なし");
  assert.ok(!nos.includes(3) || nos.filter(n => n === 3).length === 1, "谷口が重複しない");
});

test("配置入替: withSlotSwap は2スロットの担当を交換", () => {
  const sc = S.fromActual(MATCH, "入替");
  const r0 = E.rosterAt(MATCH, sc, "JPN", 100);
  const a = r0.assign.RCB, b = r0.assign.LCB;
  const r = S.withSlotSwap(MATCH, sc, "JPN", 100, "RCB", "LCB");
  assert.ok(r.validation.ok);
  const r1 = E.rosterAt(MATCH, r.scenario, "JPN", 100);
  assert.equal(r1.assign.RCB, b);
  assert.equal(r1.assign.LCB, a);
});

test("配置微調整: withTweak は位置をオフセット・可動域内・速度上限維持", () => {
  const sc = S.fromActual(MATCH, "微調整");
  const r = S.withTweak(MATCH, sc, "JPN", "RCM", 0.1, -0.3);
  assert.ok(r.validation.ok);
  const tw = E.tweakOf(r.scenario, "JPN", "RCM");
  assert.ok(Math.abs(tw.dx) <= S.TWEAK_X && Math.abs(tw.dy) <= S.TWEAK_Y, "可動域内");
  // 佐野(#24=RCM)の位置が実試合と変わる
  const base = E.stateFrozenPos(MATCH, sc, "JPN", 24, 1000);
  const moved = E.stateFrozenPos(MATCH, r.scenario, "JPN", 24, 1000);
  assert.ok(Math.hypot(base.x - moved.x, base.y - moved.y) > 1, "配置が動く");
  // 速度上限維持（微調整シナリオでも）
  let prev = null, maxV = 0;
  for (let t = 500; t <= 700; t += 0.5) {
    const p = E.stateFrozenPos(MATCH, r.scenario, "JPN", 24, t);
    if (prev) maxV = Math.max(maxV, Math.hypot(p.x - prev.x, p.y - prev.y) / 0.5);
    prev = p;
  }
  assert.ok(maxV <= 9.9, `微調整選手の速度 ${maxV.toFixed(2)} ≤ 9.9`);
});

test("布陣シナリオ: 検証は上書きスタメン基準・GK/11人ルールを維持", () => {
  const sc = S.fromActual(MATCH, "442検証");
  const r = S.withFormation(MATCH, sc, "JPN", 0, "442");
  const v = S.validateScenario(MATCH, r.scenario);
  assert.ok(v.ok, v.errors.join("/"));
  // 布陣を変えても交代枠検証は生きている（6人目は拒否）
  let r2 = r;
  const bench = [4, 5, 8, 9, 16, 17].filter(n => MATCH.teams.JPN.squad.find(p => p.no === n));
  const onField = Object.values(E.rosterAt(MATCH, r.scenario, "JPN", 0).assign);
  const outs = onField.filter(n => MATCH.teams.JPN.squad.find(p => p.no === n).pos !== "GK");
  for (let i = 0; i < 6; i++) {
    r2 = S.withSub(MATCH, r2.scenario, "JPN", { t: 3000 + i * 100, out: outs[i], in: bench[i] });
  }
  assert.ok(!r2.validation.ok, "6人交代は拒否");
});

test("布陣リセット: clearLineup で実試合フェーズへ復帰", () => {
  let sc = S.fromActual(MATCH, "reset");
  const r = S.withFormation(MATCH, sc, "JPN", 0, "442");
  const r2 = S.clearLineup(MATCH, r.scenario, "JPN");
  const roster = E.rosterAt(MATCH, r2.scenario, "JPN", 100);
  assert.equal(roster.shape, "343", "元の3-4-3に戻る");
});

test("ポゼッション・チェーン: 保持者にボールが密着・支配率が実測に整合", () => {
  const sc = E.actualScenario(MATCH);
  let near = 0, n = 0;
  for (let t = 40; t < 6080; t += 11) {
    const c = E.carrierAt(MATCH, sc, t);
    if (!c || c.mode !== "hold") continue;
    const st = E.stateAt(MATCH, sc, t);
    const p = st.players.find(q => q.team === c.team && q.no === c.no && q.onPitch);
    assert.ok(p, `保持者#${c.no}はピッチ上 @${t}`);
    const d = Math.hypot(p.x - st.ball.x, p.y - st.ball.y);
    n++;
    if (d < 3) near++;
  }
  assert.ok(near / n > 0.8, `ホールド時ボール密着率 ${(100 * near / n).toFixed(0)}% > 80%`);
  // 累積支配率が実測 BRA69/JPN31 の近傍
  const poss = E.possessionStats(MATCH, sc, 6119);
  assert.ok(poss.BRA > 0.6 && poss.BRA < 0.78, `BRA支配率 ${(poss.BRA * 100).toFixed(0)}% ≈ 69%`);
});

test("ポゼッション・チェーン: 決定論 — 保持者列はスクラブ順に依存しない", () => {
  const sc = E.actualScenario(MATCH);
  const seq = [3000, 1000, 5000, 200, 4000];
  const a = seq.map(t => { const c = E.carrierAt(MATCH, sc, t); return c ? c.team + c.no + c.mode : "-"; });
  RPDX.engine.clearCaches();
  const b = [1000, 3000, 4000, 5000, 200].map(t => { const c = E.carrierAt(MATCH, sc, t); return c ? c.team + c.no + c.mode : "-"; });
  // 同一時刻同士を突き合わせ
  const mapA = Object.fromEntries(seq.map((t, i) => [t, a[i]]));
  const mapB = Object.fromEntries([1000, 3000, 4000, 5000, 200].map((t, i) => [t, b[i]]));
  for (const t of seq) assert.equal(mapA[t], mapB[t], `t=${t} 一致`);
});
