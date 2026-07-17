// #123 編集フレームの多重編集 — 蓄積マージ・10回編集の動作保証・キー衝突なし・履歴削除
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine, S = RPDX.scenlib, SUB = RPDX.subs;

// i 回目の編集: t_i で possessionPlus の非GK 2人を決定論的に動かす
const editOnce = (m, baseSc, t, i) => {
  const f = E.editFrameAt(m, baseSc, t);
  // #83 の明記済み限界: その時刻のボール保持者は保持チェーン優先で通過が弱い → オフボール選手を編集（実運用と同じ）
  const c = E.carrierAt(m, baseSc, t);
  const movers = f.players.filter(p => p.onPitch && p.team === m.possessionPlus && p.role !== "GK"
    && !(c && c.team === p.team && c.no === p.no)).slice(0, 2);
  const targets = movers.map((p, j) => {
    p.x += 7 + (i % 3) * 3 + j * 2;
    p.y += (i % 2 === 0 ? -5 : 5) + j;
    return { team: p.team, no: p.no, x: p.x, y: p.y };
  });
  const r = S.scenarioFromFrame(m, f, baseSc);
  return { ...r, targets };
};

const buildChain = (m, n = 10) => {
  let sc = null;
  const keys = [], targetsByT = [];
  for (let i = 0; i < n; i++) {
    const t = 700 + i * 520;
    const r = editOnce(m, sc, t, i);
    sc = r.scenario;
    keys.push(E.scenarioKey(sc));
    targetsByT.push({ t, targets: r.targets });
  }
  return { sc, keys, targetsByT };
};

test("#123 10回編集: 全アンカー保持（2×10）・各時刻で編集位置を通過", () => {
  const { sc, targetsByT } = buildChain(MATCH, 10);
  assert.equal(sc.editAnchors.length, 20, "2人×10回=20アンカー（近接衝突なし）");
  assert.equal(sc.editFrom, 700, "editFrom は最初の編集時刻");
  for (const { t, targets } of targetsByT) {
    const st = E.stateAt(MATCH, sc, t);
    for (const tg of targets) {
      const p = st.players.find(q => q.team === tg.team && q.no === tg.no);
      const d = Math.hypot(p.x - tg.x, p.y - tg.y);
      assert.ok(d < 2.0, `t=${t} #${tg.no} 通過誤差 ${d.toFixed(2)}m`);
    }
  }
});

test("#123 キー: 10段階の進行シナリオ全てで scenarioKey が相異なる・actual と非衝突", () => {
  const { keys } = buildChain(MATCH, 10);
  assert.equal(new Set(keys).size, 10, "全キー相異");
  const actKey = E.scenarioKey(E.actualScenario(MATCH));
  assert.ok(!keys.includes(actKey));
  // 同一操作列は同一キー（決定論）
  const { keys: keys2 } = buildChain(MATCH, 10);
  assert.deepEqual(keys2, keys);
});

test("#123 再編集の置換: 同一選手×近接時刻は最新で置換（発散しない）", () => {
  const { sc } = buildChain(MATCH, 3);
  const before = sc.editAnchors.length;                  // 6
  // 2回目の編集時刻(t=1220)の +3s で同じ2人をもう一度動かす → 置換される
  const f = E.editFrameAt(MATCH, sc, 1223);
  const movers = f.players.filter(p => p.onPitch && p.team === MATCH.possessionPlus && p.role !== "GK").slice(0, 2);
  for (const p of movers) { p.x += 9; p.y += 4; }
  const r = S.scenarioFromFrame(MATCH, f, sc);
  assert.equal(r.replaced, 2, "旧2アンカーを置換");
  assert.equal(r.scenario.editAnchors.length, before, "総数は増えない");
  // 置換後も他の時刻(1回目 t=700)の編集は生存
  assert.ok(r.scenario.editAnchors.some(a => Math.abs(a.t - 700) < 1));
});

test("#123 決定論・スクラブ順序非依存（10回編集世界）", () => {
  const { sc } = buildChain(MATCH, 10);
  const ts = [900, 1500, 2300, 3100, 4200, 5100];
  const snap = (t) => {
    const st = E.stateAt(MATCH, sc, t);
    return st.players.slice(0, 8).map(p => p.x.toFixed(4) + "," + p.y.toFixed(4)).join("|");
  };
  const fwd = ts.map(snap);
  E.clearCaches();
  const rev = [...ts].reverse().map(snap).reverse();
  assert.deepEqual(rev, fwd, "逆順評価でも同一");
});

test("#123 JSON往復: 10回分の編集が bundle で完全往復（キー一致）", () => {
  const { sc } = buildChain(MATCH, 10);
  const json = S.serializeBundle(MATCH, sc, null);
  const r = S.parseBundle(MATCH, json);
  assert.ok(r.validation.ok);
  assert.equal(r.scenario.editAnchors.length, 20);
  assert.equal(E.scenarioKey(r.scenario), E.scenarioKey(sc), "キー一致=同一世界扱い");
});

test("#123 履歴削除: withoutEditGroup で該当時刻のみ取り消し・全削除で editFrom も消える", () => {
  const { sc } = buildChain(MATCH, 3);
  const r1 = S.withoutEditGroup(MATCH, sc, 1220);        // 2回目だけ削除
  assert.equal(r1.removed, 2);
  assert.equal(r1.scenario.editAnchors.length, 4);
  assert.ok(r1.scenario.editAnchors.every(a => Math.abs(a.t - 1220) > 0.5));
  assert.equal(r1.scenario.editFrom, 700);
  let cur = r1.scenario;
  for (const t of [700, 1740]) cur = S.withoutEditGroup(MATCH, cur, t).scenario;
  assert.ok(!cur.editAnchors && cur.editFrom == null, "全削除でフィールドごと消える");
  assert.equal(E.scenarioKey(cur).split("|")[3] || "", "", "キーの編集成分も消える");
});

test("#123 golden安全: 未編集世界は従来とビット一致（全パック）", () => {
  for (const m of Object.values(MATCHES)) {
    const act = E.actualScenario(m);
    assert.equal(E.scenarioKey(act).split("|")[3] || "", "");
    const plain = SUB.createScenario(m, "p", act);
    const a = E.stateAt(m, plain, 2000).players.map(p => [p.team, p.no, +p.x.toFixed(6), +p.y.toFixed(6)]);
    const b = E.stateAt(m, act, 2000).players.map(p => [p.team, p.no, +p.x.toFixed(6), +p.y.toFixed(6)]);
    assert.deepEqual(a, b, m.meta.id);
  }
});
