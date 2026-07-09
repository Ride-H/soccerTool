// #27 協調ラインコントロール & オフサイド（決定論・読み取り整合）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine;
const HALF = 52.5;
const act = (m) => E.actualScenario(m);
const std = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

for (const m of Object.values(MATCHES)) {
  const id = m.meta.id;

  test(`line[${id}]: 最終ラインが合意 x へ同期（DFが1枚のラインにまとまる）`, () => {
    const sc = act(m), range = E.playedRange(m);
    let tight = 0, checked = 0;
    for (let t = range.t0 + 30; t < range.t1; t += 11) {
      const st = E.stateAt(m, sc, t);
      for (const team of E.teamKeys(m)) {
        const line = E.defensiveLineAt(m, sc, team, t);
        const xs = st.players.filter(p => p.onPitch && p.team === team && ["CB", "FB", "WB"].includes(p.role)).map(p => p.x);
        if (xs.length < 3) continue;
        checked++;
        // 全 DF が合意ライン ±14m の帯に収まる（同期）
        if (xs.every(x => Math.abs(x - line.lineX) < 14)) tight++;
      }
    }
    assert.ok(checked > 100, `サンプル ${checked}`);
    assert.ok(tight / checked > 0.85, `ライン帯内率 ${tight}/${checked}`);
  });

  test(`line[${id}]: ラインは局面で上下（守勢で自陣へ・攻勢で押し上げ＝ボール進行と相関）`, () => {
    const sc = act(m), range = E.playedRange(m);
    const xsLine = [], xsBall = [];
    for (let t = range.t0 + 30; t < range.t1; t += 6) {
      const team = m.possessionPlus === E.teamKeys(m)[0] ? E.teamKeys(m)[1] : E.teamKeys(m)[0]; // 守備側の一方
      const dir = m.dir[team][E.halfOf(m, t) === 1 ? "h1" : "h2"];
      const line = E.defensiveLineAt(m, sc, team, t);
      const bs = E.ballSlowAt(m, t);
      xsLine.push(dir * line.lineX);      // 自チームの押し上げ深さ
      xsBall.push(dir * bs.x);            // ボールの深さ（攻撃方向）
    }
    const n = xsLine.length;
    const mx = xsBall.reduce((a, b) => a + b, 0) / n, my = xsLine.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xsBall[i] - mx, dy = xsLine[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    const r = sxy / (Math.sqrt(sxx * syy) || 1);
    assert.ok(r > 0.4, `ライン高さ×ボール深さ相関 r=${r.toFixed(3)}`);
  });

  test(`line[${id}]: オフサイド境界・判定 — 現実的な発生率(0〜25%)・決定論`, () => {
    const sc = act(m), range = E.playedRange(m);
    let off = 0, total = 0;
    for (let t = range.t0 + 30; t < range.t1; t += 9) {
      for (const team of E.teamKeys(m)) {
        const list = E.offsideAttackersAt(m, sc, team, t);
        const roster = E.rosterAt(m, sc, team, t);
        const fwd = Object.entries(roster.assign).filter(([slot]) => /ST|W|F|AM/.test(slot)).length;
        total += fwd; off += list.length;
        // 決定論
        assert.deepEqual(list, E.offsideAttackersAt(m, sc, team, t));
      }
    }
    const rate = off / total;
    assert.ok(rate >= 0 && rate < 0.25, `オフサイド率 ${(rate * 100).toFixed(1)}%`);
    assert.ok(off > 0, "少なくとも数回はオフサイド位置が発生する");
  });

  test(`line[${id}]: offsideLineAt/isOffsidePos の整合（境界の外側=OFF・内側=on）`, () => {
    const sc = act(m);
    for (const t of [800, 3000, 5200]) {
      for (const team of E.teamKeys(m)) {
        const o = E.offsideLineAt(m, sc, team, t);
        assert.equal(E.isOffsidePos(m, sc, team, o.dir * (o.offsideDepth + 5), t), true);
        assert.equal(E.isOffsidePos(m, sc, team, o.dir * (o.offsideDepth - 5), t), false);
      }
    }
  });
}
