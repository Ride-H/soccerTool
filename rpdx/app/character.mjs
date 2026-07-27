/* =========================================================================
   RPDX.character — 選手キャラの共有中核モジュール（単一の真実源・依存ゼロ・GL/DOM 非依存）
   骨格 / 手続きメッシュ生成(接触AO込み) / スキニング / ポーズ / 2ボーン解析IK / 歩容 /
   材質シェーダ(GLSL文字列)。レンダラ(render3d.mjs)はこのモジュールを参照し重複定義しない。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, u) => a + (b - a) * u;

  // 自己完結の数学（render3d.mjs の M4 サブセットと bit 同一）
  const M4 = {
    ident: () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
      }
      return o;
    },
    persp(fov, asp, near, far) {
      const f = 1 / Math.tan(fov / 2), o = new Float32Array(16);
      o[0] = f / asp; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1;
      o[14] = (2 * far * near) / (near - far);
      return o;
    },
    ortho(l, r, b, t, near, far) {   // #157 シャドウマップ用の平行投影（-1..1 クリップ）
      const o = new Float32Array(16);
      o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (far - near); o[15] = 1;
      o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(far + near) / (far - near);
      return o;
    },
    lookAt(eye, at, up) {
      let zx = eye[0]-at[0], zy = eye[1]-at[1], zz = eye[2]-at[2];
      let zl = Math.hypot(zx, zy, zz) || 1; zx/=zl; zy/=zl; zz/=zl;
      let xx = up[1]*zz - up[2]*zy, xy = up[2]*zx - up[0]*zz, xz = up[0]*zy - up[1]*zx;
      let xl = Math.hypot(xx, xy, xz) || 1; xx/=xl; xy/=xl; xz/=xl;
      const yx = zy*xz - zz*xy, yy = zz*xx - zx*xz, yz = zx*xy - zy*xx;
      return new Float32Array([
        xx, yx, zx, 0,  xy, yy, zy, 0,  xz, yz, zz, 0,
        -(xx*eye[0]+xy*eye[1]+xz*eye[2]), -(yx*eye[0]+yy*eye[1]+yz*eye[2]), -(zx*eye[0]+zy*eye[1]+zz*eye[2]), 1,
      ]);
    },
    trs(x, y, z, sx, sy, sz, ry = 0) {
      const c = Math.cos(ry), s = Math.sin(ry);
      return new Float32Array([c*sx,0,-s*sx,0, 0,sy,0,0, s*sz,0,c*sz,0, x,y,z,1]);
    },
    rotX(a) {
      const c = Math.cos(a), s = Math.sin(a);
      return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
    },
    roty(a) {
      const c = Math.cos(a), s = Math.sin(a);
      return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
    },
    rotZ(a) {   // 前額面（左右の傾き）。+a で +X が +Y へ回る＝上体の頭側は −X へ倒れる。
      const c = Math.cos(a), s = Math.sin(a);
      return new Float32Array([c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]);
    },
    t(x, y, z) {
      return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);
    },
    scale(sx, sy, sz) {
      return new Float32Array([sx,0,0,0, 0,sy,0,0, 0,0,sz,0, 0,0,0,1]);
    },
    chain(...ms) { let o = ms[0]; for (let i = 1; i < ms.length; i++) o = M4.mul(o, ms[i]); return o; },
  };

  // 決定論ハッシュ（noise.mjs L8-33 から verbatim・自己完結）
  const N = {};
  N.hash = (n) => {
    n = (n ^ 61) ^ (n >>> 16);
    n = (n + (n << 3)) | 0;
    n = n ^ (n >>> 4);
    n = Math.imul(n, 0x27d4eb2d);
    n = n ^ (n >>> 15);
    return (n >>> 0) / 4294967295;
  };
  N.hash2 = (a, b) => N.hash((Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) | 0);
  N.seedOf = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h | 0;
  };

  // ------------------------ キャラ中核（render3d から抽出）------------------------
  // 関節の高さ（ランドマーク）。身長 H に対する標準的な体節比から決める＝**比率を変えるときはここだけを触る**。
  // メッシュのリング位置も骨長も IK もここから導くので、骨格と皮膚がずれない。
  // 旧リグは下腿 −7.3cm・上腕 −6.2cm・肩幅が標準の約1.5倍で、手足が短く肩が広い（人体から外れた）比率だった。
  const H = 1.925;
  const LM = {
    sole: 0, ankle: 0.0751, knee: 0.5486, crotch: 0.9336, hip: 1.0203,
    lumbar: 1.3172, thorax: 1.5152, sternum: 1.5450, shoulder: 1.5346, acromion: 1.5746,
    elbow: 1.2127, wrist: 0.9336, neck: 1.6124, chin: 1.6747, headPivot: 1.70, top: 1.905,
  };
  const L = (a, b, t) => LM[a] + (LM[b] - LM[a]) * t;   // ランドマーク間の内分（メッシュのリング位置に使う）
  const HIP_X = 0.11, ARM_X = 0.20, CLAV_X = 0.03;      // 左右の関節位置（前額面）
  const SKEL = [
    [-1, 0, LM.hip, 0],                 // 0 pelvis
    [0, 0, LM.lumbar, 0],               // 1 spine（腰椎）
    [1, 0, LM.thorax, 0],               // 2 chest（胸椎）
    [2, 0, LM.neck, 0],                 // 3 neck
    [3, 0, LM.headPivot, 0],            // 4 head
    [0, -HIP_X, LM.hip, 0],             // 5 thighL
    [5, -HIP_X, LM.knee, 0],            // 6 shinL
    [6, -HIP_X, LM.ankle, 0],           // 7 footL
    [7, -HIP_X, 0.030, 0.134],          // 8 toeL（前足部＝中足趾節関節）
    [0, HIP_X, LM.hip, 0],              // 9 thighR
    [9, HIP_X, LM.knee, 0],             // 10 shinR
    [10, HIP_X, LM.ankle, 0],           // 11 footR
    [11, HIP_X, 0.030, 0.134],          // 12 toeR
    [2, -CLAV_X, LM.sternum, 0.02],     // 13 clavL（胸鎖関節＝肩甲帯）
    [13, -ARM_X, LM.shoulder, 0],       // 14 upArmL
    [14, -ARM_X, LM.elbow, 0],          // 15 foreArmL
    [2, CLAV_X, LM.sternum, 0.02],      // 16 clavR
    [16, ARM_X, LM.shoulder, 0],        // 17 upArmR
    [17, ARM_X, LM.elbow, 0],           // 18 foreArmR
  ];
  // ボーン名 → 番号（メッシュ生成・テスト・レンダラが番号を直書きしないための表）
  const BONE = { pelvis: 0, spine: 1, chest: 2, neck: 3, head: 4,
    thighL: 5, shinL: 6, footL: 7, toeL: 8, thighR: 9, shinR: 10, footR: 11, toeR: 12,
    clavL: 13, upArmL: 14, foreArmL: 15, clavR: 16, upArmR: 17, foreArmR: 18 };
  // 靴（足ボーン固定の独立した物体）。メッシュ生成と接地計算が同じ値を見るための単一定義。
  // 靴底は y=0 の平面で、踵とつま先の角だけ半径 SOLE_R で丸める（＝接地点の幾何がそのまま解析式になる）。
  // 足長 0.29（標準比 0.152H）・踵は足首の後ろ 0.075・つま先は前 0.215・母趾球（前足部の関節）は前 0.134。
  const SHOE = { heelZ: -0.075, toeZ: 0.215, mtpZ: 0.134, soleR: 0.022, width: 0.056 };
  // 色ID: 0=シャツ / 1=ショーツ / 2=肌 / 3=髪 / 4=脚（肌×ショーツ混合色）/ 5=ブーツ（暗色）
  // #155 造形: 楕円断面（rx=横半径/rz=前後半径）で V字テーパー・胸郭/腹部絞り・平たい背中を表現。
  const buildBodyMesh = () => {
    const K = BONE, B = { pel: K.pelvis, spi: K.spine, che: K.chest, nec: K.neck, hea: K.head,
      thL: K.thighL, shL: K.shinL, foL: K.footL, toL: K.toeL, thR: K.thighR, shR: K.shinR, foR: K.footR, toR: K.toeR,
      clL: K.clavL, uaL: K.upArmL, faL: K.foreArmL, clR: K.clavR, uaR: K.upArmR, faR: K.foreArmR };
    const pos = [], nor = [], bidx = [], bw = [], cid = [], ao = [], idx = [];
    // #157 頂点ベイクAO: ring.ao（既定1.0・小さいほど暗い）を接触遮蔽域（腋/股/顎下/内側）に置く。
    // 縦軸チューブ: ring={x?,y,z?,rx,rz(またはr),c,ao?,b:[骨,重み,骨2?,重み2?]}。関節をまたぐリングの
    // 重みブレンドが「連続して曲がる皮膚」を作る。法線は楕円勾配＋縦半径勾配の解析式（円の場合は従来と一致）。
    const tube = (rings, seg, capOff = 0.02) => {
      const start = pos.length / 3;
      const rX = (r) => r.rx ?? r.r, rZ = (r) => r.rz ?? r.r;
      for (let ri = 0; ri < rings.length; ri++) {
        const rg = rings[ri];
        const rx = rX(rg), rz = rZ(rg);
        const prev = rings[Math.max(0, ri - 1)], next = rings[Math.min(rings.length - 1, ri + 1)];
        const dy = (next.y - prev.y) || 1e-4;
        const rxp = (rX(next) - rX(prev)) / dy, rzp = (rZ(next) - rZ(prev)) / dy;   // dr/dy
        for (let si = 0; si < seg; si++) {
          const th = (si / seg) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
          pos.push((rg.x || 0) + cs * rx, rg.y, (rg.z || 0) + sn * rz);
          // 外向き法線 ∝ (rz·cosθ, -(rx·rz'·sin²θ + rz·rx'·cos²θ), rx·sinθ)
          let nx = rz * cs, ny = -(rx * rzp * sn * sn + rz * rxp * cs * cs), nz = rx * sn;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nor.push(nx / nl, ny / nl, nz / nl);
          bidx.push(rg.b[0], rg.b[2] ?? 0, 0, 0);
          bw.push(rg.b[1], rg.b[3] ?? 0, 0, 0);
          cid.push(rg.c); ao.push(rg.ao ?? 1);
        }
        if (ri > 0) {
          const a0 = start + (ri - 1) * seg, b0 = start + ri * seg;
          for (let si = 0; si < seg; si++) {
            const s1 = (si + 1) % seg;
            idx.push(a0 + si, b0 + si, a0 + s1, a0 + s1, b0 + si, b0 + s1);
          }
        }
      }
      const cap = (ri, up) => {   // 端の極頂点ファン
        const rg = rings[ri];
        const ci = pos.length / 3;
        pos.push((rg.x || 0), rg.y + (up ? capOff : -capOff), (rg.z || 0));
        nor.push(0, up ? 1 : -1, 0);
        bidx.push(rg.b[0], rg.b[2] ?? 0, 0, 0);
        bw.push(rg.b[1], rg.b[3] ?? 0, 0, 0);
        cid.push(rg.c); ao.push(rg.ao ?? 1);
        const r0 = start + ri * seg;
        for (let si = 0; si < seg; si++) {
          const s1 = (si + 1) % seg;
          if (up) idx.push(r0 + si, ci, r0 + s1);
          else idx.push(r0 + si, r0 + s1, ci);
        }
      };
      // リングは昇順・降順どちらでも書けるので、端のふさぎ方は並び順から決める
      // （降順のまま上下を決め打ちすると、キャップの極がチューブの内側に入って裏返る）。
      const asc = rings[rings.length - 1].y >= rings[0].y;
      cap(rings.length - 1, asc);
      cap(0, !asc);
    };
    // 単骨に固定する楕円体（ミトン手・ブーツ）: 腕/足が筒で終わらないための塊。
    // split={z0,z1,bone} を渡すと、前後方向の位置で第2ボーンへ重みを配る（ブーツのつま先＝前足部の関節）。
    const blob = (cx, cy, cz, rx, ry, rz, bone, color, latSeg, lonSeg, aoV, split) => {
      const start = pos.length / 3;
      for (let la = 0; la <= latSeg; la++) {
        const phi = (la / latSeg) * Math.PI - Math.PI / 2, cphi = Math.cos(phi), sphi = Math.sin(phi);
        for (let lo = 0; lo < lonSeg; lo++) {
          const th = (lo / lonSeg) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
          const z = cz + rz * cphi * sn;
          pos.push(cx + rx * cphi * cs, cy + ry * sphi, z);
          let nx = (cphi * cs) / rx, ny = sphi / ry, nz = (cphi * sn) / rz;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nor.push(nx / nl, ny / nl, nz / nl);
          const u = split ? clamp((z - split.z0) / (split.z1 - split.z0), 0, 1) : 0;
          const w2 = u * u * (3 - 2 * u);
          bidx.push(bone, split ? split.bone : 0, 0, 0); bw.push(1 - w2, w2, 0, 0); cid.push(color); ao.push(aoV ?? 1);
        }
      }
      for (let la = 0; la < latSeg; la++) for (let lo = 0; lo < lonSeg; lo++) {
        const a = start + la * lonSeg + lo, b = start + la * lonSeg + ((lo + 1) % lonSeg);
        const c = start + (la + 1) * lonSeg + lo, d = start + (la + 1) * lonSeg + ((lo + 1) % lonSeg);
        idx.push(a, c, b, b, c, d);
      }
    };
    // 前後方向に断面を並べるロフト（靴のように「長さ方向」がある物体用）。断面は超楕円
    // （n=3＝底が平らで側面が立つ）。ring={z, bottom, top, w, c, ao?, b:[..], split?}。
    // 法線は生成した点から差分の外積で求める（どんな断面形でも破綻しない）。
    const loftZ = (x0, rings, seg, capOff) => {
      const start = pos.length / 3, n = 3, e = 2 / n;
      const pw = (v, k) => Math.sign(v) * Math.pow(Math.abs(v), k);
      const P = [];
      for (const rg of rings) {
        const cy = (rg.bottom + rg.top) / 2, ry = (rg.top - rg.bottom) / 2, row = [];
        for (let si = 0; si < seg; si++) {
          const th = (si / seg) * Math.PI * 2;
          row.push([x0 + rg.w * pw(Math.cos(th), e), cy + ry * pw(Math.sin(th), e), rg.z]);
        }
        P.push(row);
      }
      const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      for (let ri = 0; ri < rings.length; ri++) {
        const rg = rings[ri], cy = (rg.bottom + rg.top) / 2;
        for (let si = 0; si < seg; si++) {
          const p0 = P[ri][si];
          const tTh = sub(P[ri][(si + 1) % seg], P[ri][(si - 1 + seg) % seg]);
          const tZ = sub(P[Math.min(rings.length - 1, ri + 1)][si], P[Math.max(0, ri - 1)][si]);
          let nv = cross(tZ, tTh);
          const out = [p0[0] - x0, p0[1] - cy, 0];
          if (nv[0] * out[0] + nv[1] * out[1] < 0) nv = [-nv[0], -nv[1], -nv[2]];
          const nl = Math.hypot(nv[0], nv[1], nv[2]) || 1;
          pos.push(p0[0], p0[1], p0[2]); nor.push(nv[0] / nl, nv[1] / nl, nv[2] / nl);
          const u = rg.split ? clamp((rg.z - rg.split.z0) / (rg.split.z1 - rg.split.z0), 0, 1) : 0;
          const w2 = u * u * (3 - 2 * u);
          bidx.push(rg.b[0], rg.split ? rg.split.bone : 0, 0, 0); bw.push(1 - w2, w2, 0, 0);
          cid.push(rg.c); ao.push(rg.ao ?? 1);
          if (ri > 0) {
            const a0 = start + (ri - 1) * seg, b0 = start + ri * seg, s1 = (si + 1) % seg;
            idx.push(a0 + si, a0 + s1, b0 + si, b0 + s1, b0 + si, a0 + s1);
          }
        }
      }
      const cap = (ri, front) => {   // 踵/つま先の端をふさぐ極頂点ファン
        const rg = rings[ri], ci = pos.length / 3;
        pos.push(x0, (rg.bottom + rg.top) / 2, rg.z + (front ? capOff : -capOff));
        nor.push(0, 0, front ? 1 : -1);
        const u = rg.split ? clamp((rg.z - rg.split.z0) / (rg.split.z1 - rg.split.z0), 0, 1) : 0;
        const w2 = u * u * (3 - 2 * u);
        bidx.push(rg.b[0], rg.split ? rg.split.bone : 0, 0, 0); bw.push(1 - w2, w2, 0, 0);
        cid.push(rg.c); ao.push(rg.ao ?? 1);
        const r0 = start + ri * seg;
        for (let si = 0; si < seg; si++) {
          const s1 = (si + 1) % seg;
          if (front) idx.push(r0 + si, r0 + s1, ci); else idx.push(r0 + s1, r0 + si, ci);
        }
      };
      cap(rings.length - 1, true); cap(0, false);
    };
    // 胴〜首〜頭（1本のレイズ）: V字テーパー（肩幅>腰幅）＋胸郭の膨らみ＋腹部の絞り＋
    // 僧帽筋スロープ（肩ヨーク→首の急勾配＝首肩の連続）＋顎/面のある頭部。
    tube([
      { y: LM.crotch, rx: 0.150, rz: 0.130, c: 1, ao: 0.58, b: [B.pel, 1] },    // 股下＝強い接触AO
      { y: LM.hip, rx: 0.165, rz: 0.140, c: 1, ao: 0.72, b: [B.pel, 1] },       // 骨盤/鼠径（＝股関節の高さ）
      { y: L("hip", "lumbar", 0.40), rx: 0.150, rz: 0.118, c: 1, ao: 0.90, b: [B.pel, 0.75, B.spi, 0.25] }, // 腰＝絞り
      { y: L("hip", "lumbar", 0.667), rx: 0.156, rz: 0.122, c: 0, b: [B.pel, 0.35, B.spi, 0.65] },
      { y: L("lumbar", "thorax", 0.10), rx: 0.176, rz: 0.134, c: 0, b: [B.spi, 0.8, B.che, 0.2] },
      { y: L("lumbar", "thorax", 0.60), rx: 0.196, rz: 0.142, c: 0, b: [B.spi, 0.3, B.che, 0.7] }, // 胸郭
      { y: LM.thorax, rx: 0.204, rz: 0.140, c: 0, b: [B.che, 1] },
      { y: LM.acromion, rx: 0.214, rz: 0.126, c: 0, b: [B.che, 1] },            // 肩ヨーク＝肩峰の高さ
      { y: L("acromion", "neck", 0.5), rx: 0.166, rz: 0.108, c: 0, ao: 0.9, b: [B.che, 0.7, B.nec, 0.3] }, // 僧帽筋スロープ→首
      { y: LM.neck, rx: 0.072, rz: 0.074, c: 2, ao: 0.7, b: [B.nec, 1] },       // 首（顎下の接触AO）
      { y: L("neck", "chin", 0.36), rx: 0.064, rz: 0.070, c: 2, ao: 0.78, b: [B.nec, 0.4, B.hea, 0.6] },
      { y: LM.chin, rx: 0.082, rz: 0.094, c: 2, ao: 0.92, b: [B.hea, 1] },      // 顎（前後に深い）
      { y: 1.73, rx: 0.104, rz: 0.112, c: 2, b: [B.hea, 1] },                   // 顔（額〜頬）
      { y: 1.79, rx: 0.110, rz: 0.118, c: 3, b: [B.hea, 1] },                   // 後頭部の張り（髪）
      { y: 1.86, rx: 0.082, rz: 0.088, c: 3, b: [B.hea, 1] },
      { y: LM.top, rx: 0.034, rz: 0.036, c: 3, b: [B.hea, 1] },
    ], 14);
    // 脚（腿の質量→膝→ふくらはぎ→足首の絞り・紡錘）。ふくらはぎは前後に厚い（rz>rx）。
    const leg = (s, th, sh, ft, to) => {
      tube([
        { x: s * HIP_X, y: L("hip", "knee", -0.126), rx: 0.098, rz: 0.100, c: 4, ao: 0.68, b: [th, 1] }, // 腿付け根＝鼠径の接触AO
        { x: s * HIP_X, y: L("hip", "knee", 0.110), rx: 0.106, rz: 0.110, c: 4, ao: 0.9, b: [th, 1] },   // 大腿の質量
        { x: s * HIP_X, y: L("hip", "knee", 0.571), rx: 0.093, rz: 0.096, c: 4, b: [th, 1] },
        { x: s * HIP_X, y: L("hip", "knee", 0.871), rx: 0.085, rz: 0.088, c: 4, b: [th, 0.65, sh, 0.35] },
        { x: s * HIP_X, y: LM.knee, rx: 0.082, rz: 0.086, c: 4, b: [th, 0.3, sh, 0.7] },
        { x: s * HIP_X, y: L("knee", "ankle", 0.20), rx: 0.076, rz: 0.088, c: 4, b: [sh, 0.92, th, 0.08] }, // ふくらはぎ
        { x: s * HIP_X, y: L("knee", "ankle", 0.50), rx: 0.064, rz: 0.070, c: 4, b: [sh, 1] },
        { x: s * HIP_X, y: L("knee", "ankle", 0.82), rx: 0.052, rz: 0.056, c: 4, b: [sh, 0.7, ft, 0.3] },   // 足首の絞り
        // 最下リングは足首の高さまで下ろしてブーツ楕円体の内側に入れる（脚と足が途切れて見えないように）。
        // 関節をまたぐ連続した皮膚そのものは 12 で作る。
        { x: s * HIP_X, y: LM.ankle, rx: 0.045, rz: 0.049, c: 4, b: [ft, 1] },
      ], 10);
      // 靴（踵・甲・つま先・平らな靴底を持つ独立した物体）。前寄りの断面は前足部ボーンへ重みを移す
      // ので、母趾球で曲がる（踏切で前足部が接地したまま踵が上がる）。靴底の角の丸みは接地計算と共有。
      const sp = { z0: SHOE.mtpZ - 0.045, z1: SHOE.mtpZ + 0.045, bone: to };
      const solY = (z) => {   // 靴底の高さ: 中央は平ら、踵/つま先の角だけ丸める
        const a = SHOE.heelZ + SHOE.soleR, b = SHOE.toeZ - SHOE.soleR;
        const d = z < a ? a - z : z > b ? z - b : 0;
        return SHOE.soleR - Math.sqrt(Math.max(SHOE.soleR * SHOE.soleR - d * d, 0));
      };
      const shoe = [
        [SHOE.heelZ, 0.086, 0.030, 0.86], [SHOE.heelZ + 0.022, 0.100, 0.042, 0.92],
        [-0.020, 0.110, 0.050, 1], [0.030, 0.112, 0.055, 1], [0.080, 0.100, 0.056, 1],
        [SHOE.mtpZ, 0.082, 0.054, 1], [0.178, 0.060, 0.045, 1], [0.202, 0.046, 0.032, 1],
        [SHOE.toeZ, 0.038, 0.014, 0.9],
      ].map(([z, top, w, aoV]) => ({ z, bottom: solY(z), top, w, c: 5, ao: aoV, b: [ft, 1], split: sp }));
      loftZ(s * HIP_X, shoe, 12, 0.004);   // 12 分割＝真下がサンプル点に入り靴底が厳密に平ら
    };
    leg(-1, B.thL, B.shL, B.foL, B.toL);
    leg(1, B.thR, B.shR, B.foR, B.toR);
    // 腕（肩デルトイド→上腕→肘→前腕→手首の連続チューブ＋ミトン手）。付け根は胸へブレンドし肩ヨークに接続。
    const arm = (s, cl, ua, fa) => {
      tube([
        // 肩: 胴の肩ヨーク（rx 0.214）の内側から立ち上がる三角筋のドーム。上端ほど鎖骨に、下へ行くほど
        // 上腕に追従するので、腕を振っても肩の丸みが胴と一緒に動き、段差にならない。上端キャップは 0.005 に
        // 縮めて肩ヨークの内側へ隠す（外に飛び出すと肩の上に小さな瘤として見える）。
        // 頂点は胸に固定（肩の皮膚が胴から浮かない）。下へ行くほど鎖骨→上腕に移すので、腕を上げると
        // 肩の丸みが連動しつつ、付け根は胴に埋まったままになる。
        { x: s * (ARM_X - 0.025), y: LM.acromion - 0.005, rx: 0.055, rz: 0.054, c: 0, ao: 0.95, b: [B.che, 0.75, ua, 0.25] }, // 肩の頂点（中心を内へ寄せて肩ヨークの奥に埋める）
        { x: s * ARM_X, y: LM.sternum, rx: 0.072, rz: 0.070, c: 0, ao: 0.88, b: [cl, 0.5, ua, 0.5] },
        { x: s * ARM_X, y: LM.shoulder - 0.025, rx: 0.075, rz: 0.072, c: 0, ao: 0.82, b: [cl, 0.2, ua, 0.8] },  // 三角筋の膨らみ
        { x: s * ARM_X, y: L("shoulder", "wrist", 0.072), rx: 0.070, rz: 0.068, c: 0, ao: 0.7, b: [ua, 1] },   // 腋の接触AO
        { x: s * ARM_X, y: L("shoulder", "wrist", 0.234), rx: 0.061, rz: 0.060, c: 2, ao: 0.88, b: [ua, 1] },  // 袖→肌
        { x: s * ARM_X, y: L("shoulder", "wrist", 0.432), rx: 0.056, rz: 0.056, c: 2, b: [ua, 0.62, fa, 0.38] },
        { x: s * ARM_X, y: LM.elbow, rx: 0.053, rz: 0.053, c: 2, b: [ua, 0.3, fa, 0.7] },
        { x: s * ARM_X, y: L("shoulder", "wrist", 0.721), rx: 0.050, rz: 0.050, c: 2, b: [fa, 1] },
        { x: s * ARM_X, y: L("shoulder", "wrist", 0.919), rx: 0.044, rz: 0.045, c: 2, b: [fa, 1] },
        { x: s * ARM_X, y: LM.wrist, rx: 0.038, rz: 0.040, c: 2, b: [fa, 1] },           // 手首
      ], 8, 0.005);
      // ミトン手（指なしの手のひら塊・前腕ボーン追従・腕が筒で終わらない）
      blob(s * ARM_X, LM.wrist - 0.050, 0.010, 0.050, 0.072, 0.062, fa, 2, 4, 6, 0.9);
    };
    arm(-1, B.clL, B.uaL, B.faL);
    arm(1, B.clR, B.uaR, B.faR);
    return {
      pos: new Float32Array(pos), nor: new Float32Array(nor),
      bidx: new Float32Array(bidx), bw: new Float32Array(bw), cid: new Float32Array(cid),
      ao: new Float32Array(ao), idx: new Uint16Array(idx), boneCount: SKEL.length, tri: idx.length / 3,
    };
  };
  const BODY_MESH = buildBodyMesh();
  // 関節の可動域（rad・人体の範囲を目安に設定）。**オーサリング（スライダ・クリップ）が必ずこの表を通る**ので、
  // 構造的に非人体的なポーズを作れない。左右のある関節は基準名で 1 つだけ持ち、末尾 L/R を落として引く。
  // 並進（swayX/Y/Z）は関節ではないので持たない。符号の規約: 股/肩の屈曲は負が前、膝/肘は正が屈曲、
  // 足首は正がつま先下げ、外転・内外旋・鎖骨の挙上は解剖学的な向きが正（左右の符号は poseSkin が吸収）。
  const ROM = {
    lean: [-0.40, 1.50], twist: [-0.90, 0.90], sideLean: [-0.45, 0.45], pelvisYaw: [-0.60, 0.60],
    lookYaw: [-1.40, 1.40], lookPitch: [-0.60, 0.60],
    hip: [-2.10, 0.50], hipAbd: [-0.35, 0.80], hipRot: [-0.70, 0.70],
    knee: [0, 2.40], ankle: [-0.45, 0.70], ankleTilt: [-0.35, 0.35], toe: [-1.20, 0.50],
    sw: [-3.00, 1.00], el: [0, 2.60], armAbd: [-0.60, 2.90], armRot: [-1.50, 1.50],
    clav: [-0.10, 0.15], clavFwd: [-0.25, 0.35],
  };
  const romOf = (key) => ROM[key] || ROM[key.replace(/[LR]$/, "")] || null;
  const clampPose = (p) => {
    const o = {};
    for (const k in p) { const r = romOf(k); o[k] = r && typeof p[k] === "number" ? clamp(p[k], r[0], r[1]) : p[k]; }
    return o;
  };
  // ポーズ（関節角の集合）→ ボーンパレット（19×mat4・スキン行列 = G × T(-head)）
  // 四肢の関節の合成順序（共通規約）: rotY(長軸の内外旋) · rotZ(前額面の外転) · rotX(矢状面の屈曲)。
  // 屈曲を最も内側に置くので、外転/内外旋が 0 のときは従来どおり rotX 単体と厳密に一致する（後方互換）。
  // 左右で符号が反転する量（外転・内外旋・鎖骨の挙上・足首の内外反）は**解剖学的な向きを正**とし、
  // ここで side（左=-1 / 右=+1）を掛ける。オーサリング側は左右を意識せず同じ符号で書ける。
  const limbRot = (side, flex, abd, axial) => {
    let m = M4.rotX(flex);
    if (abd) m = M4.mul(M4.rotZ(side * abd), m);
    if (axial) m = M4.mul(M4.roty(-side * axial), m);
    return m;
  };
  const poseSkin = (p) => {
    const lookY = p.lookYaw || 0, lookP = p.lookPitch || 0;   // #156 注視（首0.6+頭0.4=合計1.0で分配）
    const sway = (p.swayX || p.swayY || p.swayZ)              // #156 重心スウェイ（骨盤の並進・下流が追従）
      ? M4.t(p.swayX || 0, p.swayY || 0, p.swayZ || 0) : null;
    // 骨盤回旋（水平面）: 骨盤メッシュだけを回し、脚には逆回転で打ち消して伝播させない。
    // 脚が世界の矢状面に留まるので、股関節が動いても接地足が横滑りしない（フットIKは矢状2Dのまま）。
    const pyaw = p.pelvisYaw || 0;
    const pelvis = pyaw ? (sway ? M4.mul(sway, M4.roty(pyaw)) : M4.roty(pyaw)) : sway;
    const legRot = (s, flex, abd, axial) => {
      const m = limbRot(s, flex, abd, axial);
      return pyaw ? M4.mul(M4.roty(-pyaw), m) : m;
    };
    // 前額面の傾き（体重を支持脚へ預ける上体の倒れ・+=右(+X)へ倒れる）。脚より上だけに効く。
    const side = p.sideLean || 0;
    const spine = M4.mul(M4.rotX(p.lean * 0.5), M4.roty(p.twist * 0.45));
    const chest = M4.mul(M4.rotX(p.lean * 0.5), M4.roty(p.twist * 0.55));
    const neck = M4.mul(M4.roty(-p.twist * 0.6 + lookY * 0.6), M4.rotX(lookP * 0.4));
    // 鎖骨（肩甲帯）: 挙上（肩をすくめる/腕を上げると肩が上がる）と前方への出（protraction）。
    const clav = (s) => {
      const up = p["clav" + (s < 0 ? "L" : "R")] || 0, fwd = p["clavFwd" + (s < 0 ? "L" : "R")] || 0;
      if (!up && !fwd) return null;
      return fwd ? M4.mul(M4.rotZ(s * up), M4.roty(-s * fwd)) : M4.rotZ(s * up);
    };
    const foot = (s) => {
      const k = s < 0 ? "L" : "R", pitch = p["ankle" + k] || 0, tilt = p["ankleTilt" + k] || 0;
      return pitch || tilt ? limbRot(s, pitch, tilt, 0) : null;   // 接地ロール＋内外反
    };
    const toe = (s) => { const a = p["toe" + (s < 0 ? "L" : "R")] || 0; return a ? M4.rotX(a) : null; };
    const rot = [
      pelvis,                                                   // 0 pelvis: 重心スウェイ＋回旋（無指定=従来通り恒等）
      side ? M4.mul(spine, M4.rotZ(-side * 0.45)) : spine,      // 1 spine（腰椎）
      side ? M4.mul(chest, M4.rotZ(-side * 0.55)) : chest,      // 2 chest（胸椎・累積=lean/twist/傾き）
      side ? M4.mul(neck, M4.rotZ(side * 0.6)) : neck,          // 3 neck: 首ひねり/傾きの打消し＋注視
      M4.mul(M4.roty(lookY * 0.4), M4.rotX(lookP * 0.6)),       // 4 head: 注視（無指定=恒等）
      legRot(-1, p.hipL, p.hipAbdL || 0, p.hipRotL || 0), M4.rotX(p.kneeL), foot(-1), toe(-1),   // 5-8 左脚
      legRot(1, p.hipR, p.hipAbdR || 0, p.hipRotR || 0), M4.rotX(p.kneeR), foot(1), toe(1),      // 9-12 右脚
      clav(-1), limbRot(-1, p.swL, p.armAbdL || 0, p.armRotL || 0), M4.rotX(-p.elL),             // 13-15 左腕
      clav(1), limbRot(1, p.swR, p.armAbdR || 0, p.armRotR || 0), M4.rotX(-p.elR),               // 16-18 右腕
    ];
    const G = new Array(SKEL.length);
    const out = new Float32Array(SKEL.length * 16);
    for (let i = 0; i < SKEL.length; i++) {
      const [par, hx, hy, hz] = SKEL[i];
      const px = par < 0 ? 0 : SKEL[par][1], py = par < 0 ? 0 : SKEL[par][2], pz = par < 0 ? 0 : SKEL[par][3];
      const local = rot[i] ? M4.mul(M4.t(hx - px, hy - py, hz - pz), rot[i]) : M4.t(hx - px, hy - py, hz - pz);
      G[i] = par < 0 ? local : M4.mul(G[par], local);
      out.set(M4.mul(G[i], M4.t(-hx, -hy, -hz)), i * 16);
    }
    return out;
  };
  // #155 選手ごとの決定論的な体格差（身長・横幅の小幅スケール・キー由来）— 全員同一体型の回避。
  // 足接地は base 原点(y=0)スケールで保存・番号も同スケールに乗る。
  const bodyVarOf = (key) => ({
    h: 0.955 + N.hash2(N.seedOf(key + "|h"), 17) * 0.095,   // 身長 0.955..1.05
    w: 0.945 + N.hash2(N.seedOf(key + "|w"), 41) * 0.11,    // 横幅 0.945..1.055
  });
  // #156 2ボーン解析フットIK（矢状面・Y上/Z前）: 股(hipY,hipZ)から足首を(tY,tZ)へ届かせる
  // 股・膝の rotX を返す（poseSkin の既存 rotX 規約と一致）。膝は前方（ポールベクトル）。
  // 骨長は SKEL 由来（ランドマーク table LM から算出）。
  const IK_L1 = LM.hip - LM.knee, IK_L2 = LM.knee - LM.ankle;   // 骨長はランドマーク由来（比率を変えれば IK も追従）
  const solveLegIK = (hipY, hipZ, tY, tZ) => {
    let vf = tZ - hipZ, vu = tY - hipY;             // fwd(+Z), up(+Y)
    let d = Math.hypot(vf, vu);
    if (d < 1e-4) { vf = 0; vu = -1; d = 1e-4; }
    const dmin = Math.abs(IK_L1 - IK_L2) + 0.02, dmax = IK_L1 + IK_L2 - 0.005;
    const dc = clamp(d, dmin, dmax);
    const uf = vf / d, uu = vu / d;                 // 目標方向（単位）
    // 膝屈曲（rotX 正 = 屈曲・既存規約）: d²=L1²+L2²+2L1L2cos(θk)
    const ck = clamp((dc * dc - IK_L1 * IK_L1 - IK_L2 * IK_L2) / (2 * IK_L1 * IK_L2), -1, 1);
    const knee = Math.acos(ck);
    // 股: 目標方向の rotX 角 −（三角形の股角 α）。直下(0,-1)基準で rotX(θ)→dir(fwd,up)=(-sinθ,-cosθ)。
    const thetaDir = Math.atan2(-uf, -uu);
    const ca = clamp((IK_L1 * IK_L1 + dc * dc - IK_L2 * IK_L2) / (2 * IK_L1 * dc), -1, 1);
    const alpha = Math.acos(ca);
    return { hip: thetaDir - alpha, knee, reach: d > dmax };
  };
  // フットIK の前方運動学（テスト用・poseSkin と同じ (fwd,up) 規約）
  const legFK = (hipY, hipZ, hip, knee) => {
    const kZ = hipZ - IK_L1 * Math.sin(hip), kY = hipY - IK_L1 * Math.cos(hip);
    return { z: kZ - IK_L2 * Math.sin(hip + knee), y: kY - IK_L2 * Math.cos(hip + knee) };
  };
  // #156 歩容の足配置（純関数・スケーティング解消の核）: 位相と速度から足の局所前後(fz)/高さ(fy)。
  // 位相は PHASE_RATE で進む前提。接地相 c∈[0,π) は fz が速度整合で後退＝bodyZ 前進を打ち消し
  // ワールド固定（支持脚が滑らない）。遊脚 c∈[π,2π) は後→前へ持ち上げて次の接地へ。
  // ストライド上限 0.42 は脚の可達域（足首を接地高で届く水平距離）に合わせ IK のクランプ揺れを防ぐ。
  // 【正直な限界】歩行では足首travel＝body travel で厳密固定。サッカー走行速度では上限に達し
  // body が足を追い越すため残存スリップが出る（脚長×自然なケイデンスの物理限界・実時間ゲーム共通）。
  const STRIDE_MAX = (IK_L1 + IK_L2) * 0.477;   // 脚長に対する上限（可達域＝IK のクランプ揺れを防ぐ経験値）
  const PHASE_RATE = (v) => 4.2 + 0.85 * v;
  // 片脚の歩容位相 c∈[0,2π)（0=踵接地・π=踏切）。左右は半周期ずれる。
  const cycleOf = (phase, side) => (((phase + (side < 0 ? Math.PI : 0)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const footPlace = (phase, v, side) => {
    const stride = clamp(v * Math.PI / PHASE_RATE(v), 0, STRIDE_MAX);
    const c = cycleOf(phase, side);
    if (c < Math.PI) return { fz: stride * 0.5 - stride * (c / Math.PI), fy: 0, stance: true, stride };
    const t = (c - Math.PI) / Math.PI, e = t * t * (3 - 2 * t);
    return { fz: -stride * 0.5 + stride * e, fy: Math.sin(t * Math.PI) * (0.045 + 0.10 * clamp(v / 6, 0, 1)), stance: false, stride };
  };

  // 腕2ボーン解析IK（脚 solveLegIK と同型＝共有コア昇格・矢状面 Y上/Z前・rest は下垂・rotX・ポールベクトル）。
  // 肩(shY,shZ)から手首を(tY,tZ)へ届かせる。poseSkin の腕は upArm=rotX(sw)・foreArm=rotX(-el) の累積なので、
  // 内部で解いた {肩角, 肘屈曲} を {sw, el}=(肩角, -fold·肘屈曲) に写して返す（rotX(sw)·rotX(-el)=rotX(sw-el)＝脚の
  // hip/knee 累積と同型）。fold=+1 は肘を脚の膝と同じ側へ折る（既定）。骨長は SKEL 由来（上腕 1.50→1.20=0.30・
  // 前腕→手首）。到達性は脚IK（テスト済み legFK 往復）と数学的に同一構造で保証される。
  const IK_A1 = LM.shoulder - LM.elbow, IK_A2 = LM.elbow - LM.wrist;   // ランドマーク由来（目標点＝手首）
  const solveArmIK = (shY, shZ, tY, tZ, fold = 1) => {
    let vf = tZ - shZ, vu = tY - shY;
    let d = Math.hypot(vf, vu);
    if (d < 1e-4) { vf = 0; vu = -1; d = 1e-4; }
    const dmin = Math.abs(IK_A1 - IK_A2) + 0.02, dmax = IK_A1 + IK_A2 - 0.005;
    const dc = clamp(d, dmin, dmax);
    const uf = vf / d, uu = vu / d;
    const ce = clamp((dc * dc - IK_A1 * IK_A1 - IK_A2 * IK_A2) / (2 * IK_A1 * IK_A2), -1, 1);
    const elbow = Math.acos(ce);                   // 肘の屈曲量（≥0）
    const thetaDir = Math.atan2(-uf, -uu);
    const ca = clamp((IK_A1 * IK_A1 + dc * dc - IK_A2 * IK_A2) / (2 * IK_A1 * dc), -1, 1);
    const alpha = Math.acos(ca);
    return { sw: thetaDir - fold * alpha, el: -fold * elbow, reach: d > dmax };
  };
  // 腕IK の前方運動学（テスト用・poseSkin と同じ (fwd,up) 規約: foreArm 累積 = rotX(sw - el)）
  const armFK = (shY, shZ, sw, el) => {
    const eZ = shZ - IK_A1 * Math.sin(sw), eY = shY - IK_A1 * Math.cos(sw);
    const c = sw - el;
    return { z: eZ - IK_A2 * Math.sin(c), y: eY - IK_A2 * Math.cos(c) };
  };

  // 接地ロールの幾何: 足ピッチ a（+=つま先下げ）のとき、足首関節から接地点（ブーツ底の接線）までの落差。
  // ブーツ＝足ボーン固定の楕円体なので、a で回した楕円体の下向き支持関数から解析的に出る。
  // これで足首の目標高さを「接地点が地面 y=0 に乗る高さ」に取れる＝ロールしても沈まない/浮かない。
  const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
  // 接地点は 3 つ（踵の角・母趾球・つま先の角）。足を pitch（後足部の世界ピッチ）と toe（母趾球での
  // 前足部の相対角）で回し、いちばん低くなる点が地面に乗る高さを返す。toe=-pitch なら踏切でも前足部は
  // 接地したままで、足首だけが上がる（＝人の押し出し）。
  const CONTACT = [
    { dz: SHOE.heelZ + SHOE.soleR, fore: false },
    { dz: SHOE.mtpZ, fore: false },
    { dz: SHOE.toeZ - SHOE.soleR, fore: true },
  ];
  const soleDrop = (pitch, toe = 0) => {
    const dy0 = SHOE.soleR - LM.ankle;                    // 靴底の角の中心（足首相対）
    const ca = Math.cos(pitch), sa = Math.sin(pitch), cf = Math.cos(pitch + toe), sf = Math.sin(pitch + toe);
    const mz = SHOE.mtpZ, ballY = ca * dy0 - sa * mz;     // 母趾球の高さ（前足部はここで折れる）
    let drop = -Infinity;
    for (const p of CONTACT) {
      const dy = p.fore ? ballY - sf * (p.dz - mz) : ca * dy0 - sa * p.dz;
      drop = Math.max(drop, SHOE.soleR - dy);
    }
    return drop;
  };
  // 世界での足の傾き（+=つま先下げ）。接地相: 踵接地(背屈)→フットフラット→踏切(底屈)。
  // 遊脚相: 底屈から素早く戻してクリアランスを取り、次の踵接地の背屈へ。両端で連続・立位(loco=0)で水平。
  const HEEL_STRIKE = -0.15, TOE_OFF = 0.35;
  const footPitch = (c, loco) => (c < Math.PI
    ? HEEL_STRIKE * (1 - sstep(0, 0.22, c / Math.PI)) + TOE_OFF * sstep(0.45, 1, c / Math.PI)
    : TOE_OFF * (1 - sstep(0, 0.35, (c - Math.PI) / Math.PI)) + HEEL_STRIKE * sstep(0.5, 1, (c - Math.PI) / Math.PI)) * loco;

  // 純粋な直進歩容ポーズ（位相・速度 → poseSkin が食う全ポーズ引数）。歩容の質:
  //  (a) 体重移動: 骨盤高を「支持脚が届く上限」から導く＝中間支持で伸び上がり接地で沈む（COM の上下動）。
  //      正弦を当てるのではなく脚長から決めるので、IK が可達限界でクランプせず接地足も滑らない。
  //  (b) 接地ロール: 足の世界ピッチを指定し、足首角＝ピッチ−(股+膝)（足ボーンは脛の回転を継承するため）。
  //      足首の目標高さは soleDrop で補正し、踵接地〜踏切の間ずっと接地点が地面に乗る。
  //  (c) 対側協調: 足の前後差 split に腕振り・胸郭ひねり・骨盤回旋を位相同期（右足前＝左肩前・骨盤は胸郭と反位相）。
  //  (d) 二次モーション: opts.accel（前後加速度・呼び出し側が時刻の純関数で与える）で腕振りを遅らせ・後方へ流し・胴を前傾。
  // 外乱 opts.bob（呼吸などの骨盤の上下）は IK の前に入れるので、揺らしても足は接地したまま。
  // 直進ロコモーションの正典。文脈駆動（注視・キック・後退等）はレンダラ/オーサリング側で上乗せする。
  // LEG_EFF=公称の実効脚長（骨盤高＝これを保つ高さ・立位の膝の曲がりを決める）。REACH_MAX=骨盤高の絶対上限で
  // solveLegIK の可達 dmax より内側に取る（外乱 bob で持ち上げても IK がクランプ＝接地足が滑らない）。
  const LEG_EFF = (IK_L1 + IK_L2) * 0.9795, REACH_MAX = IK_L1 + IK_L2 - 0.012, LOAD_DIP = 0.022;
  const HIP_Y = LM.hip;   // 立位の股関節高さ（骨格由来）
  const gaitPose = (phase, speed, opts = {}) => {
    const run = clamp(speed / 6, 0, 1), kick = opts.kick || 0, kickLeg = opts.kickLeg ?? 1;
    const loco = clamp(speed / 0.6, 0, 1);          // 立位(v=0)→歩行の立ち上がり（接地ロール/体重移動を抑制）
    const accel = clamp(opts.accel || 0, -4, 4);    // (d) 前後加速度
    const kicking = kick > 0.02, kickSw = Math.sin(clamp(kick, 0, 1) * Math.PI);
    // 各脚: 歩容位相・足配置・世界での足ピッチ・足首の目標（接地点が地面に乗る高さ）・実効脚長
    const legs = [-1, 1].map((s) => {
      const c = cycleOf(phase, s), ft = footPlace(phase, speed, s), pitch = footPitch(c, loco);
      // 踏切では母趾球で折れて前足部が接地したまま踵が上がる（前足部は世界で水平＝toe が pitch を打ち消す）。
      // 遊脚の入口で滑らかに戻す。
      const toe = -Math.max(0, pitch) * (c < Math.PI ? 1 : 1 - sstep(0, 0.25, (c - Math.PI) / Math.PI));
      const load = c < Math.PI ? Math.sin(sstep(0, 0.30, c / Math.PI) * Math.PI) * loco : 0;   // 荷重応答（踵接地直後に膝が沈む）
      return { s, ft, pitch, toe, tY: soleDrop(pitch, toe) + ft.fy, tZ: ft.fz, len: LEG_EFF - LOAD_DIP * load, free: kicking && s === kickLeg };
    });
    // (c) 足の前後差（±1 に正規化・+1=右足が最前）＝腕/胴/骨盤を脚に位相同期させる基準
    const stride = legs[0].ft.stride;
    const splitAt = (ph) => (stride > 1e-6 ? (footPlace(ph, speed, 1).fz - footPlace(ph, speed, -1).fz) / stride : 0);
    const split = splitAt(phase);
    const twist = split * (0.06 + 0.17 * run);              // 胸郭: 右足前で左肩前
    const pelvisYaw = -split * (0.05 + 0.10 * run);         // 骨盤: 前に出る脚側の腰が前（＝胸郭と反位相）
    // (a) 体重移動: 左右は上体の傾きで預ける（股関節に外転が無いリグでは骨盤を横に振ると接地足が滑るため）
    const swayX = Math.sin(phase) * 0.018 * run;
    const sideLean = Math.sin(phase) * (0.02 + 0.05 * run) * loco;
    // 前後の微動＝足のロールによる制動/押し出し。左右の平均を使う（支持脚を切り替えても連続）。
    const swayZ = (legs[0].pitch + legs[1].pitch) * 0.5 * 0.03;
    const hipZ = (s) => swayZ - HIP_X * s * Math.sin(pelvisYaw);   // 骨盤回旋で股関節が前後にずれる分
    let hipY = Infinity, hipMax = Infinity;
    for (const L of legs) if (!L.free) {
      const dz = (L.tZ - hipZ(L.s)) ** 2;
      hipY = Math.min(hipY, L.tY + Math.sqrt(Math.max(L.len * L.len - dz, 0)));
      hipMax = Math.min(hipMax, L.tY + Math.sqrt(Math.max(REACH_MAX * REACH_MAX - dz, 0)));
    }
    hipY = Math.min(hipY + (opts.bob || 0), hipMax);        // 脚が届く以上には持ち上がらない
    const legOf = (L) => {
      if (L.free) return { hip: -1.25 * kickSw, knee: 0.15 + 0.7 * (1 - kick) * kickSw, ankle: 0, toe: 0 };
      const r = solveLegIK(hipY, hipZ(L.s), L.tY, L.tZ);
      return { hip: r.hip, knee: r.knee, ankle: clamp(L.pitch - (r.hip + r.knee), ROM.ankle[0], ROM.ankle[1]), toe: L.toe };
    };
    // (c)(d) 腕の振り＝歩幅/速度に連動＋加速で位相の遅れと後方への流れ
    const lag = clamp(accel * 0.05, -0.12, 0.16);
    const armAmp = splitAt(phase - lag) * (0.14 + 0.74 * run), trail = accel * 0.02;
    const lg = legOf(legs[0]), rg = legOf(legs[1]);   // L はランドマーク補間に使う名前なので避ける
    return {
      lean: 0.03 + run * run * 0.36 + clamp(accel * 0.06, -0.15, 0.28) + (kicking ? 0.22 * kickSw : 0),
      twist, pelvisYaw, sideLean, swayX, swayY: hipY - HIP_Y, swayZ, lookYaw: 0, lookPitch: 0,
      hipL: lg.hip, kneeL: lg.knee, ankleL: lg.ankle, toeL: lg.toe,
      hipR: rg.hip, kneeR: rg.knee, ankleR: rg.ankle, toeR: rg.toe,
      swL: -armAmp + trail, elL: 0.45 + run * 1.05, swR: armAmp + trail, elR: 0.45 + run * 1.05,
    };
  };

  // ------------------------ 材質/スキニング・シェーダ（GLSL）------------------------
  const VS_SKIN = `#version 300 es
  layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor;
  layout(location=3) in vec4 aBIdx; layout(location=4) in vec4 aBW; layout(location=5) in float aCid;
  layout(location=6) in float aAo;
  uniform mat4 uProj, uView, uModel; uniform mat4 uBones[19];
  out vec3 vNor; out vec3 vWorld; out float vAo; flat out int vCid;
  void main(){
    mat4 S = uBones[int(aBIdx.x)]*aBW.x + uBones[int(aBIdx.y)]*aBW.y
           + uBones[int(aBIdx.z)]*aBW.z + uBones[int(aBIdx.w)]*aBW.w;
    vec4 w = uModel * (S * vec4(aPos,1.0));
    vWorld = w.xyz; gl_Position = uProj*uView*w;
    vNor = mat3(uModel) * (mat3(S) * aNor);
    vCid = int(aCid + 0.5);   // flat: 三角形内は補間しない（材質境界＝ハードエッジ・中間値化を防ぐ）
    vAo = aAo;                // #157 接触AO（滑らかに補間＝ソフトな遮蔽グラデ）
  }`;
  const FS_SKIN = `#version 300 es
  precision highp float; in vec3 vNor; in vec3 vWorld; in float vAo; flat in int vCid; out vec4 o;
  uniform vec3 uPal[6]; uniform vec3 uEye; uniform float uEmiss, uFogD, uAlpha;
  void main(){
    vec3 n = normalize(vNor);
    vec3 L1 = normalize(vec3(0.35,0.8,0.45)), L2 = normalize(vec3(-0.5,0.6,-0.4));
    float ndl = clamp(dot(n,L1),0.0,1.0);
    float d = ndl*0.72 + clamp(dot(n,L2),0.0,1.0)*0.38 + 0.34;
    float ao = clamp(vAo, 0.0, 1.0);              // #157 接触遮蔽（腋/股/顎下/内側を暗く＝一体感・セルフ遮蔽の近似）
    vec3 base = uPal[vCid];
    vec3 V = normalize(uEye - vWorld);
    // #158 材質差別化（cid: 0/1=布 2/4=肌 3=髪 5=革）: スペキュラの強さ/鋭さを材質別に。
    float specStr, shin, subs;
    if (vCid==2 || vCid==4){ specStr=0.18; shin=14.0; subs=1.0; }   // 肌: 広く柔らかい＋サブサーフェス
    else if (vCid==5){ specStr=0.5; shin=46.0; subs=0.0; }          // 革（ブーツ）: 鋭い反射
    else if (vCid==3){ specStr=0.12; shin=22.0; subs=0.0; }         // 髪: 弱い光沢
    else { specStr=0.05; shin=8.0; subs=0.0; }                      // 布（ジャージ）: ほぼマット＋微光沢
    vec3 H = normalize(L1 + V);
    float spec = pow(clamp(dot(n,H),0.0,1.0), shin) * specStr * ndl;  // 裏面スペキュラを ndl で抑制
    vec3 sss = subs * vec3(0.16,0.03,0.0) * (1.0 - ndl) * ndl * 2.0;  // 肌: 明暗境界の暖色（安価なSSS近似）
    float rim = pow(1.0 - clamp(dot(n,V),0.0,1.0), 2.5);
    vec3 c = base * (d * ao) + sss * ao + vec3(spec * ao) + vec3(rim * 0.35 * ao) + base * uEmiss;
    float fog = clamp(length(uEye - vWorld) / uFogD, 0.0, 1.0); fog = fog*fog*0.55;
    float a = clamp(uAlpha + rim * 0.5, 0.0, 1.0);
    o = vec4(mix(c, vec3(0.043,0.066,0.118), fog), a);
  }`;

  R.character = {
    SKEL, BONE, LM, H, ROM, romOf, clampPose, SHOE, buildBodyMesh, BODY_MESH, poseSkin, bodyVarOf,
    solveLegIK, legFK, footPlace, cycleOf, gaitPose, PHASE_RATE, STRIDE_MAX, IK_L1, IK_L2,
    soleDrop, footPitch, LEG_EFF,
    solveArmIK, armFK, IK_A1, IK_A2,
    VS_SKIN, FS_SKIN,
    _M4: M4, _N: N, clamp, lerp,   // 内部数学/ハッシュも参照可能に（ビューア等の補助用）
  };
})();
