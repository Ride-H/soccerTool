// #35 ゴールデンマスター回帰 — 世界状態のダイジェストを固定し、意図しない挙動変化を検出する。
//
// 使い方:
//   通常実行           → スナップショット(golden.snapshot.json)と比較。差分があれば FAIL。
//   意図的な挙動変更時 → UPDATE_GOLDEN=1 node --test rpdx/test/golden.test.mjs で更新し、
//                        スナップショット差分を PR レビューで目視確認する（これが安全網の本体）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPDX, MATCHES } from "./load.mjs";

const E = RPDX.engine, SIM = RPDX.sim;
const SNAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden.snapshot.json");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

// FNV-1a 32bit（依存ゼロの安定ハッシュ）
const fnv = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
};

// 代表シナリオ: actual と「plus チームの最終交代を取り消した what-if」
const scenariosOf = (m) => {
  const actual = E.actualScenario(m);
  const wf = structuredClone(actual);
  delete wf.actual;                     // what-if 化（actual フラグ除去で outcome 再構成が有効）
  wf.id = "golden-wf"; wf.label = "golden what-if";
  const plus = m.possessionPlus || E.teamKeys(m)[0];
  if (wf.subs[plus] && wf.subs[plus].length) wf.subs[plus] = wf.subs[plus].slice(0, -1);
  return [["actual", actual], ["whatif-cancel-last-sub", wf]];
};

// 世界状態ダイジェスト: 時刻格子（素数間隔でエイリアシング回避）の座標/ボール/保持者 + 結果再構成
const digestOf = (m, scenario) => {
  const range = E.playedRange(m);
  let pos = "", ball = "", car = "";
  for (let t = range.t0 + 13; t < range.t1; t += 89) {
    const st = E.stateAt(m, scenario, t);
    for (const p of [...st.players].sort((a, b) => (a.team + a.no).localeCompare(b.team + b.no))) {
      if (!p.onPitch) continue;
      pos += `${p.team}${p.no}:${p.x.toFixed(2)},${p.y.toFixed(2)};`;
    }
    ball += `${st.ball.x.toFixed(2)},${st.ball.y.toFixed(2)},${st.ball.z.toFixed(2)};`;
    const c = st.carrier;
    car += c ? `${c.team}${c.no || ""}:${c.mode}${c.restart ? ":" + c.restart : ""};` : "-;";
  }
  // スコア: actual は記録から / what-if は結果再構成から（keys順で安定文字列化）
  const keys = E.teamKeys(m);
  const oc = SIM.outcome(m, scenario);
  const sc = oc ? oc.score
    : (() => { const s = {}; for (const k of keys) s[k] = 0;
        for (const ev of m.events) if (ev.type === "goal") s[ev.team]++; return s; })();
  const score = keys.map(k => `${k}:${sc[k]}`).join(",");
  return { pos: fnv(pos), ball: fnv(ball), carrier: fnv(car), score };
};

test("#35 golden: 世界状態ダイジェストがスナップショットと一致（意図しない挙動変化の検出）", () => {
  const entries = {};
  for (const m of Object.values(MATCHES)) {
    for (const [label, sc] of scenariosOf(m)) {
      entries[`${m.meta.id}|${label}`] = digestOf(m, sc);
    }
  }
  if (UPDATE || !fs.existsSync(SNAP)) {
    fs.writeFileSync(SNAP, JSON.stringify({ version: 1, entries }, null, 1) + "\n");
    console.log(`golden: スナップショットを${UPDATE ? "更新" : "初期作成"}（${Object.keys(entries).length}件）`);
    return;
  }
  const snap = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  for (const [key, d] of Object.entries(entries)) {
    const g = snap.entries[key];
    assert.ok(g, `スナップショットに ${key} が無い（UPDATE_GOLDEN=1 で追加）`);
    for (const f of ["pos", "ball", "carrier", "score"]) {
      assert.equal(d[f], g[f],
        `${key} の ${f} が変化: ${g[f]} → ${d[f]}\n` +
        `  意図的な変更なら UPDATE_GOLDEN=1 で更新し、PR で差分をレビューすること`);
    }
  }
});

test("#35 golden: ダイジェスト自体が決定論（同一実行内で再計算しても一致）", () => {
  const m = Object.values(MATCHES)[0];
  const sc = E.actualScenario(m);
  const a = digestOf(m, sc);
  E.clearCaches();
  const b = digestOf(m, sc);
  assert.deepEqual(a, b);
});
