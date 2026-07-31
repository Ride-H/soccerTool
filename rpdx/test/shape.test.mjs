// #140 形状プロパティゲート — チーム幾何の「サッカーとしての妥当性（plausibility）」を常時検証する。
// エピック #135 の負債返済: property.test は保存則/決定論/速度/スクラブ/結果のみを担保し、
// チーム形状（ライン高さ・縦コンパクトネス）は未検証だった。本ゲートはそれを検証対象に加える。
//
// 【段階導入】形状帯アサート（#136 前線ブロック / #137 コンパクトネス / #138 ライン押し上げ）は
// 改修が入るまで**現行モデルでは既知不合格**。SHAPE_V1_ACTIVE を false にしている間はスキップし、
// 改修完了時に true へ切替 → ゲート合格 → 記録イベント再現/支配率確認 → UPDATE_GOLDEN 一度、の順で有効化する
// （手順はエピック #135「golden の扱い」に固定）。プローブ整備・決定論・JPN 回帰ベンチは常時有効。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCHES } from "./load.mjs";
import { shapeProbe, frameLines, shapeVerdicts, MIN_N, fmt } from "../tools/shape-probe.mjs";

const E = RPDX.engine;

// 改修（#136-138）完了時に true へ。切替は golden 再ベースラインとセット（エピック手順）。
export const SHAPE_V1_ACTIVE = false;

// 標本不足（片側試合で一方の局面がほとんど発生しない＝決勝の ESP 守備/ARG 攻撃など）で
// 帯判定ができない組み合わせの一覧。#175: これを黙って読み飛ばすと「検査が消えたのに緑」になるため、
// **ここに書いたものだけ**を許し、増えたらテストが落ちるようにする。
// 減らすには局面の定義を見直すか、その試合を対象から外す判断を明示的にする。
const UNMEASURED_ALLOW = new Set([
  "wc2026-r32-bra-jpn|JPN|atkLine",      // 日本は敵陣深部までボールを運ぶ局面が少ない
  "wc2026-r32-bra-jpn|BRA|defFront",     // ブラジルが自陣30m以内に押し込まれる局面が少ない
  "wc2026-r32-bra-jpn|BRA|defCompact",
  "wc2026-final-esp-arg|ESP|defFront",   // 決勝はスペインが支配し、守備局面の標本が 0
  "wc2026-final-esp-arg|ESP|defCompact",
  "wc2026-final-esp-arg|ARG|atkLine",    // 同じ理由でアルゼンチンの攻撃局面の標本が 0
]);

test("#140 shape-probe: 決定論・構造妥当（プローブが tools に整備されている）", () => {
  for (const m of Object.values(MATCHES)) {
    const a = shapeProbe(m);
    const b = shapeProbe(m);
    for (const team of E.teamKeys(m)) {
      assert.ok(a[team] && a[team].defCompact && a[team].allCompact, `${m.meta.id} ${team} 構造`);
      // 決定論（同一入力で同一集計）
      assert.deepEqual(a[team], b[team], `${m.meta.id} ${team} 決定論`);
    }
  }
});

test("#140 shape-probe: frameLines は最終ライン≤前線・自ゴール縦深域内", () => {
  const m = MATCHES[RPDX.data.MATCH.meta.id];
  const sc = E.actualScenario(m);
  const range = E.playedRange(m);
  let checked = 0;
  for (let t = range.t0 + 60; t < range.t1; t += 211) {
    const st = E.stateAt(m, sc, t);
    for (const team of E.teamKeys(m)) {
      const L = frameLines(m, st, team);
      if (!L) continue;
      checked++;
      assert.ok(L.last <= L.front + 1e-9, `t=${t} ${team} last>front`);
      assert.ok(L.last >= -1 && L.front <= 106, `t=${t} ${team} 域外 ${L.last},${L.front}`);
      assert.ok(L.compact >= 0, `t=${t} ${team} compact<0`);
    }
  }
  assert.ok(checked > 20, `サンプル ${checked}`);
});

// 回帰ベンチ: 既に基準内の守備形状（JPN）を固定 — 改修（#136-138）で悪化させない。
test("#140 shape-gate: JPN 守備形状は基準内（回帰ベンチ・改修で壊さない）", () => {
  const m = MATCHES["wc2026-r32-bra-jpn"];
  const jpn = shapeProbe(m).JPN;
  // 現行: 守備時前線 p50≈38.2m（≤45）・守備時コンパクトネス p50≈27.1m（25–38帯内）
  assert.ok(jpn.defFront.n >= MIN_N, `JPN 守備サンプル ${jpn.defFront.n}`);
  assert.ok(jpn.defFront.p50 <= 45, `JPN 守備時前線 p50 ${jpn.defFront.p50.toFixed(1)} ≤45`);
  assert.ok(jpn.defCompact.p50 <= 38, `JPN 守備時コンパクトネス p50 ${jpn.defCompact.p50.toFixed(1)} ≤38`);
  assert.ok(jpn.defCompact.p90 <= 40, `JPN 守備時コンパクトネス p90 ${jpn.defCompact.p90.toFixed(1)} ≤40`);
});

// #175: 「測れていない」を「基準内」と混ぜない。標本不足で判定できない組み合わせは
// 許可リストと完全一致すること。局面の定義を変えたり試合を足したときに、
// **検査が静かに消えた**ことへ気づけるようにする（帯そのものの合否とは独立に常時有効）。
test("#140 shape-gate: 標本不足で判定できない組み合わせが増えていない", () => {
  const now = [];
  for (const m of Object.values(MATCHES))
    for (const r of shapeVerdicts(m)) if (r.verdict === "unmeasured") now.push(`${m.meta.id}|${r.team}|${r.key}`);
  const added = now.filter((k) => !UNMEASURED_ALLOW.has(k));
  const gone = [...UNMEASURED_ALLOW].filter((k) => !now.includes(k));
  assert.deepEqual(added, [], `判定できない組み合わせが増えた（検査が静かに消えている）:\n  ${added.join("\n  ")}`);
  assert.deepEqual(gone, [], `測れるようになった組み合わせは許可リストから外すこと:\n  ${gone.join("\n  ")}`);
  // 判定できているものが十分にある（全部が「測れていない」で緑、を防ぐ）
  const judged = Object.values(MATCHES).flatMap((m) => shapeVerdicts(m)).filter((r) => r.verdict !== "unmeasured");
  assert.ok(judged.length >= 24, `判定できた組み合わせ ${judged.length} 件（少なすぎる）`);
});

// 形状帯アサート（#136-138 完了で有効化）: 全収録試合・両チームで妥当性帯に収める。
// 帯の定義は shape-probe.mjs の BANDS が唯一の出所（表示と判定で二重管理しない）。
test("#140 shape-gate v1: 全試合の形状帯（#136-138 完了で有効化）", { skip: !SHAPE_V1_ACTIVE }, () => {
  const bad = [];
  for (const m of Object.values(MATCHES))
    for (const r of shapeVerdicts(m))
      if (r.verdict === "out") bad.push(`${m.meta.id} ${r.team} ${r.label} ${fmt(r)} — ${r.detail}`);
  assert.deepEqual(bad, [], `形状帯違反 ${bad.length}件:\n  ${bad.join("\n  ")}`);
});
