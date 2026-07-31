// #180 ライブ実況モードの契約（DOM 非依存の部分）。
// 画面まわりの検証は「操作標的の大きさ」だけヘッドレスで別途測る（rpdx/tools/ui-probe.mjs）。
// ここでは「入力→世界」の対応が壊れていないことを、UI を通さず session の API で固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX } from "./load.mjs";

const { live: L, generic: G, engine: E, danger: D, tactics: TAC } = RPDX;
const T0 = 1_700_000_000_000;
const start = () => L.withClock(L.create(G.template()), "start", T0);

test("ライブモードの開始と終了: セッションは作れて捨てられる（元の世界へ戻れる）", () => {
  const s = L.create(G.template());
  assert.equal(L.isRunning(s), false, "作った直後は動いていない");
  assert.equal(L.tAt(s, T0), 0);
  const m = L.matchOf(s);
  assert.equal(m.meta.live, true, "ライブであることが match から分かる");
  assert.equal(m.meta.calibrated, false, "未較正であることを明示する");
  assert.ok(E.teamKeys(m).length === 2);
  // 捨てても元のテンプレ試合は無傷（同じ cfg から作り直せる）
  assert.equal(G.templateMatch().meta.live, undefined);
});

test("時計の操作が session へ反映される（開始・一時停止・再開・時刻合わせ）", () => {
  let s = start();
  assert.equal(Math.round(L.tAt(s, T0 + 65_000)), 65);
  s = L.withClock(s, "pause", T0 + 65_000);
  assert.equal(L.isRunning(s), false);
  assert.equal(Math.round(L.tAt(s, T0 + 300_000)), 65, "止めている間は進まない");
  s = L.withClock(s, "resume", T0 + 300_000);
  assert.ok(L.isRunning(s));
  // 中継に合わせる: 分を指定して飛ばす（UI の「時計合わせ」と同じ経路）
  s = L.withClock(s, "sync", T0 + 300_000, 63 * 60);
  assert.equal(L.tAt(s, T0 + 300_000), 3780);
  assert.equal(Math.round(L.tAt(s, T0 + 310_000)), 3790, "合わせた後も進む");
});

test("イベント入力と取り消し: 得点/シュート/CK/警告/退場と undo", () => {
  let s = start();
  const KS = E.teamKeys(L.matchOf(s));
  for (const [i, type] of ["goal", "shot", "corner", "yellow", "red"].entries())
    s = L.withEvent(s, { t: 300 + i * 60, type, team: KS[i % 2], no: 9 });
  const m = L.matchOf(s);
  for (const type of ["goal", "shot", "corner", "yellow", "red"])
    assert.ok(m.events.some((e) => e.type === type), `${type} が世界へ入る`);
  assert.equal(m.meta.score[KS[0]], 1, "得点はスコアに乗る");
  const back = L.undo(L.undo(s));
  assert.equal(back.events.length, 3, "取り消しは 1 件ずつ戻る");
  // 取り消した後の世界は「入れる前」と一致する（残骸が残らない）
  let s2 = start();
  for (const [i, type] of ["goal", "shot", "corner"].entries()) s2 = L.withEvent(s2, { t: 300 + i * 60, type, team: KS[i % 2], no: 9 });
  assert.deepEqual(L.matchOf(back).events.map((e) => e.t + e.type), L.matchOf(s2).events.map((e) => e.t + e.type));
});

test("入力は解釈レイヤーまで届く（危険度と戦術助言が反応する）", () => {
  let s = start();
  const KS = E.teamKeys(L.matchOf(s));
  const T = 1500;
  const base = L.matchOf(s), scB = E.actualScenario(base);
  const quiet = D.indexAt(base, scB, T - 3)[KS[0]].total;
  s = L.withEvent(s, { t: T, type: "goal", team: KS[0], no: 9 });
  const m = L.matchOf(s), sc = E.actualScenario(m);
  let peak = 0;
  for (let t = T - 12; t <= T + 1; t++) peak = Math.max(peak, D.indexAt(m, sc, t)[KS[0]].total);
  assert.ok(peak > quiet + 10, `得点直前に危険度が上がる（${peak.toFixed(1)} vs ${quiet.toFixed(1)}）`);
  const st = E.stateAt(m, sc, T - 5);
  const adv = TAC.frameAnalysis(m, st, { team: KS[0] });
  assert.ok(adv && adv.suggestions.length > 0, "戦術助言が出る");
  for (const g of adv.suggestions) assert.ok(typeof g.text === "string" && g.text.length > 0);
});

test("ライブの世界は決定論（同じセッション・同じ壁時計なら同じ）", () => {
  let s = start();
  s = L.withEvent(s, { t: 900, type: "shot", team: E.teamKeys(L.matchOf(s))[1], no: 7 });
  const a = L.stateAt(s, T0 + 950_000), b = L.stateAt(s, T0 + 950_000);
  assert.deepEqual(a.state.players.map((p) => [p.no, p.x, p.y]), b.state.players.map((p) => [p.no, p.x, p.y]));
  assert.equal(a.t, b.t);
});

// #181 保存・復帰は**既存のバンドル**に載せる（ライブ専用の保存機構を作らない）。
// ここでは「往復して世界が bit 一致すること」「復帰した時計が止まっていること」
// 「従来のバンドルが引き続き読めること」を固定する。
test("保存・復帰: 既存のバンドルへ載せて往復し、世界が bit 一致する", () => {
  const SCN = RPDX.scenlib;
  let s = L.withClock(L.create(G.template()), "start", T0);
  const KS = E.teamKeys(L.matchOf(s));
  s = L.withEvent(s, { t: 1200, type: "goal", team: KS[0], no: 9 });
  s = L.withEvent(s, { t: 1800, type: "corner", team: KS[1] });
  const on = E.stateAt(L.matchOf(s), E.actualScenario(L.matchOf(s)), 2000).players
    .filter((p) => p.team === KS[0] && p.onPitch).map((p) => p.no);
  const bench = L.matchOf(s).teams[KS[0]].squad.map((p) => p.no).find((n) => !on.includes(n));
  s = L.withSub(s, { t: 2000, team: KS[0], out: on[5], in: bench });

  const m = L.matchOf(s), sc = E.actualScenario(m);
  const json = SCN.serializeBundle(m, sc, null, { live: s });
  const bundle = JSON.parse(json);
  assert.ok(bundle.live, "バンドルに live セクションが入る");
  assert.ok(bundle.customMatch, "未較正なのでロスターも同梱される（既存の仕組み）");

  const r = SCN.parseBundle(m, json);
  assert.ok(r.live, "復帰できる");
  assert.equal(L.isRunning(r.live), false, "復帰した時計は止まっている（勝手に進み出さない）");
  const m2 = L.matchOf(r.live);
  assert.deepEqual(m2.events.map((e) => `${e.t}${e.type}`), m.events.map((e) => `${e.t}${e.type}`));
  assert.deepEqual(m2.subsActual, m.subsActual);
  assert.deepEqual(m2.meta.score, m.meta.score);
  const pos = (mm) => E.stateAt(mm, E.actualScenario(mm), 900).players.map((p) => [p.no, p.x, p.y]);
  assert.deepEqual(pos(m2), pos(m), "復帰後の世界が保存前と bit 一致");
});

test("保存・復帰: 従来のバンドル（live なし）は今までどおり読める", () => {
  const SCN = RPDX.scenlib;
  const m = G.templateMatch(), sc = E.actualScenario(m);
  const r = SCN.parseBundle(m, SCN.serializeBundle(m, sc, null));
  assert.equal(r.live, undefined, "live が無ければ live キーも付かない");
  assert.ok(r.scenario && r.validation, "従来の戻り値はそのまま");
});

test("保存・復帰: 時計の続きから再開できる（保存時点の試合時刻を保つ）", () => {
  const SCN = RPDX.scenlib;
  let s = L.withClock(L.create(G.template()), "start", T0);
  s = L.withClock(s, "sync", T0 + 60_000, 2400);          // 40 分に合わせて進行中
  const m = L.matchOf(s);
  const saved = JSON.parse(SCN.serializeBundle(m, E.actualScenario(m), null, { live: s }));
  saved.live.savedAt = T0 + 60_000;                        // 保存した瞬間＝試合 2400s
  // 復帰の壁時計を指定できる形で呼ぶ（parseBundle は実時刻を使う。ここは検証のため固定）
  assert.ok(SCN.parseBundle(m, saved).live, "parseBundle からも復帰できる");
  const restored = L.fromObj(saved.live, T0 + 999_999);
  const t = L.tAt(restored, T0 + 999_999);
  assert.ok(Math.abs(t - 2400) < 1, `保存時点の試合時刻から再開できる（${t}）`);
  assert.equal(L.isRunning(restored), false, "復帰直後は止まっている");
  const resumed = L.withClock(restored, "resume", T0 + 999_999);
  assert.ok(L.isRunning(resumed));
  assert.ok(Math.abs(L.tAt(resumed, T0 + 1_009_999) - 2410) < 1, "再開後は進む");
});
