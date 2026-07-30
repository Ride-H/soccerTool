// 共有コア（app/character.mjs）の骨格・接地・歩容・造形の契約。character-lab から移植。
// 本体は vendored コピーを使うので、公開リポ単体でも同じ性質を検証できるようにしてある。
import { test } from "node:test";
import assert from "node:assert/strict";
import { evalFile } from "./load.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
evalFile(join(root, "app", "character.mjs"));
const C = globalThis.RPDX.character;

test("メッシュ: tri/ボーン/AO/重み正規化", () => {
  const m = C.BODY_MESH;
  assert.ok(m.tri >= 600 && m.tri <= 3300, `tri ${m.tri}`);
  assert.equal(m.boneCount, C.SKEL.length);
  const nv = m.pos.length / 3;
  assert.equal(m.ao.length, nv);
  for (let v = 0; v < nv; v++) {
    const w = m.bw[v * 4] + m.bw[v * 4 + 1] + m.bw[v * 4 + 2] + m.bw[v * 4 + 3];
    assert.ok(Math.abs(w - 1) < 1e-3, `重み合計 ${w}`);
    assert.ok(m.ao[v] >= 0 && m.ao[v] <= 1, "AO範囲");
  }
});

test("ポーズ: 中立=恒等・決定論", () => {
  const NB = { lean: 0, twist: 0, hipL: 0, kneeL: 0, hipR: 0, kneeR: 0, swL: 0, elL: 0, swR: 0, elR: 0 };
  const a = C.poseSkin(NB), b = C.poseSkin(NB);
  assert.deepEqual(Array.from(a), Array.from(b));
  for (let i = 0; i < C.SKEL.length; i++) {
    const p = [0.1, 1.0, 0.05], o = i * 16;
    const q = [a[o] * p[0] + a[o + 4] * p[1] + a[o + 8] * p[2] + a[o + 12],
      a[o + 1] * p[0] + a[o + 5] * p[1] + a[o + 9] * p[2] + a[o + 13],
      a[o + 2] * p[0] + a[o + 6] * p[1] + a[o + 10] * p[2] + a[o + 14]];
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(q[k] - p[k]) < 1e-5, `bone${i} 恒等`);
  }
});

test("IK: FK往復・膝前方", () => {
  for (const [tY, tZ] of [[0.09, 0], [0.1, 0.18], [0.1, -0.18]]) {
    const r = C.solveLegIK(0.94, 0, tY, tZ), fk = C.legFK(0.94, 0, r.hip, r.knee);
    if (!r.reach) assert.ok(Math.hypot(fk.y - tY, fk.z - tZ) < 1e-3, "到達");
    assert.ok(0 - 0.48 * Math.sin(r.hip) - (0 + fk.z) / 2 > 0, "膝前方");
  }
});

test("腕IK: FK往復・到達・範囲外クランプ・決定論", () => {
  // 到達域内の目標は armFK が機械精度で一致（脚IKと同型＝構成上保証）
  const SH = C.LM.shoulder;
  for (const [tY, tZ] of [[1.20, 0.15], [1.30, 0.20], [1.10, -0.10], [1.45, 0.05]]) {
    const r = C.solveArmIK(SH, 0, tY, tZ), fk = C.armFK(SH, 0, r.sw, r.el);
    assert.equal(r.reach, false, `到達域内 (${tY},${tZ})`);
    assert.ok(Math.hypot(fk.y - tY, fk.z - tZ) < 1e-6, `到達 err=${Math.hypot(fk.y - tY, fk.z - tZ)}`);
  }
  // 範囲外は最近点へクランプ（reach フラグ・NaN を出さない）
  const far = C.solveArmIK(SH, 0, 1.50, 1.5);
  assert.ok(far.reach && Number.isFinite(far.sw) && Number.isFinite(far.el), "範囲外検出");
  // fold で肘の折れ側が反転（同一目標で解が変わる）
  const a = C.solveArmIK(SH, 0, 1.20, 0.15, 1), b = C.solveArmIK(SH, 0, 1.20, 0.15, -1);
  assert.notEqual(a.sw.toFixed(4), b.sw.toFixed(4), "fold で肘ポール反転");
  // poseSkin の腕規約と整合（swR/elR をそのまま食える）
  const r = C.solveArmIK(SH, 0, 1.25, 0.2);
  assert.equal(C.poseSkin({ swR: r.sw, elR: r.el }).length, C.SKEL.length * 16);
});

// ---- #04 歩容の質（体重移動・接地ロール・骨盤回旋・二次モーション）----

// スキン行列でメッシュ頂点/骨頭をワールドへ（テスト内の共通補助）
const applyM = (b, o, p) => [0, 1, 2].map((r) => b[o + r] * p[0] + b[o + 4 + r] * p[1] + b[o + 8 + r] * p[2] + b[o + 12 + r]);
const boneHead = (b, i) => applyM(b, i * 16, [C.SKEL[i][1], C.SKEL[i][2], C.SKEL[i][3]]);
const M = C.BODY_MESH;
const FOOT_V = [];   // 足ボーン主導の頂点（ブーツ＋足首）
const FOOT_B = [C.BONE.footL, C.BONE.footR, C.BONE.toeL, C.BONE.toeR];
// 足/前足部の影響を受ける頂点すべて（前足部の重みが優勢な頂点も落とさない）
for (let i = 0; i < M.pos.length / 3; i++)
  if ((FOOT_B.includes(M.bidx[i * 4]) && M.bw[i * 4] > 0) || (FOOT_B.includes(M.bidx[i * 4 + 1]) && M.bw[i * 4 + 1] > 0)) FOOT_V.push(i);
const skinPos = (b, i) => {
  const o3 = i * 3, out = [0, 0, 0];
  for (let k = 0; k < 2; k++) {
    const w = M.bw[i * 4 + k]; if (!w) continue;
    const q = applyM(b, M.bidx[i * 4 + k] * 16, [M.pos[o3], M.pos[o3 + 1], M.pos[o3 + 2]]);
    for (let r = 0; r < 3; r++) out[r] += w * q[r];
  }
  return out;
};
const SPEEDS = [0, 0.8, 1.4, 3.0, 5.2];

test("04 接地: 足は地面に乗り、ロールしても沈まない/浮かない", () => {
  for (const v of SPEEDS) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < 360; i++) {
      const b = C.poseSkin(C.gaitPose(i * 2 * Math.PI / 360, v));
      for (const q of FOOT_V) { const y = skinPos(b, q)[1]; if (y < min) min = y; if (y > max) max = y; }
    }
    assert.ok(min > -0.002, `v=${v} 地面を突き抜けない (min=${min.toFixed(4)})`);
    assert.ok(min < 0.004, `v=${v} 浮かない (min=${min.toFixed(4)})`);
    assert.ok(max > 0.10, `v=${v} 遊脚で足が上がる (max=${max.toFixed(3)})`);
  }
});

test("04 接地ロール: 踵接地(つま先上げ)→踏切(つま先下げ)・接地相は狙い通りの足ピッチ", () => {
  const v = 1.4;
  // 足の世界ピッチ = 股+膝+足首（すべて rotX の累積）
  const pitchOf = (ph, s) => { const p = C.gaitPose(ph, v), k = s < 0 ? "L" : "R"; return p["hip" + k] + p["knee" + k] + p["ankle" + k]; };
  assert.ok(pitchOf(0, 1) < -0.10, `踵接地はつま先上げ (${pitchOf(0, 1).toFixed(3)})`);
  assert.ok(pitchOf(Math.PI * 0.97, 1) > 0.25, `踏切はつま先下げ (${pitchOf(Math.PI * 0.97, 1).toFixed(3)})`);
  // 接地相では足首の可動域クランプが効かず、狙いのピッチが厳密に出る（＝接地点が地面に乗る前提）
  let worst = 0;
  for (const sp of SPEEDS) for (let i = 0; i < 360; i++) {
    const ph = i * 2 * Math.PI / 360;
    for (const s of [-1, 1]) {
      const c = C.cycleOf(ph, s); if (c >= Math.PI) continue;
      const p = C.gaitPose(ph, sp), k = s < 0 ? "L" : "R";
      worst = Math.max(worst, Math.abs(C.footPitch(c, Math.min(sp / 0.6, 1)) - (p["hip" + k] + p["knee" + k] + p["ankle" + k])));
    }
  }
  assert.ok(worst < 1e-9, `接地相の足ピッチ誤差 ${worst}`);
  // 立位は足裏が水平（棒足で爪先立ちにならない）
  const st = C.gaitPose(0.7, 0);
  assert.ok(Math.abs(st.hipR + st.kneeR + st.ankleR) < 1e-9, "立位は足が水平");
});

test("04 プラント: 接地足は footPlace の目標に厳密に居る（骨盤の並進/回旋/外乱があっても）", () => {
  let eY = 0, eZ = 0, eX = 0;
  for (const v of [0.8, 1.4, 5.2]) for (const bob of [0, 0.02, -0.02]) for (let i = 0; i < 180; i++) {
    const ph = i * 2 * Math.PI / 180, p = C.gaitPose(ph, v, { bob }), b = C.poseSkin(p);
    for (const s of [-1, 1]) {
      const ft = C.footPlace(ph, v, s), c = C.cycleOf(ph, s);
      const w = boneHead(b, s < 0 ? C.BONE.footL : C.BONE.footR);
      eZ = Math.max(eZ, Math.abs(w[2] - ft.fz));
      const k = s < 0 ? "L" : "R";   // 前足部の角度はゲイトの出力を使う（規則を二重に書かない）
      eY = Math.max(eY, Math.abs(w[1] - (C.soleDrop(C.footPitch(c, Math.min(v / 0.6, 1)), p["toe" + k]) + ft.fy)));
      // #13 以降、骨盤を横に振っても股関節の外転が打ち消すので、接地足のワールド X は動かない
      eX = Math.max(eX, Math.abs(w[0] - (-C.SKEL[C.BONE.thighL][1]) * s));
    }
  }
  assert.ok(eZ < 1e-5 && eY < 1e-5, `足首がIK目標に到達 (Z誤差=${eZ.toExponential(1)} Y誤差=${eY.toExponential(1)})`);
  assert.ok(eX < 3e-3, `接地足は左右にも動かない (X誤差=${eX.toExponential(1)})`);
});

test("04 対側協調: 右足が前なら右腕は後ろ・左肩が前・右腰が前（骨盤と胸郭は反位相）", () => {
  const v = 1.4;
  const fwd = C.gaitPose(0, v), back = C.gaitPose(Math.PI, v);
  assert.ok(C.footPlace(0, v, 1).fz > 0.1, "前提: phase=0 は右足が前");
  assert.ok(fwd.swR > 0.1 && fwd.swL < -0.1, `右足前で右腕は後ろ swR=${fwd.swR.toFixed(3)}`);
  assert.ok(fwd.twist > 0.05, `右足前で左肩が前 twist=${fwd.twist.toFixed(3)}`);
  assert.ok(fwd.pelvisYaw < -0.03, `右足前で右腰が前 pelvisYaw=${fwd.pelvisYaw.toFixed(3)}`);
  assert.ok(back.swR < -0.1 && back.twist < -0.05 && back.pelvisYaw > 0.03, "半周期後は左右が反転");
  for (let i = 0; i < 240; i++) {
    const p = C.gaitPose(i * 2 * Math.PI / 240, v);
    assert.ok(p.twist * p.pelvisYaw <= 1e-12, `骨盤と胸郭は常に反位相 @${i}`);
  }
});

test("04 体重移動: 骨盤は中間支持で高く両脚支持で沈む・上体は支持脚側へ傾く", () => {
  for (const v of [1.4, 5.2]) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 360; i++) { const y = C.gaitPose(i * 2 * Math.PI / 360, v).swayY; lo = Math.min(lo, y); hi = Math.max(hi, y); }
    assert.ok(hi - lo > 0.02 && hi - lo < 0.08, `v=${v} 骨盤の上下動が人の範囲 (${((hi - lo) * 100).toFixed(1)}cm)`);
    assert.ok(C.gaitPose(Math.PI / 2, v).swayY > C.gaitPose(0, v).swayY, `v=${v} 中間支持で上昇`);
    assert.ok(C.gaitPose(Math.PI / 2, v).sideLean > 0.01, `v=${v} 右支持で右へ傾く`);
    assert.ok(C.gaitPose(-Math.PI / 2, v).sideLean < -0.01, `v=${v} 左支持で左へ傾く`);
  }
  assert.ok(Math.abs(C.gaitPose(1.0, 0).sideLean) < 1e-9, "立位では傾かない");
});

test("04 二次モーション: 加速で腕が遅れて後方へ流れ胴が前傾・減速で逆", () => {
  const ph = 1.0, v = 3.0;
  const a0 = C.gaitPose(ph, v, { accel: 0 }), ap = C.gaitPose(ph, v, { accel: 3 }), am = C.gaitPose(ph, v, { accel: -3 });
  assert.ok(ap.lean > a0.lean + 0.05 && am.lean < a0.lean - 0.05, "加速で前傾・減速で後傾");
  // 位相の遅れは左右で打ち消し合うので、両腕の和（＝後方トレイル成分の2倍）で見る
  assert.ok(ap.swR + ap.swL > a0.swR + a0.swL + 0.02, "加速で両腕が後方へ流れる（慣性）");
  assert.ok(am.swR + am.swL < a0.swR + a0.swL - 0.02, "減速では逆");
  // 位相の遅れ: 加速時の腕振りは「少し前の位相の振り」＝後方トレイルを除けば過去のポーズと一致する
  const lag = 3 * 0.05, trail = 3 * 0.02;
  for (const p of [0.4, 1.9, 3.7, 5.1]) {
    const now = C.gaitPose(p, v, { accel: 3 }).swR - trail, past = C.gaitPose(p - lag, v, { accel: 0 }).swR;
    assert.ok(Math.abs(now - past) < 1e-12, `腕は ${lag}rad 分だけ遅れる @${p}`);
  }
  assert.ok(Math.abs(C.gaitPose(0.4, v, { accel: 3 }).swR - C.gaitPose(0.4, v, { accel: 0 }).swR) > 1e-3, "遅れ＋トレイルで実際に姿勢が変わる");
  assert.ok(Math.abs(C.gaitPose(ph, v, { accel: 99 }).lean - C.gaitPose(ph, v, { accel: 4 }).lean) < 1e-9, "過大な加速度はクランプ");
});

test("04 連続性・決定論: 位相を進めてもポーズが跳ばない・NaN を出さない", () => {
  const KEYS = ["lean", "twist", "pelvisYaw", "sideLean", "swayX", "swayY", "swayZ", "hipL", "kneeL", "ankleL", "hipR", "kneeR", "ankleR", "swL", "swR"];
  for (const v of [0, 1.4, 5.2]) {
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const p1 = C.gaitPose(i * 2 * Math.PI / N, v), p2 = C.gaitPose((i + 1) * 2 * Math.PI / N, v);
      for (const k of KEYS) {
        assert.ok(Number.isFinite(p1[k]), `${k} 有限 v=${v}`);
        assert.ok(Math.abs(p2[k] - p1[k]) < 0.01, `${k} が跳ばない v=${v} @${(i * 2 * Math.PI / N).toFixed(2)} (${(p2[k] - p1[k]).toExponential(1)})`);
      }
    }
    assert.deepEqual(C.gaitPose(1.234, v, { accel: 1 }), C.gaitPose(1.234, v, { accel: 1 }), `決定論 v=${v}`);
  }
});

test("04 poseSkin: 新パラメータは後方互換・骨盤回旋は脚に伝播しない", () => {
  const NB = { lean: 0.1, twist: 0.2, hipL: -0.3, kneeL: 0.4, hipR: 0.1, kneeR: 0.2, swL: 0.1, elL: 0.3, swR: -0.1, elR: 0.3, swayX: 0.02, swayY: 0.03, swayZ: 0.01 };
  assert.deepEqual(Array.from(C.poseSkin(NB)), Array.from(C.poseSkin({ ...NB, pelvisYaw: 0, sideLean: 0, ankleL: 0, ankleR: 0 })), "無指定=0 と同一");
  // 骨盤回旋: 骨盤は回るが、脚（腿）の向きは変わらない＝接地を壊さない
  const base = C.poseSkin(NB), yaw = C.poseSkin({ ...NB, pelvisYaw: 0.25 });
  const pelvisPt = (b) => applyM(b, 0, [0.1, C.LM.hip, 0]);
  assert.ok(Math.abs(pelvisPt(yaw)[2] - pelvisPt(base)[2]) > 0.01, "骨盤メッシュは回る");
  const kneeDir = (b) => { const h = boneHead(b, C.BONE.thighL), k = boneHead(b, C.BONE.shinL); return [k[0] - h[0], k[1] - h[1], k[2] - h[2]]; };
  const d0 = kneeDir(base), d1 = kneeDir(yaw);
  for (let r = 0; r < 3; r++) assert.ok(Math.abs(d0[r] - d1[r]) < 1e-6, "腿の向きは骨盤回旋の影響を受けない");
  // 前額面の傾き: 胸は倒れるが骨盤は動かない
  const side = C.poseSkin({ ...NB, sideLean: 0.3 });
  const chestPt = (b) => applyM(b, C.BONE.chest * 16, [0, C.LM.thorax, 0]);
  assert.ok(chestPt(side)[0] > chestPt(base)[0] + 0.01, "胸は右へ倒れる");
  assert.ok(Math.abs(pelvisPt(side)[0] - pelvisPt(base)[0]) < 1e-9, "骨盤は動かない");
  // 足首: 足だけが回る
  const ank = C.poseSkin({ ...NB, ankleR: 0.4 }), FR = C.BONE.footR;
  const toeTip = [C.SKEL[FR][1], C.LM.ankle, 0.19];
  assert.ok(Math.abs(boneHead(ank, FR)[1] - boneHead(base, FR)[1]) < 1e-6, "足首関節の位置は不変（float32 精度内）");
  assert.ok(Math.abs(applyM(ank, FR * 16, toeTip)[1] - applyM(base, FR * 16, toeTip)[1]) > 0.01, "つま先は下がる");
});

// ---- #11 骨格・関節構造（人体の関節・自由度・可動域・比率）----

test("11 比率: 関節高さと体節長が人体の標準比に収まる", () => {
  const H = C.H, LM = C.LM;
  const std = { ankle: 0.039, knee: 0.285, hip: 0.530, crotch: 0.485, acromion: 0.818, elbow: 0.630, wrist: 0.485, chin: 0.870 };
  for (const k in std) {
    const r = LM[k] / H;
    assert.ok(Math.abs(r - std[k]) < 0.03 * std[k], `${k} 比率 ${r.toFixed(3)}（標準 ${std[k]}）`);
  }
  // メッシュの高さが身長と一致（頭頂キャップ +0.02）
  let top = -Infinity, low = Infinity;
  for (let i = 0; i < M.pos.length / 3; i++) { top = Math.max(top, M.pos[i * 3 + 1]); low = Math.min(low, M.pos[i * 3 + 1]); }
  assert.ok(Math.abs(top - H) < 0.005, `身長 ${top.toFixed(3)}`);
  assert.ok(Math.abs(low) < 0.005, `足裏が地面 ${low.toFixed(4)}`);
  // 骨長は IK の骨長と一致（骨格と IK が同じ表を見ている）
  assert.ok(Math.abs(C.IK_L1 - (LM.hip - LM.knee)) < 1e-12 && Math.abs(C.IK_L2 - (LM.knee - LM.ankle)) < 1e-12, "脚 IK 骨長");
  assert.ok(Math.abs(C.IK_A1 - (LM.shoulder - LM.elbow)) < 1e-12 && Math.abs(C.IK_A2 - (LM.elbow - LM.wrist)) < 1e-12, "腕 IK 骨長");
});

test("11 骨格: ボーンの親子と名前表が整合する", () => {
  assert.equal(C.SKEL.length, 25);
  assert.equal(Object.keys(C.BONE).length, 25);
  for (const [name, i] of Object.entries(C.BONE)) {
    assert.ok(C.SKEL[i], `${name} が SKEL にある`);
    assert.ok(C.SKEL[i][0] < i, `${name} の親は自分より前（トポロジ順）`);
  }
  // 鎖骨は胸の子・上腕は鎖骨の子（腕を上げると肩が動く連鎖）
  assert.equal(C.SKEL[C.BONE.clavL][0], C.BONE.chest);
  assert.equal(C.SKEL[C.BONE.upArmL][0], C.BONE.clavL);
  assert.equal(C.SKEL[C.BONE.toeL][0], C.BONE.footL);
  // メッシュは全ボーンを参照する（使われないボーンが無い）
  const used = new Set();
  for (let i = 0; i < M.bidx.length; i += 4) { if (M.bw[i] > 0) used.add(M.bidx[i]); if (M.bw[i + 1] > 0) used.add(M.bidx[i + 1]); }
  for (const [name, i] of Object.entries(C.BONE)) assert.ok(used.has(i), `${name} にメッシュが付いている`);
});

test("11 自由度: 外転で四肢が横へ・内外旋で軸回り・鎖骨で肩が上がる・前足部が曲がる", () => {
  const NB = { lean: 0.03, twist: 0, hipL: -0.1, kneeL: 0.2, hipR: -0.1, kneeR: 0.2, swL: 0.02, elL: 0.35, swR: -0.02, elR: 0.35 };
  const base = C.poseSkin(NB);
  const wristPt = [C.SKEL[C.BONE.foreArmR][1], C.LM.wrist, 0];
  const anklePt = [C.SKEL[C.BONE.footR][1], C.LM.ankle, 0];
  // 肩の外転: 手首が体から離れて上がる（正が外転＝解剖学的な向き）
  const abd = C.poseSkin({ ...NB, armAbdR: 1.2 });
  const w0 = applyM(base, C.BONE.foreArmR * 16, wristPt), w1 = applyM(abd, C.BONE.foreArmR * 16, wristPt);
  assert.ok(w1[0] > w0[0] + 0.1 && w1[1] > w0[1] + 0.1, `腕が横に上がる (${w0.map((v) => v.toFixed(2))} → ${w1.map((v) => v.toFixed(2))})`);
  // 左右対称: 同じ符号で左腕も外転する（左は -X 側へ）
  const abdL = C.poseSkin({ ...NB, armAbdL: 1.2 });
  const lw = [C.SKEL[C.BONE.foreArmL][1], C.LM.wrist, 0];
  assert.ok(applyM(abdL, C.BONE.foreArmL * 16, lw)[0] < applyM(base, C.BONE.foreArmL * 16, lw)[0] - 0.1, "左腕も同符号で外転");
  // 股関節の外転: 足首が外側へ開く
  const hipAbd = C.poseSkin({ ...NB, hipAbdR: 0.6 });
  assert.ok(applyM(hipAbd, C.BONE.footR * 16, anklePt)[0] > applyM(base, C.BONE.footR * 16, anklePt)[0] + 0.1, "脚が横に開く");
  // 内外旋: 足首の位置はほぼ変わらず、つま先の向きが変わる（軸回りの回転）
  const rot = C.poseSkin({ ...NB, hipRotR: 0.6 });
  const toeTip = [C.SKEL[C.BONE.footR][1], C.LM.ankle, 0.20];
  assert.ok(Math.abs(applyM(rot, C.BONE.footR * 16, anklePt)[0] - applyM(base, C.BONE.footR * 16, anklePt)[0]) < 0.02, "内外旋で足首は動かない");
  assert.ok(applyM(rot, C.BONE.footR * 16, toeTip)[0] < applyM(base, C.BONE.footR * 16, toeTip)[0] - 0.05, "つま先が内を向く（内旋が正）");
  // 鎖骨: 肩（上腕の根本）が上がる
  const clav = C.poseSkin({ ...NB, clavR: 0.3 });
  assert.ok(boneHead(clav, C.BONE.upArmR)[1] > boneHead(base, C.BONE.upArmR)[1] + 0.02, "鎖骨の挙上で肩関節が上がる");
  // 前足部: つま先だけが動き、足首は動かない
  const toe = C.poseSkin({ ...NB, toeR: -0.6 });
  assert.ok(Math.abs(boneHead(toe, C.BONE.footR)[1] - boneHead(base, C.BONE.footR)[1]) < 1e-6, "足首は不変");
  assert.ok(applyM(toe, C.BONE.toeR * 16, [C.SKEL[C.BONE.toeR][1], 0.02, 0.21])[1] > applyM(base, C.BONE.toeR * 16, [C.SKEL[C.BONE.toeR][1], 0.02, 0.21])[1] + 0.02, "つま先が上がる");
  // 新自由度が 0 のときは従来（rotX 単体）と厳密に一致＝後方互換
  assert.deepEqual(Array.from(base), Array.from(C.poseSkin({ ...NB, armAbdR: 0, armRotL: 0, hipAbdR: 0, hipRotL: 0, clavR: 0, toeL: 0, ankleTiltR: 0 })));
});

test("11 可動域: 表の範囲へ収め、左右の別なく同じ制限が効く", () => {
  for (const k of ["hip", "knee", "ankle", "sw", "el", "armAbd", "hipAbd", "clav", "toe", "lean", "twist"])
    assert.ok(C.ROM[k] && C.ROM[k][0] < C.ROM[k][1], `ROM ${k}`);
  assert.deepEqual(C.romOf("hipAbdL"), C.ROM.hipAbd, "末尾 L/R を落として引ける");
  assert.deepEqual(C.romOf("kneeR"), C.ROM.knee);
  assert.equal(C.romOf("swayX"), null, "並進は関節ではないので可動域を持たない");
  const p = C.clampPose({ kneeL: -1, kneeR: 99, armAbdR: 99, swayX: 5, lean: -9 });
  assert.equal(p.kneeL, C.ROM.knee[0]); assert.equal(p.kneeR, C.ROM.knee[1]);
  assert.equal(p.armAbdR, C.ROM.armAbd[1]); assert.equal(p.lean, C.ROM.lean[0]);
  assert.equal(p.swayX, 5, "並進はそのまま");
  // 膝は後ろへ曲がらない（過伸展しない）
  assert.equal(C.ROM.knee[0], 0);
});

test("11 歩容は新しい骨格でも成立する（接地・可達・決定論）", () => {
  for (const v of [0, 1.4, 5.2]) {
    let min = Infinity;
    for (let i = 0; i < 180; i++) {
      const b = C.poseSkin(C.gaitPose(i * 2 * Math.PI / 180, v));
      for (const q of FOOT_V) min = Math.min(min, skinPos(b, q)[1]);
    }
    assert.ok(min > -0.002 && min < 0.004, `v=${v} 足裏が地面に乗る (${min.toFixed(4)})`);
  }
  // 歩幅と脚の実効長が骨長から導かれている（比率を変えれば歩容も追従）
  assert.ok(Math.abs(C.STRIDE_MAX - (C.IK_L1 + C.IK_L2) * 0.477) < 1e-12, "歩幅上限は脚長由来");
  assert.ok(C.LEG_EFF < C.IK_L1 + C.IK_L2 - 0.012, "実効脚長は可達上限より内側");
});

// ---- #12 靴の造形（独立した物体のまま踵・甲・つま先・靴底を持たせる）----

test("12 靴: 靴底が平らで地面に乗り、踵とつま先の角だけ丸い", () => {
  const SH = C.SHOE;
  // 素の（ポーズ無しの）メッシュで靴底の高さを z ごとに見る
  const sole = new Map();
  for (const i of FOOT_V) {
    if (M.cid[i] !== 5) continue;   // 靴の頂点だけを見る（脚チューブの末端は除く）
    const z = M.pos[i * 3 + 2], y = M.pos[i * 3 + 1];
    const key = Math.round(z * 200) / 200;
    if (!sole.has(key) || y < sole.get(key)) sole.set(key, y);
  }
  for (const [z, y] of sole) {
    if (z > SH.heelZ + SH.soleR + 0.01 && z < SH.toeZ - SH.soleR - 0.01)
      assert.ok(Math.abs(y) < 0.004, `z=${z} で靴底が平ら (y=${y.toFixed(4)})`);
  }
  const zs = [...sole.keys()].sort((a, b) => a - b);
  assert.ok(sole.get(zs[zs.length - 1]) > 0.008, `つま先の角は持ち上がる (${sole.get(zs[zs.length - 1]).toFixed(4)})`);
  assert.ok(sole.get(zs[0]) > 0.008, `踵の角も持ち上がる (${sole.get(zs[0]).toFixed(4)})`);
  // 足の長さ・幅が寸法表どおり
  let zMin = Infinity, zMax = -Infinity, xW = 0;
  for (const i of FOOT_V) {
    if (M.cid[i] !== 5) continue;
    zMin = Math.min(zMin, M.pos[i * 3 + 2]); zMax = Math.max(zMax, M.pos[i * 3 + 2]);
    xW = Math.max(xW, Math.abs(M.pos[i * 3] - Math.sign(M.pos[i * 3]) * (-C.SKEL[C.BONE.thighL][1])));
  }
  assert.ok(Math.abs((zMax - zMin) - (SH.toeZ - SH.heelZ)) < 0.02, `足長 ${(zMax - zMin).toFixed(3)}`);
  assert.ok(Math.abs(xW - SH.width) < 0.01, `足幅 ${xW.toFixed(3)}`);
});

test("12 接地モデルと靴の形が一致する（どの足の角度でも靴底が地面に乗る）", () => {
  const NB = { lean: 0, twist: 0, hipL: 0, kneeL: 0, hipR: 0, kneeR: 0, swL: 0, elL: 0, swR: 0, elR: 0 };
  for (const [pitch, toe] of [[0, 0], [-0.15, 0], [0.2, -0.2], [0.35, -0.35], [0.5, -0.5], [-0.3, 0]]) {
    // 足首を soleDrop の高さに置く＝股関節を持ち上げて脚を伸ばす代わりに、直接ボーンを回して確かめる
    const lift = C.soleDrop(pitch, toe) - C.LM.ankle;
    const b = C.poseSkin({ ...NB, ankleR: pitch, toeR: toe, swayY: lift });
    let min = Infinity;
    for (const i of FOOT_V) if (M.cid[i] === 5 && M.pos[i * 3] > 0) min = Math.min(min, skinPos(b, i)[1]);
    assert.ok(min > -0.004 && min < 0.006, `pitch=${pitch} toe=${toe} で靴底が地面 (min=${min.toFixed(4)})`);
  }
});

test("12 踏切: 母趾球で折れて前足部は接地したまま踵が上がる", () => {
  const v = 1.4;
  // 接地相の終盤（踏切）
  const p = C.gaitPose(Math.PI * 0.95, v);
  assert.ok(p.toeR < -0.2, `前足部が曲がる toeR=${p.toeR.toFixed(3)}`);
  const rear = p.hipR + p.kneeR + p.ankleR;         // 後足部の世界ピッチ（つま先下げ）
  const fore = rear + p.toeR;                       // 前足部の世界ピッチ
  assert.ok(rear > 0.25, `踵が上がる（後足部つま先下げ ${rear.toFixed(3)}）`);
  assert.ok(Math.abs(fore) < 1e-9, `前足部は水平を保つ（${fore.toExponential(1)}）`);
  // 遊脚に入ると前足部の曲げは戻る
  assert.ok(Math.abs(C.gaitPose(Math.PI * 1.4, v).toeR) < 0.02, "遊脚では戻る");
  // 立位では曲げない
  assert.equal(C.gaitPose(1.0, 0).toeR, -0);
});

// ---- #12 連結の回帰（部品が本当に重なっているかをレイキャストで判定）----

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const domOf = (i) => (M.bw[i * 4 + 1] > M.bw[i * 4] ? M.bidx[i * 4 + 1] : M.bidx[i * 4]);
const trisOf = (pred) => {
  const out = [];
  for (let t = 0; t < M.idx.length; t += 3) {
    const a = M.idx[t], b = M.idx[t + 1], c = M.idx[t + 2];
    if (pred(a) && pred(b) && pred(c)) out.push([a, b, c]);
  }
  return out;
};
// 点が閉じた三角形群の内側にあるか（+X 方向へレイを飛ばし交差回数の偶奇で判定・軸平行を避けて少し傾ける）
const insideOf = (bones, tris, p) => {
  const dir = [1, 0.0171, 0.0131];
  let hits = 0;
  for (const [ia, ib, ic] of tris) {
    const A = skinPos(bones, ia), e1 = sub3(skinPos(bones, ib), A), e2 = sub3(skinPos(bones, ic), A);
    const h = cross3(dir, e2), det = dot3(e1, h);
    if (Math.abs(det) < 1e-12) continue;
    const f = 1 / det, sv = sub3(p, A), u = f * dot3(sv, h);
    if (u < 0 || u > 1) continue;
    const q = cross3(sv, e1), v = f * dot3(dir, q);
    if (v < 0 || u + v > 1) continue;
    if (f * dot3(e2, q) > 1e-9) hits++;
  }
  return hits % 2 === 1;
};
const TORSO_B = [C.BONE.pelvis, C.BONE.spine, C.BONE.chest, C.BONE.neck, C.BONE.head];
const TORSO_TRIS = trisOf((i) => TORSO_B.includes(domOf(i)));
const SHOE_TRIS_R = trisOf((i) => M.cid[i] === 5 && M.pos[i * 3] > 0);

test("12 肩: 腕の付け根は胴に埋まったまま（どのポーズでも素通しの隙間ができない）", () => {
  const NB = { lean: 0.03, twist: 0, hipL: -0.1, kneeL: 0.2, hipR: -0.1, kneeR: 0.2, swL: 0.02, elL: 0.35, swR: -0.02, elR: 0.35 };
  const ARM_B = [C.BONE.clavR, C.BONE.upArmR];
  const armX = -C.SKEL[C.BONE.upArmL][1];
  // 腕チューブの上端キャップ（＝腕の一番上の点）。これが胴の内側にある限り、腕チューブは胴の面を必ず
  // またぐので、両者は交わったまま＝根元に穴は空かない。内側寄りのリング頂点も通常の可動域では埋まっている。
  // 腕アセンブリ＝右腕のボーンの影響を少しでも受ける頂点（三角筋の頂点は胸寄りの重みなので主導では引けない）
  const hasArm = (i) => (ARM_B.includes(M.bidx[i * 4]) && M.bw[i * 4] > 0) || (ARM_B.includes(M.bidx[i * 4 + 1]) && M.bw[i * 4 + 1] > 0);
  let cap = -1, capY = -Infinity;
  const inner = [];
  for (let i = 0; i < M.pos.length / 3; i++) {
    if (M.pos[i * 3] <= 0 || !hasArm(i)) continue;
    if (M.pos[i * 3 + 1] > capY) { capY = M.pos[i * 3 + 1]; cap = i; }   // 腕チューブの一番上＝上端キャップ
    if (M.pos[i * 3 + 1] > C.LM.shoulder && M.pos[i * 3] < armX - 0.01) inner.push(i);
  }
  assert.ok(cap >= 0 && capY > C.LM.shoulder, `腕の上端キャップがある (y=${capY.toFixed(4)})`);
  assert.ok(inner.length >= 3, `内側寄りの付け根頂点がある (${inner.length})`);
  // 可動域（ROM）の内側であれば、どのポーズでも肩は塞がっていること。ポーズは clampPose を通してから見る。
  const POSES = [["中立", {}], ["前振り", { swR: -3 }], ["後ろ振り", { swR: 1 }], ["外転", { armAbdR: 1.5 }],
    ["真上まで外転", { armAbdR: 2.9 }], ["すくめる", { clavR: 0.9 }], ["すくめて上げる", { armAbdR: 2.9, clavR: 0.9 }],
    ["内旋", { armRotR: 1.5 }], ["歩き", C.gaitPose(0, 1.4)], ["走り", C.gaitPose(2.0, 5.2)]];
  for (const [name, pose] of POSES) {
    const p = C.clampPose({ ...NB, ...pose }), b = C.poseSkin(p);
    assert.ok(insideOf(b, TORSO_TRIS, skinPos(b, cap)), `${name}: 腕の上端が胴の内側（＝腕チューブは胴の面を必ずまたぐ）`);
    // 三角筋の面がどこまで胴の外に出るかは可動域とポーズで変わる（腕を上げれば腋は開く＝それが正しい）。
    // 塞がっている条件は「腕チューブの一番上が胴の内側にある」ことだけで足りる。
    const outside = inner.filter((i) => !insideOf(b, TORSO_TRIS, skinPos(b, i)));
    assert.ok(outside.length < inner.length, `${name}: 付け根の一部は胴に埋まっている (${outside.length}/${inner.length})`);
  }
});

test("12 足: 脚の末端は靴の内側にある（脚が宙で終わらない）", () => {
  const NB = { lean: 0.03, twist: 0, hipL: 0, kneeL: 0, hipR: 0, kneeR: 0, swL: 0, elL: 0.35, swR: 0, elR: 0.35 };
  const ankle = [];   // 右脚チューブの最下リング（色=脚・足ボーン主導）
  for (let i = 0; i < M.pos.length / 3; i++)
    if (M.cid[i] === 4 && M.pos[i * 3] > 0 && domOf(i) === C.BONE.footR && M.pos[i * 3 + 1] < C.LM.ankle + 0.01) ankle.push(i);
  assert.ok(ankle.length >= 6, `足首まわりの頂点がある (${ankle.length})`);
  for (const pose of [NB, { ...NB, ankleR: 0.5, toeR: -0.5 }, { ...NB, ankleR: -0.45 }, { ...NB, ankleTiltR: 0.3 }]) {
    const b = C.poseSkin(pose);
    const outside = ankle.filter((i) => !insideOf(b, SHOE_TRIS_R, skinPos(b, i)));
    assert.ok(outside.length === 0, `脚の末端が靴からはみ出す頂点=${outside.length}/${ankle.length}`);
  }
});

test("12 股: 骨盤の下端は左右の腿に隠れ、脚は正中で接する（内腿に空洞が見えない）", () => {
  // 骨盤（ショーツ）の最下リングの半幅 < その高さでの腿の外側 かつ 左右の腿が正中で重なる
  let pelvisMinY = Infinity, pelvisHalf = 0;
  for (let i = 0; i < M.pos.length / 3; i++) {
    if (M.bidx[i * 4] !== C.BONE.pelvis || M.bw[i * 4] < 0.99) continue;
    const y = M.pos[i * 3 + 1];
    if (y < pelvisMinY - 1e-6) { pelvisMinY = y; pelvisHalf = 0; }
    if (Math.abs(y - pelvisMinY) < 1e-6) pelvisHalf = Math.max(pelvisHalf, Math.abs(M.pos[i * 3]));
  }
  // 股の布は股下より少し下（脚の間）まで伸びる
  assert.ok(pelvisMinY < C.LM.crotch && pelvisMinY > C.LM.crotch - 0.07, `骨盤の下端が股の高さ〜その少し下 (${pelvisMinY.toFixed(3)})`);
  // その高さでの腿の内側端（正中側）— 左右が重なっていれば符号が反転する
  const hipX = -C.SKEL[C.BONE.thighL][1];
  let innerMost = Infinity;
  for (let i = 0; i < M.pos.length / 3; i++) {
    if (M.bidx[i * 4] !== C.BONE.thighR || M.bw[i * 4] < 0.99) continue;
    if (M.pos[i * 3 + 1] < C.LM.crotch - 0.02 || M.pos[i * 3 + 1] > C.LM.crotch + 0.08) continue;
    innerMost = Math.min(innerMost, M.pos[i * 3]);
  }
  assert.ok(innerMost < 0.01, `右腿が正中まで届く (x=${innerMost.toFixed(4)})`);
  assert.ok(pelvisHalf < hipX + 0.02, `骨盤の下端は腿の間に収まる (半幅=${pelvisHalf.toFixed(3)} ≤ ${(hipX + 0.02).toFixed(3)})`);
});

// ---- #13 前額面の体重移動（骨盤の左右移動と遊脚側の落ち）----

test("13 体重移動: 骨盤が支持脚側へ寄り、遊脚側の腰が落ちる", () => {
  const v = 1.4;
  const rStance = C.gaitPose(Math.PI / 2, v);    // 右支持（中間支持）
  const lStance = C.gaitPose(-Math.PI / 2, v);   // 左支持
  assert.ok(rStance.swayX > 0.01, `右支持で骨盤が右へ (${rStance.swayX.toFixed(3)})`);
  assert.ok(lStance.swayX < -0.01, `左支持で骨盤が左へ (${lStance.swayX.toFixed(3)})`);
  // 骨盤リスト: 正=右腰が上がる → 右支持では遊脚（左）側が落ちる
  assert.ok(rStance.pelvisRoll > 0.02, `右支持で右腰が上がる (${rStance.pelvisRoll.toFixed(3)})`);
  assert.ok(lStance.pelvisRoll < -0.02, "左支持では逆");
  assert.ok(Math.abs(C.gaitPose(1.0, 0).pelvisRoll) < 1e-9, "立位では傾かない");
  // 人の範囲（骨盤リストは片側 2〜7°程度）
  let maxRoll = 0;
  for (let i = 0; i < 360; i++) maxRoll = Math.max(maxRoll, Math.abs(C.gaitPose(i * 2 * Math.PI / 360, 5.2).pelvisRoll));
  assert.ok(maxRoll > 0.03 && maxRoll < 0.13, `骨盤リストが人の範囲 (${(maxRoll * 57.3).toFixed(1)}°)`);
});

test("13 接地: 骨盤を横に振っても外転が打ち消して接地足が動かない", () => {
  const hipX = -C.SKEL[C.BONE.thighL][1];
  let eX = 0, eY = 0, eZ = 0, maxAbd = 0;
  for (const v of [0.8, 1.4, 5.2]) for (let i = 0; i < 180; i++) {
    const ph = i * 2 * Math.PI / 180, p = C.gaitPose(ph, v), b = C.poseSkin(p);
    for (const s of [-1, 1]) {
      const k = s < 0 ? "L" : "R", ft = C.footPlace(ph, v, s), c = C.cycleOf(ph, s);
      if (c >= Math.PI) continue;   // 接地相のみ
      const w = boneHead(b, s < 0 ? C.BONE.footL : C.BONE.footR);
      eX = Math.max(eX, Math.abs(w[0] - hipX * s));
      eY = Math.max(eY, Math.abs(w[1] - (C.soleDrop(C.footPitch(c, Math.min(v / 0.6, 1)), p["toe" + k]) + ft.fy)));
      eZ = Math.max(eZ, Math.abs(w[2] - ft.fz));
      maxAbd = Math.max(maxAbd, Math.abs(p["hipAbd" + k]));
    }
  }
  // 打ち消しは 1 次近似（外転角を落差の asin から決める）なので 1mm 級の残差が出る。足幅 11cm に対し無視できる。
  assert.ok(eX < 2e-3, `左右に動かない (${eX.toExponential(1)})`);
  assert.ok(eY < 1e-5 && eZ < 1e-5, `上下・前後も厳密 (Y=${eY.toExponential(1)} Z=${eZ.toExponential(1)})`);
  assert.ok(maxAbd > 0.01 && maxAbd < C.ROM.hipAbd[1], `外転が可動域内で働く (${(maxAbd * 57.3).toFixed(1)}°)`);
});

// ---- #05 顔の造形（面・鼻・目・生え際・耳）----

test("05 頭部の寸法が人体比（幅/奥行/高さ）", () => {
  const LM = C.LM;
  const head = [];
  for (let i = 0; i < M.pos.length / 3; i++) if (M.pos[i * 3 + 1] > LM.chin - 0.01) head.push(i);
  const at = (i) => [M.pos[i * 3], M.pos[i * 3 + 1], M.pos[i * 3 + 2]];
  // 幅は耳を除く（耳は頭の外に出るのが正しい）／奥行は鼻を除く（鼻は前に出るのが正しい）
  let w = 0, back = 0, faceZ = 0, top = -Infinity;
  for (const i of head) {
    const [x, y, z] = at(i);
    if (y > 1.834 && y < 1.846) w = Math.max(w, Math.abs(x));   // 頭蓋の最大幅（耳の高さを避ける）
    back = Math.min(back, z);
    if (Math.abs(y - LM.eye) < 0.01 && Math.abs(x) < 0.02) faceZ = Math.max(faceZ, z);
    top = Math.max(top, y);
  }
  assert.ok(Math.abs(w * 2 - 0.160) < 0.014, `頭幅 ${(w * 2).toFixed(3)}（標準 0.155〜0.163）`);
  assert.ok(Math.abs((faceZ - back) - 0.195) < 0.025, `頭の奥行 ${(faceZ - back).toFixed(3)}（標準 0.195・鼻を含む）`);
  assert.ok(Math.abs((top - LM.chin) - 0.25) < 0.012, `頭の高さ ${(top - LM.chin).toFixed(3)}（標準 0.25）`);
  // 顔の三等分（顎→鼻の付け根→眉→生え際）がほぼ等間隔
  const t1 = LM.noseBase - LM.chin, t2 = LM.brow - LM.noseBase, t3 = LM.hairline - LM.brow;
  assert.ok(Math.max(t1, t2, t3) / Math.min(t1, t2, t3) < 1.2, `顔の三等分 ${[t1, t2, t3].map((v) => v.toFixed(3))}`);
});

test("05 顔: 鼻が前へ出て、目が暗色で左右対称、耳が横に付く", () => {
  const LM = C.LM;
  const at = (i) => [M.pos[i * 3], M.pos[i * 3 + 1], M.pos[i * 3 + 2]];
  // 鼻: 鼻先の高さの中央が、目の高さの中央より前へ出ている
  let noseZ = -Infinity, cheekZ = -Infinity;
  for (let i = 0; i < M.pos.length / 3; i++) {
    const [x, y, z] = at(i);
    if (Math.abs(y - LM.noseTip) > 0.006) continue;
    if (Math.abs(x) < 0.02) noseZ = Math.max(noseZ, z);            // 鼻先（中央）
    if (Math.abs(x) > 0.045 && Math.abs(x) < 0.065) cheekZ = Math.max(cheekZ, z);   // 同じ高さの頬
  }
  assert.ok(noseZ - cheekZ > 0.015, `鼻が頬より前へ出る (${((noseZ - cheekZ) * 1000).toFixed(0)}mm)`);
  // 目: 目の高さに暗色（髪と同じ色ID）の頂点が左右対称にある
  const eyesL = [], eyesR = [];
  for (let i = 0; i < M.pos.length / 3; i++) {
    const [x, y, z] = at(i);
    if (M.cid[i] !== 3 || z < 0.05 || Math.abs(y - LM.eye) > 0.02) continue;
    (x < 0 ? eyesL : eyesR).push(i);
  }
  assert.ok(eyesL.length >= 6 && eyesR.length >= 6, `目の頂点が左右にある (L=${eyesL.length} R=${eyesR.length})`);
  assert.equal(eyesL.length, eyesR.length, "左右対称");
  // 耳: 目の高さで頭の幅より外に出る頂点がある
  let earX = 0;
  for (let i = 0; i < M.pos.length / 3; i++) { const [x, y] = at(i); if (Math.abs(y - LM.eye) < 0.03) earX = Math.max(earX, Math.abs(x)); }
  assert.ok(earX > 0.080, `耳が横へ出る (${earX.toFixed(3)})`);
});

test("05 生え際: 額は肌・後頭部と側頭は髪（のっぺり球でない）", () => {
  const LM = C.LM;
  const colorAt = (y, zSign, xAbs) => {
    let best = null, bd = Infinity;
    for (let i = 0; i < M.pos.length / 3; i++) {
      const x = M.pos[i * 3], yy = M.pos[i * 3 + 1], z = M.pos[i * 3 + 2];
      if (yy < LM.chin) continue;
      const d = Math.abs(yy - y) * 3 + Math.abs(Math.abs(x) - xAbs) + Math.abs(Math.sign(z) - zSign) * 0.1 + Math.abs(z) * 0.01;
      if (d < bd) { bd = d; best = i; }
    }
    return M.cid[best];
  };
  assert.equal(colorAt(LM.brow + 0.008, 1, 0.01), 2, "眉のすぐ上（額）は肌");
  assert.equal(colorAt(LM.hairline + 0.015, 1, 0.01), 3, "生え際より上は髪");
  assert.equal(colorAt(LM.eye, -1, 0.01), 3, "後頭部は目の高さでも髪");
  // 頭部が首から離れていない（胴チューブの上端キャップが頭の内側にある）
  // 胴チューブの上端キャップ（軸上の極）より下まで頭部が伸びている＝キャップは頭に包まれ、顎下に隙間ができない
  let capY = -Infinity, headMinY = Infinity;
  for (let i = 0; i < M.pos.length / 3; i++) {
    const x = M.pos[i * 3], y = M.pos[i * 3 + 1], z = M.pos[i * 3 + 2];
    const hasHead = (M.bidx[i * 4] === C.BONE.head && M.bw[i * 4] > 0) || (M.bidx[i * 4 + 1] === C.BONE.head && M.bw[i * 4 + 1] > 0);
    if (!hasHead) continue;
    if (Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6 && y > LM.neck && y < LM.chin) capY = Math.max(capY, y);
    headMinY = Math.min(headMinY, y);
  }
  assert.ok(capY > -Infinity, "胴チューブの上端キャップがある");
  assert.ok(headMinY < capY, `頭部がキャップより下まで包む (頭下端 ${headMinY.toFixed(4)} < キャップ ${capY.toFixed(4)})`);
});

test("07 体型: 既定は同一の形・プリセットは寸法が変わるが破綻しない", () => {
  const std = C.buildArchetype("standard");
  assert.equal(std.mesh, C.BODY_MESH, "標準は既定のメッシュそのもの（本体の形は不変）");
  assert.equal(std.skel, C.SKEL);
  const seen = [];
  for (const key of Object.keys(C.ARCHETYPES)) {
    const a = C.buildArchetype(key);
    const m2 = a.mesh, n = m2.pos.length / 3;
    assert.equal(m2.idx.length, C.BODY_MESH.idx.length, `${key} 三角形数は同じ`);
    let lo = Infinity, hi = -Infinity, sh = 0;
    for (let i = 0; i < n; i++) {
      const y = m2.pos[i * 3 + 1];
      assert.ok(Number.isFinite(y) && Number.isFinite(m2.pos[i * 3]) && Number.isFinite(m2.pos[i * 3 + 2]), `${key} 座標が有限`);
      const nl = Math.hypot(m2.nor[i * 3], m2.nor[i * 3 + 1], m2.nor[i * 3 + 2]);
      assert.ok(Math.abs(nl - 1) < 1e-3, `${key} 法線が単位長`);
      lo = Math.min(lo, y); hi = Math.max(hi, y);
      if (y > 1.40 * a.spec.h && y < 1.58 * a.spec.h) sh = Math.max(sh, Math.abs(m2.pos[i * 3]));
    }
    assert.ok(Math.abs(lo) < 0.002, `${key} 足裏が地面 (${lo.toFixed(4)})`);
    assert.ok(Math.abs(hi - C.H * a.spec.h) < 0.004, `${key} 身長が倍率どおり (${hi.toFixed(3)})`);
    seen.push([key, hi, sh]);
    // 骨格も同じ倍率で動く＝ポーズが破綻しない
    const b = C.poseSkin(C.gaitPose(1.0, 1.4, { scale: a.spec.h }), a.skel);
    assert.equal(b.length, a.skel.length * 16);
    for (const v of b) assert.ok(Number.isFinite(v), `${key} スキン行列が有限`);
  }
  // プリセットどうしが実際に違う（身長 or 肩幅）
  for (let i = 1; i < seen.length; i++)
    assert.ok(Math.abs(seen[i][1] - seen[0][1]) > 0.005 || Math.abs(seen[i][2] - seen[0][2]) > 0.005, `${seen[i][0]} は標準と違う`);
  // 決定論（同じキーで同じ形）
  const a1 = C.buildArchetype("heavy"), a2 = C.buildArchetype("heavy");
  assert.deepEqual(Array.from(a1.mesh.pos), Array.from(a2.mesh.pos));
});

test("07 断面: 胴が楕円でなく背中側が平たい（樽に見えない）", () => {
  const m2 = C.BODY_MESH, LM = C.LM;
  // 胸の高さで、前後の最大半径と左右の最大半径を比べる（人体は左右に広く前後に薄い）
  let fx = 0, fzF = 0, fzB = 0;
  for (let i = 0; i < m2.pos.length / 3; i++) {
    const [x, y, z] = [m2.pos[i * 3], m2.pos[i * 3 + 1], m2.pos[i * 3 + 2]];
    if (Math.abs(y - LM.thorax) > 0.01 || M.bidx[i * 4] > C.BONE.head) continue;
    fx = Math.max(fx, Math.abs(x)); fzF = Math.max(fzF, z); fzB = Math.min(fzB, z);
  }
  assert.ok((fx * 2) / (fzF - fzB) > 1.25, `胸は左右に広い (幅/厚み=${((fx * 2) / (fzF - fzB)).toFixed(2)})`);
  assert.ok(fzF > -fzB * 0.9, `前が厚く背中は平たい (前${fzF.toFixed(3)} 後${fzB.toFixed(3)})`);
});

// 立位で腕が胴に貼り付いていると「気をつけ」に見える。脇の下は埋まったまま、
// 肋骨の下端から下は左右に空間が開いていること（＝上肢のシルエットが胴から分離する）。
test("肌: 顔/腕/手/腿が同じ素肌 ID・膝下だけソックス", () => {
  const M = C.BODY_MESH, B = C.BONE, LM = C.LM, NV = M.pos.length / 3;
  const dom = (i) => (M.bw[i * 4 + 1] > M.bw[i * 4] ? M.bidx[i * 4 + 1] : M.bidx[i * 4]);
  const cids = (pred) => { const s = new Set(); for (let i = 0; i < NV; i++) if (pred(i)) s.add(M.cid[i]); return s; };
  const thigh = cids((i) => dom(i) === B.thighR && M.pos[i * 3 + 1] < LM.hip - 0.17 && M.pos[i * 3 + 1] > LM.knee);
  assert.deepEqual([...thigh], [2], `腿は素肌 ${[...thigh]}`);
  const hand = cids((i) => [B.indexR, B.fingersR, B.thumbR].includes(dom(i)));
  assert.deepEqual([...hand], [2], `手は素肌 ${[...hand]}`);
  const sock = cids((i) => dom(i) === B.shinR && M.pos[i * 3 + 1] < LM.knee - 0.12);
  assert.deepEqual([...sock], [4], `膝下はソックス ${[...sock]}`);
});

// poseSkin は「与えられていないキーは効かない」ことで後方互換を保つ。骨盤の並進・回旋・
// 鎖骨・足首・つま先・指は、それぞれ単独で与えても組み合わせても同じ結果になる必要がある。

test("character.gaitPose: キックの出入りでポーズが連続に混ざる（跳ねない）", () => {
  let prev = null;
  for (let kick = 0; kick <= 1.0001; kick += 0.02) {
    const p = C.gaitPose(1.2, 3.0, { kick: Math.min(kick, 1), kickLeg: 1 });
    for (const k of Object.keys(p)) assert.ok(Number.isFinite(p[k]), `kick=${kick} ${k}`);
    if (prev) {
      const jump = Math.max(...Object.keys(p).map((k) => Math.abs(p[k] - prev[k])));
      assert.ok(jump < 0.35, `kick=${kick.toFixed(2)} で跳ぶ ${jump.toFixed(3)}`);
    }
    prev = p;
  }
});
