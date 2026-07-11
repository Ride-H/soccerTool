// #41 レイヤ・プラグイン・アーキテクチャ — レジストリ整合・readonly契約・決定論
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const E = RPDX.engine, L = RPDX.layers;

// 座標ダイジェスト（golden と同型の安定ハッシュ・状態不変検証用）
const stateDigest = (m, sc, t) => {
  const st = E.stateAt(m, sc, t);
  let s = "";
  for (const p of [...st.players].sort((a, b) => (a.team + a.no).localeCompare(b.team + b.no))) {
    if (!p.onPitch) continue;
    s += `${p.team}${p.no}:${p.x.toFixed(4)},${p.y.toFixed(4)};`;
  }
  s += `B:${st.ball.x.toFixed(4)},${st.ball.y.toFixed(4)},${st.ball.z.toFixed(4)}`;
  const c = st.carrier;
  s += `|C:${c ? c.team + (c.no || "") + ":" + c.mode : "-"}`;
  return s;
};

test("#41 layers: 全レイヤの api 関数が存在・callable・id一意", () => {
  const layers = L.list();
  assert.ok(layers.length >= 9, `登録レイヤ数 ${layers.length}`);
  const ids = new Set();
  for (const ly of layers) {
    assert.ok(typeof ly.id === "string" && ly.id, "id 文字列");
    assert.ok(!ids.has(ly.id), `id 一意: ${ly.id}`);
    ids.add(ly.id);
    assert.equal(ly.kind, "analysis", `${ly.id} kind`);
    assert.equal(ly.readonly, true, `${ly.id} readonly契約`);
    assert.ok(Array.isArray(ly.deps), `${ly.id} deps 配列`);
    const keys = Object.keys(ly.api);
    assert.ok(keys.length >= 1, `${ly.id} api 非空`);
    for (const k of keys) assert.equal(typeof ly.api[k], "function", `${ly.id}.${k} callable`);
    // get/has もレジストリと一致
    assert.equal(L.get(ly.id), ly, `get(${ly.id})`);
    assert.ok(L.has(ly.id), `has(${ly.id})`);
  }
  // 想定9レイヤが全て登録されている
  for (const id of ["danger", "psy", "duel", "physio", "filter", "uq", "tactics", "opponent", "scenlib"])
    assert.ok(ids.has(id), `${id} 未登録`);
  // deps は全て登録済み id を指す（トポロジ健全性）
  for (const ly of layers)
    for (const d of ly.deps) assert.ok(ids.has(d), `${ly.id} の依存 ${d} が未登録`);
  // api の関数参照は実モジュールの実体と同一
  for (const ly of layers)
    for (const [k, fn] of Object.entries(ly.api))
      assert.equal(fn, RPDX[ly.id][k], `${ly.id}.${k} は実体参照`);
});

test("#41 layers: register は id 重複を拒否し、非関数 api を拒否", () => {
  assert.throws(() => L.register({ id: "danger", api: {} }), /重複/, "id 重複");
  assert.throws(() => L.register({ id: "", api: {} }), /id/, "id 空");
  assert.throws(() => L.register({ id: "__bad_api__", api: { x: 42 } }), /関数/, "非関数 api");
  assert.equal(L.has("__bad_api__"), false, "失敗した登録は残らない");
});

test("#41 layers: readonly契約 — 代表レイヤ compute 前後で世界状態が不変・決定論", () => {
  const m = MATCH, sc = E.actualScenario(m);
  const before = stateDigest(m, sc, 1234);
  // 代表レイヤの compute を一通り呼ぶ（合成状態を読むだけのはず）
  const D = L.get("danger").api, PSY = L.get("psy").api,
    DU = L.get("duel").api, TA = L.get("tactics").api;
  for (const t of [800, 1234, 2500, 3480]) {
    D.threatAt(10, 5, 1);
    D.indexAt(m, sc, t);
    PSY.momentumAt(m, sc, t);
    PSY.teamAt(m, sc, t);
    DU.tackleAt(m, sc, t);
    TA.phaseAt(m, sc, t);
    TA.shapeMetrics(m, sc, "JPN", t);
    TA.voronoiShare(m, sc, t);
  }
  const after = stateDigest(m, sc, 1234);
  assert.equal(after, before, "レイヤ compute は位置・ボール・保持者を変えない（readonly契約）");
  // 決定論: 同一 api を再評価しても同一ダイジェスト
  E.clearCaches();
  assert.equal(stateDigest(m, sc, 1234), before, "state 決定論");
});
