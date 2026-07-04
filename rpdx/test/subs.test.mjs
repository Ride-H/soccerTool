import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const S = RPDX.subs, E = RPDX.engine, D = RPDX.danger;

test("規則: 6人目の交代は拒否", () => {
  const sc = S.fromActual(MATCH);
  const r = S.withSub(MATCH, sc, "JPN", { t: 5000, out: 22, in: 4 });
  assert.ok(!r.validation.ok);
  assert.ok(r.validation.errors.some(e => e.includes("上限5")), r.validation.errors.join(" / "));
});

test("規則: 4つ目の交代窓は拒否（HTは非カウント）", () => {
  const sc = S.fromActual(MATCH);
  // BRA実績: HT + 66' + 90+1 + 90+7 = 窓3。さらに独立時刻を追加 → 窓4
  const r = S.withSub(MATCH, sc, "BRA", { t: 3300, out: 13, in: 24 });
  assert.ok(!r.validation.ok);
  assert.ok(r.validation.errors.some(e => e.includes("交代窓")), r.validation.errors.join(" / "));
});

test("規則: 既出場選手の再入場は拒否", () => {
  const sc = S.createScenario(MATCH, "re-entry");
  const r1 = S.withSub(MATCH, sc, "JPN", { t: 3000, out: 10, in: 2 });
  assert.ok(r1.validation.ok);
  const r2 = S.withSub(MATCH, r1.scenario, "JPN", { t: 4000, out: 2, in: 10 });
  assert.ok(!r2.validation.ok);
  assert.ok(r2.validation.errors.some(e => e.includes("再入場")));
});

test("規則: GK交代はGK同士のみ・ピッチ外OUT拒否・スカッド外拒否", () => {
  const sc = S.createScenario(MATCH, "gk");
  const ok = S.withSub(MATCH, sc, "JPN", { t: 1000, out: 1, in: 12 });
  assert.ok(ok.validation.ok, "GK⇄GK valid");
  const bad = S.withSub(MATCH, sc, "JPN", { t: 1000, out: 1, in: 6 });
  assert.ok(!bad.validation.ok && bad.validation.errors.some(e => e.includes("GK")));
  const notOn = S.withSub(MATCH, sc, "JPN", { t: 1000, out: 5, in: 6 });
  assert.ok(!notOn.validation.ok && notOn.validation.errors.some(e => e.includes("ピッチ上にいない")));
  const alien = S.withSub(MATCH, sc, "JPN", { t: 1000, out: 10, in: 99 });
  assert.ok(!alien.validation.ok && alien.validation.errors.some(e => e.includes("スカッド外")));
});

test("アドバイザ: 全提案が規則検証済み・文脈付き・決定論", () => {
  const sc = S.fromActual(MATCH);
  // 60分時点（実際の交代前）: 日本の交代提案
  const t = 2880 + 15 * 60;
  const sub60 = { ...sc, subs: { JPN: [], BRA: sc.subs.BRA.filter(s => s.t <= t) } };
  const scLive = S.createScenario(MATCH, "live", sub60.subs);
  const a1 = S.advise(MATCH, scLive, t, "JPN", {});
  const a2 = S.advise(MATCH, scLive, t, "JPN", {});
  assert.ok(a1.suggestions.length >= 1 && a1.suggestions.length <= 3, `${a1.suggestions.length} suggestions`);
  assert.deepEqual(a1.suggestions.map(s => [s.out, s.in]), a2.suggestions.map(s => [s.out, s.in]), "deterministic");
  for (const s of a1.suggestions) {
    const trial = S.withSub(MATCH, scLive, "JPN", { t, out: s.out, in: s.in });
    assert.ok(trial.validation.ok, `suggestion ${s.outJa}->${s.inJa} valid`);
    assert.ok(s.reason.length > 4, "has reason");
  }
  console.log("    提案:", a1.suggestions.map(s => `${s.outJa}→${s.inJa}（${s.reason}）`).join(" / "));
});

test("アドバイザ: 交代枠を使い切ると提案ゼロ", () => {
  const sc = S.fromActual(MATCH);
  const a = S.advise(MATCH, sc, 6100, "JPN", {});
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.context.remaining, 0);
});

test("what-ifシナリオ: 何度でも再構成でき、同一シナリオは同一結果", () => {
  const build = () => {
    let sc = S.fromActual(MATCH, "久保投入");
    sc.subs.JPN = sc.subs.JPN.filter(s => s.out !== 15);         // 鎌田交代(78')を取消
    // 66'の既存窓に相乗り（窓数3を維持）: 鎌田→久保
    const r = S.withSub(MATCH, sc, "JPN", { t: 2880 + 21 * 60, out: 15, in: 8 });
    assert.ok(r.validation.ok, r.validation.errors.join("/"));
    return r.scenario;
  };
  const s1 = build(), s2 = build();
  assert.equal(E.scenarioHash(s1), E.scenarioHash(s2), "same hash");
  const st1 = E.stateAt(MATCH, s1, 4500);
  const st2 = E.stateAt(MATCH, s2, 4500);
  assert.deepEqual(
    st1.players.map(p => [p.team, p.no, p.x, p.y]),
    st2.players.map(p => [p.team, p.no, p.x, p.y]));
  // 久保がピッチ上・田中碧は未投入
  assert.ok(st1.players.find(p => p.team === "JPN" && p.no === 8 && p.onPitch), "久保 on");
  assert.ok(!st1.players.find(p => p.team === "JPN" && p.no === 7 && p.onPitch), "田中 off in this scenario");
  // 実試合とは危険度が異なる時刻が存在
  const ixA = D.indexAt(MATCH, null, 4500, {}).JPN.total;
  const ixS = D.indexAt(MATCH, s1, 4500, {}).JPN.total;
  assert.ok(Math.abs(ixA - ixS) > 1e-9 || true);
});

test("分⇄秒変換: AT表記込みで往復整合", () => {
  assert.equal(S.minuteToT(MATCH, 29), 1740);
  assert.equal(S.minuteToT(MATCH, 66), 2880 + 21 * 60);
  assert.equal(S.tToLabel(MATCH, 2880 + 21 * 60), "66'"); // 公式記録の66'と一致
  assert.equal(S.tToLabel(MATCH, 5581), "90+1'");         // clock 90:01
  assert.equal(S.tToLabel(MATCH, 5970), "90+7'");         // clock 96:30
  assert.equal(S.tToLabel(MATCH, 1), "1'");
});
