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

const M4 = C._M4, N = C._N;

const apply = (m, v) => {   // 列優先 4x4 に (x,y,z,1) を掛けて w で割る（射影も同じ経路で見る）
  const o = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) o[r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r];
  return o;
};
const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;

test("M4: 単位行列・掛け算・chain の結合", () => {
  const i = M4.ident();
  assert.deepEqual(Array.from(i), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const t = M4.t(1, 2, 3);
  assert.deepEqual(Array.from(M4.mul(i, t)), Array.from(t), "単位行列は何も変えない");
  // chain(a,b,c) は a·b·c と一致し、点には右から順に効く
  const c = M4.chain(M4.t(1, 0, 0), M4.scale(2, 2, 2));
  const p = apply(c, [1, 0, 0]);
  assert.ok(near(p[0], 3) && near(p[1], 0) && near(p[2], 0), `拡大してから平行移動 ${p}`);
  assert.deepEqual(Array.from(M4.chain(t)), Array.from(t), "1 個なら素通し");
});

test("M4: 平行移動・スケール・TRS", () => {
  assert.deepEqual(apply(M4.t(1, 2, 3), [0, 0, 0]).slice(0, 3), [1, 2, 3]);
  assert.deepEqual(apply(M4.scale(2, 3, 4), [1, 1, 1]).slice(0, 3), [2, 3, 4]);
  const trs = M4.trs(5, 6, 7, 2, 2, 2, Math.PI / 2);   // Y 回りに 90°
  const q = apply(trs, [1, 0, 0]);
  assert.ok(near(q[0], 5) && near(q[1], 6) && near(q[2], 7 - 2), `回して拡大して移動 ${q}`);
});

test("M4: 回転（X/Y/Z）は右手系で単位長を保つ", () => {
  const rx = apply(M4.rotX(Math.PI / 2), [0, 1, 0]);
  assert.ok(near(rx[1], 0) && near(rx[2], 1), `X 回転 ${rx}`);
  const ry = apply(M4.roty(Math.PI / 2), [0, 0, 1]);
  assert.ok(near(ry[0], 1) && near(ry[2], 0), `Y 回転 ${ry}`);
  const rz = apply(M4.rotZ(Math.PI / 2), [1, 0, 0]);
  assert.ok(near(rz[0], 0) && near(rz[1], 1), `Z 回転 ${rz}`);
});

test("M4: 透視投影は near/far を -1..1 へ、視野角どおりに横を広げる", () => {
  const P = M4.persp(Math.PI / 2, 2, 0.1, 100);
  const onNear = apply(P, [0, 0, -0.1]), onFar = apply(P, [0, 0, -100]);
  assert.ok(near(onNear[2] / onNear[3], -1, 1e-5), `near 面 ${onNear[2] / onNear[3]}`);
  assert.ok(near(onFar[2] / onFar[3], 1, 1e-5), `far 面 ${onFar[2] / onFar[3]}`);
  assert.ok(near(P[0], 1 / 2), "アスペクト 2 で横は半分に縮む");
  assert.ok(near(P[5], 1), "視野 90° なら縦の係数は 1");
  assert.equal(P[11], -1, "w に -z を入れる（透視除算）");
});

test("M4: 平行投影は箱を -1..1 へ写す", () => {
  const O = M4.ortho(-2, 2, -1, 1, 0.5, 10.5);
  const lo = apply(O, [-2, -1, -0.5]), hi = apply(O, [2, 1, -10.5]);
  assert.ok(near(lo[0], -1) && near(lo[1], -1) && near(lo[2], -1), `手前下左 ${lo}`);
  assert.ok(near(hi[0], 1) && near(hi[1], 1) && near(hi[2], 1), `奥上右 ${hi}`);
});

test("M4: lookAt は注視点を視線上（-Z）に置き、視点を原点へ移す", () => {
  const V = M4.lookAt([0, 2, 5], [0, 1, 0], [0, 1, 0]);
  const eye = apply(V, [0, 2, 5]), at = apply(V, [0, 1, 0]);
  assert.ok(near(eye[0], 0) && near(eye[1], 0) && near(eye[2], 0), `視点は原点 ${eye}`);
  assert.ok(near(at[0], 0) && near(at[1], 0), `注視点は画面中心 ${at}`);
  assert.ok(at[2] < 0, "注視点は前方（-Z）");
  assert.ok(near(Math.hypot(at[0], at[1], at[2]), Math.hypot(0 - 0, 1 - 2, 0 - 5)), "距離は保たれる");
});

test("N: ハッシュは 0..1 の決定論・入力が変われば値も変わる", () => {
  for (const n of [0, 1, -1, 12345, -98765, 2 ** 30]) {
    const v = N.hash(n);
    assert.ok(v >= 0 && v <= 1, `範囲 ${v}`);
    assert.equal(v, N.hash(n), "同じ入力は同じ値");
  }
  assert.notEqual(N.hash(1), N.hash(2));
  assert.equal(N.hash2(3, 7), N.hash2(3, 7));
  assert.notEqual(N.hash2(3, 7), N.hash2(7, 3));
  assert.equal(N.seedOf("JPN:10"), N.seedOf("JPN:10"));
  assert.notEqual(N.seedOf("JPN:10"), N.seedOf("JPN:11"));
  assert.equal(N.seedOf(""), 2166136261 | 0, "空文字は FNV の初期値");
});

test("bodyVarOf: 選手キーごとに決定論・想定の範囲に収まる", () => {
  const keys = ["JPN:10", "BRA:9", "ESP:6", "ARG:10", ""];
  for (const k of keys) {
    const v = C.bodyVarOf(k);
    assert.equal(v.h, C.bodyVarOf(k).h, "同じキーは同じ体格");
    assert.ok(v.h >= 0.955 && v.h <= 1.05, `身長スケール ${v.h}`);
    assert.ok(v.w >= 0.945 && v.w <= 1.055, `横幅スケール ${v.w}`);
  }
  const hs = new Set(keys.map((k) => C.bodyVarOf(k).h));
  assert.ok(hs.size >= 4, "キーが違えばだいたい違う体格になる");
});

test("lerp / clamp: 端点と外挿", () => {
  assert.equal(C.lerp(2, 6, 0), 2);
  assert.equal(C.lerp(2, 6, 1), 6);
  assert.equal(C.lerp(2, 6, 0.25), 3);
  assert.equal(C.lerp(2, 6, 2), 10, "u>1 は外挿（クランプしない）");
  assert.equal(C.clamp(5, 0, 1), 1);
  assert.equal(C.clamp(-5, 0, 1), 0);
  assert.equal(C.clamp(0.5, 0, 1), 0.5);
});

test("M4.lookAt: 視点と注視点が同じ／上方向が視線と平行でも NaN を返さない", () => {
  const same = M4.lookAt([1, 2, 3], [1, 2, 3], [0, 1, 0]);
  assert.ok(Array.from(same).every(Number.isFinite), `視線長 0 ${same}`);
  const parallel = M4.lookAt([0, 5, 0], [0, 0, 0], [0, 1, 0]);   // 真上から見下ろす＝up と視線が平行
  assert.ok(Array.from(parallel).every(Number.isFinite), `up が平行 ${parallel}`);
});

// poseSkin は「与えられていないキーは効かない」ことで後方互換を保つ。骨盤の並進・回旋・
// 鎖骨・足首・つま先・指は、それぞれ単独で与えても組み合わせても同じ結果になる必要がある。
test("poseSkin: 疎なポーズの各分岐（スウェイ無し・骨盤回旋のみ・鎖骨の挙上のみ 等）", () => {
  const base = { lean: 0, twist: 0, hipL: 0, kneeL: 0, hipR: 0, kneeR: 0, swL: 0, elL: 0, swR: 0, elR: 0 };
  const eq = (a, b) => { assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `[${i}] ${a[i]} vs ${b[i]}`); };
  const ne = (a, b) => { let diff = false; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) diff = true; assert.ok(diff, "変化がない"); };
  const B0 = C.poseSkin(base);
  // スウェイ 0 は「無し」と同じ／どれか 1 つでも入れば効く
  eq(C.poseSkin({ ...base, swayX: 0, swayY: 0, swayZ: 0 }), B0);
  for (const k of ["swayX", "swayY", "swayZ"]) ne(C.poseSkin({ ...base, [k]: 0.05 }), B0);
  // 骨盤: ヨーだけ・ロールだけ・両方（スウェイの有無で合成順が変わる）
  ne(C.poseSkin({ ...base, pelvisYaw: 0.2 }), B0);
  ne(C.poseSkin({ ...base, pelvisRoll: 0.1 }), B0);
  ne(C.poseSkin({ ...base, pelvisYaw: 0.2, pelvisRoll: 0.1 }), C.poseSkin({ ...base, pelvisYaw: 0.2 }));
  ne(C.poseSkin({ ...base, swayX: 0.03, pelvisYaw: 0.2, pelvisRoll: 0.1 }), C.poseSkin({ ...base, pelvisYaw: 0.2, pelvisRoll: 0.1 }));
  // 鎖骨: 挙上のみ / 前方への出も入れる
  eq(C.poseSkin({ ...base, clavL: 0, clavFwdL: 0 }), B0);
  ne(C.poseSkin({ ...base, clavL: 0.2 }), B0);
  ne(C.poseSkin({ ...base, clavL: 0.2, clavFwdL: 0.2 }), C.poseSkin({ ...base, clavL: 0.2 }));
  ne(C.poseSkin({ ...base, clavFwdR: 0.2 }), B0);
  // 足首（ピッチ/内外反）・つま先・指
  eq(C.poseSkin({ ...base, ankleL: 0, ankleTiltL: 0, toeL: 0, indexL: 0, fingersL: 0, thumbL: 0 }), B0);
  for (const k of ["ankleL", "ankleTiltR", "toeL", "indexR", "fingersR", "thumbL"]) ne(C.poseSkin({ ...base, [k]: 0.3 }), B0);
  // 骨格を差し替えても同じ経路を通る（アーキタイプ）
  const heavy = C.buildArchetype("heavy");
  ne(C.poseSkin(base, heavy.skel), B0);
});

test("buildArchetype: 文字列キー・未知のキー・spec 直渡しのいずれでも解決する", () => {
  assert.equal(C.buildArchetype("standard").mesh, C.BODY_MESH, "標準は既定のメッシュそのもの");
  assert.equal(C.buildArchetype("そんな体型はない").spec.key, "standard", "未知のキーは標準へ落とす");
  assert.equal(C.buildArchetype().spec.key, "standard", "省略も標準");
  const bySpec = C.buildArchetype(C.ARCHETYPES.slim), byKey = C.buildArchetype("slim");
  assert.equal(bySpec.spec.key, byKey.spec.key);
  for (let i = 0; i < bySpec.mesh.pos.length; i++) assert.equal(bySpec.mesh.pos[i], byKey.mesh.pos[i]);
  // 中心線（x=0）の頂点は左右どちらにも寄せない
  const std = C.BODY_MESH, sl = byKey.mesh;
  for (let i = 0; i < std.pos.length / 3; i++)
    if (std.pos[i * 3] === 0) assert.equal(sl.pos[i * 3], 0, `中心の頂点がずれる #${i}`);
});

test("IK: 目標が関節と同じ位置でも解が有限（0 除算に落ちない）", () => {
  const legAtHip = C.solveLegIK(1.0203, 0, 1.0203, 0);
  assert.ok(Number.isFinite(legAtHip.hip) && Number.isFinite(legAtHip.knee), `${JSON.stringify(legAtHip)}`);
  assert.ok(legAtHip.reach === false, "到達不能フラグは立たない（縮みきり側）");
  const armAtShoulder = C.solveArmIK(1.5346, 0, 1.5346, 0);
  assert.ok(Number.isFinite(armAtShoulder.sw) && Number.isFinite(armAtShoulder.el));
  // 遠すぎる目標は reach=true を返し、角度は伸びきりで有限
  const far = C.solveLegIK(1.0203, 0, 0, 3);
  assert.equal(far.reach, true);
  assert.ok(Number.isFinite(far.hip) && Number.isFinite(far.knee));
  const farArm = C.solveArmIK(1.5346, 0, 0, 3);
  assert.equal(farArm.reach, true);
  assert.ok(Number.isFinite(farArm.sw) && Number.isFinite(farArm.el));
});
