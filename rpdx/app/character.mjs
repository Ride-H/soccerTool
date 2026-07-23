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
  const SKEL = [
    [-1, 0, 0.94, 0],      // 0 pelvis
    [0, 0, 1.24, 0],       // 1 spine
    [1, 0, 1.44, 0],       // 2 chest
    [2, 0, 1.62, 0],       // 3 neck
    [3, 0, 1.70, 0],       // 4 head
    [0, -0.13, 0.94, 0],   // 5 thighL
    [5, -0.13, 0.46, 0],   // 6 shinL
    [6, -0.13, 0.06, 0],   // 7 footL
    [0, 0.13, 0.94, 0],    // 8 thighR
    [8, 0.13, 0.46, 0],    // 9 shinR
    [9, 0.13, 0.06, 0],    // 10 footR
    [2, -0.30, 1.50, 0],   // 11 upArmL
    [11, -0.30, 1.20, 0],  // 12 foreArmL
    [2, 0.30, 1.50, 0],    // 13 upArmR
    [13, 0.30, 1.20, 0],   // 14 foreArmR
  ];
  // 色ID: 0=シャツ / 1=ショーツ / 2=肌 / 3=髪 / 4=脚（肌×ショーツ混合色）/ 5=ブーツ（暗色）
  // #155 造形: 楕円断面（rx=横半径/rz=前後半径）で V字テーパー・胸郭/腹部絞り・平たい背中を表現。
  const buildBodyMesh = () => {
    const B = { pel: 0, spi: 1, che: 2, nec: 3, hea: 4, thL: 5, shL: 6, foL: 7, thR: 8, shR: 9, foR: 10, uaL: 11, faL: 12, uaR: 13, faR: 14 };
    const pos = [], nor = [], bidx = [], bw = [], cid = [], ao = [], idx = [];
    // #157 頂点ベイクAO: ring.ao（既定1.0・小さいほど暗い）を接触遮蔽域（腋/股/顎下/内側）に置く。
    // 縦軸チューブ: ring={x?,y,z?,rx,rz(またはr),c,ao?,b:[骨,重み,骨2?,重み2?]}。関節をまたぐリングの
    // 重みブレンドが「連続して曲がる皮膚」を作る。法線は楕円勾配＋縦半径勾配の解析式（円の場合は従来と一致）。
    const tube = (rings, seg) => {
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
        pos.push((rg.x || 0), rg.y + (up ? 0.02 : -0.02), (rg.z || 0));
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
      cap(rings.length - 1, true);
      cap(0, false);
    };
    // 単骨に固定する楕円体（ミトン手・ブーツ）: 腕/足が筒で終わらないための塊。
    const blob = (cx, cy, cz, rx, ry, rz, bone, color, latSeg, lonSeg, aoV) => {
      const start = pos.length / 3;
      for (let la = 0; la <= latSeg; la++) {
        const phi = (la / latSeg) * Math.PI - Math.PI / 2, cphi = Math.cos(phi), sphi = Math.sin(phi);
        for (let lo = 0; lo < lonSeg; lo++) {
          const th = (lo / lonSeg) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
          pos.push(cx + rx * cphi * cs, cy + ry * sphi, cz + rz * cphi * sn);
          let nx = (cphi * cs) / rx, ny = sphi / ry, nz = (cphi * sn) / rz;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nor.push(nx / nl, ny / nl, nz / nl);
          bidx.push(bone, 0, 0, 0); bw.push(1, 0, 0, 0); cid.push(color); ao.push(aoV ?? 1);
        }
      }
      for (let la = 0; la < latSeg; la++) for (let lo = 0; lo < lonSeg; lo++) {
        const a = start + la * lonSeg + lo, b = start + la * lonSeg + ((lo + 1) % lonSeg);
        const c = start + (la + 1) * lonSeg + lo, d = start + (la + 1) * lonSeg + ((lo + 1) % lonSeg);
        idx.push(a, c, b, b, c, d);
      }
    };
    // 胴〜首〜頭（1本のレイズ）: V字テーパー（肩幅>腰幅）＋胸郭の膨らみ＋腹部の絞り＋
    // 僧帽筋スロープ（肩ヨーク→首の急勾配＝首肩の連続）＋顎/面のある頭部。
    tube([
      { y: 0.84, rx: 0.150, rz: 0.130, c: 1, ao: 0.58, b: [B.pel, 1] },    // 股下＝強い接触AO
      { y: 0.94, rx: 0.165, rz: 0.140, c: 1, ao: 0.72, b: [B.pel, 1] },    // 骨盤/鼠径
      { y: 1.06, rx: 0.150, rz: 0.118, c: 1, ao: 0.90, b: [B.pel, 0.75, B.spi, 0.25] }, // 腰＝絞り
      { y: 1.14, rx: 0.156, rz: 0.122, c: 0, b: [B.pel, 0.35, B.spi, 0.65] },
      { y: 1.26, rx: 0.176, rz: 0.134, c: 0, b: [B.spi, 0.8, B.che, 0.2] },
      { y: 1.36, rx: 0.196, rz: 0.142, c: 0, b: [B.spi, 0.3, B.che, 0.7] }, // 胸郭
      { y: 1.44, rx: 0.204, rz: 0.140, c: 0, b: [B.che, 1] },
      { y: 1.50, rx: 0.214, rz: 0.126, c: 0, b: [B.che, 1] },              // 肩ヨーク（胸となだらかに接続）
      { y: 1.55, rx: 0.166, rz: 0.108, c: 0, ao: 0.9, b: [B.che, 0.7, B.nec, 0.3] }, // 僧帽筋スロープ→首
      { y: 1.60, rx: 0.072, rz: 0.074, c: 2, ao: 0.7, b: [B.nec, 1] },     // 首（顎下の接触AO）
      { y: 1.635, rx: 0.064, rz: 0.070, c: 2, ao: 0.78, b: [B.nec, 0.4, B.hea, 0.6] },
      { y: 1.675, rx: 0.082, rz: 0.094, c: 2, ao: 0.92, b: [B.hea, 1] },   // 顎（前後に深い）
      { y: 1.73, rx: 0.104, rz: 0.112, c: 2, b: [B.hea, 1] },              // 顔（額〜頬）
      { y: 1.79, rx: 0.110, rz: 0.118, c: 3, b: [B.hea, 1] },              // 後頭部の張り（髪）
      { y: 1.86, rx: 0.082, rz: 0.088, c: 3, b: [B.hea, 1] },
      { y: 1.905, rx: 0.034, rz: 0.036, c: 3, b: [B.hea, 1] },
    ], 14);
    // 脚（腿の質量→膝→ふくらはぎ→足首の絞り・紡錘）。ふくらはぎは前後に厚い（rz>rx）。
    const leg = (s, th, sh, ft) => {
      tube([
        { x: s * 0.13, y: 1.00, rx: 0.098, rz: 0.100, c: 4, ao: 0.68, b: [th, 1] }, // 腿付け根＝鼠径の接触AO
        { x: s * 0.13, y: 0.88, rx: 0.106, rz: 0.110, c: 4, ao: 0.9, b: [th, 1] },   // 大腿の質量
        { x: s * 0.13, y: 0.66, rx: 0.093, rz: 0.096, c: 4, b: [th, 1] },
        { x: s * 0.13, y: 0.52, rx: 0.085, rz: 0.088, c: 4, b: [th, 0.65, sh, 0.35] },
        { x: s * 0.13, y: 0.46, rx: 0.082, rz: 0.086, c: 4, b: [th, 0.3, sh, 0.7] },
        { x: s * 0.13, y: 0.38, rx: 0.076, rz: 0.088, c: 4, b: [sh, 0.92, th, 0.08] }, // ふくらはぎ
        { x: s * 0.13, y: 0.26, rx: 0.064, rz: 0.070, c: 4, b: [sh, 1] },
        { x: s * 0.13, y: 0.14, rx: 0.052, rz: 0.056, c: 4, b: [sh, 0.7, ft, 0.3] },   // 足首の絞り
        { x: s * 0.13, y: 0.10, rx: 0.048, rz: 0.052, c: 4, b: [ft, 1] },
      ], 10);
      // ブーツ（つま先/踵のある形状・前方に長い楕円体・足ボーン追従）
      blob(s * 0.13, 0.045, 0.055, 0.056, 0.050, 0.135, ft, 5, 4, 8, 0.82);
    };
    leg(-1, B.thL, B.shL, B.foL);
    leg(1, B.thR, B.shR, B.foR);
    // 腕（肩デルトイド→上腕→肘→前腕→手首の連続チューブ＋ミトン手）。付け根は胸へブレンドし肩ヨークに接続。
    const arm = (s, ua, fa) => {
      tube([
        { x: s * 0.30, y: 1.545, rx: 0.072, rz: 0.070, c: 0, ao: 0.82, b: [B.che, 0.45, ua, 0.55] }, // デルトイド（肩ヨーク接続）
        { x: s * 0.30, y: 1.46, rx: 0.070, rz: 0.068, c: 0, ao: 0.7, b: [ua, 1] },       // 腋の接触AO
        { x: s * 0.30, y: 1.37, rx: 0.061, rz: 0.060, c: 2, ao: 0.88, b: [ua, 1] },      // 袖→肌
        { x: s * 0.30, y: 1.26, rx: 0.056, rz: 0.056, c: 2, b: [ua, 0.62, fa, 0.38] },
        { x: s * 0.30, y: 1.20, rx: 0.053, rz: 0.053, c: 2, b: [ua, 0.3, fa, 0.7] },
        { x: s * 0.30, y: 1.10, rx: 0.050, rz: 0.050, c: 2, b: [fa, 1] },
        { x: s * 0.30, y: 0.99, rx: 0.044, rz: 0.045, c: 2, b: [fa, 1] },
        { x: s * 0.30, y: 0.945, rx: 0.038, rz: 0.040, c: 2, b: [fa, 1] },               // 手首
      ], 8);
      // ミトン手（指なしの手のひら塊・前腕ボーン追従・腕が筒で終わらない）
      blob(s * 0.30, 0.895, 0.010, 0.050, 0.072, 0.062, fa, 2, 4, 6, 0.9);
    };
    arm(-1, B.uaL, B.faL);
    arm(1, B.uaR, B.faR);
    return {
      pos: new Float32Array(pos), nor: new Float32Array(nor),
      bidx: new Float32Array(bidx), bw: new Float32Array(bw), cid: new Float32Array(cid),
      ao: new Float32Array(ao), idx: new Uint16Array(idx), boneCount: SKEL.length, tri: idx.length / 3,
    };
  };
  const BODY_MESH = buildBodyMesh();
  // ポーズ（既存ゲイトの回転群）→ ボーンパレット（15×mat4・スキン行列 = G × T(-head)）
  const poseSkin = (p) => {
    const lookY = p.lookYaw || 0, lookP = p.lookPitch || 0;   // #156 注視（首0.6+頭0.4=合計1.0で分配）
    const sway = (p.swayX || p.swayY || p.swayZ)              // #156 重心スウェイ（骨盤の並進・下流が追従）
      ? M4.t(p.swayX || 0, p.swayY || 0, p.swayZ || 0) : null;
    const rot = [
      sway,                                                     // pelvis: 重心スウェイ（無指定=従来通り恒等）
      M4.mul(M4.rotX(p.lean * 0.5), M4.roty(p.twist * 0.45)),   // spine
      M4.mul(M4.rotX(p.lean * 0.5), M4.roty(p.twist * 0.55)),   // chest（累積=lean/twist・腕はここに従う）
      M4.mul(M4.roty(-p.twist * 0.6 + lookY * 0.6), M4.rotX(lookP * 0.4)),  // neck: 首ひねり打消し＋注視
      M4.mul(M4.roty(lookY * 0.4), M4.rotX(lookP * 0.6)),       // head: 注視（無指定=恒等）
      M4.rotX(p.hipL), M4.rotX(p.kneeL), null,
      M4.rotX(p.hipR), M4.rotX(p.kneeR), null,
      M4.rotX(p.swL), M4.rotX(-p.elL),
      M4.rotX(p.swR), M4.rotX(-p.elR),
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
  // 骨長は SKEL 由来（thigh 0.94→0.46=0.48・shin 0.46→0.06=0.40）。
  const IK_L1 = 0.48, IK_L2 = 0.40;
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
  const STRIDE_MAX = 0.42;
  const PHASE_RATE = (v) => 4.2 + 0.85 * v;
  const footPlace = (phase, v, side) => {
    const stride = clamp(v * Math.PI / PHASE_RATE(v), 0, STRIDE_MAX);
    const c = (((phase + (side < 0 ? Math.PI : 0)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (c < Math.PI) return { fz: stride * 0.5 - stride * (c / Math.PI), fy: 0, stance: true, stride };
    const t = (c - Math.PI) / Math.PI, e = t * t * (3 - 2 * t);
    return { fz: -stride * 0.5 + stride * e, fy: Math.sin(t * Math.PI) * (0.045 + 0.10 * clamp(v / 6, 0, 1)), stance: false, stride };
  };

  // ------------------------ 材質/スキニング・シェーダ（GLSL）------------------------
  const VS_SKIN = `#version 300 es
  layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor;
  layout(location=3) in vec4 aBIdx; layout(location=4) in vec4 aBW; layout(location=5) in float aCid;
  layout(location=6) in float aAo;
  uniform mat4 uProj, uView, uModel; uniform mat4 uBones[15];
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
    SKEL, buildBodyMesh, BODY_MESH, poseSkin, bodyVarOf,
    solveLegIK, legFK, footPlace, PHASE_RATE, STRIDE_MAX, IK_L1, IK_L2,
    VS_SKIN, FS_SKIN,
    _M4: M4, _N: N, clamp, lerp,   // 内部数学/ハッシュも参照可能に（ビューア等の補助用）
  };
})();
