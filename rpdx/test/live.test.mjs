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

/* ---------------------------------------------------------------------------
   #191 PK 戦の進行。位置エンジンには載せない（engine.mjs の差分ゼロ）。
   成否の予測はしない — ここに在るのは記録から数えた結果だけ（#187 §6）。
   --------------------------------------------------------------------------- */
const T2 = ["TMA", "TMB"];
const kick = (s, team, scored) => L.withPk(s, { team, cell: 4, scored });

test("#191 PK戦: 残り本数で追いつけなくなったら 5 本を待たずに決着する", () => {
  let s = L.create(cfg());
  assert.equal(L.pkResult(s, T2).decided, false, "開始時は未決着");
  for (const [tm, ok] of [["TMA", 1], ["TMB", 0], ["TMA", 1], ["TMB", 0]]) s = kick(s, tm, !!ok);
  assert.equal(L.pkResult(s, T2).decided, false, "2-0（2本ずつ）はまだ追いつける");
  s = kick(s, "TMA", true); s = kick(s, "TMB", false);
  const r = L.pkResult(s, T2);
  assert.equal(r.decided, true, "3-0（3本ずつ）は残り 2 本で追いつけない");
  assert.equal(r.winner, "TMA");
  assert.equal(r.reason, "打ち切り");
  assert.equal(r.phase, "regular");
});

test("#191 PK戦: 5 本ずつで同点ならサドンデスへ入り、同数で差がついたら決着する", () => {
  let s = L.create(cfg());
  for (let i = 0; i < 5; i++) { s = kick(s, "TMA", true); s = kick(s, "TMB", true); }
  const tied = L.pkResult(s, T2);
  assert.equal(tied.decided, false);
  assert.equal(tied.phase, "sudden", "5-5 はサドンデス");
  assert.deepEqual(tied.taken, { TMA: 5, TMB: 5 });

  s = kick(s, "TMA", true);
  assert.equal(L.pkResult(s, T2).decided, false, "片方だけ蹴った時点では決着しない");
  s = kick(s, "TMB", false);
  const r = L.pkResult(s, T2);
  assert.equal(r.decided, true);
  assert.equal(r.winner, "TMA");
  assert.equal(r.reason, "サドンデス");

  // サドンデスで両者決めれば続く
  let s2 = L.create(cfg());
  for (let i = 0; i < 5; i++) { s2 = kick(s2, "TMA", false); s2 = kick(s2, "TMB", false); }
  s2 = kick(s2, "TMA", true); s2 = kick(s2, "TMB", true);
  assert.equal(L.pkResult(s2, T2).decided, false, "0-0 から 1-1 は続行");
});

test("#191 PK戦: 5 本ずつ終えて差があればそこで決着する", () => {
  let s = L.create(cfg());
  for (let i = 0; i < 5; i++) { s = kick(s, "TMA", i < 4); s = kick(s, "TMB", i < 3); }
  const r = L.pkResult(s, T2);
  assert.equal(r.decided, true);
  assert.equal(r.winner, "TMA");
  assert.equal(r.reason, "5 本ずつ");
  assert.deepEqual(r.score, { TMA: 4, TMB: 3 });
});

test("#191 PK戦: 順番を変えても記録済みの本は 1 本も動かない", () => {
  let s = L.create(cfg());
  s = kick(s, "TMA", true);
  s = kick(s, "TMB", false);
  const before = JSON.stringify(s.pk);
  s = L.withPkOrder(s, "TMA", [10, 9, 7]);
  s = L.withPkOrder(s, "TMA", [7, 9, 10]);          // 並べ替え
  s = L.withPkOrder(s, "TMB", [1, 2]);
  assert.equal(JSON.stringify(s.pk), before, "記録は不変");
  assert.deepEqual(s.pkOrder.TMA, [7, 9, 10]);
  // 計画は巡回する（サドンデスで一巡しても止まらない）
  assert.deepEqual([1, 2, 3, 4].map((n) => L.pkPlanned(s, "TMA", n)), [7, 9, 10, 7]);
  assert.equal(L.pkPlanned(s, "TMC", 1), null, "計画の無いチームは null");
  assert.throws(() => L.withPkOrder(s, "TMA", "10,9"), /背番号の配列/);
  assert.throws(() => L.withPkOrder(s, null, [1]), /team が必要/);
  // 保存往復
  const back = L.fromObj(L.toObj(s), Date.now());
  assert.deepEqual(back.pkOrder, s.pkOrder);
  assert.deepEqual(back.pk, s.pk);
});

// リリース前検査: 旧バージョンで保存したバンドル（pk / pkOrder が無い）を読み込めること。
// 利用者の端末には前の版で保存したセッションが残っている。読めなくなると記録が消える。
test("互換: PK より前に保存したセッションを読み込める", () => {
  const base = L.create(cfg());
  const old = L.toObj(L.withEvent(base, { t: 100, type: "goal", team: "TMA", no: 9 }));
  delete old.pk;            // 旧版には無かった項目
  delete old.pkOrder;
  const back = L.fromObj(old, Date.now());
  assert.ok(back, "読み込めること");
  assert.deepEqual(back.pk, [], "PK は空で始まる");
  assert.equal(back.events.length, 1, "旧版の記録は残る");
  // 読み込んだあと PK を足せる（片方向の互換で終わらせない）
  const next = L.withPk(back, { team: "TMA", cell: 0, scored: true });
  assert.equal(next.pk.length, 1);
  assert.deepEqual(L.fromObj(L.toObj(next), Date.now()).pk, next.pk, "保存し直しても往復する");
});

/* ---------------------------------------------------------------------------
   #196 試合中の PK と PK 戦を別のデータとして持つ。
   違い: 試合中の PK は試合時間 t を持ち／同じチームに連続で与えられ得る／危険度に効く。
         PK 戦は試合時間を持たず／順番 n で交互／危険度に関係しない。
   --------------------------------------------------------------------------- */
test("#196 試合中の PK: 試合時間を持ち、同じチームに連続で与えられる", () => {
  let s = L.create(cfg());
  s = L.withPenalty(s, { t: 1320, team: "TMA", kicker: 9, gk: 1, cell: 0, scored: true });
  s = L.withPenalty(s, { t: 2100, team: "TMA", kicker: 9, gk: 1, cell: 8, scored: false });
  const m = L.matchOf(s);
  const pens = m.events.filter((e) => e.type === "penalty");
  assert.equal(pens.length, 2, "同じチームに 2 本続けて入る（PK 戦では起こらない）");
  assert.deepEqual(pens.map((e) => e.t), [1320, 2100], "試合時間を持つ");
  assert.equal(pens[0].min, "22'", "分表示が付く＝試合のイベントとして扱われる");
  // 決まった PK は試合の得点になる。PK 戦の成否は試合スコアに入れない。
  assert.deepEqual(m.meta.score, { TMA: 1, TMB: 0 });
});

test("#196 試合中の PK: 危険度に効く／PK 戦は効かない", () => {
  const base = L.create(cfg());
  const T = 1320;
  const peak = (sess) => {
    const m = L.matchOf(sess), sc = E.actualScenario(m);
    let x = 0;
    for (let t = T - 10; t <= T + 1; t++) x = Math.max(x, D.indexAt(m, sc, t).TMA.total);
    return x;
  };
  const plain = peak(base);
  const withPen = peak(L.withPenalty(base, { t: T, team: "TMA", cell: 0, scored: true }));
  const withShootout = peak(L.withPk(base, { team: "TMA", cell: 4, scored: true }));
  assert.ok(withPen > plain + 15, `試合中の PK は危険度を上げる（${withPen.toFixed(1)} vs ${plain.toFixed(1)}）`);
  assert.equal(withShootout, plain, "PK 戦は試合中の危険度に影響しない");
});

test("#196 試合中の PK: ボールが PK スポットへ据えられ、決まればゴールへ入る", () => {
  const T = 1320;
  const m = L.matchOf(L.withPenalty(L.create(cfg()), { t: T, team: "TMA", cell: 0, scored: true }));
  const sc = E.actualScenario(m);
  const half = E.halfOf(m, T), dir = m.dir.TMA[half === 1 ? "h1" : "h2"];
  const at = (t) => E.ballAt(m, sc, t).x * dir;   // 攻撃方向を正にそろえる
  assert.ok(Math.abs(at(T - 5) - 41.5) < 1.5, `蹴る前はスポット付近（実測 ${at(T - 5).toFixed(1)}・スポットは 41.5）`);
  // 「ゴール内」は x だけでは決まらない。枠の幅（±3.66m）も見る。
  const inGoal = (mm, t) => { const b = E.ballAt(mm, E.actualScenario(mm), t);
    return b.x * dir > 52.1 && Math.abs(b.y) < 3.66; };
  assert.ok(inGoal(m, T), "決まった PK はゴール枠の中へ入る");

  const miss = L.matchOf(L.withPenalty(L.create(cfg()), { t: T, team: "TMA", cell: 0, scored: false }));
  assert.deepEqual(miss.meta.score, { TMA: 0, TMB: 0 }, "外した PK は得点にならない");
  assert.ok(!inGoal(miss, T), "外した PK はゴール枠の外");
  // #196: 成功と失敗で試合 ID が変わること（同じだと古い世界が返り続ける — #182 と同じ型）
  assert.notEqual(m.meta.id, miss.meta.id, "成功/失敗で ID が変わる（キャッシュが古い世界を返さない）");
});

test("#196 PK 戦と試合中の PK が互いの集計・順番を汚さない", () => {
  let s = L.create(cfg());
  s = L.withPenalty(s, { t: 1320, team: "TMA", kicker: 9, cell: 0, scored: true });
  s = L.withPenalty(s, { t: 2100, team: "TMA", kicker: 9, cell: 8, scored: false });
  // 試合中の PK を 2 本入れても、PK 戦は 1 本目・先攻チームから
  const st0 = L.pkStanding(s, ["TMA", "TMB"]);
  assert.equal(st0.n, 1);
  assert.equal(st0.team, "TMA");
  assert.deepEqual(st0.taken, { TMA: 0, TMB: 0 }, "試合中の PK は PK 戦の本数に入らない");
  assert.equal(L.pkResult(s, ["TMA", "TMB"]).decided, false);

  s = L.withPk(s, { team: "TMA", kicker: 9, cell: 4, scored: true });
  assert.equal(L.pkStanding(s, ["TMA", "TMB"]).team, "TMB", "PK 戦は交互");

  // 集計は対象を選べる（数える関数を分けると片方だけ直る不具合を生む）
  assert.equal(L.pkTally(s).total, 1, "既定は PK 戦");
  assert.equal(L.pkTally(s, { source: "match" }).total, 2, "試合中の PK");
  assert.equal(L.pkTally(s, { source: "both" }).total, 3);
  assert.equal(L.pkTally(s, { source: "both", kicker: 9 }).total, 3);
  assert.equal(L.pkTally(s, { source: "match" }).scored, 1);
});

test("#196 試合中の PK: 不正な入力を受け付けない", () => {
  const s = L.create(cfg());
  assert.throws(() => L.withPenalty(s, { team: "TMA", scored: true }), /t が必要/);
  assert.throws(() => L.withPenalty(s, { t: 100, scored: true }), /team が必要/);
  assert.throws(() => L.withPenalty(s, { t: 100, team: "TMA" }), /scored/);
  assert.throws(() => L.withPenalty(s, { t: 100, team: "TMA", scored: true, cell: 9 }), /cell が範囲外/);
});

test("#196 保存往復: 試合中の PK と PK 戦が両方そのまま戻る", () => {
  let s = L.create(cfg());
  s = L.withPenalty(s, { t: 1320, team: "TMA", kicker: 9, cell: 0, scored: true });
  s = L.withPk(s, { team: "TMB", kicker: 10, cell: 8, scored: false });
  const back = L.fromObj(L.toObj(s), Date.now());
  assert.equal(back.events.filter((e) => e.type === "penalty").length, 1);
  assert.deepEqual(back.pk, s.pk);
  assert.equal(L.pkTally(back, { source: "both" }).total, 2);
});

// #196: 入力のどのフィールドを変えても試合 ID が変わること。
// ID の材料を手で並べていると、あとから足したフィールドが漏れて古い世界が返る（実際 scored で踏んだ）。
test("#196 試合 ID: 入力のどの項目を変えても世界が作り直される", () => {
  const base = L.create(cfg());
  const id = (sess) => L.matchOf(sess).meta.id;
  const p = { t: 1320, team: "TMA", kicker: 9, gk: 1, cell: 0, scored: true };
  const ref = id(L.withPenalty(base, p));
  const variants = {
    scored: { ...p, scored: false },
    cell: { ...p, cell: 5 },
    kicker: { ...p, kicker: 11 },
    gk: { ...p, gk: 12 },
    t: { ...p, t: 1500 },
    team: { ...p, team: "TMB" },
  };
  for (const [k, v] of Object.entries(variants))
    assert.notEqual(id(L.withPenalty(base, v)), ref, `${k} を変えても ID が同じ（古い世界が返る）`);
});

/* ---------------------------------------------------------------------------
   #201 アディショナルタイムを試合ごとに入力できる。
   実際のロスタイムは試合終盤に発表されるので、試合中に変えられる必要がある。
   --------------------------------------------------------------------------- */
test("#201 AT: 変更すると終端が動き、入力済みの記録は 1 件も失われない", () => {
  let s = L.withClock(L.create(cfg()), "start", T0);
  s = L.withEvent(s, { t: 1200, type: "goal", team: "TMA", no: 9 });
  s = L.withPenalty(s, { t: 2000, team: "TMB", cell: 4, scored: true });
  s = L.withPk(s, { team: "TMA", cell: 0, scored: true });
  s = L.withSub(s, { t: 2400, team: "TMA", out: Object.values(L.matchOf(s).teams.TMA.phases[0].assign)[5], in: 99 });
  const end0 = E.playedRange(L.matchOf(s)).t1;

  s = L.withCfg(s, { ...s.cfg, added2: 9 });
  const end1 = E.playedRange(L.matchOf(s)).t1;
  assert.equal(end1 - end0, (9 - 5) * 60, "後半 AT を +5 → +9 にすると終端が 4 分伸びる");
  assert.equal(s.events.length, 2, "イベントは保持");
  assert.equal(s.pk.length, 1, "PK 戦の記録は保持");
  assert.equal(s.subs.length, 1, "交代は保持");

  // 減らす方向でも同じ（記録が範囲外になっても既存の丸め規則で壊れない）
  const shrunk = L.withCfg(s, { ...s.cfg, added2: 0 });
  const m = L.matchOf(shrunk);
  const end2 = E.playedRange(m).t1;
  assert.ok(end2 < end1, "減らせば終端は縮む");
  for (const ev of m.events) assert.ok(ev.t >= 0 && ev.t <= end2, `イベント ${ev.type} が範囲外 ${ev.t}`);
  for (const a of m.ballAnchors) assert.ok(a.t >= 0 && a.t <= end2, `アンカーが範囲外 ${a.t}`);
});

test("#201 AT: 保存と復元で往復する（既定値なら従来と同じ）", () => {
  const s = L.withCfg(L.create(cfg()), { ...cfg(), added1: 4, added2: 9 });
  const back = L.fromObj(L.toObj(s), Date.now());
  assert.equal(back.cfg.added1, 4);
  assert.equal(back.cfg.added2, 9);
  assert.equal(E.playedRange(L.matchOf(back)).t1, E.playedRange(L.matchOf(s)).t1);
  // 既定値のままなら 90+5（従来と同じ）
  const plain = L.create(cfg());
  assert.equal(L.matchOf(plain).time.h2.added, 5);
});

/* ---------------------------------------------------------------------------
   #202 自作の試合で延長戦を作る。
   エンジン側は #141 で h3/h4 に一般対応済みなので、生成経路とピリオド進行だけを足す。
   --------------------------------------------------------------------------- */
test("#202 延長: 未指定なら従来どおり／指定すると h3/h4 が生える", () => {
  const G2 = RPDX.generic;
  const plain = G2.createMatch(G2.template());
  assert.equal(plain.time.h3, undefined, "未指定なら延長のキーごと生えない");
  assert.equal(E.playedRange(plain).t1, 2700 + 2 * 60 + 2700 + 5 * 60);

  const ex = G2.createMatch({ ...G2.template(), extra: true, added3: 2, added4: 3 });
  assert.ok(ex.time.h3 && ex.time.h4, "延長のピリオドが生える");
  assert.equal(ex.time.h3.start, ex.time.h2.end, "延長前半は後半終了から始まる");
  assert.equal(ex.time.h3.end - ex.time.h3.start, 900 + 2 * 60, "延長前半は 15 分 + AT");
  assert.equal(ex.time.h4.end - ex.time.h4.start, 900 + 3 * 60, "延長後半は 15 分 + AT");
  // #141 の一般対応がそのまま効く（105+X / 120+X 表示）
  assert.match(E.clockAt(ex, ex.time.h4.end).disp, /^120\+3/, "終端は 120+3");
  assert.equal(E.playedRange(ex).t1, ex.time.h4.end);
});

test("#202 延長: 後半終了で止まり、延長前半・延長後半へ順に進む", () => {
  const cfgX = { ...cfg(), extra: true, added2: 4, added3: 2, added4: 3 };
  let s = L.withClock(L.create(cfgX), "start", T0);
  const m = L.matchOf(s);
  const at = (t) => T0 + t * 1000;

  s = L.atHalfBreak(s, m, at(m.time.h1.end + 3));
  assert.ok(s, "前半終了で止まる");
  assert.equal(L.breakAt(s, m, at(m.time.h1.end + 3)), "h2");
  s = L.startSecondHalf(s, m, at(m.time.h1.end + 60));

  const wallAtFT = at(m.time.h1.end + 60 + (m.time.h2.end - m.time.h2.start) + 3);
  const stopped = L.atHalfBreak(s, m, wallAtFT);
  assert.ok(stopped, "後半終了でも止まる（#183 は前半しか見ていなかった）");
  assert.equal(Math.round(L.tAt(stopped, wallAtFT)), m.time.h2.end);
  assert.equal(L.breakAt(stopped, m, wallAtFT), "h3", "次は延長前半");

  const inET = L.startSecondHalf(stopped, m, wallAtFT + 60_000);
  assert.ok(L.isRunning(inET), "延長前半が動く");
  assert.equal(L.atHalfBreak(inET, m, wallAtFT + 61_000), null, "開始直後に止め直さない");
  assert.equal(L.breakAt(inET, m, wallAtFT + 61_000), null, "動いている間は区切りではない");
});

test("#202 延長: 途中で延長を足しても記録が失われず、保存で往復する", () => {
  let s = L.withClock(L.create(cfg()), "start", T0);
  s = L.withEvent(s, { t: 1200, type: "goal", team: "TMA", no: 9 });
  s = L.withPk(s, { team: "TMA", cell: 0, scored: true });
  const end0 = E.playedRange(L.matchOf(s)).t1;

  s = L.withCfg(s, { ...s.cfg, extra: true });
  const m = L.matchOf(s);
  assert.ok(m.time.h3, "後から延長を足せる");
  assert.ok(E.playedRange(m).t1 > end0, "終端が伸びる");
  assert.equal(s.events.length, 1, "イベントは保持");
  assert.equal(s.pk.length, 1, "PK 戦の記録は保持");

  const back = L.fromObj(L.toObj(s), Date.now());
  assert.equal(back.cfg.extra, true);
  assert.equal(E.playedRange(L.matchOf(back)).t1, E.playedRange(m).t1);
});

test("#202 延長: 復帰しても開始済みのピリオドで止め直さない", () => {
  const cfgX = { ...cfg(), extra: true };
  let s = L.withClock(L.create(cfgX), "start", T0);
  const m = L.matchOf(s);
  const at = (t) => T0 + t * 1000;
  s = L.startSecondHalf(L.atHalfBreak(s, m, at(m.time.h1.end + 3)), m, at(m.time.h1.end + 60));
  const wFT = at(m.time.h1.end + 60 + (m.time.h2.end - m.time.h2.start) + 3);
  s = L.startSecondHalf(L.atHalfBreak(s, m, wFT), m, wFT + 60_000);   // 延長前半へ
  const back = L.fromObj(L.toObj(s), wFT + 200_000);
  assert.notEqual(L.breakAt(back, m, wFT + 200_000), "h2", "復帰後に後半開始へ戻らない");
  assert.notEqual(L.breakAt(back, m, wFT + 200_000), "h3", "復帰後に延長前半開始へも戻らない");
});
