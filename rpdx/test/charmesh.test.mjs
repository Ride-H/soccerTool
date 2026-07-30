// 共有コア（app/character.mjs）の単体テスト。character-lab から移植し、本体でも同じ契約を固定する。
// vendored なので中身は lab と bit 一致だが、公開リポ単体で 100% 検証できることが要件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { evalFile } from "./load.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
evalFile(join(root, "app", "character.mjs"));
const C = globalThis.RPDX.character;

const B = C.BONE;

const nb = () => C.newMeshBuilder();
const finite = (a) => a.every((v) => Number.isFinite(v));
const vec = (m, i) => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
const nrm = (m, i) => [m.nor[i * 3], m.nor[i * 3 + 1], m.nor[i * 3 + 2]];
const len = (v) => Math.hypot(...v);

test("tube: リング数とセグメント数から頂点・三角形が決まる（キャップ 2 枚を含む）", () => {
  const M = nb();
  M.tube([{ y: 0, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] }, { y: 1, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] }], 8);
  const m = M.finish();
  assert.equal(m.pos.length / 3, 2 * 8 + 2, "リング頂点 + 極 2");
  assert.equal(m.tri, 8 * 2 + 8 * 2, "側面 2 枚/セグメント + キャップ 2 枚");
  assert.ok(finite(m.pos) && finite(m.nor));
});

test("tube: 円のリングは半径どおりの円柱になり、法線は外向きの単位ベクトル", () => {
  const M = nb();
  M.tube([{ y: 0, rx: 0.2, rz: 0.2, c: 0, b: [0, 1] }, { y: 1, rx: 0.2, rz: 0.2, c: 0, b: [0, 1] }], 16);
  const m = M.finish();
  for (let i = 0; i < 32; i++) {
    const [x, , z] = vec(m, i);
    assert.ok(Math.abs(Math.hypot(x, z) - 0.2) < 1e-6, `半径 ${Math.hypot(x, z)}`);
    const n = nrm(m, i);
    assert.ok(Math.abs(len(n) - 1) < 1e-6, `法線長 ${len(n)}`);
    assert.ok(n[0] * x + n[2] * z > 0, "法線は外を向く");
  }
});

test("tube: 同じ高さのリングを 2 枚重ねても法線が壊れない（色の境界を水平にする手口）", () => {
  const M = nb();
  M.tube([
    { y: 0, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] },
    { y: 0.5, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] },
    { y: 0.5, rx: 0.1, rz: 0.1, c: 1, b: [0, 1] },   // 高さが前のリングと同一＝dy が 0
    { y: 1, rx: 0.1, rz: 0.1, c: 1, b: [0, 1] },
  ], 8);
  const m = M.finish();
  assert.ok(finite(m.nor), "dy=0 でも NaN 法線を出さない");
  for (let i = 0; i < m.nor.length / 3; i++) assert.ok(Math.abs(len(nrm(m, i)) - 1) < 1e-6);
  const cids = new Set(Array.from(m.cid));
  assert.deepEqual([...cids].sort(), [0, 1], "境界の上下で色が分かれる");
});

test("tube: リングを降順に書いてもキャップが裏返らない", () => {
  const asc = nb(); asc.tube([{ y: 0, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] }, { y: 1, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] }], 8);
  const desc = nb(); desc.tube([{ y: 1, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] }, { y: 0, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] }], 8);
  const a = asc.finish(), d = desc.finish();
  const capNormalY = (m) => { const o = []; for (let i = 0; i < m.nor.length / 3; i++) { const n = nrm(m, i); if (Math.abs(n[1]) > 0.99) o.push([vec(m, i)[1], n[1]]); } return o; };
  for (const m of [a, d]) {
    const caps = capNormalY(m);
    assert.equal(caps.length, 2, "極は 2 つ");
    const [lo, hi] = caps.sort((p, q) => p[0] - q[0]);
    assert.ok(lo[1] < 0, "下の極は下向き");
    assert.ok(hi[1] > 0, "上の極は上向き");
  }
});

test("tube: 超楕円の指数 n と背中の平たさ back が断面に効く", () => {
  const mk = (opt) => { const M = nb();
    M.tube([{ y: 0, rx: 0.2, rz: 0.1, c: 0, b: [0, 1], ...opt }, { y: 1, rx: 0.2, rz: 0.1, c: 0, b: [0, 1], ...opt }], 32);
    return M.finish(); };
  const round = mk({}), sup = mk({ n: 3 });
  const areaX = (m, sign) => { let s = 0; for (let i = 0; i < 32; i++) { const [x, , z] = vec(m, i); if (Math.sign(z || 1) === sign) s = Math.max(s, Math.abs(x)); } return s; };
  // 同じ rx でも指数が大きいほど「角が張る」＝斜め 45° の点が外へ出る
  const diag = (m) => { let best = 0; for (let i = 0; i < 32; i++) { const [x, , z] = vec(m, i); if (x > 0 && z > 0) best = Math.max(best, Math.hypot(x / 0.2, z / 0.1)); } return best; };
  assert.ok(diag(sup) > diag(round) + 0.05, `n=3 は角が張る ${diag(sup)} vs ${diag(round)}`);
  const flat = mk({ back: 0.5 });
  assert.ok(Math.abs(areaX(flat, 1) - areaX(round, 1)) < 1e-6, "前側（+Z）は変わらない");
  let backDepth = 0; for (let i = 0; i < 32; i++) { const [, , z] = vec(flat, i); backDepth = Math.min(backDepth, z); }
  assert.ok(Math.abs(backDepth + 0.05) < 1e-6, `背中側だけ平たくなる ${backDepth}`);
});

test("tube: 骨の重み・色・AO の既定値（b の 2 本目は省略可・ao 省略は 1・aoAt が優先）", () => {
  const M = nb();
  M.tube([
    { y: 0, rx: 0.1, rz: 0.1, c: 2, b: [B.chest, 1] },                          // ao 省略
    { y: 1, rx: 0.1, rz: 0.1, c: 2, ao: 0.5, b: [B.chest, 0.4, B.spine, 0.6] }, // 2 骨ブレンド
    { y: 2, rx: 0.1, rz: 0.1, c: 2, ao: 0.8, aoAt: (th, a) => a * (th < Math.PI ? 1 : 0.5), b: [B.chest, 1] },
  ], 8);
  const m = M.finish();
  for (let i = 0; i < 8; i++) { assert.equal(m.ao[i], 1); assert.equal(m.bidx[i * 4 + 1], 0); assert.equal(m.bw[i * 4 + 1], 0); }
  for (let i = 8; i < 16; i++) { assert.equal(m.ao[i], 0.5); assert.equal(m.bidx[i * 4 + 1], B.spine); assert.ok(Math.abs(m.bw[i * 4 + 1] - 0.6) < 1e-7); }
  const third = [...new Set(Array.from(m.ao.slice(16, 24)))].sort((a, b) => a - b);   // float32 なので近似で比べる
  assert.equal(third.length, 2, `aoAt は角度ごとに AO を変える ${third}`);
  assert.ok(Math.abs(third[0] - 0.4) < 1e-6 && Math.abs(third[1] - 0.8) < 1e-6, `${third}`);
});

test("blob: 楕円体の頂点が式どおりに乗り、面積 0 の三角形を出さない", () => {
  const M = nb();
  M.blob(0.1, 1, -0.05, 0.02, 0.03, 0.04, B.head, 3, 6, 10, 0.8);
  const m = M.finish();
  for (let i = 0; i < m.pos.length / 3; i++) {
    const [x, y, z] = vec(m, i);
    const q = ((x - 0.1) / 0.02) ** 2 + ((y - 1) / 0.03) ** 2 + ((z + 0.05) / 0.04) ** 2;
    assert.ok(Math.abs(q - 1) < 1e-4, `楕円体の面上 ${q}`);   // 頂点は float32 で保持される
    assert.equal(m.cid[i], 3); assert.ok(Math.abs(m.ao[i] - 0.8) < 1e-6); assert.equal(m.bidx[i * 4], B.head);
  }
  for (let t = 0; t < m.tri; t++) {
    const [a, b, c] = [m.idx[t * 3], m.idx[t * 3 + 1], m.idx[t * 3 + 2]];
    assert.ok(a !== b && b !== c && a !== c, "退化した三角形を作らない");
  }
});

test("blob: AO 省略時は 1", () => {
  const M = nb(); M.blob(0, 0, 0, 0.01, 0.01, 0.01, B.head, 2, 3, 4);
  const m = M.finish();
  assert.ok(Array.from(m.ao).every((v) => v === 1));
});

test("loftZ: 前後に積む断面（靴）— 底が平ら・前後のキャップが向かい合う・分割ボーンへ重みが移る", () => {
  const M = nb();
  const sp = { z0: 0.05, z1: 0.15, bone: B.toeR };
  M.loftZ(0.1, [
    { z: -0.06, bottom: 0.01, top: 0.08, w: 0.03, c: 5, ao: 0.9, b: [B.footR, 1], split: sp },
    { z: 0.02, bottom: 0, top: 0.10, w: 0.05, c: 5, b: [B.footR, 1], split: sp },
    { z: 0.20, bottom: 0.004, top: 0.05, w: 0.02, c: 5, b: [B.footR, 1], split: sp },
  ], 12, 0.004);
  const m = M.finish();
  assert.ok(finite(m.pos) && finite(m.nor));
  let minY = 1e9; for (let i = 0; i < m.pos.length / 3; i++) minY = Math.min(minY, vec(m, i)[1]);
  assert.ok(Math.abs(minY) < 1e-9, `靴底の最下点は bottom と一致 ${minY}`);
  let front = 0, back = 0;
  for (let i = 0; i < m.pos.length / 3; i++) { const n = nrm(m, i); if (n[2] > 0.99) front++; if (n[2] < -0.99) back++; }
  assert.equal(front, 1); assert.equal(back, 1);
  // 分割: 後方は第1骨だけ、前方は第2骨へ重みが移る
  let rear = null, fore = null;
  for (let i = 0; i < m.pos.length / 3; i++) { const z = vec(m, i)[2]; if (z < 0) rear = i; if (z > 0.18) fore = i; }
  assert.equal(m.bw[rear * 4 + 1], 0, "踵は足首ボーンのみ");
  assert.ok(m.bw[fore * 4 + 1] > 0.99, "つま先は前足部ボーンへ移る");
});

test("handMesh / headMesh: 単体で呼んでも有限・重み正規化・色が想定どおり", () => {
  const M = nb();
  M.handMesh(1, B.foreArmR);
  const hand = M.finish();
  assert.ok(hand.tri > 0 && finite(hand.pos) && finite(hand.nor));
  assert.ok(Array.from(hand.cid).every((c) => c === 2), "手は素肌");
  for (let i = 0; i < hand.pos.length / 3; i++) {
    const w = hand.bw[i * 4] + hand.bw[i * 4 + 1] + hand.bw[i * 4 + 2] + hand.bw[i * 4 + 3];
    assert.ok(Math.abs(w - 1) < 1e-6, `重み和 ${w}`);
  }
  const M2 = nb(); M2.headMesh(M2.B);
  const head = M2.finish();
  assert.ok(head.tri > 0 && finite(head.pos) && finite(head.nor));
  const cids = new Set(Array.from(head.cid));
  assert.ok(cids.has(2) && cids.has(3), "顔（肌）と髪の色を持つ");
});

test("newMeshBuilder: 呼ぶたびに独立した頂点配列（前の呼び出しが混ざらない）", () => {
  const a = nb(); a.tube([{ y: 0, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] }, { y: 1, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] }], 8);
  const b = nb(); b.tube([{ y: 0, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] }, { y: 1, rx: 0.1, rz: 0.1, c: 0, b: [0, 1] }], 8);
  assert.equal(a.finish().tri, b.finish().tri);
});

test("unit: 法線の正規化は長さ 1・長さ 0 でも NaN を出さない", () => {
  const u = C.unit(3, 4, 0);
  assert.ok(Math.abs(Math.hypot(...u) - 1) < 1e-12, `長さ ${Math.hypot(...u)}`);
  assert.deepEqual(u, [0.6, 0.8, 0]);
  assert.deepEqual(C.unit(0, 0, 0), [0, 0, 0], "長さ 0 は 0 のまま（NaN にしない）");
});

test("tube: 退化したリング（半径 0・r 指定・前後のリングが同じ高さ）でも NaN を出さない", () => {
  const M = nb();
  M.tube([
    { y: 0, r: 0.05, c: 0, b: [0, 1] },        // rx/rz の代わりに r（円）で書ける
    { y: 0.5, rx: 0, rz: 0, c: 0, b: [0, 1] }, // 半径 0 ＝ 法線が定義できないリング
    { y: 0.5, rx: 0.05, rz: 0.05, c: 0, b: [0, 1] },
    { y: 0.5, rx: 0.05, rz: 0.05, c: 0, b: [0, 1] },  // 前後のリングが同じ高さ＝dy が 0
    { y: 1, r: 0.05, c: 0, b: [0, 1] },
  ], 6);
  const m = M.finish();
  assert.ok(finite(m.pos) && finite(m.nor));
  for (let i = 0; i < 6; i++) {
    const [x, , z] = vec(m, i);
    assert.ok(Math.abs(Math.hypot(x, z) - 0.05) < 1e-6, "r 指定は rx=rz と同じ");
  }
});

test("blob: split を渡すと前後位置で第2ボーンへ重みが移る", () => {
  const M = nb();
  M.blob(0, 0, 0, 0.02, 0.02, 0.1, B.footR, 5, 4, 8, 0.9, { z0: -0.05, z1: 0.05, bone: B.toeR });
  const m = M.finish();
  let rear = null, fore = null;
  for (let i = 0; i < m.pos.length / 3; i++) { const z = vec(m, i)[2]; if (z < -0.06) rear = i; if (z > 0.06) fore = i; }
  assert.equal(m.bw[rear * 4 + 1], 0);
  assert.ok(m.bw[fore * 4 + 1] > 0.99);
  assert.equal(m.bidx[fore * 4 + 1], B.toeR);
});

test("loftZ: split なし・ao 省略でも成立する（分割しない単純な塊）", () => {
  const M = nb();
  M.loftZ(0, [
    { z: -0.05, bottom: 0, top: 0.06, w: 0.03, c: 5, b: [B.footR, 1] },
    { z: 0.05, bottom: 0, top: 0.06, w: 0.03, c: 5, b: [B.footR, 1] },
  ], 8, 0.003);
  const m = M.finish();
  assert.ok(finite(m.pos) && finite(m.nor));
  assert.ok(Array.from(m.ao).every((v) => v === 1), "ao 省略は 1");
  assert.ok(Array.from(m.bw).filter((_, i) => i % 4 === 1).every((v) => v === 0), "split なしなら第2骨の重みは 0");
});
