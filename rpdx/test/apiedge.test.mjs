// 各モジュールの「省略時・異常時・境界」の契約。既定値と防御の効き方は
// 画面から触ると気づきにくく、壊れても静かに間違った数字を返すので、ここで固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const { engine: E, filter: F, formations: FM, noise: N, layers: L, physio: PHYS, policy: POL, duel: DU, opponent: OPP } = RPDX;
const SC = E.actualScenario(MATCH);

test("filter.abg: 先頭が欠測でも初期化を持ち越す（欠測は coast で外挿）", () => {
  const out = F.abg([
    { t: 0, x: null, y: null },      // まだ初期化されていない欠測
    { t: 1, x: null, y: null },
    { t: 2, x: 10, y: 20 },          // ここで初期化
    { t: 3, x: 11, y: 21 },
    { t: 4, x: null, y: null },      // 初期化後の欠測
    { t: 5, x: 13, y: 23 },
  ]);
  assert.equal(out.length, 6);
  assert.equal(out[0].x, null); assert.equal(out[0].coast, true);
  assert.equal(out[1].x, null); assert.equal(out[1].coast, true);
  assert.equal(out[2].x, 10); assert.equal(out[2].coast, false);
  assert.equal(out[2].vx, 0, "初期化直後の速度は 0");
  assert.equal(out[4].coast, true, "初期化後の欠測は外挿で埋める");
  assert.ok(out[4].x !== null, "外挿値が入る");
  for (const s of out) for (const k of ["vx", "vy", "ax", "ay"]) assert.ok(Number.isFinite(s[k]), `${k}`);
  assert.deepEqual(F.abg([]), [], "空入力は空出力");
  // θ 指定でもゲイン直接指定でも同じ形の出力になる（追従の強さだけが変わる）
  const samples = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 1, y: 1 }, { t: 2, x: 4, y: 4 }];
  const slow = F.abg(samples, { theta: 0.9 }), fast = F.abg(samples, { theta: 0.2 });
  assert.equal(slow.length, fast.length);
  assert.ok(Math.abs(fast[2].x - 4) <= Math.abs(slow[2].x - 4) + 1e-9, "θ が小さいほど観測に追従する");
  const direct = F.abg(samples, { alpha: 0.5, beta: 0.2, gamma: 0.05 });
  assert.ok(direct.every((o) => Number.isFinite(o.x) && Number.isFinite(o.vx)));
});

test("formations: タグ省略時は役割名がタグになる・10 人時の変形・タグ由来の重み", () => {
  const names = Object.keys(FM.SHAPES);
  assert.ok(names.length > 0, "陣形が読める");
  let taggedOnly = 0;
  for (const name of names) {
    for (const sl of FM.SHAPES[name]) {
      assert.ok(Array.isArray(sl.tags) && sl.tags.length > 0, `${name} ${sl.role} のタグ`);
      if (sl.tags.length === 1 && sl.tags[0] === sl.role) taggedOnly++;
      for (const k of ["def", "att"]) assert.ok(Number.isFinite(sl[k].x) && Number.isFinite(sl[k].y), `${name} ${sl.role} ${k}`);
      assert.ok(Number.isFinite(FM.roleAffinity(sl.tags, sl.tags)), "適合度が数値");
      for (const tg of sl.tags) {
        assert.ok(FM.chaseWeight[tg] == null || Number.isFinite(FM.chaseWeight[tg]), `追走重み ${tg}`);
        assert.ok(FM.noiseAmp[tg] == null || Number.isFinite(FM.noiseAmp[tg]), `揺らぎ幅 ${tg}`);
      }
    }
    assert.ok(typeof FM.tenManShapeFor(name) === "string", "10 人時の代替陣形");
  }
  assert.ok(taggedOnly > 0, "タグ省略（＝役割名がそのままタグ）の枠がある");
  // pos + 能力値 → 役割タグ（速い DF は WB も、点を取る MF は AM/W も兼ねる）
  assert.deepEqual(FM.tagsOfPos({ pos: "GK", attrs: { pac: 50, att: 50 } }), ["GK"]);
  assert.ok(FM.tagsOfPos({ pos: "DF", attrs: { pac: 80, att: 40 } }).includes("WB"), "速い DF は WB");
  assert.ok(!FM.tagsOfPos({ pos: "DF", attrs: { pac: 60, att: 40 } }).includes("WB"));
  assert.ok(FM.tagsOfPos({ pos: "MF", attrs: { pac: 70, att: 85 } }).includes("AM"), "攻撃的 MF は AM");
  assert.ok(FM.tagsOfPos({ pos: "MF", attrs: { pac: 70, att: 60 } }).includes("DM"));
  assert.ok(FM.tagsOfPos({ pos: "FW", attrs: { pac: 90, att: 80 } }).includes("W"), "速い FW は W");
  assert.deepEqual(FM.tagsOfPos({ pos: "FW", attrs: { pac: 70, att: 80 } }), ["ST"]);
  // 役割類似度: 同じ役割が最大・無関係は 0
  assert.equal(FM.roleAffinity(["CB"], ["CB"]), 1);
  assert.ok(FM.roleAffinity(["CB"], ["ST"]) < FM.roleAffinity(["CB"], ["FB"]), "近い役割ほど高い");
  assert.equal(FM.roleAffinity(["GK"], ["ST"]), 0, "対応が無ければ 0");
  // 10 人時: バック3/5系は 5-3-1、それ以外は 4-4-1
  assert.equal(FM.tenManShapeFor("343"), "10_531");
  assert.equal(FM.tenManShapeFor("4231"), "10_441");
});

test("noise.spline: キーが 1 本・同時刻の重複でも 0 除算にならない", () => {
  assert.deepEqual(N.spline([[0, 5]], 3), [5], "1 本なら常にその値");
  const dup = N.spline([[2, 1], [2, 9]], 2);   // 同時刻＝区間長 0
  assert.equal(dup.length, 1);
  assert.ok(Number.isFinite(dup[0]), `${dup}`);
  const mid = N.spline([[0, 0, 10], [10, 10, 0]], 5);
  assert.equal(mid.length, 2, "多次元も返る");
  assert.ok(Math.abs(mid[0] - 5) < 1e-9 && Math.abs(mid[1] - 5) < 1e-9, `中点 ${mid}`);
  assert.deepEqual(N.spline([[0, 3], [10, 7]], -5), [3], "範囲外は端で止まる");
  assert.deepEqual(N.spline([[0, 3], [10, 7]], 99), [7]);
});

test("layers.register: id 重複・api が関数でない・既定値", () => {
  const id = "テスト用レイヤ" + Math.random().toString(36).slice(2);
  const e = L.register({ id, api: { f: () => 1 } });
  assert.equal(e.label, id, "label 省略時は id");
  assert.equal(e.kind, "analysis", "kind の既定");
  assert.equal(e.readonly, true, "readonly の既定は true");
  assert.deepEqual([...e.deps], []);
  assert.equal(L.has(id), true);
  assert.equal(L.get(id), e);
  assert.equal(L.get("そんなレイヤはない"), null);
  assert.ok(L.list().includes(e));
  assert.throws(() => L.register({ id, api: {} }), /id 重複/);
  assert.throws(() => L.register({ id: id + "2", api: { g: 42 } }), /関数参照/);
  const e2 = L.register({ id: id + "3", label: "表示名", kind: "edit", readonly: false, deps: [id] });
  assert.equal(e2.label, "表示名"); assert.equal(e2.kind, "edit"); assert.equal(e2.readonly, false);
  assert.deepEqual([...e2.deps], [id]);
  assert.throws(() => { e2.api.x = 1; }, "api は凍結されている");
});

test("physio: step 指定・出場範囲外・キャッシュキーが条件ごとに分かれる", () => {
  const team = E.teamKeys(MATCH)[0];
  const no = MATCH.teams[team].squad.map((p) => p.no).find((n) => E.presenceOf(MATCH, SC, team, n));
  assert.ok(no != null, "出場記録のある選手が居る");
  PHYS.clearCaches();
  const coarse = PHYS.summary(MATCH, SC, team, no, { step: 10 });
  const fine = PHYS.summary(MATCH, SC, team, no, { step: 2 });
  assert.ok(coarse.n < fine.n, "刻みが細かいほどサンプル数が増える");
  assert.ok(Math.abs(coarse.mins - fine.mins) < 1e-9, "出場時間は刻みに依らない");
  assert.ok(coarse.peakV <= fine.peakV + 1e-9, "細かいほど最大値を捉えやすい");
  // 既定の scenario（省略）でも同じ結果
  assert.deepEqual(PHYS.summary(MATCH, null, team, no, { step: 10 }), coarse);
  for (const k of ["avgP", "peakP", "hsr", "sprints", "peakV", "loadKJ"]) assert.ok(coarse[k] >= 0, k);
});

test("duel: タックル/空中戦/シールドの確率は 0..1・決定論・キャッシュ破棄で不変", () => {
  const range = E.playedRange(MATCH), t = range.t0 + 1200;
  const probs = [DU.tackleAt(MATCH, SC, t), DU.aerialAt(MATCH, SC, t), DU.shieldAt(MATCH, SC, t)];
  for (const d of probs) {
    if (d == null) continue;
    const p = typeof d === "number" ? d : (d.p ?? d.win ?? d.prob);
    if (p != null) assert.ok(p >= 0 && p <= 1, `確率 ${p}`);
  }
  const again = [DU.tackleAt(MATCH, SC, t), DU.aerialAt(MATCH, SC, t), DU.shieldAt(MATCH, SC, t)];
  assert.deepEqual(again, probs, "同じ時刻は同じ結果");
  DU.clearCaches();
  assert.deepEqual([DU.tackleAt(MATCH, SC, t), DU.aerialAt(MATCH, SC, t), DU.shieldAt(MATCH, SC, t)], probs);
  const fouls = DU.foulsOf(MATCH, SC);
  assert.ok(fouls && typeof fouls === "object");
});

test("opponent.stars: 端の丸め（0.4→0 個・4.6→5 個）", () => {
  assert.equal(OPP.stars(0.4), "☆☆☆☆☆");
  assert.equal(OPP.stars(0.5), "★☆☆☆☆");
  assert.equal(OPP.stars(4.6), "★★★★★");
});

test("policy.envSpec: チーム省略時は保持側→先頭チームへ落ちる・行動空間が有限", () => {
  const ks = E.teamKeys(MATCH);
  const spec = POL.envSpec(MATCH, ks[1]);
  assert.equal(spec.team, ks[1]);
  assert.ok(spec.formations.length > 0, "陣形の選択肢");
  const auto = POL.envSpec(MATCH);
  assert.ok(ks.includes(auto.team), `省略時のチーム ${auto.team}`);
  assert.deepEqual(POL.envSpec(MATCH, null).team, auto.team, "null も省略と同じ");
  // 実際のシナリオは目的値 0 基準（再構成なし）で決定論
  const o1 = POL.objective(MATCH, SC, ks[0]), o2 = POL.objective(MATCH, SC, ks[0]);
  assert.equal(o1.value ?? o1, o2.value ?? o2);
});
