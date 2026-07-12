// #91 ロスター/シナリオ/フレームの JSON 往復（統合スキーマ・取込→反映→書出・端末内のみ・golden安全）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, D = RPDX.danger, S = RPDX.subs, SCN = RPDX.scenlib;

const fieldSig = (match, sc, t = 3500) => {
  const f = D.fieldAt(match, E.stateAt(match, sc, t), { includeGK: false });
  let s = 0; for (let i = 0; i < f.grid.length; i++) s += f.grid[i] * (i + 1);
  return +s.toFixed(3);
};

test("#91 往復一致: subs+attr+name+editAnchors を書出→取込で決定論的に同値", () => {
  const sc = S.createScenario(MATCH, "roundtrip", E.actualScenario(MATCH));
  sc.attrOverrides = { BRA: { 9: { pac: 40, att: 40, tec: 45 } }, JPN: { 10: { def: 90 } } };
  sc.nameOverrides = { BRA: { 9: { ja: "テスト9", name: "T9", label: "T9" } } };
  const withSub = S.withSub(MATCH, sc, "JPN", { t: 2880 + 20 * 60, out: 15, in: 8 });
  const src = withSub.validation.ok ? withSub.scenario : sc;

  const json = SCN.serializeBundle(MATCH, src, null);
  const r = SCN.parseBundle(MATCH, json);
  assert.ok(r.validation.ok, "取込は検証OK");
  // 危険度シグネチャ一致（決定論・往復）
  assert.equal(fieldSig(MATCH, r.scenario), fieldSig(MATCH, src), "危険度が往復一致");
  // 上書きが保持される
  assert.equal(E.attrsOf(MATCH, r.scenario, "BRA", 9).pac, 40, "attr往復");
  assert.equal(E.nameOverrideOf(MATCH, r.scenario, "BRA", 9).ja, "テスト9", "name往復");
});

test("#91 roster 形式: 能力値なしは既定のまま・能力値/名前ありは上書きへ翻訳", () => {
  const bundle = {
    v: 1, kind: "rpdx-bundle", match: MATCH.meta.id,
    roster: { BRA: { players: [
      { no: 9, attrs: { pac: 55 }, name: "Roster9", ja: "ロスター9" },
      { no: 8 },   // 能力値/名前なし → 上書きしない（既定＝squad由来）
    ] } },
  };
  const r = SCN.parseBundle(MATCH, bundle);
  assert.ok(r.validation.ok);
  assert.equal(E.attrsOf(MATCH, r.scenario, "BRA", 9).pac, 55, "roster能力値が反映");
  // 9番の他属性・8番は squad 由来のまま
  const base9 = E.attrsOf(MATCH, null, "BRA", 9), base8 = E.attrsOf(MATCH, null, "BRA", 8);
  assert.equal(E.attrsOf(MATCH, r.scenario, "BRA", 9).att, base9.att, "指定外属性は既定");
  assert.equal(E.attrsOf(MATCH, r.scenario, "BRA", 8).pac, base8.pac, "未指定選手は既定");
  assert.equal(E.nameOverrideOf(MATCH, r.scenario, "BRA", 9).ja, "ロスター9", "roster名前が反映");
});

test("#91 能力値は値域にクランプ（不正値でも決定論・値域維持）", () => {
  const bundle = { v: 1, match: MATCH.meta.id, overrides: {
    attrOverrides: { BRA: { 9: { pac: 999, def: -50, att: "x", tec: NaN } } } } };
  const r = SCN.parseBundle(MATCH, bundle);
  assert.ok(r.validation.ok);
  const a = E.attrsOf(MATCH, r.scenario, "BRA", 9);
  assert.equal(a.pac, 99, "pac 上限クランプ");
  assert.equal(a.def, 20, "def 下限クランプ");
  const base = E.attrsOf(MATCH, null, "BRA", 9);
  assert.equal(a.att, base.att, "非数値は無視（既定維持）");
  assert.equal(a.tec, base.tec, "NaN は無視（既定維持）");
});

test("#91 不正JSONは安全に拒否・throwしない", () => {
  const r1 = SCN.parseBundle(MATCH, "{ not json");
  assert.ok(r1.error, "壊れたJSONは error を返す");
  const r2 = SCN.parseBundle(MATCH, "42");
  assert.ok(r2.error, "非オブジェクトは error");
  // 未知チーム・未知属性は黙殺（scenario は成立）
  const r3 = SCN.parseBundle(MATCH, { overrides: { attrOverrides: { XXX: { 1: { pac: 50 } } }, nameOverrides: { BRA: { 9: { foo: "bar" } } } } });
  assert.ok(r3.validation.ok && !r3.scenario.attrOverrides, "未知チームは無視");
});

test("#91 golden安全: actual の往復は actual と同値・取込は match を破壊しない", () => {
  for (const m of Object.values(MATCHES)) {
    const t0 = E.teamKeys(m)[0];
    const before = JSON.stringify(m.teams[t0].squad);
    // 上書き無し（actual）を書出→取込 → 危険度が actual と一致（決定論・golden安全）
    const json = SCN.serializeBundle(m, E.actualScenario(m), null);
    const r = SCN.parseBundle(m, json);
    assert.ok(r.validation.ok);
    assert.equal(fieldSig(m, r.scenario, 1500), fieldSig(m, E.actualScenario(m), 1500), "actual往復==actual");
    assert.ok(!r.scenario.attrOverrides && !r.scenario.nameOverrides, "上書きは付かない");
    const after = JSON.stringify(m.teams[t0].squad);
    assert.equal(after, before, "match.squad は不変（golden安全）");
  }
});

test("#91 serializeBundle は空シナリオでも最小・整形JSON", () => {
  const json = SCN.serializeBundle(MATCH, E.actualScenario(MATCH), null);
  const o = JSON.parse(json);
  assert.equal(o.kind, "rpdx-bundle");
  assert.equal(o.v, 1);
  assert.equal(o.match, MATCH.meta.id);
  assert.ok(o.overrides && typeof o.overrides === "object", "overrides キーは常設");
});
