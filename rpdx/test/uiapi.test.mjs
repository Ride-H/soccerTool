// UI 側だけが呼ぶ API（チャンク非同期・キャッシュ破棄・表示ユーティリティ）の契約。
// 画面からしか叩かれない関数はテストが手薄になりやすいが、同期版と結果がずれると
// 「表示だけ違う」不具合になるので、同期版との一致とキャッシュの効き方を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH } from "./load.mjs";

const { engine: E, danger: D, physio: PHYS, opponent: OPP, noise: N } = RPDX;
const SC = E.actualScenario(MATCH);

test("physio.summaryAsync: 同期版と一致・キャッシュ再取得・出場していない番号は null", async () => {
  const team = E.teamKeys(MATCH)[0];
  const no = MATCH.teams[team].squad[5].no;
  PHYS.clearCaches();
  const sync = PHYS.summary(MATCH, SC, team, no);
  assert.ok(sync && sync.n > 0, "同期版が値を返す");

  PHYS.clearCaches();
  const first = await new Promise((res) => PHYS.summaryAsync(MATCH, SC, team, no, res));
  for (const k of ["avgP", "peakP", "hsr", "sprints", "peakV", "loadKJ", "mins", "n"])
    assert.ok(Math.abs(first[k] - sync[k]) < 1e-9, `${k}: ${first[k]} vs ${sync[k]}`);
  // 2 回目はキャッシュから即返る（同じ内容）
  const second = await new Promise((res) => PHYS.summaryAsync(MATCH, SC, team, no, res));
  assert.deepEqual(second, first);
  // 出場記録の無い番号は null（同期・非同期とも）
  assert.equal(PHYS.summary(MATCH, SC, team, 999), null);
  assert.equal(await new Promise((res) => PHYS.summaryAsync(MATCH, SC, team, 999, res)), null);
  PHYS.clearCaches();
  assert.ok(PHYS.summary(MATCH, SC, team, no).n === sync.n, "破棄後も同じ値を再計算する");
});

test("danger.curveAsync: 同期の curve と一致・進捗が 0..1・キャッシュ再取得", async () => {
  const opts = { step: 30 };
  D.clearCaches();   // 同期版が先にキャッシュを埋めると非同期版は即返る（進捗が出ない）
  const prog = [];
  const first = await new Promise((res) => D.curveAsync(MATCH, SC, opts, (p) => prog.push(p), res));
  const sync = D.curve(MATCH, SC, opts);
  assert.equal(first.length, sync.length);
  for (let i = 0; i < sync.length; i++) {
    assert.equal(first[i].t, sync[i].t);
    for (const k of Object.keys(sync[i].v)) assert.ok(Math.abs(first[i].v[k] - sync[i].v[k]) < 1e-9, `t=${sync[i].t} ${k}`);
  }
  assert.ok(prog.length >= 1 && prog.every((p) => p > 0), `進捗が前へ進む ${prog}`);
  assert.ok(prog[prog.length - 1] >= 1, `最後は完了 ${prog[prog.length - 1]}`);
  for (let i = 1; i < prog.length; i++) assert.ok(prog[i] > prog[i - 1], "進捗は単調");
  const second = await new Promise((res) => D.curveAsync(MATCH, SC, opts, null, res));
  assert.equal(second, first, "2 回目はキャッシュのインスタンスがそのまま返る");
  assert.ok(typeof D.curveKeyOf(MATCH, SC, opts.step, opts) === "string");
});

test("danger.indexSmooth: 3 点平均・スクラブしても決定論・状態は総和から決まる", () => {
  const range = E.playedRange(MATCH);
  const t = range.t0 + (range.t1 - range.t0) * 0.5;
  const s1 = D.indexSmooth(MATCH, SC, t), s2 = D.indexSmooth(MATCH, SC, t);
  const ks = E.teamKeys(MATCH);
  for (const k of ks) {
    assert.equal(s1[k].total, s2[k].total, "同じ時刻は同じ値");
    assert.ok(Number.isFinite(s1[k].total) && s1[k].total >= 0);
    const st = s1[k].total >= D.CRIT_AT ? "CRITICAL" : s1[k].total >= D.WARN_AT ? "WARNING" : "OK";
    assert.equal(s1[k].status, st, "状態はしきい値どおり");
    for (const m of D.MODULES) assert.ok(Number.isFinite(s1[k].mods[m]), `モジュール ${m}`);
  }
  // 試合開始直後は t-2.5/t-5 が範囲外になるが、範囲の下限へ丸めて計算できる
  const head = D.indexSmooth(MATCH, SC, range.t0);
  for (const k of ks) assert.ok(Number.isFinite(head[k].total));
  // 生の指標と平滑版は同じ桁で、平滑版のほうが時間方向に滑らか
  const raw = (tt) => D.indexAt(MATCH, SC, tt)[ks[0]].total;
  const sm = (tt) => D.indexSmooth(MATCH, SC, tt)[ks[0]].total;
  let dRaw = 0, dSm = 0;
  for (let tt = range.t0 + 10; tt < range.t0 + 300; tt += 10) { dRaw += Math.abs(raw(tt) - raw(tt - 10)); dSm += Math.abs(sm(tt) - sm(tt - 10)); }
  assert.ok(dSm <= dRaw + 1e-9, `平滑版のほうが暴れない ${dSm} vs ${dRaw}`);
});

test("danger.setGeomOnly: 幾何のみモードの切替は問い合わせでき、指標に効く", () => {
  const range = E.playedRange(MATCH), t = range.t0 + 600;
  assert.equal(D.isGeomOnly(), false, "既定は能力値込み");
  const withAttrs = D.indexAt(MATCH, SC, t)[E.teamKeys(MATCH)[0]].total;
  D.setGeomOnly(true);
  try {
    assert.equal(D.isGeomOnly(), true);
    const geom = D.indexAt(MATCH, SC, t)[E.teamKeys(MATCH)[0]].total;
    assert.ok(Number.isFinite(geom));
    assert.notEqual(geom, withAttrs, "能力値を外すと値が変わる");
  } finally {
    D.setGeomOnly(false);
  }
  assert.equal(D.isGeomOnly(), false);
  assert.equal(D.indexAt(MATCH, SC, t)[E.teamKeys(MATCH)[0]].total, withAttrs, "戻せば元の値");
});

test("opponent: 星表示は 5 個・キャッシュ破棄しても同じ IFL を返す", () => {
  assert.equal(OPP.stars(0), "☆☆☆☆☆");
  assert.equal(OPP.stars(5), "★★★★★");
  assert.equal(OPP.stars(3.4), "★★★☆☆");
  for (const v of [0, 1, 2.5, 3, 4.9, 5]) assert.equal([...OPP.stars(v)].length, 5, `星の総数 ${v}`);
  const t = E.playedRange(MATCH).t0 + 900;
  const a = OPP.iflAt(MATCH, SC, t);
  OPP.clearCaches();
  const b = OPP.iflAt(MATCH, SC, t);
  assert.equal(a, b, "キャッシュを捨てても決定論");
});

test("noise.fbm1MaxSpeed: オクターブの最大変化率（速度上限の見積り）", () => {
  assert.equal(N.fbm1MaxSpeed([]), 0);
  assert.ok(Math.abs(N.fbm1MaxSpeed([{ amp: 2, period: 3 }]) - 2) < 1e-12);
  const oct = [{ amp: 1, period: 10 }, { amp: 0.5, period: 2 }];
  assert.ok(Math.abs(N.fbm1MaxSpeed(oct) - (0.3 + 0.75)) < 1e-12);
  // 実際の fbm1 の差分がこの上限を超えない
  const dt = 0.05;
  let worst = 0;
  for (let t = 0; t < 20; t += dt) worst = Math.max(worst, Math.abs(N.fbm1(oct, 7, t + dt) - N.fbm1(oct, 7, t)) / dt);
  assert.ok(worst <= N.fbm1MaxSpeed(oct) + 1e-9, `実測 ${worst} ≦ 上限 ${N.fbm1MaxSpeed(oct)}`);
});
