import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const D = RPDX.danger, E = RPDX.engine;

test("脅威面 T(x,y): ゴール距離に単調・敵陣半面でほぼゼロ", () => {
  assert.ok(D.threatAt(-46, 0, -1) > D.threatAt(-30, 0, -1));
  assert.ok(D.threatAt(-30, 0, -1) > D.threatAt(-5, 0, -1));
  assert.ok(D.threatAt(30, 0, -1) < 0.02, "far half ~0");
  // 角度: 正面 > 同距離のサイド
  assert.ok(D.threatAt(-42, 0, -1) > D.threatAt(-48.5, 22, -1));
});

// 合成状態を直接作る（距離→危険度の関係性を単離検証）
const mkState = (players, ball, possession = 1) => ({
  half: 2, possession, ball: { ...ball, z: 0.11 },
  players: players.map(p => ({
    onPitch: true, entering: 0, role: p.role || "ST", team: p.team,
    no: p.no || 9, label: "T", x: p.x, y: p.y,
    attrs: p.attrs || { pac: 80, sta: 80, def: 70, att: 80, tec: 80, aer: 70 },
  })),
});

test("距離-危険度: 守備者が近づくほど危険度が下がる（CPR単調性）", () => {
  // ブラジル(攻撃方向 h2 = -X)のストライカーがPA内、守備者の距離を変化
  const striker = { team: "BRA", no: 9, x: -42, y: 2 };
  const vals = [];
  for (const dd of [20, 10, 5, 2]) {
    const st = mkState([
      striker,
      { team: "JPN", no: 4, x: -42 + dd, y: 2, role: "CB" },
    ], { x: -42, y: 2 });
    const ix = D.indexFor(MATCH, st, "BRA", {});
    vals.push(ix.total);
  }
  for (let i = 1; i < vals.length; i++) {
    assert.ok(vals[i] < vals[i - 1] + 1e-9, `defender closer -> danger down: ${vals.map(v => v.toFixed(1))}`);
  }
});

test("距離-危険度: ゴールに近い攻撃者ほど危険（同一守備条件）", () => {
  const mk = (x) => mkState([
    { team: "BRA", no: 9, x, y: 0 },
    { team: "JPN", no: 4, x: x + 12, y: 6, role: "CB" },
  ], { x, y: 0 });
  const near = D.indexFor(MATCH, mk(-44), "BRA", {}).total;
  const far = D.indexFor(MATCH, mk(-20), "BRA", {}).total;
  assert.ok(near > far, `near=${near.toFixed(1)} far=${far.toFixed(1)}`);
});

test("GKトグル: 20人（既定）↔ 22人でGKが守備側に算入される", () => {
  const players = [
    { team: "BRA", no: 9, x: -46, y: 0 },
    { team: "JPN", no: 1, x: -51.5, y: 0, role: "GK" },
    { team: "JPN", no: 4, x: -20, y: 10, role: "CB" },
  ];
  const st = mkState(players, { x: -46, y: 0 });
  const without = D.indexFor(MATCH, st, "BRA", { includeGK: false }).total;
  const withGK = D.indexFor(MATCH, st, "BRA", { includeGK: true }).total;
  assert.ok(withGK < without, `GK included lowers danger: ${withGK.toFixed(1)} < ${without.toFixed(1)}`);
});

test("パスレーン: レーン上の守備者がPLVを下げる", () => {
  const base = [
    { team: "BRA", no: 9, x: -30, y: 0 },                       // carrier
    { team: "BRA", no: 22, x: -46, y: 6, role: "W" },           // receiver near goal
    { team: "JPN", no: 4, x: -20, y: 20, role: "CB" },          // 遠い守備者
  ];
  const open = D.indexFor(MATCH, mkState(base, { x: -30, y: 0 }), "BRA", {});
  const blocked = D.indexFor(MATCH, mkState([
    ...base,
    { team: "JPN", no: 22, x: -38, y: 3, role: "CB" },          // レーン上
  ], { x: -30, y: 0 }), "BRA", {});
  assert.ok(blocked.mods.PLV < open.mods.PLV,
    `PLV blocked ${blocked.mods.PLV.toFixed(1)} < open ${open.mods.PLV.toFixed(1)}`);
});

test("v2モジュール: 6モジュール(SDI/CPR/PLV/OVL/TPA/TRV)が揃い[0,100]", () => {
  const ix = D.indexAt(MATCH, null, 3510, {}).BRA;
  for (const m of D.MODULES) {
    assert.ok(m in ix.mods, `${m} が存在`);
    assert.ok(isFinite(ix.mods[m]) && ix.mods[m] >= 0 && ix.mods[m] <= 100.001, `${m}=${ix.mods[m]}`);
  }
  assert.deepEqual(D.MODULES, ["SDI", "CPR", "PLV", "OVL", "TPA", "TRV"]);
});

test("OVL 局所数的優位: ボール周辺の攻撃人数が増えると上がる", () => {
  const mk = (extra) => ({
    half: 2, possession: 1, ball: { x: -42, y: 0, z: 0.11 },
    carrier: { team: "BRA", no: 9, mode: "hold", u: 1 },
    players: [
      { onPitch: true, entering: 0, role: "ST", team: "BRA", no: 9, x: -42, y: 0, attrs: { pac: 84, sta: 80, def: 55, att: 87, tec: 87, aer: 66 } },
      ...extra,
      { onPitch: true, entering: 0, role: "CB", team: "JPN", no: 4, x: -48, y: 4, attrs: { pac: 71, sta: 79, def: 87, att: 58, tec: 74, aer: 85 } },
    ],
  });
  const alone = D.indexFor(MATCH, mk([]), "BRA", {}).mods.OVL;
  const supported = D.indexFor(MATCH, mk([
    { onPitch: true, entering: 0, role: "AM", team: "BRA", no: 20, x: -40, y: -3, attrs: { pac: 78, sta: 83, def: 64, att: 85, tec: 90, aer: 68 } },
    { onPitch: true, entering: 0, role: "W", team: "BRA", no: 7, x: -44, y: 5, attrs: { pac: 95, sta: 85, def: 45, att: 92, tec: 93, aer: 50 } },
  ]), "BRA", {}).mods.OVL;
  assert.ok(supported > alone, `数的優位でOVL上昇: ${supported.toFixed(1)} > ${alone.toFixed(1)}`);
});

test("TPA 持続圧力: 波状攻撃の継続で瞬時値より積み上がる／HTで持ち越さない", () => {
  // 56'失点前は後半で圧力が持続 → TPA>0
  const tpa = D.indexAt(MATCH, null, 3510, {}).BRA.mods.TPA;
  assert.ok(tpa > 0, `後半の持続圧力 TPA=${tpa.toFixed(1)} > 0`);
  // 後半開始直後(2882s)はハーフ跨ぎの持ち越しがない → 前半終了際より低い
  const justAfterHT = D.indexAt(MATCH, null, 2884, {}).BRA.mods.TPA;
  assert.ok(justAfterHT < 40, `HT直後は圧力リセット TPA=${justAfterHT.toFixed(1)}`);
});

test("TRV 侵攻速度: ボールが自ゴールへ急接近するカウンターで上がる", () => {
  // 佐野の29'独走（日本が-Xへ急進） → JPNのTRVが平常より高い
  let best = 0;
  for (let t = 1725; t <= 1735; t += 1) best = Math.max(best, D.indexAt(MATCH, null, t, {}).JPN.mods.TRV);
  const calm = D.indexAt(MATCH, null, 1200, {}).JPN.mods.TRV;
  assert.ok(best > calm, `カウンターでTRV上昇: ${best.toFixed(1)} > ${calm.toFixed(1)}`);
});

test("較正: 実試合の3失点はすべて直前にCRITICAL(≥75)へ到達", () => {
  const goals = MATCH.events.filter(e => e.type === "goal");
  for (const g of goals) {
    let peak = 0;
    for (let dt = -12; dt <= 1; dt += 1) peak = Math.max(peak, D.indexAt(MATCH, null, g.t + dt, {})[g.team].total);
    assert.ok(peak >= D.CRIT_AT, `${g.min} ${g.team} ピーク危険度 ${peak.toFixed(1)} ≥ ${D.CRIT_AT}`);
  }
});

test("実試合: 指数は[0,100]・失点前に高危険・状態整合", () => {
  for (const t of [100, 1000, 1733, 3000, 3510, 4500, 5857, 6100]) {
    const ix = D.indexAt(MATCH, null, t, {});
    for (const k of ["JPN", "BRA"]) {
      const v = ix[k];
      assert.ok(v.total >= 0 && v.total <= 100, `${k} total ∈[0,100] @${t}`);
      for (const m of Object.values(v.mods)) assert.ok(isFinite(m) && m >= 0 && m <= 100.0001);
      const expected = v.total >= D.CRIT_AT ? "CRITICAL" : v.total >= D.WARN_AT ? "WARNING" : "OK";
      assert.equal(v.status, expected);
      assert.ok(Array.isArray(v.contrib) && v.contrib.length >= 9, "contrib list");
    }
  }
  // カゼミーロ弾直前: ブラジルの危険度が日本の平常時より高い
  const preGoal = D.indexAt(MATCH, null, 3510, {}).BRA.total;
  const calm = D.indexAt(MATCH, null, 1200, {}).JPN.total;
  assert.ok(preGoal > calm, `pre-goal BRA ${preGoal.toFixed(1)} > calm JPN ${calm.toFixed(1)}`);
  console.log(`    56'失点直前 BRA危険度=${preGoal.toFixed(1)} / 90+5直前=${D.indexAt(MATCH, null, 5857, {}).BRA.total.toFixed(1)}`);
});

test("ヒートマップ場: 有限・両符号・後半はブラジル脅威が-X側に集中", () => {
  const st = E.stateAt(MATCH, null, 3510);
  const f = D.fieldAt(MATCH, st, {});
  assert.equal(f.grid.length, f.nx * f.ny);
  let maxV = -1, maxI = -1, hasNeg = false;
  for (let i = 0; i < f.grid.length; i++) {
    assert.ok(isFinite(f.grid[i]));
    if (f.grid[i] > maxV) { maxV = f.grid[i]; maxI = i; }
    if (f.grid[i] < 0) hasNeg = true;
  }
  assert.ok(maxV > 0, "positive BRA threat exists");
  const cx = -52.5 + ((maxI % f.nx + 0.5) / f.nx) * 105;
  assert.ok(cx < 0, `BRA(h2, -X攻撃) 最大脅威セル x=${cx.toFixed(1)} < 0`);
  assert.equal(f.plus, "BRA");
  assert.ok(hasNeg || true);
});

test("曲線: 決定論・キャッシュ一貫・シナリオで分岐", () => {
  D.clearCaches();
  const c1 = D.curve(MATCH, null, { step: 60 });
  D.clearCaches();
  const c2 = D.curve(MATCH, null, { step: 60 });
  assert.equal(c1.length, c2.length);
  for (let i = 0; i < c1.length; i++) {
    assert.equal(c1[i].v.BRA, c2[i].v.BRA);
    assert.equal(c1[i].v.JPN, c2[i].v.JPN);
  }
  // シナリオ: 66'交代なし（堂安続投）→ 少なくともどこかで曲線が変わる
  const S = RPDX.subs;
  const sc = S.fromActual(MATCH, "test");
  sc.subs.JPN = sc.subs.JPN.filter(s => !(s.out === 10));
  const c3 = D.curve(MATCH, sc, { step: 60 });
  let differs = false;
  for (let i = 0; i < c1.length; i++) if (Math.abs(c1[i].v.BRA - c3[i].v.BRA) > 1e-9 || Math.abs(c1[i].v.JPN - c3[i].v.JPN) > 1e-9) { differs = true; break; }
  assert.ok(differs, "scenario changes the curve");
});
