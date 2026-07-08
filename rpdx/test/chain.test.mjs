// ポゼッション・チェーン品質 — 連続保持・実パス・リスタート・タッチライン活用の回帰固定
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine;

for (const m of Object.values(MATCHES)) {
  const id = m.meta.id;
  const sc = () => E.actualScenario(m);

  test(`chain[${id}]: 連続保持がパスのように敵味方交互にならない（マルコフ持続）`, () => {
    const cs = E.chainStats(m, sc());
    // 自己再抽選はほぼゼロ（旧実装は56%が同一選手へ戻っていた）
    assert.ok(cs.selfConsecutive <= cs.segments * 0.03, `self ${cs.selfConsecutive}/${cs.segments}`);
    // チームメイトへの実パスが主構成（旧実装は1試合11本だった）
    assert.ok(cs.passes > 400, `実パス ${cs.passes}`);
    // ターンオーバーは実試合水準（~200前後）
    assert.ok(cs.turnovers >= 120 && cs.turnovers <= 300, `turnovers ${cs.turnovers}`);
    // 優勢側は平均5本以上つなぎ、劣勢側も2.5本以上
    const keys = E.teamKeys(m);
    const plus = m.possessionPlus;
    const minus = keys.find(k => k !== plus);
    assert.ok(cs.runs[plus].avg >= 5, `${plus} avg ${cs.runs[plus].avg}`);
    assert.ok(cs.runs[minus].avg >= 2.5, `${minus} avg ${cs.runs[minus].avg}`);
    assert.ok(cs.runs[plus].avg <= 16 && cs.runs[minus].avg <= 16, "過剰持続もしない");
  });

  test(`chain[${id}]: アウトオブプレー — スローイン/コーナー/ゴールキックが発生する`, () => {
    const cs = E.chainStats(m, sc());
    const total = cs.restarts.throwin + cs.restarts.corner + cs.restarts.goalkick;
    assert.ok(total >= 30 && total <= 100, `リスタート計 ${total}`);
    assert.ok(cs.restarts.throwin >= cs.restarts.corner, "スローインが最多クラス");
    assert.ok(cs.restarts.corner >= 2 && cs.restarts.goalkick >= 2,
      `corner ${cs.restarts.corner} / gk ${cs.restarts.goalkick}`);
  });

  test(`chain[${id}]: ゴールキックはGKが再開・スローインでボールがタッチライン際へ`, () => {
    // chainStats ではなく実セグメントで検証
    const scenario = sc();
    const range = E.playedRange(m);
    let gkOk = 0, gkAll = 0, lineReach = 0, thAll = 0;
    for (let t = range.t0 + 5; t < range.t1; t += 2) {
      const c = E.carrierAt(m, scenario, t);
      if (!c || c.mode !== "hold" || !c.restart) continue;
      if (c.restart === "goalkick") {
        gkAll++;
        const p = m.teams[c.team].squad.find(q => q.no === c.no);
        if (p && p.pos === "GK") gkOk++;
      } else if (c.restart === "throwin" && t >= c.seg.tf && t <= c.seg.tf + c.seg.rdelay) {
        // 静止（ピン留め）中のみ判定 — 再開後はプレーに戻る
        const b = E.ballAt(m, scenario, t);
        if (b.free < 0.9) continue;                      // 実試合アンカー窓は対象外
        thAll++;
        if (Math.abs(b.y) > 32.5) lineReach++;
      }
    }
    assert.ok(gkAll > 0 && gkOk === gkAll, `GK再開 ${gkOk}/${gkAll}`);
    assert.ok(thAll > 0 && lineReach / thAll > 0.9, `タッチライン到達 ${lineReach}/${thAll}`);
  });

  test(`chain[${id}]: 支配率較正がチェーン刷新後も維持（±4%）`, () => {
    const st = E.possessionStats(m, sc(), E.playedRange(m).t1);
    const plus = m.possessionPlus;
    // stats表の実測値（"69%"等）と照合
    const row = (m.stats || []).find(s => s.key === "ボール支配率");
    const target = parseInt(String(row[plus]), 10) / 100;
    assert.ok(Math.abs(st[plus] - target) < 0.04, `${plus} ${st[plus].toFixed(3)} vs ${target}`);
  });

  test(`chain[${id}]: ターンオーバー時に奪取者が前保持者の近くにいる（接触）`, () => {
    const scenario = sc();
    const chain = [];
    const range = E.playedRange(m);
    let prev = null, checked = 0, near = 0;
    for (let t = range.t0 + 5; t < range.t1; t += 1.5) {
      const c = E.carrierAt(m, scenario, t);
      if (!c) { prev = null; continue; }
      const key = c.team + ":" + c.no + ":" + c.seg.t0;
      if (prev && key !== prev.key && c.team !== prev.team && !c.restart && c.mode === "flight") {
        // 奪取直後: 新旧保持者の基礎距離（フライト先の選手 vs 前保持者）
        const a = E.stateFrozenPos(m, scenario, prev.team, prev.no, c.seg.t0 + 0.2);
        const b = E.stateFrozenPos(m, scenario, c.team, c.no, c.seg.t0 + 0.2);
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        checked++;
        if (d < 14) near++;
      }
      prev = { key, team: c.team, no: c.no };
    }
    assert.ok(checked > 30, `サンプル ${checked}`);
    assert.ok(near / checked > 0.75, `近接奪取率 ${near}/${checked}`);
  });
}
