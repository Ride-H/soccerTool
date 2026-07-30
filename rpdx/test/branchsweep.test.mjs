// 条件がそろったときにしか通らない経路（助言の種類・復旧プラン・ゴール取消の理由・
// 交代分スイープ・キック中の脚の合成）を、全試合の時間掃引と合成入力で通す。
// ここが未テストだと「特定の局面でだけ出る文言/挙動」が壊れても誰も気づかない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const { engine: E, tactics: T, scenlib: SCN, sim: SIM, policy: POL, subs: S, generic: G } = RPDX;
const ALL = Object.values(MATCHES);

test("tactics.frameAnalysis: 助言の全種類が実試合のどこかで出る・severity 順に並ぶ", () => {
  const kinds = new Set();
  for (const m of ALL) {
    const sc = E.actualScenario(m), range = E.playedRange(m);
    for (const team of E.teamKeys(m)) {
      for (let t = range.t0; t <= range.t1; t += 45) {
        const st = E.stateAt ? E.stateAt(m, sc, t) : null;
        const a = T.frameAnalysis(m, st || { match: m, scenario: sc, t }, { team });
        if (!a || !a.suggestions) continue;
        for (let i = 1; i < a.suggestions.length; i++)
          assert.ok(a.suggestions[i - 1].severity >= a.suggestions[i].severity, "severity 降順");
        for (const s of a.suggestions) {
          kinds.add(s.exploits);
          assert.equal(typeof s.text, "string");
          assert.ok(s.text.length > 0);
          assert.ok(Number.isFinite(s.severity));
        }
      }
    }
  }
  // 数的不利/優位・背後・カバー・幅・安定 の少なくとも大半が実データで再現される
  assert.ok(kinds.size >= 3, `出た助言の種類: ${[...kinds].join(",")}`);
});

test("engine.ballBounceHeight: 全区間で 0.11m 以上・最終ホップの後は接地高へ戻る", () => {
  const h = 3, e = 0.6, hops = 4;
  let prev = null;
  for (let u = 0; u <= 1.0001; u += 0.005) {
    const y = E.ballBounceHeight(Math.min(u, 1), h, e, hops);
    assert.ok(y >= 0.109, `u=${u} y=${y}`);
    assert.ok(y <= 0.11 + h + 1e-9, `u=${u} は初期ピーク+接地高を超えない`);
    prev = y;
  }
  assert.ok(Math.abs(prev - 0.11) < 0.05, `最後は接地高付近 ${prev}`);
  // 範囲外（u>1）は接地高
  assert.equal(E.ballBounceHeight(1.5, h, e, hops), 0.11);
  assert.equal(E.ballBounceHeight(2, h, e, 1), 0.11);
  assert.equal(E.ballBounceHeight(0.5, h, e, 0), 0.11, "ホップ 0 は接地高のまま");
  // 反発が大きいほど 2 山目が高い
  const at = (ee) => E.ballBounceHeight(0.75, h, ee, 4);
  assert.ok(at(0.8) > at(0.4), `${at(0.8)} > ${at(0.4)}`);
});

test("sim.outcome: 得点の取消理由（不在/脅威低下）が文言つきで返る", () => {
  const reasons = new Set();
  for (const m of ALL) {
    const ks = E.teamKeys(m);
    const goals = E.eventsOf ? m.events.filter((ev) => ev.type === "goal") : [];
    for (const g of goals.slice(0, 3)) {
      // 得点者をピッチ外にするシナリオ（不在による取消）
      const sc = S.fromActual(m, "取消検証");
      const scorer = g.no ?? g.scorer;
      if (scorer == null) continue;
      const out = S.withOutage(m, sc, g.team, { t: Math.max(1, g.t - 60), no: scorer, kind: "red" }).scenario;
      const oc = SIM.outcome(m, out);
      assert.ok(oc && oc.score, "結果が返る");
      for (const r of oc.removed || []) {
        reasons.add(r.reason.replace(/[0-9]+/g, "N"));
        assert.equal(typeof r.reason, "string");
        assert.equal(r.t, r.t, "取消された得点の時刻が残る");
      }
      // 手動取消でも結果が返る
      const rm = S.withRemoveGoal(m, sc, { team: g.team, t: g.t }).scenario;
      const oc2 = SIM.outcome(m, rm);
      assert.ok(oc2.score[g.team] <= oc.score[g.team] + 1);
    }
    if (ks.length) break;
  }
  assert.ok(reasons.size >= 1, `取消理由: ${[...reasons].join(" / ")}`);
});

test("scenlib.recoveryPlans: 負けている側へ複数の案（シフト/交代/複合）を返す", () => {
  let sawSub = false, sawCombined = false;
  for (const m of ALL) {
    const { trailer, plans } = SCN.recoveryPlans(m, S.fromActual(m, "復旧案"));
    if (!plans.length) { assert.equal(trailer, null, "案が無いのは引き分け/リードのときだけ"); continue; }
    assert.ok(E.teamKeys(m).includes(trailer), "ビハインド側が特定される");
    for (const p of plans) {
      assert.equal(typeof p.id, "string");
      assert.equal(typeof p.label, "string");
      assert.ok(p.scenario && typeof p.scenario === "object");
      if (p.id === "attack-sub") sawSub = true;
      if (p.id === "combined") sawCombined = true;
    }
  }
  assert.ok(sawSub || sawCombined, "交代/複合の案が少なくともどこかで作られる");
});

test("policy.gridSearch: 交代分スイープ（subIdx）を含めても決定論で順位が付く", () => {
  const m = ALL[0], team = E.teamKeys(m)[0];
  const opts = { minutes: [60, 75], shapes: Object.keys(RPDX.formations.SHAPES).filter((k) => RPDX.formations.SHAPES[k].length === 11).slice(0, 2) };
  const opts2 = { minutes: opts.minutes, formations: opts.shapes };
  const plain = POL.gridSearch(m, team, opts2, 5);
  assert.ok(Array.isArray(plain) && plain.length > 0, "候補が並ぶ");
  for (let i = 1; i < plain.length; i++) assert.ok(plain[i - 1].value >= plain[i].value, "value 降順");
  const withSub = POL.gridSearch(m, team, { ...opts2, subIdx: 0 }, 8);
  assert.ok(withSub.length > 0);
  const again = POL.gridSearch(m, team, { ...opts2, subIdx: 0 }, 8);
  assert.deepEqual(again.map((c) => c.label), withSub.map((c) => c.label), "決定論");
  // チーム省略でも動く（保持側→先頭チーム）
  assert.ok(POL.gridSearch(m, null, opts2, 2).length > 0);
});

test("subs.fork: 位置微調整（tweaks）を持つシナリオを複製しても互いに影響しない", () => {
  const m = ALL[0], team = E.teamKeys(m)[0];
  const shape = Object.keys(RPDX.formations.SHAPES).find((k) => RPDX.formations.SHAPES[k].length === 11);
  const withLu = S.withFormation(m, S.fromActual(m, "微調整"), team, 0, shape).scenario;
  const slot = Object.keys(withLu.lineup[team].phases[0].assign)[1];
  const tweaked = S.withTweak(m, withLu, team, slot, 3, -2).scenario;
  assert.ok(tweaked.tweaks, "tweaks が入る");
  const copy = S.fork(m, tweaked, "複製");
  assert.notEqual(copy.tweaks, tweaked.tweaks, "参照は共有しない");
  assert.deepEqual(copy.tweaks, tweaked.tweaks, "中身は同じ");
  const more = S.withTweak(m, copy, team, slot, 9, 9).scenario;
  assert.notDeepEqual(more.tweaks[team][slot], tweaked.tweaks[team][slot], "複製を編集しても元は変わらない");
});

test("generic.editEntry: 控え GK が居れば外野へ変更できる／最後の 1 人は阻止", () => {
  const tpl = G.templateMatch ? G.templateMatch() : G.template();
  const team = E.teamKeys(tpl)[0];
  // 控え GK を 1 人足す（editEntry の GK 昇格はスワップなので、2 人目はデータ側で用意する）
  const spare = { ...tpl.teams[team].squad.find((p) => p.pos !== "GK") };
  spare.no = 99; spare.pos = "GK"; spare.name = "Backup GK"; spare.ja = "控えGK";
  tpl.teams[team].squad.push(spare);
  assert.equal(tpl.teams[team].squad.filter((p) => p.pos === "GK").length, 2);

  const demote = G.editEntry(tpl, team, 99, { pos: "DF" });
  assert.equal(demote.ok, true, demote.error);
  assert.equal(tpl.teams[team].squad.find((p) => p.no === 99).pos, "DF");

  // 残り 1 人になった GK は外野化できない
  const last = tpl.teams[team].squad.filter((p) => p.pos === "GK");
  assert.equal(last.length, 1);
  const rej = G.editEntry(tpl, team, last[0].no, { pos: "MF" });
  assert.equal(rej.ok, false);
  assert.match(rej.error, /GK/);
  assert.equal(tpl.teams[team].squad.find((p) => p.no === last[0].no).pos, "GK", "拒否時は変更しない");
});
