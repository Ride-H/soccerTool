// #92 編集可能テンプレート試合（実測なしの起点・generic 薄活用・未較正明示・golden安全）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger, S = RPDX.subs, G = RPDX.generic;

test("#92 templateMatch: 収録実試合と同一APIで動く（engine/danger/subs・決定論）", () => {
  const m = G.templateMatch();
  const keys = E.teamKeys(m);
  assert.equal(keys.length, 2, "2チーム");
  for (const k of keys) assert.ok(m.teams[k].squad.length >= 11, "スカッド11人以上");
  // 同一APIで state/危険度/交代が動く
  const st = E.stateAt(m, E.actualScenario(m), 1500);
  assert.equal(st.players.filter(p => p.onPitch).length, 22, "22人オンピッチ");
  const f = D.fieldAt(m, st, { includeGK: false });
  assert.ok(f.grid.length > 0, "危険度場が算出できる");
  const val = S.validateScenario(m, S.createScenario(m, "t", E.actualScenario(m)));
  assert.ok(val.ok, "シナリオ検証が通る（同一API）");
});

test("#92 未較正フラグ: template は calibrated=false・収録実試合は較正済み扱い", () => {
  const m = G.templateMatch();
  assert.equal(m.meta.calibrated, false, "テンプレは未較正");
  for (const real of Object.values(MATCHES))
    assert.notEqual(real.meta.calibrated, false, "収録実試合は未較正フラグを持たない（較正済み扱い）");
});

test("#92 golden安全: template はレジストリ非登録・収録試合に非干渉", () => {
  const before = Object.keys(MATCHES).length;
  const m = G.templateMatch();
  assert.equal(Object.keys(MATCHES).length, before, "MATCHES 件数は不変（テンプレ非登録）");
  assert.ok(!MATCHES[m.meta.id], "テンプレはレジストリに存在しない");
});

test("#92 決定論: 独立生成した template は同一世界（座標一致）", () => {
  const a = G.templateMatch(), b = G.templateMatch();
  const pa = E.stateAt(a, E.actualScenario(a), 2000).players.map(p => [p.team, p.no, +p.x.toFixed(4), +p.y.toFixed(4)]);
  const pb = E.stateAt(b, E.actualScenario(b), 2000).players.map(p => [p.team, p.no, +p.x.toFixed(4), +p.y.toFixed(4)]);
  assert.deepEqual(pa, pb, "同一テンプレ=同一世界");
});

test("#92b 既定名: チームA/チームB・選手名 プレイヤーA1../プレイヤーB1..", () => {
  const m = G.templateMatch();
  const [a, b] = m.teamOrder;
  assert.equal(m.teams[a].name, "チームA");
  assert.equal(m.teams[b].name, "チームB");
  assert.ok(m.teams[a].squad.some(p => p.ja === "プレイヤーA1"), "A1 命名");
  assert.ok(m.teams[b].squad.some(p => p.ja === "プレイヤーB11"), "B11 命名");
});

test("#92c リンク: template()（カスタム初期値）と templateMatch() は同一定義を共有", () => {
  const cfg = G.template();
  assert.equal(cfg.home.name, "チームA");
  assert.equal(cfg.away.name, "チームB");
  const m = G.templateMatch();
  // templateMatch は createMatch(template()) と同値（決定論・同一世界）
  const m2 = G.createMatch(G.template());
  const sig = (mm) => E.stateAt(mm, E.actualScenario(mm), 1800).players.map(p => [p.team, p.no, +p.x.toFixed(3)]);
  assert.deepEqual(sig(m), sig(m2), "templateMatch == createMatch(template())");
  assert.equal(m.teams[cfg.home.code].name, "チームA", "カスタムと同じチーム名");
});

test("#92b editEntry: 名前編集（未較正のみ・cosmetic）", () => {
  const m = G.templateMatch();
  const team = m.teamOrder[0];
  const r = G.editEntry(m, team, 9, { name: "エース" });
  assert.ok(r.ok);
  assert.equal(m.teams[team].squad.find(p => p.no === 9).ja, "エース");
});

test("#92b editEntry: 背番号変更で XI割当・主将順・交代参照を再マップ", () => {
  const m = G.templateMatch();
  const team = m.teamOrder[0];
  // 9番がXIに入っていることを前提化: 先発スロットの実番号を1つ選ぶ
  const assign = m.teams[team].phases[0].assign;
  const slot = Object.keys(assign).find(s => s !== "GK");
  const oldNo = assign[slot];
  const r = G.editEntry(m, team, oldNo, { no: 77 });
  assert.ok(r.ok && r.newNo === 77);
  assert.equal(m.teams[team].squad.find(p => p.no === 77).no, 77, "squad更新");
  assert.ok(!m.teams[team].squad.some(p => p.no === oldNo), "旧番号は消える");
  assert.equal(assign[slot], 77, "XI割当が再マップ");
});

test("#92b editEntry: 重複番号は拒否・較正済み試合は拒否", () => {
  const m = G.templateMatch();
  const team = m.teamOrder[0];
  const dup = G.editEntry(m, team, 9, { no: 10 });   // 10 は既存
  assert.ok(!dup.ok && /重複/.test(dup.error), "重複拒否");
  const oob = G.editEntry(m, team, 9, { no: 200 });
  assert.ok(!oob.ok, "範囲外拒否");
  // 収録実試合（calibrated 未設定）は編集不可
  const real = Object.values(MATCHES)[0];
  const rk = E.teamKeys(real)[0], rno = real.teams[rk].squad[0].no;
  const blocked = G.editEntry(real, rk, rno, { name: "X" });
  assert.ok(!blocked.ok, "較正済みは拒否");
  assert.notEqual(real.teams[rk].squad[0].ja, "X", "実試合スカッドは不変（golden保護）");
});

test("#92 編集可能: template 上の能力値上書きで危険度が動く（#89/#90 と連結）", () => {
  const m = G.templateMatch();
  const keys = E.teamKeys(m);
  // XI（先発）の非GK選手を選ぶ＝t=2500 で確実に場に居る
  const assign = m.teams[keys[0]].phases[0].assign;
  const xiNo = Object.entries(assign).find(([s]) => s !== "GK")[1];
  const sc = S.createScenario(m, "edit", E.actualScenario(m));
  const base = E.attrsOf(m, null, keys[0], xiNo);
  sc.attrOverrides = { [keys[0]]: { [xiNo]: { pac: Math.max(20, base.pac - 45), att: 20, tec: 20 } } };
  const f0 = D.fieldAt(m, E.stateAt(m, E.actualScenario(m), 2500), { includeGK: false });
  const f1 = D.fieldAt(m, E.stateAt(m, sc, 2500), { includeGK: false });
  let diff = 0; for (let i = 0; i < f0.grid.length; i++) diff += Math.abs(f0.grid[i] - f1.grid[i]);
  assert.ok(diff > 0.01, `テンプレ上でも編集が危険度に効く ${diff.toFixed(3)}`);
});
