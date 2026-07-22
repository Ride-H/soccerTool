// #154 スキンドメッシュ — 骨格/メッシュ/ポーズの純関数検証（DOM/GL非依存で評価）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// render3d は先頭で R.noise を参照するため noise → quality → render3d の順に評価
(0, eval)(readFileSync(join(root, "src", "noise.mjs"), "utf8"));
(0, eval)(readFileSync(join(root, "app", "quality.mjs"), "utf8"));
(0, eval)(readFileSync(join(root, "app", "render3d.mjs"), "utf8"));
const R = globalThis.RPDX;
const S = R.render3d._skin;
const Q = R.quality;

test("#154 メッシュ: tri/ボーン数が品質予算内・両tierに適合", () => {
  const m = S.BODY_MESH;
  assert.ok(m.tri >= 600, `十分な解像度（${m.tri}tri）`);
  assert.ok(m.tri <= Q.BUDGETS.lightweight.playerTriBudget, `LW予算内（${m.tri} ≤ 2500）`);
  assert.ok(m.tri <= Q.BUDGETS.cinematic.playerTriBudget, "Cinematic予算内");
  assert.equal(m.boneCount, S.SKEL.length);
  assert.ok(m.boneCount <= Q.BUDGETS.lightweight.playerBoneBudget, `LWボーン予算内（${m.boneCount} ≤ 16）`);
  assert.ok(m.idx.length % 3 === 0);
});

// バインド空間の頂点を y 帯・ボーン・色で絞り込むヘルパ
const vertsWhere = (m, pred) => {
  const out = [];
  const nv = m.pos.length / 3;
  for (let v = 0; v < nv; v++) {
    const x = m.pos[v * 3], y = m.pos[v * 3 + 1], z = m.pos[v * 3 + 2];
    const b0 = m.bidx[v * 4], w0 = m.bw[v * 4], b1 = m.bidx[v * 4 + 1], w1 = m.bw[v * 4 + 1];
    if (pred({ x, y, z, cid: m.cid[v], b0, w0, b1, w1 })) out.push({ x, y, z });
  }
  return out;
};
const maxAbsX = (verts) => verts.reduce((mx, p) => Math.max(mx, Math.abs(p.x)), 0);

test("#155 造形: V字テーパー（肩幅 > 腰幅）", () => {
  const m = S.BODY_MESH;
  const shoulder = maxAbsX(vertsWhere(m, (p) => p.y > 1.46 && p.y < 1.54 && p.cid === 0));   // 肩ヨーク帯（シャツ）
  const waist = maxAbsX(vertsWhere(m, (p) => p.y > 1.02 && p.y < 1.10));                       // 腰帯
  assert.ok(shoulder > waist * 1.25, `肩幅 ${shoulder.toFixed(3)} > 腰幅 ${waist.toFixed(3)} ×1.25`);
});

test("#155 造形: 手（ミトン）が前腕の先にある — 腕が筒で終わらない", () => {
  const m = S.BODY_MESH;
  // 前腕ボーン(12=faL,14=faR)に付き、手首(y0.945)より下＝手のひら塊の頂点
  for (const [fa, side] of [[12, "L"], [14, "R"]]) {
    const hand = vertsWhere(m, (p) => p.b0 === fa && p.w0 === 1 && p.y < 0.90);
    assert.ok(hand.length >= 8, `${side}手のミトン頂点 ${hand.length}個`);
    const lowest = hand.reduce((mn, p) => Math.min(mn, p.y), 1);
    assert.ok(lowest < 0.86, `${side}手が手首より下へ張り出す（最下 y=${lowest.toFixed(3)}）`);
  }
});

test("#155 造形: ブーツ（暗色 cid=5）が足ボーンに付く", () => {
  const m = S.BODY_MESH;
  for (const [ft, side] of [[7, "L"], [10, "R"]]) {
    const boot = vertsWhere(m, (p) => p.cid === 5 && p.b0 === ft);
    assert.ok(boot.length >= 8, `${side}ブーツ頂点 ${boot.length}個`);
    // つま先が前方(+Z)へ伸びる（踵より前が長い）
    const maxZ = boot.reduce((mx, p) => Math.max(mx, p.z), -1);
    assert.ok(maxZ > 0.12, `${side}つま先が前方へ（maxZ=${maxZ.toFixed(3)}）`);
  }
});

test("#155 造形: 首肩が連続（首→僧帽筋→ヨークの段階的な幅）", () => {
  const m = S.BODY_MESH;
  // 胴カラム（ボーン0-4）に限定＝腕デルトイド（ボーン11+）を除外して測る
  const torso = (lo, hi) => maxAbsX(vertsWhere(m, (p) => p.y > lo && p.y < hi && p.b0 <= 4 && (p.w1 === 0 || p.b1 <= 4)));
  const neck = torso(1.585, 1.615);   // 首
  const slope = torso(1.535, 1.565);  // 僧帽筋スロープ
  const yoke = torso(1.485, 1.515);   // 肩ヨーク
  assert.ok(neck < slope && slope < yoke, `首 ${neck.toFixed(3)} < スロープ ${slope.toFixed(3)} < ヨーク ${yoke.toFixed(3)}（段階的接続）`);
});

test("#154 メッシュ: 重みは正規化・ボーン番号は範囲内・座標/法線が有限", () => {
  const m = S.BODY_MESH;
  const nv = m.pos.length / 3;
  assert.equal(m.bw.length, nv * 4);
  assert.equal(m.bidx.length, nv * 4);
  assert.equal(m.cid.length, nv);
  for (let v = 0; v < nv; v++) {
    const w = m.bw[v * 4] + m.bw[v * 4 + 1] + m.bw[v * 4 + 2] + m.bw[v * 4 + 3];
    assert.ok(Math.abs(w - 1) < 1e-3, `頂点${v} 重み合計=${w}`);
    for (let k = 0; k < 4; k++) {
      const bi = m.bidx[v * 4 + k];
      assert.ok(bi >= 0 && bi < m.boneCount && Number.isInteger(bi), `頂点${v} ボーン番号${bi}`);
    }
    for (let k = 0; k < 3; k++) {
      assert.ok(Number.isFinite(m.pos[v * 3 + k]), "有限座標");
      assert.ok(Number.isFinite(m.nor[v * 3 + k]), "有限法線");
    }
    const cid = m.cid[v];
    assert.ok(cid >= 0 && cid <= 5, `色ID範囲 ${cid}`);
  }
  for (const i of m.idx) assert.ok(i < nv, "インデックス範囲");
});

test("#155 体格差: 決定論・範囲・選手ごとに異なる", () => {
  const a = S.bodyVarOf("BRA:10"), a2 = S.bodyVarOf("BRA:10"), b = S.bodyVarOf("JPN:24");
  assert.deepEqual(a, a2, "同一キーで同一（決定論）");
  assert.ok(a.h >= 0.955 && a.h <= 1.05, `身長範囲 ${a.h}`);
  assert.ok(a.w >= 0.945 && a.w <= 1.055, `横幅範囲 ${a.w}`);
  assert.ok(a.h !== b.h || a.w !== b.w, "別選手は別体型");
  // 母集団が偏りすぎない（10人で身長に幅が出る）
  const hs = ["A:1", "A:2", "A:3", "A:4", "A:5", "A:6", "A:7", "A:8", "A:9", "A:10"].map((k) => S.bodyVarOf(k).h);
  assert.ok(Math.max(...hs) - Math.min(...hs) > 0.03, "身長にばらつきがある");
});

test("#154 メッシュ: 関節リングは2ボーンブレンド（連続曲げの実体）が存在する", () => {
  const m = S.BODY_MESH;
  let blended = 0;
  for (let v = 0; v < m.cid.length; v++) {
    if (m.bw[v * 4] > 0.05 && m.bw[v * 4 + 1] > 0.05) blended++;
  }
  // 膝×2・肘×2・股/脊椎/首の遷移リングぶん（1リング=8〜14頂点）
  assert.ok(blended >= 100, `ブレンド頂点 ${blended} 個`);
});

const NEUTRAL = { lean: 0, twist: 0, hipL: 0, kneeL: 0, hipR: 0, kneeR: 0, swL: 0, elL: 0, swR: 0, elR: 0 };
const xform = (mat, off, p) => [
  mat[off] * p[0] + mat[off + 4] * p[1] + mat[off + 8] * p[2] + mat[off + 12],
  mat[off + 1] * p[0] + mat[off + 5] * p[1] + mat[off + 9] * p[2] + mat[off + 13],
  mat[off + 2] * p[0] + mat[off + 6] * p[1] + mat[off + 10] * p[2] + mat[off + 14],
];

test("#154 ポーズ: 中立ポーズのスキン行列は恒等（バインド一致）・決定論", () => {
  const b1 = S.poseSkin(NEUTRAL), b2 = S.poseSkin(NEUTRAL);
  assert.deepEqual(Array.from(b1), Array.from(b2), "同一入力で同一出力");
  for (let i = 0; i < S.SKEL.length; i++) {
    // 恒等: 任意点がそのまま戻る（バインド姿勢の定義）
    const p = [0.1, 1.0, 0.05];
    const q = xform(b1, i * 16, p);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(q[k] - p[k]) < 1e-5, `bone${i} 恒等`);
  }
});

test("#154 ポーズ: 膝・肘・前傾が期待方向に効く（階層合成の検証）", () => {
  // 膝 90°: 足首点(0.13側, y0.06)が後方(+Z…rotX正=足が後ろへ)かつ持ち上がる
  const bent = S.poseSkin({ ...NEUTRAL, kneeR: Math.PI / 2 });
  const ankle = [0.13, 0.06, 0];
  const q = xform(bent, 9 * 16, ankle);   // 9 = shinR
  assert.ok(q[1] > 0.3, `膝90°で足首が上がる（y=${q[1].toFixed(2)}）`);
  assert.ok(Math.abs(q[2]) > 0.3, `足首が前後へ振れる（z=${q[2].toFixed(2)}）`);
  // 前傾: 頭頂点が前へ出て下がる
  const leanP = S.poseSkin({ ...NEUTRAL, lean: 0.5 });
  const top = xform(leanP, 4 * 16, [0, 1.9, 0]);   // 4 = head
  assert.ok(top[1] < 1.9, "前傾で頭頂が下がる");
  assert.ok(Math.abs(top[2]) > 0.05, "前傾で頭頂が前へ出る");
  // 腕スイング: 手首点が動く
  const swing = S.poseSkin({ ...NEUTRAL, swL: -1.2, elL: 0.9 });
  const wrist = xform(swing, 12 * 16, [-0.30, 0.93, 0]);   // 12 = foreArmL
  assert.ok(Math.hypot(wrist[1] - 0.93, wrist[2]) > 0.2, "腕振り+肘で手首が大きく動く");
});

test("#154 契約: 予算・切り戻しフラグ・単一情報源の整合", () => {
  // ladder の player-lod 段が改定後のボーン値と一致（12の残骸がない）
  const src = readFileSync(join(root, "app", "quality.mjs"), "utf8");
  assert.ok(!/playerBoneBudget = 12\b/.test(src), "旧ボーン予算12の残骸なし");
  // ui に切り戻しフラグの配線がある
  const ui = readFileSync(join(root, "app", "ui.mjs"), "utf8");
  assert.ok(ui.includes('urlq.get("fig") === "capsule"'), "?fig=capsule 切り戻し");
  // render3d が独自トグルを新設していない（quality.flags 以外のON/OFF状態を持たない）
  const rd = readFileSync(join(root, "app", "render3d.mjs"), "utf8");
  assert.ok(!rd.includes("localStorage"), "render3d は永続トグルを持たない");
});
