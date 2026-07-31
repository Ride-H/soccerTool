// ライブ実況セッションの契約。中継を見ながら使う道具なので、収録パックとは別に
// 「時計が壁時計で進む」「イベントが後から増える」の 2 点が正しく効くことを固定する。
// 特に重要なのは因果: 後から入れたイベントで過去の表示が変わってはいけない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX } from "./load.mjs";

const { live: L, generic: G, engine: E, danger: D } = RPDX;
const cfg = () => G.template();
const T0 = 1_700_000_000_000;   // 壁時計の基準（任意の固定値）

test("時計: 開始・一時停止・再開・中継への同期が壁時計の純関数", () => {
  let s = L.create(cfg());
  assert.equal(L.tAt(s, T0), 0, "開始前は 0");
  assert.equal(L.isRunning(s), false);

  s = L.withClock(s, "start", T0);
  assert.equal(L.tAt(s, T0), 0);
  assert.equal(L.tAt(s, T0 + 30_000), 30, "壁時計 30 秒で試合 30 秒");
  assert.equal(L.isRunning(s), true);

  const paused = L.withClock(s, "pause", T0 + 60_000);
  assert.equal(L.tAt(paused, T0 + 60_000), 60);
  assert.equal(L.tAt(paused, T0 + 600_000), 60, "止めている間は進まない");
  assert.equal(L.isRunning(paused), false);

  const resumed = L.withClock(paused, "resume", T0 + 600_000);
  assert.equal(L.tAt(resumed, T0 + 600_000), 60);
  assert.equal(L.tAt(resumed, T0 + 630_000), 90, "再開後は再び進む");

  // 中継に合わせて時刻を合わせる（ロスタイム・CM 明けのずれ）
  const synced = L.withClock(resumed, "sync", T0 + 630_000, 300);
  assert.equal(L.tAt(synced, T0 + 630_000), 300);
  assert.equal(L.tAt(synced, T0 + 660_000), 330, "同期後も進み続ける");
  assert.equal(L.isRunning(synced), true, "動作中に同期しても止まらない");
  // 止めた状態で同期したら止まったまま
  const syncedPaused = L.withClock(paused, "sync", T0 + 60_000, 1200);
  assert.equal(L.tAt(syncedPaused, T0 + 120_000), 1200);
  assert.equal(L.isRunning(syncedPaused), false);
  // 同じ入力なら常に同じ（純関数）
  for (const w of [T0, T0 + 1, T0 + 12_345, T0 + 999_999]) assert.equal(L.tAt(synced, w), L.tAt(synced, w));
  assert.throws(() => L.withClock(s, "そんな操作", T0), /未知の操作/);
});

test("入力: イベントと交代は時刻順に保たれ、直前の入力を取り消せる", () => {
  let s = L.withClock(L.create(cfg()), "start", T0);
  s = L.withEvent(s, { t: 900, type: "shot", team: "TMA", no: 9 });
  s = L.withEvent(s, { t: 300, type: "corner", team: "TMB" });
  assert.deepEqual(s.events.map((e) => e.t), [300, 900], "時刻順");
  assert.equal(s.events[0].min, "5'", "分表示が付く");
  s = L.withSub(s, { t: 2000, team: "TMA", out: 7, in: 15 });
  assert.equal(L.undo(s).subs.length, 0, "最後に入れた交代が取り消される");
  const back = L.undo(L.undo(s));
  assert.deepEqual(back.events.map((e) => e.t), [300], "その前のイベントが取り消される");
  assert.equal(L.undo(L.undo(back)).events.length, 0);
  assert.equal(L.undo(L.create(cfg())).events.length, 0, "何も無くても壊れない");
  assert.throws(() => L.withEvent(s, { type: "goal" }), /t が必要/);
  assert.throws(() => L.withEvent(s, { t: 1 }), /type が必要/);
  assert.throws(() => L.withSub(s, { team: "TMA" }), /t が必要/);
});

test("不変: 操作は元のセッションを書き換えない", () => {
  const s0 = L.withClock(L.create(cfg()), "start", T0);
  const snapshot = JSON.stringify(s0);
  L.withEvent(s0, { t: 100, type: "goal", team: "TMA", no: 9 });
  L.withSub(s0, { t: 200, team: "TMA", out: 7, in: 15 });
  L.withClock(s0, "pause", T0 + 1000);
  assert.equal(JSON.stringify(s0), snapshot);
});

test("因果: 入力しても PRE_ROLL 秒より前の世界は 1mm も変わらない", () => {
  let s = L.withClock(L.create(cfg()), "start", T0);
  const before = L.matchOf(s);
  const scB = E.actualScenario(before);
  const T = 3000;
  const probe = [60, 600, 1500, 2400, T - L.PRE_ROLL - 10];
  const posOf = (m, sc, t) => E.stateAt(m, sc, t).players.map((p) => `${p.team}${p.no}:${p.x},${p.y}`).join("|");
  const ballOf = (m, sc, t) => JSON.stringify(E.stateAt(m, sc, t).ball);
  const snapP = probe.map((t) => posOf(before, scB, t));
  const snapB = probe.map((t) => ballOf(before, scB, t));

  s = L.withEvent(s, { t: T, type: "goal", team: "TMA", no: 9, label: "GOAL" });
  const after = L.matchOf(s);
  const scA = E.actualScenario(after);
  probe.forEach((t, i) => {
    assert.equal(posOf(after, scA, t), snapP[i], `t=${t} の選手配置が後から変わった`);
    assert.equal(ballOf(after, scA, t), snapB[i], `t=${t} のボールが後から変わった`);
  });
  // 窓の中は変わってよい（変わらなければ入力が効いていない）
  assert.notEqual(ballOf(after, scA, T - 5), ballOf(before, scB, T - 5), "得点直前は反応する");
  // 種類を問わず因果が成り立つ（ファウルのように世界へ直接効かない型でも過去を触らない）
  for (const type of ["foul", "corner", "shot"]) {
    const s2 = L.withEvent(L.withClock(L.create(cfg()), "start", T0), { t: 5000, type, team: "TMA", no: 9 });
    const m2 = L.matchOf(s2), sc2 = E.actualScenario(m2);
    assert.equal(posOf(m2, sc2, 600), posOf(before, scB, 600), `${type} を足したら t=600 が変わった`);
  }
  // 交代も同じ（名簿は変わるが、それ以前の世界は不変）
  const xi = Object.values(before.teams.TMA.phases[0].assign);
  const bench = before.teams.TMA.squad.map((p) => p.no).find((n) => !xi.includes(n));
  const s3 = L.withSub(L.withClock(L.create(cfg()), "start", T0), { t: 4000, team: "TMA", out: xi[5], in: bench });
  const m3 = L.matchOf(s3), sc3 = E.actualScenario(m3);
  assert.equal(posOf(m3, sc3, 600), posOf(before, scB, 600), "交代を足したら t=600 が変わった");
});

test("反映: 入力した得点はスコア・イベント・危険度に効く", () => {
  let s = L.withClock(L.create(cfg()), "start", T0);
  const base = L.matchOf(s);
  assert.deepEqual(base.meta.score, { TMA: 0, TMB: 0 }, "入力前は 0-0");

  const T = 1500;
  s = L.withEvent(s, { t: T, type: "goal", team: "TMA", no: 9, label: "GOAL" });
  const m = L.matchOf(s);
  assert.deepEqual(m.meta.score, { TMA: 1, TMB: 0 });
  assert.ok(m.events.some((e) => e.type === "goal" && e.t === T));
  assert.equal(m.meta.live, true);
  assert.equal(m.meta.calibrated, false, "ライブは未較正であることを明示する");

  // 危険度が得点直前に上がる（入力が解釈レイヤーまで届く）
  const sc = E.actualScenario(m);
  let peak = 0, baseLevel = 0;
  for (let t = T - 12; t <= T + 1; t++) peak = Math.max(peak, D.indexAt(m, sc, t).TMA.total);
  for (let t = T - 400; t <= T - 300; t += 10) baseLevel = Math.max(baseLevel, D.indexAt(m, sc, t).TMA.total);
  assert.ok(peak > baseLevel + 10, `得点直前に危険度が上がる（${peak.toFixed(1)} vs 平常 ${baseLevel.toFixed(1)}）`);
});

test("交代: 入力した交代が名簿へ反映される", () => {
  let s = L.withClock(L.create(cfg()), "start", T0);
  const T = 3600;
  const m0 = L.matchOf(s);
  const xi = Object.values(m0.teams.TMA.phases[0].assign);
  const out = xi[5], bench = m0.teams.TMA.squad.map((p) => p.no).find((n) => !xi.includes(n));
  s = L.withSub(s, { t: T, team: "TMA", out, in: bench });
  const m = L.matchOf(s);
  assert.equal(m.subsActual.TMA.length, 1);
  assert.equal(m.subsActual.TMA[0].out, out);
  const sc = E.actualScenario(m);
  const onBefore = E.stateAt(m, sc, T - 60).players.filter((p) => p.onPitch && p.team === "TMA").map((p) => p.no);
  const onAfter = E.stateAt(m, sc, T + 120).players.filter((p) => p.onPitch && p.team === "TMA").map((p) => p.no);
  assert.ok(onBefore.includes(out), "交代前は居る");
  assert.ok(!onAfter.includes(out), "交代後は退いている");
  assert.ok(onAfter.includes(bench), "控えが入っている");
});

test("stateAt: 壁時計から 1 回で世界が取れる・試合終了後は終端で止まる", () => {
  let s = L.withClock(L.create(cfg()), "start", T0);
  const a = L.stateAt(s, T0 + 90_000);
  assert.equal(Math.round(a.t), 90);
  assert.equal(a.state.players.length, 22);
  assert.equal(a.running, true);
  const end = a.match.time.h2.end;
  const late = L.stateAt(s, T0 + (end + 5000) * 1000);
  assert.equal(late.t, end, "試合時間を超えたら終端で止まる");
  assert.ok(Number.isFinite(late.state.ball.x));
  // 同じ壁時計なら完全に同じ世界（決定論）
  const b = L.stateAt(s, T0 + 90_000);
  assert.deepEqual(b.state.players.map((p) => [p.no, p.x, p.y]), a.state.players.map((p) => [p.no, p.x, p.y]));
});

test("入力の種類: シュート・CK もボールと保持に効く／範囲外の時刻は試合内へ丸める", () => {
  let s = L.withClock(L.create(cfg()), "start", T0);
  const base = L.matchOf(s);
  const end = base.time.h2.end;
  s = L.withEvent(s, { t: 1200, type: "shot", team: "TMA", no: 11 });
  s = L.withEvent(s, { t: 1800, type: "corner", team: "TMB" });
  const m = L.matchOf(s);
  // シュート/CK でボールが相手ゴール方向・コーナー付近へ寄る
  const nearShot = m.ballAnchors.filter((a) => Math.abs(a.t - 1200) <= 6);
  assert.ok(nearShot.length >= 2, "シュートの前後にアンカーが入る");
  const ck = m.ballAnchors.find((a) => a.t === 1800);
  assert.ok(ck && Math.abs(ck.x) > 50 && Math.abs(ck.y) > 30, `CK はコーナー付近 ${JSON.stringify(ck)}`);
  // 保持の起伏が入り、危険度が動く
  const sc = E.actualScenario(m);
  const at = (t) => D.indexAt(m, sc, t).TMA.total;
  assert.ok(Number.isFinite(at(1195)) && Number.isFinite(at(1800)));
  assert.ok(at(1198) > at(900), `シュート直前は平常より高い（${at(1198).toFixed(1)} vs ${at(900).toFixed(1)}）`);

  // 試合時間の外を入力しても内側へ丸める（誤入力で世界が壊れない）
  const clamped = L.matchOf(L.withEvent(L.withEvent(s, { t: -500, type: "shot", team: "TMA" }), { t: end + 9999, type: "goal", team: "TMB", no: 9 }));
  for (const ev of clamped.events) assert.ok(ev.t >= 0 && ev.t <= end, `${ev.type} t=${ev.t}`);
  for (const a of clamped.ballAnchors) assert.ok(a.t >= 0 && a.t <= end, `anchor t=${a.t}`);
  assert.deepEqual(clamped.meta.score, { TMA: 0, TMB: 1 });
});
