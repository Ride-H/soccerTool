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

/* ---------------------------------------------------------------------------
   #189 PK コース記録の契約。
   規律（docs/RESPONSIBLE_ANALYSIS.md §6）はここでも守る: 集計は本数と母数だけを返し、
   確率は返さない。保存はライブセッションに載せる（保存の仕組みを二重に作らない）。
   --------------------------------------------------------------------------- */
test("#189 PK: 1 本ずつ記録され、入力順に並び、母数つきで数えられる", () => {
  let s = L.create(cfg());
  assert.deepEqual(s.pk, [], "初期は空");
  s = L.withPk(s, { team: "TMA", kicker: 9, gk: 1, approach: "L", gkMove: "R", cell: 0, scored: true });
  s = L.withPk(s, { team: "TMB", kicker: 10, gk: 12, approach: "C", gkMove: "S", cell: 8, scored: false });
  s = L.withPk(s, { team: "TMA", kicker: 9, gk: 1, approach: "L", gkMove: "L", cell: 0, scored: true });
  assert.deepEqual(s.pk.map((r) => r.n), [1, 2, 3], "入力順に番号が付く");

  const t = L.pkTally(s, { team: "TMA", kicker: 9 });
  assert.equal(t.total, 2, "母数");
  assert.equal(t.scored, 2);
  assert.equal(t.cells[0], 2, "左下 2 本");
  assert.equal(t.cells.reduce((a, b) => a + b, 0), t.total, "セルの合計＝母数");
  // 割合・確率は返さない（§6）
  for (const k of Object.keys(t)) assert.ok(!/rate|prob|pct|ratio/i.test(k), `確率めいた項目 ${k} を返している`);

  const all = L.pkTally(s);
  assert.equal(all.total, 3);
});

test("#189 PK: 不正な入力を受け付けない", () => {
  const s = L.create(cfg());
  assert.throws(() => L.withPk(s, { cell: 0, scored: true }), /team が必要/);
  assert.throws(() => L.withPk(s, { team: "TMA", cell: 9, scored: true }), /cell が範囲外/);
  assert.throws(() => L.withPk(s, { team: "TMA", cell: -1, scored: true }), /cell が範囲外/);
  assert.throws(() => L.withPk(s, { team: "TMA", cell: 0 }), /scored/);
  assert.throws(() => L.withPk(s, { team: "TMA", cell: 0, scored: true, approach: "X" }), /助走側/);
  assert.throws(() => L.withPk(s, { team: "TMA", cell: 0, scored: true, gkMove: "X" }), /GK の動き/);
});

test("#189 PK: 取り消しは PK の列だけを戻す・元のセッションを書き換えない", () => {
  let s = L.withEvent(L.create(cfg()), { t: 100, type: "goal", team: "TMA", no: 9 });
  s = L.withPk(s, { team: "TMA", cell: 4, scored: true });
  const snapshot = JSON.stringify(s);
  const back = L.undoPk(s);
  assert.equal(back.pk.length, 0);
  assert.equal(back.events.length, 1, "イベントは触らない");
  assert.equal(JSON.stringify(s), snapshot, "元のセッションは不変");
  assert.equal(L.undoPk(L.create(cfg())).pk.length, 0, "空でも壊れない");
});

test("#189 PK: 保存と復元で記録が往復する（保存の仕組みを増やさない）", () => {
  let s = L.create(cfg());
  s = L.withPk(s, { team: "TMA", kicker: 9, gk: 1, approach: "R", gkMove: "L", cell: 5, scored: false,
    approachAt: 1000, gkMoveAt: 1800, kickAt: 2000 });
  const back = L.fromObj(L.toObj(s), Date.now());
  assert.deepEqual(back.pk, s.pk, "PK 記録がそのまま戻る");
  // 蹴る前の観測は時刻つきで残る（結果だけでは「GK が早く倒れるか」が分からない）
  assert.equal(back.pk[0].kickAt - back.pk[0].gkMoveAt, 200);
});

test("#189 PK: ゴールマウスの格子が 3×3 で、セル中心がゴール内に収まる", () => {
  assert.equal(L.PK_COLS * L.PK_ROWS, 9);
  for (let c = 0; c < 9; c++) {
    const p = L.pkCellCenter(c);
    assert.ok(Math.abs(p.w) <= L.PK_GOAL_W / 2, `セル ${c} の幅 ${p.w} がゴール外`);
    assert.ok(p.h > 0 && p.h <= L.PK_GOAL_H, `セル ${c} の高さ ${p.h} がゴール外`);
  }
  assert.equal(L.pkCellCenter(4).w, 0, "中央のセルは幅の中心");
  assert.ok(L.pkCellCenter(0).h < L.pkCellCenter(6).h, "0 は下段・6 は上段");
});

test("#189 PK: 順番は交互で、決まった本数が数えられる", () => {
  let s = L.create(cfg());
  assert.equal(L.pkStanding(s, ["TMA", "TMB"]).n, 1);
  assert.equal(L.pkStanding(s, ["TMA", "TMB"]).team, "TMA", "先攻は 1 番目のチーム");
  s = L.withPk(s, { team: "TMA", cell: 0, scored: true });
  assert.equal(L.pkStanding(s, ["TMA", "TMB"]).team, "TMB", "次は相手");
  s = L.withPk(s, { team: "TMB", cell: 1, scored: false });
  const st = L.pkStanding(s, ["TMA", "TMB"]);
  assert.equal(st.n, 3);
  assert.equal(st.team, "TMA");
  assert.deepEqual(st.score, { TMA: 1, TMB: 0 });
  assert.deepEqual(st.taken, { TMA: 1, TMB: 1 });
});

// #190: ゴールマウスへ流す本数は、0 本と 1 本が構造的に区別できること。
// 粒子は本数に比例して置くので、0 本のセルには 1 粒も出ない（明るさではなく数で示す）。
test("#190 PK: セルごとの本数が 0 と 1 で区別でき、絞り込みで母数が変わる", () => {
  let s = L.create(cfg());
  s = L.withPk(s, { team: "TMA", kicker: 9, cell: 0, scored: true });
  s = L.withPk(s, { team: "TMB", kicker: 10, cell: 0, scored: false });
  s = L.withPk(s, { team: "TMA", kicker: 9, cell: 8, scored: true });

  const kicker = L.pkTally(s, { team: "TMA", kicker: 9 });
  const team = L.pkTally(s, { team: "TMA" });
  const all = L.pkTally(s);
  assert.deepEqual([kicker.total, team.total, all.total], [2, 2, 3], "絞り込みで母数が変わる");

  // 0 本のセルは 0（描画側はこれを見て 1 粒も置かない）
  assert.equal(all.cells[4], 0, "記録の無いセルは 0");
  assert.equal(all.cells[0], 2, "同じセルに 2 本");
  assert.equal(all.cells[8], 1, "別のセルに 1 本");
  assert.ok(all.cells[0] > all.cells[8] && all.cells[8] > all.cells[4], "0本 < 1本 < 2本 の順に区別できる");
});
