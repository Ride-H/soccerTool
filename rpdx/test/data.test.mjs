import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const E = RPDX.engine;

test("スカッド: 26人×2チーム・背番号1-26一意", () => {
  for (const k of ["JPN", "BRA"]) {
    const sq = MATCH.teams[k].squad;
    assert.equal(sq.length, 26, `${k} squad size`);
    const nos = sq.map(p => p.no).sort((a, b) => a - b);
    assert.deepEqual(nos, Array.from({ length: 26 }, (_, i) => i + 1), `${k} numbers 1..26`);
    for (const p of sq) {
      assert.ok(p.name && p.ja && p.label, `${k}#${p.no} names`);
      for (const a of Object.values(p.attrs)) assert.ok(a >= 20 && a <= 99);
    }
  }
});

test("検証済ファクト: スタメンXI（FIFA公式記録との一致）", () => {
  const jpnXI = new Set(Object.values(MATCH.teams.JPN.phases[0].assign));
  const braXI = new Set(Object.values(MATCH.teams.BRA.phases[0].assign));
  assert.deepEqual([...jpnXI].sort((a, b) => a - b), [1, 3, 10, 11, 13, 14, 15, 18, 21, 22, 24]);
  assert.deepEqual([...braXI].sort((a, b) => a - b), [1, 3, 4, 5, 7, 8, 9, 13, 16, 20, 26]);
  // 個別スポットチェック
  const jp = (no) => MATCH.teams.JPN.squad.find(p => p.no === no);
  const br = (no) => MATCH.teams.BRA.squad.find(p => p.no === no);
  assert.equal(jp(24).name, "Kaishu Sano");
  assert.equal(jp(1).name, "Zion Suzuki");
  assert.equal(jp(22).name, "Takehiro Tomiyasu");
  assert.equal(jp(8).name, "Takefusa Kubo");     // ベンチスタート
  assert.equal(br(22).name, "Gabriel Martinelli");
  assert.equal(br(26).name, "Rayan");
  assert.equal(br(10).name, "Neymar");           // ベンチ（未出場）
  assert.equal(br(5).name, "Casemiro");
});

test("検証済ファクト: 交代9件（分・番号）とゴール3点・警告5枚", () => {
  const j = MATCH.subsActual.JPN, b = MATCH.subsActual.BRA;
  assert.equal(j.length, 5);
  assert.equal(b.length, 4);
  assert.deepEqual(j.map(s => [s.out, s.in]), [[10, 2], [13, 25], [15, 7], [14, 6], [11, 19]]);
  assert.deepEqual(b.map(s => [s.out, s.in]), [[20, 19], [9, 22], [5, 17], [8, 18]]);
  const goals = MATCH.events.filter(e => e.type === "goal");
  assert.equal(goals.length, 3);
  assert.deepEqual(goals.map(g => [g.team, g.no]), [["JPN", 24], ["BRA", 5], ["BRA", 22]]);
  assert.equal(goals[1].assist, 3);   // カゼミーロ ← G・マガリャンイス
  assert.equal(goals[2].assist, 8);   // マルティネッリ ← B・ギマランイス
  const yellows = MATCH.events.filter(e => e.type === "yellow");
  assert.deepEqual(yellows.map(y => [y.team, y.no]), [["JPN", 24], ["BRA", 5], ["JPN", 15], ["BRA", 13], ["JPN", 25]]);
});

test("イベント参照整合: 全イベントの選手はスカッドに存在", () => {
  for (const ev of MATCH.events) {
    if (ev.no == null) continue;
    const p = MATCH.teams[ev.team].squad.find(q => q.no === ev.no);
    assert.ok(p, `event ${ev.label} refs ${ev.team}#${ev.no}`);
  }
  for (const a of MATCH.playerAnchors) {
    assert.ok(MATCH.teams[a.team].squad.find(q => q.no === a.no));
  }
});

test("フェーズ割当: 各フェーズ11人・GK1人・スカッド内", () => {
  for (const k of ["JPN", "BRA"]) {
    for (const ph of MATCH.teams[k].phases) {
      const nos = Object.values(ph.assign);
      assert.equal(nos.length, 11, `${k} phase@${ph.from}`);
      assert.equal(new Set(nos).size, 11);
      const shape = RPDX.formations.SHAPES[ph.shape];
      assert.ok(shape, `${k} shape ${ph.shape}`);
      const gkSlots = shape.filter(s => s.role === "GK");
      assert.equal(gkSlots.length, 1);
      const gkNo = ph.assign[gkSlots[0].id];
      assert.equal(MATCH.teams[k].squad.find(p => p.no === gkNo).pos, "GK");
    }
  }
});

test("実試合交代プランはFIFA規則検証を通過（窓3以内・HT非カウント）", () => {
  const v = RPDX.subs.validatePlan(MATCH, MATCH.subsActual);
  assert.deepEqual(v.errors, []);
  assert.ok(v.ok);
  assert.equal(v.info.JPN.count, 5);
  assert.equal(v.info.BRA.count, 4);
  assert.ok(v.info.JPN.windows <= 3);
  assert.ok(v.info.BRA.windows <= 3); // HT(46')は窓に数えない
});

test("時間軸: 表示時計・スコア推移", () => {
  assert.equal(E.clockAt(MATCH, 0).disp, "00:00");
  assert.equal(E.clockAt(MATCH, 0).half, 1);
  assert.equal(E.clockAt(MATCH, 2760).disp, "45+1:00");
  assert.equal(E.clockAt(MATCH, 2880).half, 2);
  assert.equal(E.clockAt(MATCH, 2880).disp, "45:00");
  assert.equal(E.clockAt(MATCH, 5640).disp, "90+1:00");
  assert.deepEqual(E.scoreAt(MATCH, 1000), { JPN: 0, BRA: 0 });
  assert.deepEqual(E.scoreAt(MATCH, 1800), { JPN: 1, BRA: 0 });
  assert.deepEqual(E.scoreAt(MATCH, 3600), { JPN: 1, BRA: 1 });
  assert.deepEqual(E.scoreAt(MATCH, 6120), { JPN: 1, BRA: 2 });
});
