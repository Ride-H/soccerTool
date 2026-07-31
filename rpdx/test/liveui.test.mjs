// #180 ライブ実況モードの契約（DOM 非依存の部分）。
// 画面まわりの検証は「操作標的の大きさ」だけヘッドレスで別途測る（rpdx/tools/ui-probe.mjs）。
// ここでは「入力→世界」の対応が壊れていないことを、UI を通さず session の API で固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX } from "./load.mjs";

const { live: L, generic: G, engine: E, danger: D, tactics: TAC } = RPDX;
const T0 = 1_700_000_000_000;
const start = () => L.withClock(L.create(G.template()), "start", T0);

test("ライブモードの開始と終了: セッションは作れて捨てられる（元の世界へ戻れる）", () => {
  const s = L.create(G.template());
  assert.equal(L.isRunning(s), false, "作った直後は動いていない");
  assert.equal(L.tAt(s, T0), 0);
  const m = L.matchOf(s);
  assert.equal(m.meta.live, true, "ライブであることが match から分かる");
  assert.equal(m.meta.calibrated, false, "未較正であることを明示する");
  assert.ok(E.teamKeys(m).length === 2);
  // 捨てても元のテンプレ試合は無傷（同じ cfg から作り直せる）
  assert.equal(G.templateMatch().meta.live, undefined);
});

test("時計の操作が session へ反映される（開始・一時停止・再開・時刻合わせ）", () => {
  let s = start();
  assert.equal(Math.round(L.tAt(s, T0 + 65_000)), 65);
  s = L.withClock(s, "pause", T0 + 65_000);
  assert.equal(L.isRunning(s), false);
  assert.equal(Math.round(L.tAt(s, T0 + 300_000)), 65, "止めている間は進まない");
  s = L.withClock(s, "resume", T0 + 300_000);
  assert.ok(L.isRunning(s));
  // 中継に合わせる: 分を指定して飛ばす（UI の「時計合わせ」と同じ経路）
  s = L.withClock(s, "sync", T0 + 300_000, 63 * 60);
  assert.equal(L.tAt(s, T0 + 300_000), 3780);
  assert.equal(Math.round(L.tAt(s, T0 + 310_000)), 3790, "合わせた後も進む");
});

test("イベント入力と取り消し: 得点/シュート/CK/警告/退場と undo", () => {
  let s = start();
  const KS = E.teamKeys(L.matchOf(s));
  for (const [i, type] of ["goal", "shot", "corner", "yellow", "red"].entries())
    s = L.withEvent(s, { t: 300 + i * 60, type, team: KS[i % 2], no: 9 });
  const m = L.matchOf(s);
  for (const type of ["goal", "shot", "corner", "yellow", "red"])
    assert.ok(m.events.some((e) => e.type === type), `${type} が世界へ入る`);
  assert.equal(m.meta.score[KS[0]], 1, "得点はスコアに乗る");
  const back = L.undo(L.undo(s));
  assert.equal(back.events.length, 3, "取り消しは 1 件ずつ戻る");
  // 取り消した後の世界は「入れる前」と一致する（残骸が残らない）
  let s2 = start();
  for (const [i, type] of ["goal", "shot", "corner"].entries()) s2 = L.withEvent(s2, { t: 300 + i * 60, type, team: KS[i % 2], no: 9 });
  assert.deepEqual(L.matchOf(back).events.map((e) => e.t + e.type), L.matchOf(s2).events.map((e) => e.t + e.type));
});

test("入力は解釈レイヤーまで届く（危険度と戦術助言が反応する）", () => {
  let s = start();
  const KS = E.teamKeys(L.matchOf(s));
  const T = 1500;
  const base = L.matchOf(s), scB = E.actualScenario(base);
  const quiet = D.indexAt(base, scB, T - 3)[KS[0]].total;
  s = L.withEvent(s, { t: T, type: "goal", team: KS[0], no: 9 });
  const m = L.matchOf(s), sc = E.actualScenario(m);
  let peak = 0;
  for (let t = T - 12; t <= T + 1; t++) peak = Math.max(peak, D.indexAt(m, sc, t)[KS[0]].total);
  assert.ok(peak > quiet + 10, `得点直前に危険度が上がる（${peak.toFixed(1)} vs ${quiet.toFixed(1)}）`);
  const st = E.stateAt(m, sc, T - 5);
  const adv = TAC.frameAnalysis(m, st, { team: KS[0] });
  assert.ok(adv && adv.suggestions.length > 0, "戦術助言が出る");
  for (const g of adv.suggestions) assert.ok(typeof g.text === "string" && g.text.length > 0);
});

test("ライブの世界は決定論（同じセッション・同じ壁時計なら同じ）", () => {
  let s = start();
  s = L.withEvent(s, { t: 900, type: "shot", team: E.teamKeys(L.matchOf(s))[1], no: 7 });
  const a = L.stateAt(s, T0 + 950_000), b = L.stateAt(s, T0 + 950_000);
  assert.deepEqual(a.state.players.map((p) => [p.no, p.x, p.y]), b.state.players.map((p) => [p.no, p.x, p.y]));
  assert.equal(a.t, b.t);
});

// #181 保存・復帰は**既存のバンドル**に載せる（ライブ専用の保存機構を作らない）。
// ここでは「往復して世界が bit 一致すること」「復帰した時計が止まっていること」
// 「従来のバンドルが引き続き読めること」を固定する。
test("保存・復帰: 既存のバンドルへ載せて往復し、世界が bit 一致する", () => {
  const SCN = RPDX.scenlib;
  let s = L.withClock(L.create(G.template()), "start", T0);
  const KS = E.teamKeys(L.matchOf(s));
  s = L.withEvent(s, { t: 1200, type: "goal", team: KS[0], no: 9 });
  s = L.withEvent(s, { t: 1800, type: "corner", team: KS[1] });
  const on = E.stateAt(L.matchOf(s), E.actualScenario(L.matchOf(s)), 2000).players
    .filter((p) => p.team === KS[0] && p.onPitch).map((p) => p.no);
  const bench = L.matchOf(s).teams[KS[0]].squad.map((p) => p.no).find((n) => !on.includes(n));
  s = L.withSub(s, { t: 2000, team: KS[0], out: on[5], in: bench });

  const m = L.matchOf(s), sc = E.actualScenario(m);
  const json = SCN.serializeBundle(m, sc, null, { live: s });
  const bundle = JSON.parse(json);
  assert.ok(bundle.live, "バンドルに live セクションが入る");
  assert.ok(bundle.customMatch, "未較正なのでロスターも同梱される（既存の仕組み）");

  const r = SCN.parseBundle(m, json);
  assert.ok(r.live, "復帰できる");
  assert.equal(L.isRunning(r.live), false, "復帰した時計は止まっている（勝手に進み出さない）");
  const m2 = L.matchOf(r.live);
  assert.deepEqual(m2.events.map((e) => `${e.t}${e.type}`), m.events.map((e) => `${e.t}${e.type}`));
  assert.deepEqual(m2.subsActual, m.subsActual);
  assert.deepEqual(m2.meta.score, m.meta.score);
  const pos = (mm) => E.stateAt(mm, E.actualScenario(mm), 900).players.map((p) => [p.no, p.x, p.y]);
  assert.deepEqual(pos(m2), pos(m), "復帰後の世界が保存前と bit 一致");
});

test("保存・復帰: 従来のバンドル（live なし）は今までどおり読める", () => {
  const SCN = RPDX.scenlib;
  const m = G.templateMatch(), sc = E.actualScenario(m);
  const r = SCN.parseBundle(m, SCN.serializeBundle(m, sc, null));
  assert.equal(r.live, undefined, "live が無ければ live キーも付かない");
  assert.ok(r.scenario && r.validation, "従来の戻り値はそのまま");
});

test("保存・復帰: 時計の続きから再開できる（保存時点の試合時刻を保つ）", () => {
  const SCN = RPDX.scenlib;
  let s = L.withClock(L.create(G.template()), "start", T0);
  s = L.withClock(s, "sync", T0 + 60_000, 2400);          // 40 分に合わせて進行中
  const m = L.matchOf(s);
  const saved = JSON.parse(SCN.serializeBundle(m, E.actualScenario(m), null, { live: s }));
  saved.live.savedAt = T0 + 60_000;                        // 保存した瞬間＝試合 2400s
  // 復帰の壁時計を指定できる形で呼ぶ（parseBundle は実時刻を使う。ここは検証のため固定）
  assert.ok(SCN.parseBundle(m, saved).live, "parseBundle からも復帰できる");
  const restored = L.fromObj(saved.live, T0 + 999_999);
  const t = L.tAt(restored, T0 + 999_999);
  assert.ok(Math.abs(t - 2400) < 1, `保存時点の試合時刻から再開できる（${t}）`);
  assert.equal(L.isRunning(restored), false, "復帰直後は止まっている");
  const resumed = L.withClock(restored, "resume", T0 + 999_999);
  assert.ok(L.isRunning(resumed));
  assert.ok(Math.abs(L.tAt(resumed, T0 + 1_009_999) - 2410) < 1, "再開後は進む");
});

// #182 名簿はライブ専用に作らず、既存の cfg → createMatch の経路を通す。
// 記録済みの入力を保ったまま名簿だけ差し替えられること、ID がちゃんと変わることを固定する。
test("名簿: cfg を差し替えても入力した記録は残る（既存の createMatch 経路）", () => {
  let s = L.withClock(L.create(G.template()), "start", T0);
  const KS0 = E.teamKeys(L.matchOf(s));
  s = L.withEvent(s, { t: 600, type: "goal", team: KS0[0], no: 9 });
  const before = L.matchOf(s);

  // チーム名だけ差し替えた cfg（UI の「この名簿ではじめる」と同じ操作）
  const cfg2 = JSON.parse(JSON.stringify(s.cfg));
  cfg2.home.name = "県立南高校"; cfg2.home.code = "MNM";
  cfg2.away.name = "北高校"; cfg2.away.code = "KTA";
  const s2 = L.withCfg(s, cfg2);
  const after = L.matchOf(s2);

  assert.deepEqual(E.teamKeys(after), ["MNM", "KTA"], "チームが差し替わる");
  assert.equal(after.teams.MNM.name, "県立南高校");
  assert.equal(after.events.filter((e) => e.type === "goal").length, 1, "入力した得点は残る");
  assert.notEqual(after.meta.id, before.meta.id,
    "名簿が変われば試合 ID も変わる（同じだと各層のキャッシュが古い世界を返す）");
  assert.equal(after.meta.seedId, before.meta.seedId, "世界生成の種は変えない（過去が作り直されない）");
  // 記録は残るが、チームキーが変わるので古いキーの得点は数えない（UI 側で選び直す前提）
  assert.equal(Object.keys(after.meta.score).length, 2);
});

test("名簿: 収録試合はライブの土台にしない（公式記録を上書きしたように見せない）", () => {
  const rec = RPDX.data.MATCH;
  assert.notEqual(rec.meta.calibrated, false, "収録試合は較正済み");
  const tpl = G.templateMatch();
  assert.equal(tpl.meta.calibrated, false, "テンプレ/カスタムは未較正");
  // ライブが作る試合は必ず未較正（＝画面で「未較正」と明示される）
  const m = L.matchOf(L.create(G.template()));
  assert.equal(m.meta.calibrated, false);
  assert.equal(m.meta.live, true);
});

// #183 ハーフタイムは必ず起きるので、人が時計合わせで入れ直さなくてよい。
test("ハーフタイム: 前半終了で自動的に止まり、後半開始で先頭から進む", () => {
  let s = L.withClock(L.create(G.template()), "start", T0);
  const m = L.matchOf(s);
  const h1end = m.time.h1.end, h2start = m.time.h2.start;
  assert.ok(h1end > 0 && h2start >= h1end);

  // 前半の途中では何も起きない
  assert.equal(L.atHalfBreak(s, m, T0 + (h1end - 60) * 1000), null, "前半の途中では止めない");
  assert.equal(L.isAtHalfBreak(s, m, T0 + (h1end - 60) * 1000), false);

  // 前半終了を越えたら、越えた瞬間ちょうどで止まる（行き過ぎた分は進まない）
  const past = T0 + (h1end + 37) * 1000;
  const paused = L.atHalfBreak(s, m, past);
  assert.ok(paused, "前半終了を越えたら止める");
  assert.equal(L.isRunning(paused), false);
  assert.ok(Math.abs(L.tAt(paused, past) - h1end) < 1e-6, `止まる位置は前半終了ちょうど（${L.tAt(paused, past)}）`);
  assert.ok(Math.abs(L.tAt(paused, past + 600_000) - h1end) < 1e-6, "そのまま置いても進まない");
  assert.equal(L.isAtHalfBreak(paused, m, past), true, "画面が「後半開始」を出せる状態");
  assert.equal(L.atHalfBreak(paused, m, past), null, "止まっている間は何度呼んでも何もしない（純関数）");

  // 後半開始で後半の先頭から進む
  const h2 = L.startSecondHalf(paused, m, past + 300_000);
  assert.ok(L.isRunning(h2));
  assert.ok(Math.abs(L.tAt(h2, past + 300_000) - h2start) < 1e-6, "後半の先頭から");
  assert.ok(Math.abs(L.tAt(h2, past + 310_000) - (h2start + 10)) < 1e-6, "その後は進む");
  assert.equal(L.isAtHalfBreak(h2, m, past + 310_000), false);

  // 手動の時計合わせは従来どおり効く（ロスタイムの微調整）
  const synced = L.withClock(h2, "sync", past + 320_000, h2start + 120);
  assert.ok(Math.abs(L.tAt(synced, past + 320_000) - (h2start + 120)) < 1e-6);
});

test("ハーフタイム: 止まっている間に入力しても記録は前半終了の時刻に入る", () => {
  let s = L.withClock(L.create(G.template()), "start", T0);
  const m = L.matchOf(s);
  const h1end = m.time.h1.end;
  const past = T0 + (h1end + 5) * 1000;
  s = L.atHalfBreak(s, m, past) || s;
  const t = L.tAt(s, past + 60_000);
  s = L.withEvent(s, { t, type: "yellow", team: E.teamKeys(m)[0], no: 5 });
  const m2 = L.matchOf(s);
  const ev = m2.events.find((e) => e.type === "yellow");
  assert.ok(ev && Math.abs(ev.t - h1end) < 1e-6, "止まっている間の入力は前半終了の時刻");
});

// 実機で見つけた不具合の回帰: h1.end と h2.start は同じ時刻なので、時刻の比較だけで
// 自動停止を判断すると、後半開始の直後にまた止まってしまう（「後半開始」を押しても動かない）。
test("ハーフタイム: 後半開始のあとは二度と自動停止しない（保存・復帰をまたいでも）", () => {
  const SCN = RPDX.scenlib;
  let s = L.withClock(L.create(G.template()), "start", T0);
  const m = L.matchOf(s);
  assert.equal(m.time.h1.end, m.time.h2.start, "前半終了と後半開始は同じ時刻（この前提が罠だった）");
  const past = T0 + (m.time.h1.end + 5) * 1000;
  s = L.atHalfBreak(s, m, past);
  s = L.startSecondHalf(s, m, past + 60_000);
  assert.ok(L.isRunning(s), "後半は動いている");
  assert.equal(L.atHalfBreak(s, m, past + 61_000), null, "後半開始の直後に止め直さない");
  assert.equal(L.isAtHalfBreak(s, m, past + 61_000), false, "「後半開始」ボタンも出ない");
  assert.ok(L.tAt(s, past + 120_000) > m.time.h2.start + 30, "後半は進み続ける");

  // 保存・復帰をまたいでも前半終了へ戻らない
  const m2 = L.matchOf(s);
  const saved = JSON.parse(SCN.serializeBundle(m2, E.actualScenario(m2), null, { live: s }));
  const back = L.fromObj(saved.live, past + 200_000);
  assert.equal(L.isAtHalfBreak(back, m2, past + 200_000), false, "復帰後も後半のまま");
  const resumed = L.withClock(back, "resume", past + 200_000);
  assert.equal(L.atHalfBreak(resumed, m2, past + 260_000), null, "復帰して再開しても止め直さない");
});
