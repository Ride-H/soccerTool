// マッチパック共通整合テスト — レジストリ内の全試合に適用（試合非依存）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine, S = RPDX.subs, F = RPDX.formations;
const packs = Object.values(MATCHES);

test("packs: レジストリに1試合以上・既定試合が登録済み", () => {
  assert.ok(packs.length >= 1);
  assert.ok(MATCHES[RPDX.data.MATCH.meta.id] === RPDX.data.MATCH);
});

for (const m of packs) {
  const id = m.meta.id;
  const keys = Object.keys(m.teams);

  test(`packs[${id}]: チーム構造 — 2チーム・dir整合・kickoff/possessionPlus有効`, () => {
    assert.equal(keys.length, 2);
    const [a, b] = keys;
    assert.equal(m.dir[a].h1 + m.dir[b].h1, 0);
    assert.equal(m.dir[a].h1 + m.dir[a].h2, 0);
    assert.ok(keys.includes(m.kickoffBy.h1) && keys.includes(m.kickoffBy.h2));
    assert.ok(keys.includes(m.possessionPlus));
    for (const k of m.teamOrder) assert.ok(keys.includes(k));
  });

  test(`packs[${id}]: スカッド — 背番号一意・属性値域・ラベル`, () => {
    for (const k of keys) {
      const squad = m.teams[k].squad;
      const nos = new Set(squad.map(p => p.no));
      assert.equal(nos.size, squad.length, "背番号重複");
      assert.ok(squad.length >= 11);
      for (const p of squad) {
        assert.ok(p.name && p.ja && p.label, `${k}#${p.no} 名前欠落`);
        assert.ok(["GK", "DF", "MF", "FW"].includes(p.pos));
        for (const a of Object.values(p.attrs)) assert.ok(a >= 0 && a <= 100);
      }
    }
  });

  test(`packs[${id}]: 布陣 — 各フェーズ11人・スロットはシェイプ準拠・GK整合`, () => {
    for (const k of keys) {
      for (const ph of m.teams[k].phases) {
        const shape = F.SHAPES[ph.shape];
        assert.ok(shape, `未知のシェイプ ${ph.shape}`);
        const slotIds = new Set(shape.map(s => s.id));
        const assign = Object.entries(ph.assign);
        assert.equal(assign.length, 11);
        const nos = new Set();
        for (const [slot, no] of assign) {
          assert.ok(slotIds.has(slot), `未知スロット ${slot}`);
          assert.ok(!nos.has(no)); nos.add(no);
          const p = m.teams[k].squad.find(q => q.no === no);
          assert.ok(p, `${k}#${no} スカッド外`);
          const role = shape.find(s => s.id === slot).role;
          if (role === "GK") assert.equal(p.pos, "GK");
          if (role !== "GK") assert.notEqual(p.pos, "GK");
        }
      }
    }
  });

  test(`packs[${id}]: 実試合交代がFIFA規則バリデータを通過`, () => {
    const v = S.validatePlan(m, m.subsActual, null);
    assert.ok(v.ok, JSON.stringify(v.errors));
  });

  test(`packs[${id}]: イベント — 時刻昇順・タイムライン内・得点数=公式スコア`, () => {
    const range = E.playedRange(m);
    let prev = -1;
    const goals = {};
    for (const k of keys) goals[k] = 0;
    for (const ev of m.events) {
      assert.ok(ev.t >= prev, `イベント順序 ${ev.type}@${ev.t}`);
      prev = ev.t;
      assert.ok(ev.t >= range.t0 && ev.t <= range.t1);
      if (ev.type === "goal") {
        assert.ok(keys.includes(ev.team));
        assert.ok(m.teams[ev.team].squad.some(p => p.no === ev.no), `得点者 ${ev.team}#${ev.no}`);
        goals[ev.team]++;
      }
    }
    for (const k of keys) assert.equal(goals[k], m.meta.score[k], `${k} スコア不一致`);
  });

  test(`packs[${id}]: アンカー — ピッチ内・時刻内・選手アンカーの選手が実在`, () => {
    const range = E.playedRange(m);
    for (const a of m.ballAnchors) {
      assert.ok(a.t >= range.t0 && a.t <= range.t1);
      assert.ok(Math.abs(a.x) <= 53.5 && Math.abs(a.y) <= 34.5, `ボールアンカー外 ${a.x},${a.y}`);
    }
    for (const a of m.playerAnchors) {
      assert.ok(keys.includes(a.team));
      assert.ok(m.teams[a.team].squad.some(p => p.no === a.no));
      assert.ok(Math.abs(a.x) <= 53.5 && Math.abs(a.y) <= 34.5);
    }
    for (const [t, v] of m.possessionKP) {
      assert.ok(t >= 0 && t <= range.t1 + 1);
      assert.ok(v >= -1 && v <= 1);
    }
  });

  test(`packs[${id}]: エンジン統合 — stateAt常時22人(退場反映)・決定論`, () => {
    const sc = E.actualScenario(m);
    const range = E.playedRange(m);
    for (const t of [range.t0 + 10, range.t0 + 1200, m.time.h2.start + 600, range.t1 - 10]) {
      const st = E.stateAt(m, sc, t);
      const want = E.teamKeys(m).reduce((a, k) => a + E.onPitchCount(m, sc, k, t), 0);   // #141: 退場反映
      assert.equal(st.players.filter(p => p.onPitch).length, want, `t=${t}`);
      const st2 = E.stateAt(m, sc, t);
      assert.deepEqual(
        st.players.map(p => [p.team, p.no, p.x.toFixed(6), p.y.toFixed(6)]),
        st2.players.map(p => [p.team, p.no, p.x.toFixed(6), p.y.toFixed(6)]));
    }
  });
}
