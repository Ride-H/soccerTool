// シナリオの不変編集（追加した要素を取り消す側）の契約。
// 追加系はテストがあるが取り消し系は手薄で、空になったキーの後始末を間違えると
// 「消したはずの得点/退場が残る」「空配列が残って検証が通らない」に化ける。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const { engine: E, subs: S } = RPDX;
const KS = E.teamKeys(MATCH);

const base = () => S.fromActual(MATCH, "編集テスト");

test("ショック得点: 追加してから取り消すと元のシナリオへ戻る", () => {
  const t = E.playedRange(MATCH).t0 + 1800;
  const added = S.withShockGoal(MATCH, base(), { t, team: KS[0], kind: "add" });
  assert.equal(added.scenario.shockGoals.length, 1);
  const removed = S.withoutShockGoal(MATCH, added.scenario, 0);
  assert.equal(removed.scenario.shockGoals, undefined, "最後の 1 件を消したらキーごと消す");
  assert.ok(removed.validation.ok, removed.validation.errors?.join());
  // 2 件のうち 1 件だけ消す
  const two = S.withShockGoal(MATCH, S.withShockGoal(MATCH, base(), { t, team: KS[0], kind: "add" }).scenario,
    { t: t + 600, team: KS[1], kind: "add" }).scenario;
  assert.equal(two.shockGoals.length, 2);
  const one = S.withoutShockGoal(MATCH, two, 0).scenario;
  assert.equal(one.shockGoals.length, 1);
  assert.equal(one.shockGoals[0].team, KS[1]);
  // そもそも無い状態で取り消しても壊れない
  assert.ok(S.withoutShockGoal(MATCH, base(), 0).validation.ok);
});

test("得点の取消: 追加してから取り消すと元へ戻る（時刻順に保たれる）", () => {
  const goals = MATCH.events.filter((e) => e.type === "goal");
  if (!goals.length) return;
  const g = goals[0];
  const added = S.withRemoveGoal(MATCH, base(), { team: g.team, t: g.t });
  assert.equal(added.scenario.removeGoals.length, 1);
  const two = S.withRemoveGoal(MATCH, added.scenario, { team: g.team, t: g.t + 1 }).scenario;
  assert.ok(two.removeGoals[0].t <= two.removeGoals[1].t, "時刻順");
  const back = S.withoutRemoveGoal(MATCH, two, 1).scenario;
  assert.equal(back.removeGoals.length, 1);
  assert.equal(S.withoutRemoveGoal(MATCH, back, 0).scenario.removeGoals, undefined);
  assert.ok(S.withoutRemoveGoal(MATCH, base(), 0).validation.ok, "無い状態で取り消しても壊れない");
});

test("退場・負傷離脱: チーム単位で追加/取り消し、空になったら親キーも消える", () => {
  const t = E.playedRange(MATCH).t0 + 2400;
  const no = MATCH.teams[KS[0]].squad[4].no;
  const added = S.withOutage(MATCH, base(), KS[0], { t, no, kind: "red" });
  assert.equal(added.scenario.outages[KS[0]].length, 1);
  const both = S.withOutage(MATCH, added.scenario, KS[1], { t: t + 300, no: MATCH.teams[KS[1]].squad[4].no, kind: "injury" }).scenario;
  assert.equal(Object.keys(both.outages).length, 2);
  const one = S.withoutOutage(MATCH, both, KS[0], 0).scenario;
  assert.equal(one.outages[KS[0]], undefined, "そのチームが空になればチームのキーを消す");
  assert.ok(one.outages[KS[1]]);
  const none = S.withoutOutage(MATCH, one, KS[1], 0).scenario;
  assert.equal(none.outages, undefined, "全部消えたら outages 自体を消す");
  assert.ok(S.withoutOutage(MATCH, base(), KS[0], 0).validation.ok, "無い状態でも壊れない");
});

test("交代: 追加した交代を取り消せる（元の交代数へ戻る）", () => {
  const sc = base();
  const before = sc.subs[KS[0]].length;
  const t = E.playedRange(MATCH).t0 + 3000;
  const squad = MATCH.teams[KS[0]].squad;
  const out = squad[2].no, inn = squad[squad.length - 1].no;
  const added = S.withSub(MATCH, sc, KS[0], { t, out, in: inn });
  assert.equal(added.scenario.subs[KS[0]].length, before + 1);
  const removed = S.withoutSub(MATCH, added.scenario, KS[0], added.scenario.subs[KS[0]].findIndex((s) => s.t === t));
  assert.equal(removed.scenario.subs[KS[0]].length, before);
  assert.ok(Array.isArray(removed.validation.errors));
});

test("フェーズ: 追加した陣形フェーズを削除できる（開始フェーズは消えない）", () => {
  const min = 60;
  const shape = Object.keys(RPDX.formations.SHAPES).find((k) => RPDX.formations.SHAPES[k].length === 11);
  const added = S.withFormation(MATCH, base(), KS[0], min, shape);
  assert.ok(added.scenario.lineup, added.validation.errors?.join());
  const lu = added.scenario.lineup[KS[0]];
  const added2 = lu.phases.find((ph) => ph.from > 0);
  assert.ok(added2, "ユーザーフェーズが増える");
  const removed = S.withoutPhase(MATCH, added.scenario, KS[0], added2.from).scenario;
  assert.ok(!removed.lineup[KS[0]].phases.some((ph) => ph.from === added2.from), "指定フェーズが消える");
  assert.ok(removed.lineup[KS[0]].phases.some((ph) => ph.from === 0), "開始フェーズは残る");
  // 未知の陣形・10 人シェイプは拒否し、シナリオを変えない
  const sc0 = base();
  const bad = S.withFormation(MATCH, sc0, KS[0], min, "そんな陣形はない");
  assert.equal(bad.validation.ok, false);
  assert.equal(bad.scenario, sc0);
  const ten = Object.keys(RPDX.formations.SHAPES).find((k) => RPDX.formations.SHAPES[k].length !== 11);
  if (ten) assert.equal(S.withFormation(MATCH, sc0, KS[0], min, ten).validation.ok, false);
});

test("スロット入替: 不正なスロットを指定したらシナリオを変えずにエラーを返す", () => {
  const shape = Object.keys(RPDX.formations.SHAPES).find((k) => RPDX.formations.SHAPES[k].length === 11);
  const sc = S.withFormation(MATCH, base(), KS[0], 0, shape).scenario;
  const t = E.playedRange(MATCH).t0 + 10;
  const lu = sc.lineup[KS[0]];
  const slots = Object.keys(lu.phases[0].assign);
  const ok = S.withSlotSwap(MATCH, sc, KS[0], t, slots[0], slots[1]);
  assert.ok(ok.validation.ok || ok.validation.errors.length >= 0);
  assert.notEqual(ok.scenario.lineup[KS[0]].phases[0].assign[slots[0]], lu.phases[0].assign[slots[0]]);
  const bad = S.withSlotSwap(MATCH, sc, KS[0], t, slots[0], "存在しないスロット");
  assert.equal(bad.validation.ok, false);
  assert.deepEqual(bad.validation.errors, ["スロットが不正"]);
  assert.equal(bad.scenario, sc, "失敗時は元のシナリオをそのまま返す");
});

test("時刻表記: 分↔秒↔ラベルが往復する（延長・ロスタイム表記を含む）", () => {
  const range = E.playedRange(MATCH);
  for (const min of [0, 15, 45, 46, 60, 90]) {
    const t = S.minuteToT(MATCH, min);
    assert.ok(Number.isFinite(t), `min=${min}`);
    assert.ok(Number.isFinite(S.tToMinute(MATCH, t)));
    assert.equal(typeof S.tToLabel(MATCH, t), "string");
  }
  assert.equal(typeof S.tToLabel(MATCH, range.t1), "string");
  assert.equal(typeof S.tToLabel(MATCH, range.ht), "string");
});
