/* =========================================================================
   RPDX.render3d — 依存ゼロ WebGL2 スタジアム・レンダラ
   ナイター照明の NRG スタジアム / 選手カプセル+背番号ビルボード /
   D²-Field ヒートマップ / 軌跡 / 5種カメラ（VR風フリーフライト含む）
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const N = R.noise;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, u) => a + (b - a) * u;
  // #char-lab: キャラ中核は共有コア character.mjs（単一の真実源）から取得。ここで再定義しない。
  const { SKEL, buildBodyMesh, BODY_MESH, poseSkin, bodyVarOf, solveLegIK, legFK, footPlace,
    PHASE_RATE, STRIDE_MAX, IK_L1, IK_L2, VS_SKIN, FS_SKIN } = R.character;
  // #153: 決定論シーケンシャル乱数 — 視覚要素に素の乱数関数は使わない（視覚回帰の再現性契約・visualgate.test が走査）
  const seqRand = (seed) => { let s = seed | 0; return () => N.hash((s = (s + 0x9e3779b9) | 0)); };

  /* ------------------------------ mat4 ------------------------------ */
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

  /* ------------------------------ meshes ------------------------------ */
  const capsuleMesh = (seg = 14, rings = 5) => {
    // 高さ1・半径1の正規化カプセル（y 0..1）。scaleで体格
    const pos = [], nor = [], idx = [];
    const push = (p, n) => { pos.push(...p); nor.push(...n); };
    const rows = [];
    for (let r = 0; r <= rings; r++) { // bottom hemi
      const a = (r / rings) * Math.PI / 2;
      rows.push({ y: 0.18 - Math.cos(a) * 0.18, rr: Math.sin(a), ny: -Math.cos(a) });
    }
    rows.push({ y: 0.82, rr: 1, ny: 0 });
    for (let r = 1; r <= rings; r++) { // top hemi
      const a = (r / rings) * Math.PI / 2;
      rows.push({ y: 0.82 + Math.sin(a) * 0.18, rr: Math.cos(a), ny: Math.sin(a) });
    }
    for (let r = 0; r < rows.length; r++) {
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
        const row = rows[r];
        push([c * row.rr, row.y, s * row.rr], [c * (1 - Math.abs(row.ny)), row.ny, s * (1 - Math.abs(row.ny))]);
      }
    }
    const W = seg + 1;
    for (let r = 0; r < rows.length - 1; r++) for (let i = 0; i < seg; i++) {
      const a = r * W + i;
      idx.push(a, a + 1, a + W, a + 1, a + W + 1, a + W);
    }
    return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint16Array(idx) };
  };
  const sphereMesh = (seg = 16) => {
    const pos = [], nor = [], idx = [];
    for (let r = 0; r <= seg; r++) for (let i = 0; i <= seg; i++) {
      const ph = (r / seg) * Math.PI, th = (i / seg) * Math.PI * 2;
      const x = Math.sin(ph) * Math.cos(th), y = Math.cos(ph), z = Math.sin(ph) * Math.sin(th);
      pos.push(x, y, z); nor.push(x, y, z);
    }
    const W = seg + 1;
    for (let r = 0; r < seg; r++) for (let i = 0; i < seg; i++) {
      const a = r * W + i;
      idx.push(a, a + 1, a + W, a + 1, a + W + 1, a + W);
    }
    return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint16Array(idx) };
  };
  /* ------- #154 スキンドボディ（LBS・単一連続メッシュ・プロシージャル生成） ------- */
  // ボーン: [親idx, バインド頭位置x, y, z]（直立・腕は体側に垂下のバインド姿勢）。
  // 15ボーン=脊椎5+脚3×2+腕2×2。RPDX.quality.flags.playerBoneBudget の予算内で運用する。
  // バインド回転は恒等（純並進）なので inverseBind = T(-head) となり一般逆行列が不要。
  const quadMesh = () => ({
    pos: new Float32Array([-0.5,0,-0.5, 0.5,0,-0.5, 0.5,0,0.5, -0.5,0,0.5]),
    nor: new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]),
    uv: new Float32Array([0,0, 1,0, 1,1, 0,1]),
    idx: new Uint16Array([0,1,2, 0,2,3]),
  });
  const vquadMesh = () => ({ // 垂直ビルボード（XY平面, 中心原点）
    pos: new Float32Array([-0.5,-0.5,0, 0.5,-0.5,0, 0.5,0.5,0, -0.5,0.5,0]),
    nor: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]),
    uv: new Float32Array([0,1, 1,1, 1,0, 0,0]),
    idx: new Uint16Array([0,1,2, 0,2,3]),
  });
  const boxMesh = () => {
    const p = [], n = [], idx = [];
    const faces = [
      [[0,0,1],[[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]]],
      [[0,0,-1],[[.5,-.5,-.5],[-.5,-.5,-.5],[-.5,.5,-.5],[.5,.5,-.5]]],
      [[1,0,0],[[.5,-.5,.5],[.5,-.5,-.5],[.5,.5,-.5],[.5,.5,.5]]],
      [[-1,0,0],[[-.5,-.5,-.5],[-.5,-.5,.5],[-.5,.5,.5],[-.5,.5,-.5]]],
      [[0,1,0],[[-.5,.5,.5],[.5,.5,.5],[.5,.5,-.5],[-.5,.5,-.5]]],
      [[0,-1,0],[[-.5,-.5,-.5],[.5,-.5,-.5],[.5,-.5,.5],[-.5,-.5,.5]]],
    ];
    let b = 0;
    for (const [nn, vs] of faces) {
      for (const v of vs) { p.push(...v); n.push(...nn); }
      idx.push(b, b+1, b+2, b, b+2, b+3); b += 4;
    }
    return { pos: new Float32Array(p), nor: new Float32Array(n), idx: new Uint16Array(idx) };
  };

  /* ------------------------------ shaders ------------------------------ */
  const VS_BASE = `#version 300 es
  layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec2 aUv;
  uniform mat4 uProj, uView, uModel, uLightMVP; out vec3 vNor; out vec2 vUv; out vec3 vWorld; out vec4 vLightPos;
  void main(){ vec4 w = uModel * vec4(aPos,1.0); vWorld = w.xyz; gl_Position = uProj*uView*w;
    vNor = mat3(uModel)*aNor; vUv = aUv; vLightPos = uLightMVP * w; }`;   // #157 光源空間座標（影受け）
  // #157 PCF シャドウ係数（0=影/1=非影）: 深度テクスチャを 3×3 で比較・範囲外や無効時は 1。
  const GLSL_SHADOW = `
  uniform highp sampler2D uShadow; uniform float uShadowOn; uniform vec2 uShadowTexel;
  float shadowF(vec4 lp, vec3 n, vec3 ldir){
    if (uShadowOn < 0.5) return 1.0;
    vec3 p = lp.xyz / lp.w * 0.5 + 0.5;
    if (p.x<0.0||p.x>1.0||p.y<0.0||p.y>1.0||p.z>1.0) return 1.0;
    float bias = max(0.0035 * (1.0 - clamp(dot(n, ldir),0.0,1.0)), 0.0012);
    float s = 0.0;
    for (int i=-1;i<=1;i++) for (int j=-1;j<=1;j++){
      float d = texture(uShadow, p.xy + vec2(float(i),float(j))*uShadowTexel).r;
      s += (p.z - bias > d) ? 0.0 : 1.0;
    }
    return mix(1.0, s/9.0, 0.78);   // 影の濃さ 0.78（完全な黒にしない）
  }`;
  const FS_LAMBERT = `#version 300 es
  precision highp float; in vec3 vNor; in vec3 vWorld; out vec4 o;
  uniform vec3 uColor, uColor2, uEye; uniform float uSplit, uEmiss, uFogD, uAlpha;
  void main(){
    vec3 n = normalize(vNor);
    vec3 L1 = normalize(vec3(0.35,0.8,0.45)), L2 = normalize(vec3(-0.5,0.6,-0.4));
    float d = clamp(dot(n,L1),0.0,1.0)*0.72 + clamp(dot(n,L2),0.0,1.0)*0.38 + 0.34;
    vec3 base = (uSplit > 0.5 && vWorld.y < uSplit) ? uColor2 : uColor;
    vec3 V = normalize(uEye - vWorld);
    float rim = pow(1.0 - clamp(dot(n,V),0.0,1.0), 2.5);
    vec3 c = base * d + vec3(rim * 0.35) + base * uEmiss;
    float fog = clamp(length(uEye - vWorld) / uFogD, 0.0, 1.0); fog = fog*fog*0.55;
    // 透明感: フレネル縁は不透明に残す（ガラス質の量感）
    float a = clamp(uAlpha + rim * 0.5, 0.0, 1.0);
    o = vec4(mix(c, vec3(0.043,0.066,0.118), fog), a);
  }`;
  // #157 深度パス用（影キャスターのプロキシを光源空間へ）: 深度のみ書き込む・非スキンド
  const VS_DEPTH = `#version 300 es
  layout(location=0) in vec3 aPos; uniform mat4 uModel, uLightMVP;
  void main(){ gl_Position = uLightMVP * (uModel * vec4(aPos,1.0)); }`;
  const FS_DEPTH = `#version 300 es
  precision highp float; void main(){}`;
  // #159 ポストプロセス: フルスクリーン三角形（頂点属性なし・gl_VertexID駆動）
  const VS_POST = `#version 300 es
  out vec2 vT;
  void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vT = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;
  const FS_BRIGHT = `#version 300 es
  precision highp float; in vec2 vT; out vec4 o; uniform sampler2D uTex; uniform float uThresh;
  void main(){ vec3 c = texture(uTex, vT).rgb; float l = dot(c, vec3(0.2126,0.7152,0.0722));
    o = vec4(c * clamp((l - uThresh) / max(l, 1e-4), 0.0, 1.0), 1.0); }`;
  const FS_BLUR = `#version 300 es
  precision highp float; in vec2 vT; out vec4 o; uniform sampler2D uTex; uniform vec2 uDir;
  void main(){ vec3 s = texture(uTex,vT).rgb*0.227
    + texture(uTex, vT+uDir*1.384).rgb*0.316 + texture(uTex, vT-uDir*1.384).rgb*0.316
    + texture(uTex, vT+uDir*3.231).rgb*0.070 + texture(uTex, vT-uDir*3.231).rgb*0.070;
    o = vec4(s, 1.0); }`;
  // トーンマップ（控えめフィルミック）＋グレーディング（コントラスト/彩度/ビネット）＋任意bloom＋軽量FXAA
  const FS_POST = `#version 300 es
  precision highp float; in vec2 vT; out vec4 o;
  uniform sampler2D uTex, uBloom; uniform vec2 uTexel;
  uniform float uBloomOn, uContrast, uSat, uVig, uExposure, uTonemap;
  vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
  float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
  void main(){
    vec3 c = texture(uTex, vT).rgb;
    // 軽量FXAA: 強いエッジのみ近傍平均（オフスクリーンでMSAA喪失の補償・過度にぼかさない）
    vec3 nw=texture(uTex,vT+vec2(-uTexel.x,-uTexel.y)).rgb, ne=texture(uTex,vT+vec2(uTexel.x,-uTexel.y)).rgb;
    vec3 sw=texture(uTex,vT+vec2(-uTexel.x,uTexel.y)).rgb, se=texture(uTex,vT+vec2(uTexel.x,uTexel.y)).rgb;
    float lc=lum(c), l0=lum(nw),l1=lum(ne),l2=lum(sw),l3=lum(se);
    float lmin=min(lc,min(min(l0,l1),min(l2,l3))), lmax=max(lc,max(max(l0,l1),max(l2,l3)));
    if (lmax-lmin > 0.20) c = (c*2.0 + nw+ne+sw+se) / 6.0;
    if (uBloomOn > 0.5) c += texture(uBloom, vT).rgb * 0.85;   // Cinematic: bloom 加算
    c *= uExposure;
    c = mix(c, aces(c), uTonemap);                             // 控えめトーンマップ（既存の作り込みを濁さない）
    c = (c - 0.5) * uContrast + 0.5;                           // コントラスト
    c = mix(vec3(lum(c)), c, uSat);                            // 彩度
    float vig = smoothstep(1.4, 0.82, length(vT - 0.5));       // ビネット（外周のみ・中央や UI 帯は暗くしない）
    c *= mix(1.0, vig, uVig);
    o = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`;
  const FS_TEX = `#version 300 es
  precision highp float; in vec2 vUv; in vec3 vWorld; in vec4 vLightPos; out vec4 o;
  uniform sampler2D uTex; uniform vec3 uEye, uTint; uniform float uAlpha, uFogD, uEmiss, uShadowRecv;
  ${GLSL_SHADOW}
  void main(){
    vec4 t = texture(uTex, vUv);
    vec3 c = t.rgb * uTint * (1.0 + uEmiss);
    // #157 芝の投影影（受け手のみ・uShadowRecv=1）: 人型のキャストシャドウ
    if (uShadowRecv > 0.5) c *= mix(1.0, shadowF(vLightPos, vec3(0.0,1.0,0.0), normalize(vec3(0.35,0.8,0.45))), 0.9);
    float fog = clamp(length(uEye - vWorld) / uFogD, 0.0, 1.0); fog = fog*fog*0.55;
    o = vec4(mix(c, vec3(0.043,0.066,0.118), fog), t.a * uAlpha);
    if (o.a < 0.01) discard;
  }`;
  const FS_FLAT = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform vec3 uColor; uniform float uAlpha, uRing, uSoft, uRect;
  void main(){
    // uRect>0.5: 角丸矩形距離（ゾーンハイライト用） / それ以外: 円距離
    float r = uRect > 0.5
      ? max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0
      : length(vUv - 0.5) * 2.0;
    float a;
    if (uRing > 0.0) { a = smoothstep(uRing+uSoft, uRing, r) * smoothstep(uRing-0.22-uSoft, uRing-0.22, r); }
    else { a = smoothstep(1.0, 1.0-uSoft, r); }
    o = vec4(uColor, a * uAlpha);
    if (o.a < 0.01) discard;
  }`;
  const VS_SKY = `#version 300 es
  layout(location=0) in vec2 aP; out vec2 vP;
  void main(){ vP = aP; gl_Position = vec4(aP,0.9999,1.0); }`;
  const FS_SKY = `#version 300 es
  precision highp float; in vec2 vP; out vec4 o; uniform float uT;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  void main(){
    float h = vP.y * 0.5 + 0.5;
    vec3 top = vec3(0.016,0.027,0.055), mid = vec3(0.043,0.070,0.125), glow = vec3(0.10,0.16,0.24);
    vec3 c = mix(glow, mix(mid, top, smoothstep(0.25,0.9,h)), smoothstep(0.02,0.3,h));
    // 星
    vec2 g = floor(vP * vec2(180.0,90.0));
    float st = step(0.9975, hash(g)) * smoothstep(0.3,0.8,h) * (0.5+0.5*sin(uT*0.7+hash(g*1.7)*6.28));
    c += vec3(st*0.55);
    o = vec4(c,1.0);
  }`;

  /* ---- 粒子（インスタンシング・加算グロー — 空間プラグイン風） ---- */
  const VS_PART = `#version 300 es
  layout(location=0) in vec2 aP;               // クワッド頂点 (-0.5..0.5)
  layout(location=1) in vec3 iPos;             // ワールド位置
  layout(location=2) in vec2 iSizePhase;       // size, phase
  layout(location=3) in vec4 iColor;           // rgb + alpha
  uniform mat4 uProj, uView;
  uniform vec3 uRight, uUp;
  uniform float uT;
  out vec2 vUv; out vec4 vCol;
  void main(){
    float ph = iSizePhase.y * 6.2831;
    float bob = sin(uT * 1.15 + ph) * 0.26 + sin(uT * 0.53 + ph * 1.7) * 0.14;
    vec3 w = iPos + vec3(0.0, bob, 0.0) + (uRight * aP.x + uUp * aP.y) * iSizePhase.x;
    vUv = aP + 0.5;
    vCol = iColor * (0.85 + 0.15 * sin(uT * 1.7 + ph * 2.3));
    gl_Position = uProj * uView * vec4(w, 1.0);
  }`;
  const FS_PART = `#version 300 es
  precision highp float; in vec2 vUv; in vec4 vCol; out vec4 o;
  void main(){
    float d = length(vUv - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.24, d) * 0.55 + smoothstep(0.34, 0.0, d) * 0.75;
    o = vec4(vCol.rgb * (a * vCol.a), 1.0);   // 加算前提（premultiplied）
  }`;

  /* ---------------------------- GL helpers ---------------------------- */
  const compile = (gl, vs, fs) => {
    const mk = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) + src.slice(0, 200));
      return sh;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    return pr;
  };
  const buildVAO = (gl, mesh) => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = (loc, data, size) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    buf(0, mesh.pos, 3);
    if (mesh.nor) buf(1, mesh.nor, 3);
    if (mesh.uv) buf(2, mesh.uv, 2);
    if (mesh.bidx) buf(3, mesh.bidx, 4);   // #154 スキニング: ボーン番号（floatで供給）
    if (mesh.bw) buf(4, mesh.bw, 4);       //                    ボーン重み
    if (mesh.cid) buf(5, mesh.cid, 1);     //                    色ID（パレット参照）
    if (mesh.ao) buf(6, mesh.ao, 1);       // #157 頂点ベイクAO（接触遮蔽）
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, n: mesh.idx.length };
  };

  /* ---------------------------- textures ---------------------------- */
  const canvasTex = (gl, cv, mips = true) => {
    const tx = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mips) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return tx;
  };

  const makePitchCanvas = () => {
    const W = 2100, H = 1400, sx = W / 118, sy = H / 80; // 105+margin / 68+margin
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    const px = (x) => (x + 59) * sx, py = (y) => (y + 40) * sy;
    // 外周ランオフ
    g.fillStyle = "#0F3D28"; g.fillRect(0, 0, W, H);
    // 芝モーイング・ストライプ（#134: コントラストを上げ、縞境界に軽いソフトエッジ）
    for (let i = 0; i < 14; i++) {
      g.fillStyle = i % 2 ? "#176439" : "#0F4227";
      g.fillRect(px(-52.5 + i * 7.5), py(-34), 7.5 * sx, 68 * sy);
    }
    // 縞に直交する薄いクロス・モー（芝目の交差＝刈り跡のリアル感）
    g.save();
    g.globalAlpha = 0.06;
    for (let j = 0; j < 20; j++) {
      g.fillStyle = j % 2 ? "#1C6E40" : "#0C3A22";
      g.fillRect(px(-52.5), py(-34 + j * 3.4), 105 * sx, 3.4 * sy);
    }
    g.restore();
    // 芝ノイズ（微粒・刈り跡のざらつき）— #153: 決定論シード（視覚回帰の再現性）
    const rnd = seqRand(0x51ED01);
    for (let i = 0; i < 11000; i++) {
      const x = rnd() * W, y = rnd() * H;
      g.fillStyle = `rgba(${20 + rnd() * 34},${70 + rnd() * 46},${40 + rnd() * 28},0.055)`;
      g.fillRect(x, y, 2.3, 2.3);
    }
    // ライン
    g.strokeStyle = "rgba(245,250,255,0.85)"; g.lineWidth = 2.6; g.lineCap = "round";
    const rect = (x, y, w, h) => g.strokeRect(px(x), py(y), w * sx, h * sy);
    rect(-52.5, -34, 105, 68);
    g.beginPath(); g.moveTo(px(0), py(-34)); g.lineTo(px(0), py(34)); g.stroke();
    g.beginPath(); g.arc(px(0), py(0), 9.15 * sx, 0, 7); g.stroke();
    g.beginPath(); g.arc(px(0), py(0), 3, 0, 7); g.fillStyle = "rgba(245,250,255,0.85)"; g.fill();
    for (const s of [-1, 1]) {
      rect(s * 52.5 - (s > 0 ? 16.5 : 0), -20.16, 16.5, 40.32);
      rect(s * 52.5 - (s > 0 ? 5.5 : 0), -9.16, 5.5, 18.32);
      g.beginPath(); g.arc(px(s * 41.5), py(0), 2.6, 0, 7); g.fill();
      // PAアーク
      g.beginPath();
      const a0 = s > 0 ? Math.PI * 0.65 : -Math.PI * 0.35;
      g.arc(px(s * 41.5), py(0), 9.15 * sx, a0, a0 + Math.PI * 0.7);
      g.stroke();
      // コーナー
      for (const cy of [-34, 34]) {
        g.beginPath();
        g.arc(px(s * 52.5), py(cy), 1 * sx, 0, 7);
        g.stroke();
      }
    }
    return cv;
  };

  const makeCrowdCanvas = () => {
    const cv = document.createElement("canvas");
    cv.width = 1024; cv.height = 192;
    const g = cv.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 192);
    grad.addColorStop(0, "#0A0F1C"); grad.addColorStop(1, "#141D33");
    g.fillStyle = grad; g.fillRect(0, 0, 1024, 192);
    const rnd = seqRand(0x51ED02);   // #153: 決定論シード（視覚回帰の再現性）
    for (let i = 0; i < 5200; i++) {
      const x = rnd() * 1024, y = 16 + rnd() * 168;
      const t = rnd();
      g.fillStyle = t < 0.24 ? "rgba(255,198,26,0.5)" : t < 0.5 ? "rgba(74,125,255,0.5)" : `rgba(${150 + rnd() * 105},${150 + rnd() * 90},${140 + rnd() * 80},0.42)`;
      g.fillRect(x, y, 2.6, 2.6);
    }
    return cv;
  };

  // 広告ボードは試合メタからデータ駆動生成（マッチパック切替に追従）
  const makeAdCanvas = (m) => {
    const cv = document.createElement("canvas");
    cv.width = 2048; cv.height = 64;
    const g = cv.getContext("2d");
    g.fillStyle = "#0B1322"; g.fillRect(0, 0, 2048, 64);
    g.font = "700 30px ui-monospace, Menlo, monospace";
    const keys = m.teamOrder || Object.keys(m.teams);
    const [a, b] = keys;
    const score = m.meta.score || {};
    const items = [
      "RPD-X", "D²-FIELD // 距離危険度場",
      (m.meta.competition || "").toUpperCase() || "FOOTBALL",
      `${a} ${score[a] ?? ""}-${score[b] ?? ""} ${b}`,
      (m.meta.venue || "").toUpperCase(),
      (m.teams[a].nameEn || a).toUpperCase(),
      (m.teams[b].nameEn || b).toUpperCase(),
    ].filter(s => s && s.trim());
    let x = 30, ci = 0;
    for (let k = 0; k < 3; k++) for (const it of items) {
      g.fillStyle = ["#6FA0FF", "#FFC61A", "#93A3C0"][ci++ % 3];
      g.globalAlpha = 0.8;
      g.fillText(it, x, 42);
      x += g.measureText(it).width + 90;
      if (x > 2048) break;
    }
    return cv;
  };

  const makeNetCanvas = () => {
    const cv = document.createElement("canvas");
    cv.width = 128; cv.height = 128;
    const g = cv.getContext("2d");
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = "rgba(235,240,250,0.5)"; g.lineWidth = 1;
    for (let i = 0; i <= 128; i += 8) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke();
    }
    return cv;
  };

  const makeGlowCanvas = () => {
    const cv = document.createElement("canvas");
    cv.width = 128; cv.height = 128;
    const g = cv.getContext("2d");
    const gr = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    gr.addColorStop(0, "rgba(255,250,230,0.95)");
    gr.addColorStop(0.25, "rgba(230,238,255,0.35)");
    gr.addColorStop(1, "rgba(210,225,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return cv;
  };

  // 選手ラベル（番号+名前）テクスチャ
  const makeLabelCanvas = (num, name, kit, opts = {}) => {
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 132;
    const g = cv.getContext("2d");
    g.clearRect(0, 0, 256, 132);
    const y0 = 6;
    // 番号チップ
    g.beginPath();
    const r = 14, w = 116, h = 84, x0 = (256 - w) / 2;
    g.roundRect(x0, y0, w, h, r);
    g.fillStyle = kit.shirt; g.fill();
    g.lineWidth = 3; g.strokeStyle = "rgba(10,14,24,0.55)"; g.stroke();
    g.fillStyle = kit.number;
    g.font = "800 60px -apple-system, 'Helvetica Neue', sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(String(num), 128, y0 + h / 2 + 3);
    if (opts.captain) {
      g.fillStyle = "#FFC61A";
      g.fillRect(x0 + 8, y0 + 8, 22, 10);
      g.fillStyle = "#161B29";
      g.font = "800 9px sans-serif";
      g.fillText("C", x0 + 19, y0 + 13.5);
    }
    // 名前プレート
    g.font = "700 26px -apple-system, 'Hiragino Sans', sans-serif";
    const tw = Math.min(240, g.measureText(name).width + 22);
    g.beginPath(); g.roundRect(128 - tw / 2, 96, tw, 32, 8);
    g.fillStyle = "rgba(8,12,22,0.78)"; g.fill();
    g.fillStyle = "#EAF0FB";
    g.fillText(name, 128, 112 + 1);
    return cv;
  };

  /* ============================== renderer ============================== */
  R.render3d = {};
  // #154 テスト用の純データ/純関数（DOM/GL非依存 — node --test が骨格・メッシュ・ポーズを検証）
  R.render3d._skin = { SKEL, buildBodyMesh, poseSkin, bodyVarOf, solveLegIK, legFK, footPlace, PHASE_RATE, BODY_MESH };
  R.render3d.create = (canvas, matchInit) => {
    let match = matchInit;
    const gl = canvas.getContext("webgl2", {
      antialias: true, alpha: false,
      preserveDrawingBuffer: true, powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 not available");
    canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
    // #152: GPU文字列で品質tierを保守側へ補正（SwiftShader等ソフトウェア描画→軽量へ降格のみ）
    try {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "";
      R.quality && R.quality.refineGpu(String(gpu || ""));
    } catch (_) { /* 拡張が無い/マスクされる環境は初期判定のまま */ }

    const prLambert = compile(gl, VS_BASE, FS_LAMBERT);
    const prSkin = compile(gl, VS_SKIN, FS_SKIN);   // #154 スキンド選手
    const prTex = compile(gl, VS_BASE, FS_TEX);
    const prFlat = compile(gl, VS_BASE, FS_FLAT);
    const prSky = compile(gl, VS_SKY, FS_SKY);
    const prPart = compile(gl, VS_PART, FS_PART);
    const prDepth = compile(gl, VS_DEPTH, FS_DEPTH);   // #157 影の深度パス（プロキシ）
    const prBright = compile(gl, VS_POST, FS_BRIGHT);  // #159 bloom 輝度抽出
    const prBlur = compile(gl, VS_POST, FS_BLUR);      // #159 ガウスブラー
    const prPost = compile(gl, VS_POST, FS_POST);      // #159 トーンマップ+グレーディング+FXAA
    const U = (pr, n) => gl.getUniformLocation(pr, n);

    // #159 ポストプロセスの資源: シーンを色テクスチャへ描画→フルスクリーンで整える。
    // 失敗（FBO不完全/非対応）時は post = null → 直接描画フォールバック（従来動作）。
    const emptyVAO = gl.createVertexArray();   // フルスクリーン三角形用（属性なし）
    let post = null;   // { w,h, fbo, tex, depth, bloomFBO[2], bloomTex[2] }
    const makeColorTex = (w, h) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const ensurePost = (w, h) => {
      if (post && post.w === w && post.h === h) return post;
      if (post) { gl.deleteFramebuffer(post.fbo); gl.deleteTexture(post.tex); gl.deleteRenderbuffer(post.depth); post.bloomFBO.forEach(f => gl.deleteFramebuffer(f)); post.bloomTex.forEach(t => gl.deleteTexture(t)); }
      try {
        const tex = makeColorTex(w, h);
        const depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);   // bloom は半解像度
        const bloomTex = [makeColorTex(bw, bh), makeColorTex(bw, bh)];
        const bloomFBO = bloomTex.map((t) => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; });
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        post = ok ? { w, h, bw, bh, fbo, tex, depth, bloomFBO, bloomTex } : null;
      } catch (_) { post = null; }
      return post;
    };
    const drawFS = () => { gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null); };
    let urlPost = true;   // #159 既定ON・?post=0 で無効（比較/デバッグ用）
    try { urlPost = new URLSearchParams(location.search).get("post") !== "0"; } catch (_) { /* 非ブラウザ */ }

    // #157 シャドウマップの資源（Cinematic tier のみ使用・非対応/失敗時は null → 円盤影へ安全フォールバック）
    const SHADOW_RES = 1536;
    let shadowFBO = null, shadowTex = null;
    try {
      shadowTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, shadowTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_RES, SHADOW_RES, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      shadowFBO = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0);
      gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);   // 深度専用（色出力なし）— ドライバ互換
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { shadowFBO = null; shadowTex = null; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
    } catch (_) { shadowFBO = null; shadowTex = null; }   // 深度テクスチャ非対応環境
    // 光源（ディレクショナル）: FS の L1 と同方向。ピッチ全域を覆う平行投影で選手をキャスト。
    const SHADOW_DIR = (() => { const v = [0.35, 0.8, 0.45], l = Math.hypot(...v); return [v[0]/l, v[1]/l, v[2]/l]; })();
    const lightMVP = (() => {
      const dist = 70, c = [0, 0, 0];
      const lp = [c[0] + SHADOW_DIR[0]*dist, c[1] + SHADOW_DIR[1]*dist, c[2] + SHADOW_DIR[2]*dist];
      const lv = M4.lookAt(lp, c, [0, 1, 0]);
      const lo = M4.ortho(-62, 62, -46, 46, 1, 140);   // ピッチ全域＋余白
      return M4.mul(lo, lv);
    })();
    const IDENT16 = M4.ident();
    let shadowOn = false;   // 毎フレーム quality.flags.shadowMap から更新
    // 影ユニフォームを program に設定（uShadowOn=0 のときは lightMVP/tex を触らない＝安全）
    const setShadow = (pr) => {
      gl.uniformMatrix4fv(U(pr, "uLightMVP"), false, shadowOn ? lightMVP : IDENT16);
      gl.uniform1f(U(pr, "uShadowOn"), shadowOn ? 1 : 0);
      if (shadowOn) {
        gl.uniform1i(U(pr, "uShadow"), 1);
        gl.uniform2f(U(pr, "uShadowTexel"), 1 / SHADOW_RES, 1 / SHADOW_RES);
      }
    };

    /* ---- 粒子インスタンス基盤 ---- */
    const PART_CAP = 9000, PART_STRIDE = 9;   // x,y,z, size,phase, r,g,b,a
    const partData = new Float32Array(PART_CAP * PART_STRIDE);
    let partCount = 0;
    const partVAO = gl.createVertexArray();
    const partIBuf = gl.createBuffer();
    {
      gl.bindVertexArray(partVAO);
      const qb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, qb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5,-0.5, 0.5,-0.5, -0.5,0.5, 0.5,0.5]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, partIBuf);
      gl.bufferData(gl.ARRAY_BUFFER, partData.byteLength, gl.DYNAMIC_DRAW);
      const B = PART_STRIDE * 4;
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, B, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, B, 12);
      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, B, 20);
      gl.vertexAttribDivisor(3, 1);
      gl.bindVertexArray(null);
    }
    const partReset = () => { partCount = 0; };
    const partPush = (x, y, z, size, phase, r, g, b, a) => {
      if (partCount >= PART_CAP) return;
      const o = partCount * PART_STRIDE;
      partData[o] = x; partData[o + 1] = y; partData[o + 2] = z;
      partData[o + 3] = size; partData[o + 4] = phase;
      partData[o + 5] = r; partData[o + 6] = g; partData[o + 7] = b; partData[o + 8] = a;
      partCount++;
    };
    const partDraw = (time) => {
      if (partCount === 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, partIBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, partData, 0, partCount * PART_STRIDE);
      gl.useProgram(prPart);
      gl.uniformMatrix4fv(U(prPart, "uProj"), false, proj);
      gl.uniformMatrix4fv(U(prPart, "uView"), false, view);
      gl.uniform3f(U(prPart, "uRight"), view[0], view[4], view[8]);
      gl.uniform3f(U(prPart, "uUp"), view[1], view[5], view[9]);
      gl.uniform1f(U(prPart, "uT"), time);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);            // 加算（premultiplied出力）
      gl.depthMask(false);
      gl.bindVertexArray(partVAO);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, partCount);
      gl.bindVertexArray(null);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    };

    const mCapsule = buildVAO(gl, capsuleMesh());
    const mSphere = buildVAO(gl, sphereMesh());
    const mSkinBody = buildVAO(gl, BODY_MESH);   // #154 単一スキンドボディ（全人型で共有）
    const mQuad = buildVAO(gl, quadMesh());
    const mVQuad = buildVAO(gl, vquadMesh());
    const mBox = buildVAO(gl, boxMesh());
    const skyVAO = (() => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      return vao;
    })();

    const txPitch = canvasTex(gl, makePitchCanvas());
    const txCrowd = canvasTex(gl, makeCrowdCanvas());
    let txAd = canvasTex(gl, makeAdCanvas(match));
    const txNet = canvasTex(gl, makeNetCanvas(), false);
    const txGlow = canvasTex(gl, makeGlowCanvas(), false);

    // 汎用テキスト・テクスチャ（速度ラベル/選手タグ — 内容キーでキャッシュ）
    const textCache = new Map();
    const textTex = (key, draw) => {
      if (textCache.has(key)) return textCache.get(key);
      const cv = document.createElement("canvas");
      draw(cv);
      const entry = { tx: canvasTex(gl, cv), w: cv.width, h: cv.height };
      textCache.set(key, entry);
      return entry;
    };
    // 「24 | SANO」タグ（選手毎キャッシュ）
    const nameTagTex = (team, p) => textTex(`tag:${team}:${p.no}`, (cv) => {
      cv.width = 512; cv.height = 80;
      const g = cv.getContext("2d");
      const surname = (p.name || "").trim().split(/\s+/).pop().toUpperCase();
      g.font = "600 46px -apple-system, 'Helvetica Neue', sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.shadowColor = "rgba(4,8,16,0.9)"; g.shadowBlur = 10; g.shadowOffsetY = 2;
      g.fillStyle = "rgba(233,240,250,0.92)";
      g.fillText(`${p.no} | ${surname}`, 256, 40, 500);
    });
    // 「18 km/h」（整数km/h × チーム色でキャッシュ — 生成は最大 ~36×2 枚）
    const speedTagTex = (kmh, colorCss) => textTex(`spd:${kmh}:${colorCss}`, (cv) => {
      cv.width = 384; cv.height = 84;
      const g = cv.getContext("2d");
      g.textAlign = "center"; g.textBaseline = "middle";
      g.shadowColor = "rgba(4,8,16,0.9)"; g.shadowBlur = 10; g.shadowOffsetY = 2;
      g.fillStyle = colorCss;
      g.font = "800 58px -apple-system, 'Helvetica Neue', sans-serif";
      g.fillText(`${kmh}`, 132, 44);
      g.font = "700 34px -apple-system, 'Helvetica Neue', sans-serif";
      g.fillText("km/h", 256, 50);
    });

    // ヒートマップ動的テクスチャ
    const heatCv = document.createElement("canvas");
    heatCv.width = 42; heatCv.height = 28;
    const heatCtx = heatCv.getContext("2d");
    const txHeat = canvasTex(gl, heatCv, false);

    // ラベルキャッシュ
    const labelCache = new Map();
    const labelTex = (team, p, captain) => {
      const key = `${team}:${p.no}:${captain ? 1 : 0}:${p.role === "GK" ? "gk" : "f"}`;
      if (labelCache.has(key)) return labelCache.get(key);
      const kit = match.teams[team].kit;
      const useKit = p.role === "GK" ? { shirt: kit.gk, number: kit.gkNumber } : { shirt: kit.shirt, number: kit.number };
      const tx = canvasTex(gl, makeLabelCanvas(p.no, p.label, useKit, { captain }));
      labelCache.set(key, tx);
      return tx;
    };

    // #134: キット背番号（胴メッシュ背面に描く番号）— キット番号色・透明背景。番号毎キャッシュ。
    const kitNumCache = new Map();
    const kitNumTex = (team, no, isGK) => {
      const key = `${team}:${no}:${isGK ? 1 : 0}`;
      const hit = kitNumCache.get(key);
      if (hit) return hit;
      const kit = match.teams[team].kit;
      const numCss = isGK ? (kit.gkNumber || "#F5F7FA") : (kit.number || "#F5F7FA");
      const cv = document.createElement("canvas");
      cv.width = 128; cv.height = 128;
      const g = cv.getContext("2d");
      g.textAlign = "center"; g.textBaseline = "middle";
      g.font = `800 ${no >= 10 ? 74 : 92}px -apple-system, 'Helvetica Neue', Arial, sans-serif`;
      // 視認性: キット色より暗い縁取り → 番号（キット番号色）
      g.lineWidth = 8; g.strokeStyle = "rgba(6,10,18,0.55)"; g.lineJoin = "round";
      g.strokeText(String(no), 64, 70, 118);
      g.fillStyle = numCss;
      g.fillText(String(no), 64, 70, 118);
      const tx = canvasTex(gl, cv);
      kitNumCache.set(key, tx);
      return tx;
    };

    const hex2rgb = (h) => {
      const v = parseInt(h.slice(1), 16);
      return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
    };

    /* ---------------------------- camera ---------------------------- */
    const cam = {
      mode: "orbit", theta: Math.PI / 2, phi: 0.62, dist: 78,
      target: [0, 0, 6], fov: 46,
      fly: { pos: [0, 22, 55], yaw: -Math.PI / 2, pitch: -0.32 },
      anim: null, followBall: false,
    };
    const PRESETS = {
      broadcast: { theta: Math.PI / 2, phi: 0.62, dist: 78, target: [0, 0, 6], fov: 46, followBall: false },
      tactical: { theta: Math.PI / 2, phi: 1.42, dist: 136, target: [0, 0, 0], fov: 40, followBall: false },
      goal: { theta: Math.PI + 0.0001, phi: 0.32, dist: 46, target: [-32, 0, 0], fov: 52, followBall: false },
      pitch: { theta: Math.PI / 2, phi: 0.16, dist: 26, target: [0, 0, 0], fov: 58, followBall: true },
    };
    const setPreset = (name, immediate) => {
      if (name === "fly") {
        const eye = eyePos();
        cam.fly.pos = [...eye];
        const d = [cam.target[0] - eye[0], cam.target[1] - eye[1], cam.target[2] - eye[2]];
        cam.fly.yaw = Math.atan2(d[2], d[0]);
        cam.fly.pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
        cam.mode = "fly";
        return;
      }
      const p = PRESETS[name];
      if (!p) return;
      cam.mode = "orbit";
      if (immediate) {
        cam.anim = null;
        cam.theta = p.theta; cam.phi = p.phi; cam.dist = p.dist;
        cam.fov = p.fov; cam.target = [...p.target];
      } else {
        cam.anim = { from: { theta: cam.theta, phi: cam.phi, dist: cam.dist, target: [...cam.target], fov: cam.fov }, to: p, u: 0 };
      }
      cam.followBall = p.followBall;
    };
    const eyePos = () => {
      if (cam.mode === "fly") return cam.fly.pos;
      const { theta, phi, dist, target } = cam;
      return [
        target[0] + Math.cos(theta) * Math.cos(phi) * dist,
        target[1] + Math.sin(phi) * dist,
        target[2] + Math.sin(theta) * Math.cos(phi) * dist,
      ];
    };

    // 入力
    const keys = new Set();
    let dragging = 0, lastX = 0, lastY = 0, moved = 0;
    // #105: マルチタッチ（2本指ピンチ=ズーム / 2本指パン）。1本指/マウスは従来どおり。
    const activePts = new Map();     // pointerId → {x,y}
    let pinchDist = 0, pinchMx = 0, pinchMy = 0, pinching = false;
    const twoPts = () => { const v = [...activePts.values()]; return [v[0], v[1]]; };
    canvas.addEventListener("pointerdown", (e) => {
      if (api.editMode) return;        // #82: 編集モード中はカメラ操作を抑止（UI側がドラッグを持つ）
      activePts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (activePts.size >= 2) {
        const [p1, p2] = twoPts();
        pinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        pinchMx = (p1.x + p2.x) / 2; pinchMy = (p1.y + p2.y) / 2;
        pinching = true; dragging = 0;    // 2本指開始: 単一ドラッグを解除
      } else {
        dragging = e.button === 2 || e.shiftKey ? 2 : 1;
        lastX = e.clientX; lastY = e.clientY; moved = 0;
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!activePts.has(e.pointerId)) return;
      activePts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // 2本指: ピンチ=ズーム + 中点移動=パン（fly 以外）
      if (pinching && activePts.size >= 2) {
        if (cam.mode !== "fly") {
          const [p1, p2] = twoPts();
          const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
          cam.anim = null;
          if (pinchDist > 0 && d > 0) cam.dist = clamp(cam.dist * (pinchDist / d), 9, 200);
          const s = cam.dist * 0.0016;
          const dx = mx - pinchMx, dy = my - pinchMy;
          const cx = Math.cos(cam.theta), sx = Math.sin(cam.theta);
          cam.target[0] = clamp(cam.target[0] + (-dx * sx + dy * cx) * s, -60, 60);
          cam.target[2] = clamp(cam.target[2] + (dx * cx + dy * sx) * s, -45, 45);
          cam.followBall = false;
          pinchDist = d; pinchMx = mx; pinchMy = my;
        }
        return;
      }
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (cam.mode === "fly") {
        cam.fly.yaw += dx * 0.0035;
        cam.fly.pitch = clamp(cam.fly.pitch - dy * 0.0032, -1.35, 1.35);
        return;
      }
      cam.anim = null;
      if (dragging === 2) {
        // パン（地表面基準）
        const s = cam.dist * 0.0016;
        const cx = Math.cos(cam.theta), sx = Math.sin(cam.theta);
        cam.target[0] += (-dx * sx + dy * cx) * s;
        cam.target[2] += (dx * cx + dy * sx) * s;
        cam.target[0] = clamp(cam.target[0], -60, 60);
        cam.target[2] = clamp(cam.target[2], -45, 45);
        cam.followBall = false;
      } else {
        cam.theta += dx * 0.005;
        cam.phi = clamp(cam.phi + dy * 0.004, 0.06, 1.52);
      }
    });
    const endPtr = (e) => {
      activePts.delete(e.pointerId);
      if (activePts.size < 2) pinching = false;
      if (activePts.size === 1) {
        const [p] = [...activePts.values()];
        lastX = p.x; lastY = p.y; dragging = 1; moved = 0;   // 残った指で旋回継続（ジャンプ防止）
      } else if (activePts.size === 0) {
        dragging = 0;
      }
    };
    canvas.addEventListener("pointerup", endPtr);
    canvas.addEventListener("pointercancel", endPtr);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (cam.mode === "fly") {
        api.flySpeed = clamp(api.flySpeed * (e.deltaY > 0 ? 0.88 : 1.14), 3, 90);
        return;
      }
      cam.anim = null;
      cam.dist = clamp(cam.dist * (e.deltaY > 0 ? 1.08 : 0.925), 9, 200);
    }, { passive: false });
    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => keys.delete(e.code));

    /* ---------------------------- draw utils ---------------------------- */
    let proj = M4.ident(), view = M4.ident(), eye = [0, 0, 0];
    const FOG = 340;

    const useLambert = (model, color, opts = {}) => {
      gl.useProgram(prLambert);
      gl.uniformMatrix4fv(U(prLambert, "uProj"), false, proj);
      gl.uniformMatrix4fv(U(prLambert, "uView"), false, view);
      gl.uniformMatrix4fv(U(prLambert, "uModel"), false, model);
      gl.uniform3fv(U(prLambert, "uColor"), color);
      gl.uniform3fv(U(prLambert, "uColor2"), opts.color2 || color);
      gl.uniform3fv(U(prLambert, "uEye"), eye);
      gl.uniform1f(U(prLambert, "uSplit"), opts.split ?? 0);
      gl.uniform1f(U(prLambert, "uEmiss"), opts.emiss ?? 0);
      gl.uniform1f(U(prLambert, "uFogD"), FOG);
      gl.uniform1f(U(prLambert, "uAlpha"), opts.alpha ?? 1);
    };
    // #154 スキンド描画: ボーンパレット（15×mat4）と色パレット（5×vec3）を渡して1ドロー
    const useSkin = (model, bones, pal, opts = {}) => {
      gl.useProgram(prSkin);
      gl.uniformMatrix4fv(U(prSkin, "uProj"), false, proj);
      gl.uniformMatrix4fv(U(prSkin, "uView"), false, view);
      gl.uniformMatrix4fv(U(prSkin, "uModel"), false, model);
      gl.uniformMatrix4fv(U(prSkin, "uBones[0]"), false, bones);
      gl.uniform3fv(U(prSkin, "uPal[0]"), pal);
      gl.uniform3fv(U(prSkin, "uEye"), eye);
      gl.uniform1f(U(prSkin, "uEmiss"), opts.emiss ?? 0);
      gl.uniform1f(U(prSkin, "uFogD"), FOG);
      gl.uniform1f(U(prSkin, "uAlpha"), opts.alpha ?? 1);
      setShadow(prSkin);   // #157 セルフ/被キャスト影
    };
    const drawMesh = (m) => {
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.n, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
    };
    const useTex = (model, tx, opts = {}) => {
      gl.useProgram(prTex);
      gl.uniformMatrix4fv(U(prTex, "uProj"), false, proj);
      gl.uniformMatrix4fv(U(prTex, "uView"), false, view);
      gl.uniformMatrix4fv(U(prTex, "uModel"), false, model);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.uniform1i(U(prTex, "uTex"), 0);
      gl.uniform3fv(U(prTex, "uEye"), eye);
      gl.uniform3fv(U(prTex, "uTint"), opts.tint || [1, 1, 1]);
      gl.uniform1f(U(prTex, "uAlpha"), opts.alpha ?? 1);
      gl.uniform1f(U(prTex, "uEmiss"), opts.emiss ?? 0);
      gl.uniform1f(U(prTex, "uFogD"), opts.fog ?? FOG);
      gl.uniform1f(U(prTex, "uShadowRecv"), opts.shadowRecv ? 1 : 0);   // #157 ピッチのみ影を受ける
      setShadow(prTex);
    };
    const useFlat = (model, color, opts = {}) => {
      gl.useProgram(prFlat);
      gl.uniformMatrix4fv(U(prFlat, "uProj"), false, proj);
      gl.uniformMatrix4fv(U(prFlat, "uView"), false, view);
      gl.uniformMatrix4fv(U(prFlat, "uModel"), false, model);
      gl.uniform3fv(U(prFlat, "uColor"), color);
      gl.uniform1f(U(prFlat, "uAlpha"), opts.alpha ?? 1);
      gl.uniform1f(U(prFlat, "uRing"), opts.ring ?? 0);
      gl.uniform1f(U(prFlat, "uSoft"), opts.soft ?? 0.25);
      gl.uniform1f(U(prFlat, "uRect"), opts.rect ?? 0);
    };
    // ビルボード行列（カメラに正対）
    const billboard = (x, y, z, w, h) => {
      const m = M4.ident();
      // ビュー行列の回転部の転置 = カメラ回転
      m[0] = view[0] * w; m[1] = view[4] * w; m[2] = view[8] * w;
      m[4] = view[1] * h; m[5] = view[5] * h; m[6] = view[9] * h;
      m[8] = view[2]; m[9] = view[6]; m[10] = view[10];
      m[12] = x; m[13] = y; m[14] = z;
      return m;
    };

    /* ------------------- 人型フィギュア（ゲイトつき低ポリ） ------------------- */
    // 肌・髪トーン（選手ごとに決定論選択 — 表示上の多様性のみ・実在特徴の推定ではない）
    const SKIN = [[0.95,0.80,0.62],[0.85,0.65,0.45],[0.66,0.47,0.31],[0.47,0.32,0.21]];
    const HAIR = [[0.10,0.09,0.08],[0.22,0.15,0.09],[0.05,0.05,0.06],[0.30,0.24,0.15]];
    const toneOf = (team, no) => {
      const u = N.hash2(N.seedOf(team + "skin"), no * 13 + 5);
      const i = Math.min(SKIN.length - 1, (u * SKIN.length) | 0);
      return { skin: SKIN[i], hair: HAIR[Math.min(HAIR.length - 1, ((u * 7919) % 1 * HAIR.length) | 0)] };
    };
    const REF_TONE = { skin: SKIN[1], hair: HAIR[0] };   // #154 審判（決定論・固定）
    // 描画側の歩容状態（向き・位相・速度）— 見た目のみ・データは純関数のまま
    const figState = new Map();
    const figOf = (key) => {
      let f = figState.get(key);
      if (!f) { f = { yaw: Math.PI / 2, phase: N.hash(N.seedOf(String(key))) * 6.28, v: 0, lx: null, lz: null }; figState.set(key, f); }   // #153: 位相は選手キー由来の決定論シード
      return f;
    };
    const lerpAngle = (a, b, u) => {
      let d = b - a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return a + d * u;
    };
    // 1フレームぶんのポーズ計算（歩容状態の更新込み）— #154 でカプセル/スキンドの
    // 両描画経路が共有する。数式は従来 drawFigure から移設（挙動・文脈ポーズは不変）。
    // 向きの規則: 走行=進行方向 / 低速後退=ボールを向いてバックペダル / 至近プレッサー
    // あり=ボールシールド（体を入れる）/ アイドル=ボール（なければ攻撃方向）。
    const figPose = (key, px, pz, dt, defYaw, bx, bz, ex, time) => {
      const f = figOf(key);
      if (f.lx == null) { f.lx = px; f.lz = pz; f.yaw = defYaw; }
      const dx = px - f.lx, dz = pz - f.lz;
      const dist = Math.hypot(dx, dz);
      let backpedal = false;
      const dbx = bx - px, dbz = bz - pz;
      const dBall = Math.hypot(dbx, dbz);
      const stumble = ex && ex.stumble ? ex.stumble : 0;
      const shield = ex && ex.shield ? ex.shield : null;
      const jump = ex && ex.jump ? ex.jump : 0;          // 0..1 ジャンプ弧の高さ（空中戦）
      const header = !!(ex && ex.header);                // 勝者=ヘディングの前傾
      if (dist > 6) { f.lx = px; f.lz = pz; f.v = 0; f.yaw = defYaw; f.pv = 0; f.acc = 0; }   // スクラブ・ジャンプ（#156: 加速度状態もリセット＝テレポート後のリーン揺れ回避）
      else if (dt > 0) {
        const vInst = Math.min(dist / dt, 10);
        f.v += (vInst - f.v) * Math.min(1, dt * 5);
        if (shield && f.v < 3) {
          // シールド: プレッサーへ背を向けボールと相手の間に体を入れる
          const target = Math.atan2(px - shield.x, pz - shield.z);
          f.yaw = lerpAngle(f.yaw, target, Math.min(1, dt * 4.5));
        } else if (f.v > 0.6 && dist > 0.002) {
          const dot = (dx * dbx + dz * dbz) / (dist * (dBall || 1));
          backpedal = dot < -0.35 && f.v < 4.5 && dBall < 45;
          const target = backpedal ? Math.atan2(dbx, dbz) : Math.atan2(dx, dz);
          f.yaw = lerpAngle(f.yaw, target, Math.min(1, dt * (backpedal ? 5 : 7)));
        } else if (f.v <= 0.6) {
          const target = dBall < 30 ? Math.atan2(dbx, dbz) : defYaw;
          f.yaw = lerpAngle(f.yaw, target, Math.min(1, dt * 2.2));
        }
        // ケイデンス: 歩き~0.9Hz → スプリント~1.6Hz（ストライド）
        f.phase += dt * (4.2 + f.v * 0.85) * (f.v > 0.3 ? 1 : 0.25);
        f.lx = px; f.lz = pz;
      }
      const run = clamp(f.v / 6, 0, 1);
      const gaitAmp = (backpedal ? 0.55 : 1) * (1 - jump);    // ジャンプ中は走行スイングを畳む
      const hipA = (0.10 + 0.75 * run) * gaitAmp;             // 股スイング振幅
      const kneeB = 0.35 + 1.05 * run;                        // 膝屈曲（走りほど深い）
      const lean = jump > 0.05 ? (header ? 0.28 * jump : 0.05)  // 空中戦: 勝者はヘッドで前傾
        : stumble > 0 ? 0.15 + 0.55 * Math.sin(stumble * Math.PI)
        : backpedal ? -0.04 : 0.03 + run * run * 0.36;        // 歩き=直立/走り=強い前傾
      const lift = jump * 0.85;                               // 跳躍の垂直変位（描画のみ）
      const bob = Math.abs(Math.cos(f.phase)) * (0.012 + 0.055 * run) - (stumble > 0 ? 0.10 * stumble : 0) + lift;
      const base = M4.trs(px, bob, pz, 1, 1, 1, f.yaw);      // capsule（従来・bob込み）
      const baseFlat = M4.trs(px, 0, pz, 1, 1, 1, f.yaw);    // skinned（足接地・bob は骨盤スウェイ swayY へ）
      // 上半身: 前傾 + 脚と逆位相のひねり（肩の回旋 — 人形っぽさを消す）
      const twist = Math.sin(f.phase) * (0.05 + 0.16 * run) * gaitAmp;
      const upper = M4.chain(base, M4.t(0, 0.90, 0), M4.rotX(lean), M4.trs(0, 0, 0, 1, 1, 1, twist));
      const side = (s) => {
        const phi = f.phase + (s < 0 ? Math.PI : 0);
        // ジャンプ中は両脚をやや前へ畳む（踏み切り/滞空のシルエット）・両腕を上げて競り合う
        const hip = jump > 0.05 ? -0.35 * jump + Math.sin(phi) * hipA : Math.sin(phi) * hipA;
        const knee = jump > 0.05 ? 0.5 * jump + kneeB * Math.max(0, Math.sin(phi - 1.85)) * gaitAmp
          : kneeB * Math.max(0, Math.sin(phi - 1.85)) * gaitAmp;
        const armSw = jump > 0.05 ? -1.9 * jump - s * 0.25 * jump
          : -s * Math.sin(f.phase) * (0.10 + 0.78 * run) * gaitAmp - (stumble > 0 ? 0.9 * stumble : 0);
        const elbow = jump > 0.05 ? 0.3 : 0.45 + run * 1.05 + (stumble > 0 ? 0.4 * stumble : 0);
        return { hip, knee, armSw, elbow };
      };
      const L = side(-1), R = side(1);

      // ================= #156 リッチアニメ（スキンド経路用・決定論） =================
      const tSec = time || 0;
      const kick = ex && ex.kick ? clamp(ex.kick, 0, 1) : 0;      // 0..1 キック包絡
      const kickLeg = ex && ex.kickLeg ? ex.kickLeg : 1;          // 蹴り足（±1）
      const normalMode = jump < 0.05 && stumble < 0.05;          // 通常接地（IK対象）
      // 加速度（ローパス）→ アンティシペーション前傾
      const accNow = (dt > 0 && dist <= 6) ? clamp((f.v - (f.pv ?? f.v)) / Math.max(dt, 1e-3), -12, 12) : 0;
      f.pv = f.v;
      f.acc = (f.acc ?? 0) + (accNow - (f.acc ?? 0)) * (dt > 0 ? Math.min(1, dt * 2.5) : 1);
      // 重心スウェイ＋呼吸（アイドルでも静止しない）: 横=歩容 / 縦=bob+呼吸 / 前後=加速リーン
      const koff = N.hash(N.seedOf(String(key) + "|br")) * 6.28;
      const idleAmt = clamp(1 - f.v / 0.7, 0, 1);
      const breath = Math.sin(tSec * 1.55 + koff) * 0.009 * idleAmt;
      const idleSway = Math.sin(tSec * 0.8 + koff) * 0.012 * idleAmt;
      const swayX = Math.sin(f.phase) * 0.018 * run * gaitAmp + idleSway;
      const swayY = bob + breath;
      const swayZ = clamp(-f.acc * 0.010, -0.045, 0.045);
      // フットIK: ストライドを速度から算出（支持脚を世界固定＝スケーティング解消・footPlace が核）
      const REST_ANKLE = 0.085;
      const ikOf = (s) => {
        const ft = footPlace(f.phase, f.v, s);
        const r = solveLegIK(0.94 + swayY, swayZ, REST_ANKLE + ft.fy, swayZ + ft.fz);
        // キック足: フライト開始で前方へ振り抜く。IK姿勢から swing で補間（swing=0 の開始/終端は
        // IK姿勢に一致＝入りも抜けも連続・#156 の1フレーム飛びを解消）。
        if (kick > 0.02 && s === kickLeg) {
          const swing = Math.sin(clamp(kick, 0, 1) * Math.PI);          // 0→1→0 の振り
          return { hip: lerp(r.hip, -1.25, swing), knee: lerp(r.knee, 0.15, swing) };
        }
        return { hip: r.hip, knee: r.knee };
      };
      const ikL = normalMode ? ikOf(-1) : { hip: L.hip, knee: L.knee };
      const ikR = normalMode ? ikOf(1) : { hip: R.hip, knee: R.knee };
      // 注視（look-at）: 頭・首・胸でボール/進行方向へ（角度クランプ・首肩に分配）
      let lookYaw = 0, lookPitch = 0;
      if (jump < 0.05) {
        const tgtYaw = dBall < 42 ? Math.atan2(dbx, dbz) : f.yaw;
        let dyaw = tgtYaw - f.yaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2; while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        lookYaw = clamp(dyaw, -1.0, 1.0);                              // 頭+首の合計ヨー（±57°）
        lookPitch = clamp((dBall < 14 ? 0.14 : 0.02) - kick * 0.15, -0.32, 0.32);
      } else if (header) { lookPitch = -0.2 * jump; }                   // 空中戦の勝者は上を見る
      // キック時の前傾（蹴り足の振りに同調）
      const kickLean = kick > 0.02 ? 0.22 * Math.sin(clamp(kick, 0, 1) * Math.PI) : 0;

      return {
        f, base, baseFlat, upper, run, gaitAmp, lean: lean + kickLean, bob, twist, jump, header, stumble, backpedal,
        L, R, ikL, ikR, swayX, swayY, swayZ, lookYaw, lookPitch, normalMode,
      };
    };
    // #134/#154: キット背番号 — 胴の背面クワッド。model は各描画経路が胴の背面に合わせて構築する。
    const drawKitNum = (model, numTx, jump, alpha) => {
      if (!numTx || jump >= 0.5) return;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      useTex(model, numTx, { alpha: alpha * 0.98, fog: 1e9, emiss: 0.06 });
      drawMesh(mVQuad);
      gl.disable(gl.BLEND);
    };
    // カプセル胴（upper 基準・従来位置）とスキンド胴（胸ボーン基準・絶対座標）で背面アンカーが異なる
    const kitNumCapsule = (upper) => M4.chain(upper, M4.t(0, 0.16, -0.212), M4.roty(Math.PI), M4.scale(0.44, 0.5, 1));
    const kitNumSkinned = (base, chestMat) => M4.chain(base, chestMat, M4.t(0, 1.38, -0.20), M4.roty(Math.PI), M4.scale(0.40, 0.46, 1));
    const legMix = (tone, shorts) =>
      [tone.skin[0] * 0.45 + shorts[0] * 0.55, tone.skin[1] * 0.45 + shorts[1] * 0.55, tone.skin[2] * 0.45 + shorts[2] * 0.55];
    // 旧経路（カプセル寄せ集め）— #154 移行期の切り戻し用に温存（?fig=capsule）。VIS-02 完了後に撤去予定。
    const drawFigureCapsule = (key, px, pz, dt, shirt, shorts, tone, alpha, defYaw, bx, bz, ex, numTx, time) => {
      const P = figPose(key, px, pz, dt, defYaw, bx, bz, ex, time);
      const op = { emiss: 0.04, alpha };
      const legC = legMix(tone, shorts);
      for (const s of [-1, 1]) {
        const g = s < 0 ? P.L : P.R;
        const hipT = M4.chain(P.base, M4.t(s * 0.13, 0.94, 0), M4.rotX(g.hip));
        useLambert(M4.chain(hipT, M4.t(0, -0.48, 0), M4.scale(0.105, 0.48, 0.105)), legC, op);
        drawMesh(mCapsule);
        useLambert(M4.chain(hipT, M4.t(0, -0.48, 0), M4.rotX(g.knee), M4.t(0, -0.44, 0), M4.scale(0.088, 0.44, 0.088)), legC, op);
        drawMesh(mCapsule);
      }
      useLambert(M4.chain(P.base, M4.t(0, 0.68, 0), M4.scale(0.21, 0.36, 0.185)), shorts, op);
      drawMesh(mCapsule);
      useLambert(M4.chain(P.upper, M4.scale(0.265, 0.72, 0.205)), shirt, op);
      drawMesh(mCapsule);
      drawKitNum(kitNumCapsule(P.upper), numTx, P.jump, alpha);
      const headY = P.bob + 0.90 + 0.80 * Math.cos(P.lean);
      useLambert(
        M4.chain(P.upper, M4.trs(0, 0, 0, 1, 1, 1, -P.twist * 0.6), M4.t(0, 0.80, 0.04), M4.scale(0.16, 0.175, 0.16)),
        tone.hair, { color2: tone.skin, split: headY - 0.02, emiss: 0.03, alpha });
      drawMesh(mSphere);
      for (const s of [-1, 1]) {
        const g = s < 0 ? P.L : P.R;
        const shoulder = M4.chain(P.upper, M4.t(s * 0.30, 0.60, 0), M4.rotX(g.armSw));
        useLambert(M4.chain(shoulder, M4.t(0, -0.30, 0), M4.scale(0.070, 0.30, 0.070)), tone.skin, op);
        drawMesh(mCapsule);
        useLambert(M4.chain(shoulder, M4.t(0, -0.30, 0), M4.rotX(-g.elbow), M4.t(0, -0.27, 0), M4.scale(0.060, 0.27, 0.060)), tone.skin, op);
        drawMesh(mCapsule);
      }
      return P.f.v;
    };
    // #154 新経路: 単一スキンドメッシュ1回描画（関節球なし・膝/肘/股/脊椎で表面が連続）
    const skinPal = new Float32Array(18);       // 6色 × vec3
    const BOOT_COL = [0.09, 0.09, 0.105];
    const drawFigureSkinned = (key, px, pz, dt, shirt, shorts, tone, alpha, defYaw, bx, bz, ex, numTx, time) => {
      const P = figPose(key, px, pz, dt, defYaw, bx, bz, ex, time);
      const legC = legMix(tone, shorts);
      skinPal.set(shirt, 0); skinPal.set(shorts, 3); skinPal.set(tone.skin, 6);
      skinPal.set(tone.hair, 9); skinPal.set(legC, 12); skinPal.set(BOOT_COL, 15);
      const bones = poseSkin({
        lean: P.lean, twist: P.twist,
        swayX: P.swayX, swayY: P.swayY, swayZ: P.swayZ,      // #156 重心スウェイ（bob込み・呼吸）
        lookYaw: P.lookYaw, lookPitch: P.lookPitch,           // #156 注視
        hipL: P.ikL.hip, kneeL: P.ikL.knee, hipR: P.ikR.hip, kneeR: P.ikR.knee,   // #156 フットIK
        swL: P.L.armSw, elL: P.L.elbow, swR: P.R.armSw, elR: P.R.elbow,
      });
      // 体格スケールを baseFlat（足接地・bob抜き）に折り込む（接地は保存・番号も同スケール）
      const bv = bodyVarOf(key);
      const sbase = M4.chain(P.baseFlat, M4.scale(bv.w, bv.h, bv.w));
      useSkin(sbase, bones, skinPal, { emiss: 0.04, alpha });
      drawMesh(mSkinBody);
      // 背番号は胸ボーンに追従（bones の chest=index2 スキン行列で胴の傾き/ひねり/スウェイに乗る）
      drawKitNum(kitNumSkinned(sbase, bones.slice(2 * 16, 2 * 16 + 16)), numTx, P.jump, alpha);
      return P.f.v;
    };
    let figCapsuleMode = false;   // frame() で scene.options.figCapsule から更新（切り戻しフラグ）
    const drawFigure = (...a) => (figCapsuleMode ? drawFigureCapsule : drawFigureSkinned)(...a);

    /* ---------------------------- static world ---------------------------- */
    const heatColorPos = hex2rgb("#FF9D2E");   // plus側（可視ランプの起点）
    const heatColorPos2 = hex2rgb("#FF3B2E");
    const heatColorNeg = hex2rgb("#3F8CFF");
    const heatColorNeg2 = hex2rgb("#7FE7FF");

    const updateHeat = (field, gain) => {
      const img = heatCtx.createImageData(42, 28);
      // フレーム内ソフト正規化: 低ブロック時（積が全域で微小）でも構造を可視化
      let maxAbs = 0;
      for (let i = 0; i < field.grid.length; i++) {
        const av = Math.abs(field.grid[i]);
        if (av > maxAbs) maxAbs = av;
      }
      const norm = 1 / Math.max(0.14, maxAbs);
      for (let i = 0; i < field.grid.length; i++) {
        const v = field.grid[i] * norm;
        const a = clamp(Math.pow(Math.abs(v) * gain * 0.42, 0.8), 0, 1);
        let r, g2, b;
        if (v >= 0) {
          r = lerp(heatColorPos[0], heatColorPos2[0], a) * 255;
          g2 = lerp(heatColorPos[1], heatColorPos2[1], a) * 255;
          b = lerp(heatColorPos[2], heatColorPos2[2], a) * 255;
        } else {
          r = lerp(heatColorNeg[0], heatColorNeg2[0], a) * 255;
          g2 = lerp(heatColorNeg[1], heatColorNeg2[1], a) * 255;
          b = lerp(heatColorNeg[2], heatColorNeg2[2], a) * 255;
        }
        img.data[i * 4] = r; img.data[i * 4 + 1] = g2; img.data[i * 4 + 2] = b;
        img.data[i * 4 + 3] = a * 175;
      }
      heatCtx.putImageData(img, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, txHeat);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, heatCv);
    };

    const drawWorld = (time) => {
      // 空
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(prSky);
      gl.uniform1f(U(prSky, "uT"), time);
      gl.bindVertexArray(skyVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.enable(gl.DEPTH_TEST);

      // ピッチ（#157: 影を受ける = 選手の人型キャストシャドウ）
      useTex(M4.trs(0, 0, 0, 118, 1, 80), txPitch, { shadowRecv: 1 });
      drawMesh(mQuad);

      // スタンド（4面 + 角度）
      for (const [x, z, w, ry] of [
        [0, 58, 150, 0], [0, -58, 150, Math.PI],
        [78, 0, 110, Math.PI / 2], [-78, 0, 110, -Math.PI / 2],
      ]) {
        const m = M4.mul(M4.trs(x, 7, z, 1, 1, 1, ry), M4.trs(0, 0, 0, w, 15, 1));
        // vquad は XY 平面 → ry回転で向ける
        useTex(m, txCrowd, { emiss: 0.12 });
        drawMesh(mVQuad);
      }
      // 広告ボード
      for (const [x, z, w, ry] of [
        [0, 41.5, 118, 0], [0, -41.5, 118, Math.PI],
        [59, 0, 82, Math.PI / 2], [-59, 0, 82, -Math.PI / 2],
      ]) {
        const m = M4.mul(M4.trs(x, 0.55, z, 1, 1, 1, ry), M4.trs(0, 0, 0, w, 1.1, 1));
        useTex(m, txAd, { emiss: 0.55, alpha: 0.96 });
        drawMesh(mVQuad);
      }
      // フラッドライト（グロー）
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      for (const [x, z] of [[-88, 66], [88, 66], [-88, -66], [88, -66]]) {
        useTex(billboard(x, 34, z, 26, 26), txGlow, { alpha: 0.85, fog: 1e9 });
        drawMesh(mVQuad);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);

      // ゴール（±X）
      for (const s of [-1, 1]) {
        const white = [0.93, 0.95, 0.99];
        const px = s * 52.5;
        for (const gy of [-3.66, 3.66]) {
          useLambert(M4.trs(px, 1.22, gy, 0.09, 2.44, 0.09), white, { emiss: 0.25 });
          drawMesh(mBox);
        }
        useLambert(M4.trs(px, 2.44, 0, 0.09, 0.09, 7.5), white, { emiss: 0.25 });
        drawMesh(mBox);
        // ネット（背面+屋根）
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        const back = M4.mul(M4.trs(px + s * 1.7, 1.1, 0, 1, 1, 1, Math.PI / 2), M4.trs(0, 0, 0, 7.4, 2.2, 1));
        useTex(back, txNet, { alpha: 0.5 });
        drawMesh(mVQuad);
        const roof = M4.mul(M4.trs(px + s * 0.85, 2.42, 0, 1.7 / 7.4, 1, 1), M4.trs(0, 0, 0, 7.4, 1, 7.4));
        useTex(roof, txNet, { alpha: 0.45 });
        drawMesh(mQuad);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
    };

    /* ---------------------------- frame ---------------------------- */
    const api = {
      cam, setPreset, flySpeed: 22,
      dpr: Math.min(window.devicePixelRatio || 1, 2),
    };

    // #134: ゴール・リプレイ用カメラ — 得点した側のゴール裏低めから。side>=0 で +X 端、<0 で −X 端。
    // 純カメラ演出（stateAt/アンカーのみ参照・SIM 非改変）。
    api.replayCam = (side, immediate) => {
      const to = {
        theta: side >= 0 ? 0.0001 : Math.PI + 0.0001,
        phi: 0.30, dist: 44, target: [side >= 0 ? 33 : -33, 0, 0], fov: 52, followBall: false,
      };
      cam.mode = "orbit"; cam.followBall = false;
      if (immediate) {
        cam.anim = null;
        cam.theta = to.theta; cam.phi = to.phi; cam.dist = to.dist; cam.fov = to.fov; cam.target = [...to.target];
      } else {
        cam.anim = { from: { theta: cam.theta, phi: cam.phi, dist: cam.dist, target: [...cam.target], fov: cam.fov }, to, u: 0 };
      }
    };

    api.resize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = Math.round(w * api.dpr);
      canvas.height = Math.round(h * api.dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    let lastHeat = -1;
    api.frame = (time, dt, scene) => {
      const { state, field, options, selected, hover } = scene;
      figCapsuleMode = !!(options && options.figCapsule);   // #154 切り戻しフラグ（?fig=capsule）
      // カメラ更新
      if (cam.anim) {
        cam.anim.u = Math.min(1, cam.anim.u + dt / 1.15);
        const u = cam.anim.u < 0.5 ? 2 * cam.anim.u * cam.anim.u : 1 - Math.pow(-2 * cam.anim.u + 2, 2) / 2;
        const { from, to } = cam.anim;
        cam.theta = lerp(from.theta, to.theta, u);
        cam.phi = lerp(from.phi, to.phi, u);
        cam.dist = lerp(from.dist, to.dist, u);
        cam.fov = lerp(from.fov, to.fov, u);
        for (let i = 0; i < 3; i++) cam.target[i] = lerp(from.target[i], to.target[i], u);
        if (cam.anim.u >= 1) cam.anim = null;
      }
      if (cam.followBall && cam.mode === "orbit" && !cam.anim) {
        const k = Math.min(1, dt * 2.2);
        cam.target[0] += (state.ball.x - cam.target[0]) * k;
        cam.target[2] += (-state.ball.y - cam.target[2]) * k;   // 幅軸は worldZ=-fieldY
      }
      if (cam.mode === "fly") {
        const sp = api.flySpeed * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 2.6 : 1) * dt;
        const cy = Math.cos(cam.fly.yaw), sy = Math.sin(cam.fly.yaw);
        const cp = Math.cos(cam.fly.pitch), spt = Math.sin(cam.fly.pitch);
        const fwd = [cy * cp, spt, sy * cp], right = [-sy, 0, cy];
        const mv = (v, k) => { cam.fly.pos[0] += v[0] * k; cam.fly.pos[1] += v[1] * k; cam.fly.pos[2] += v[2] * k; };
        if (keys.has("KeyW")) mv(fwd, sp);
        if (keys.has("KeyS")) mv(fwd, -sp);
        if (keys.has("KeyA")) mv(right, -sp);
        if (keys.has("KeyD")) mv(right, sp);
        if (keys.has("KeyQ")) cam.fly.pos[1] -= sp;
        if (keys.has("KeyE")) cam.fly.pos[1] += sp;
        cam.fly.pos[0] = clamp(cam.fly.pos[0], -160, 160);
        cam.fly.pos[1] = clamp(cam.fly.pos[1], 0.6, 130);
        cam.fly.pos[2] = clamp(cam.fly.pos[2], -120, 120);
      }

      eye = eyePos();
      const asp = canvas.width / Math.max(1, canvas.height);
      proj = M4.persp((cam.fov * Math.PI) / 180, asp, 0.3, 900);
      if (cam.mode === "fly") {
        const cy = Math.cos(cam.fly.yaw), sy = Math.sin(cam.fly.yaw);
        const cp = Math.cos(cam.fly.pitch), spt = Math.sin(cam.fly.pitch);
        view = M4.lookAt(eye, [eye[0] + cy * cp, eye[1] + spt, eye[2] + sy * cp], [0, 1, 0]);
      } else {
        view = M4.lookAt(eye, cam.target, [0, 1, 0]);
      }

      // #157 影の深度パス（Cinematic tier のみ・FBO あり）: 選手プロキシ（胴＋頭）を光源空間で深度描画。
      // これで芝が人型のキャストシャドウを受ける。セルフ遮蔽は頂点AOが担う（プロキシ自己影の破綻回避）。
      shadowOn = !!(shadowFBO && R.quality && R.quality.flags && R.quality.flags.shadowMap);
      if (shadowOn) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFBO);
        gl.viewport(0, 0, SHADOW_RES, SHADOW_RES);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.useProgram(prDepth);
        gl.uniformMatrix4fv(U(prDepth, "uLightMVP"), false, lightMVP);
        for (const p of state.players) {
          if (!p.onPitch || (p.leaving && p.leaving > 0.9)) continue;
          const px = p.x, pz = -p.y;
          // 胴＋脚のプロキシ（立ち姿ベース）＋頭。ポーズ追従はしないが体型の人型影になる。
          gl.uniformMatrix4fv(U(prDepth, "uModel"), false, M4.trs(px, 0.95, pz, 0.28, 0.95, 0.24));
          drawMesh(mCapsule);
          gl.uniformMatrix4fv(U(prDepth, "uModel"), false, M4.trs(px, 1.72, pz, 0.14, 0.16, 0.14));
          drawMesh(mSphere);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.activeTexture(gl.TEXTURE1);              // ユニット1に影テクスチャを常設
        gl.bindTexture(gl.TEXTURE_2D, shadowTex);
        gl.activeTexture(gl.TEXTURE0);
      }

      // #159 ポスト有効時はシーンをオフスクリーンへ（?post=0・shotframes無関係で常時可）
      const postOn = urlPost && ensurePost(canvas.width, canvas.height);
      if (postOn) { gl.bindFramebuffer(gl.FRAMEBUFFER, post.fbo); gl.viewport(0, 0, post.w, post.h); }

      gl.clearColor(0.043, 0.066, 0.118, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);

      drawWorld(time);

      // 危険場 — 面モード（テクスチャ）
      if (options.fieldMode === "surface" && field) {
        if (time - lastHeat > 0.12) { updateHeat(field, options.heatGain ?? 2.6); lastHeat = time; }
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        useTex(M4.trs(0, 0.06, 0, 105, 1, -68), txHeat, { alpha: 0.9, fog: 1e9 });  // 幅軸反転
        drawMesh(mQuad);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      // 危険ホットゾーン矩形（WARNING以上 — 放送グラフィクスのエリア強調）
      if (scene.hotZone) {
        const hz = scene.hotZone;
        const pulse = 0.8 + 0.2 * Math.sin(time * 2.6);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        // 面のウォッシュ + 枠線（角丸矩形リング）
        useFlat(M4.trs(hz.x, 0.05, -hz.y, hz.w, 1, hz.h), hz.color, { alpha: hz.alpha * 0.55 * pulse, soft: 0.5, rect: 1 });
        drawMesh(mQuad);
        useFlat(M4.trs(hz.x, 0.055, -hz.y, hz.w, 1, hz.h), hz.color, { alpha: hz.alpha * 1.6 * pulse, ring: 0.97, soft: 0.03, rect: 1 });
        drawMesh(mQuad);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      /* ---- 粒子場の構築（ゾーニング + 危険場粒子モード） ---- */
      partReset();
      const zoneView = scene.zoneView || "BOTH";
      if (scene.zone && options.zones) {
        const z = scene.zone;
        const selKey = selected ? selected.team + ":" + selected.no : null;
        const colOf = {}, lumaOf = {};
        for (const k of Object.keys(match.teams)) {
          const c = hex2rgb(match.teams[k].color);
          colOf[k] = c;
          // 知覚輝度の低い色（青系）は加算アルファを補償
          const luma = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
          lumaOf[k] = clamp(0.55 / Math.max(luma, 0.2), 1, 1.9);
        }
        for (let j = 0; j < z.ny; j++) for (let i = 0; i < z.nx; i++) {
          const idx = j * z.nx + i;
          const own = z.players[z.owner[idx]];
          if (!own) continue;
          const conf = z.conf ? z.conf[idx] : 1;    // 選手不在の空域は光らせない
          if (conf < 0.1) continue;
          const mag = Math.abs(z.grid[idx]);
          const ownTeam = own.team;
          let w = conf;
          if (zoneView !== "BOTH") w *= ownTeam === zoneView ? 1 : 0.12;
          const isSel = selKey && ownTeam + ":" + own.no === selKey;
          if (mag * conf < 0.06 && !isSel) continue;
          const cx = -52.5 + ((i + 0.5) / z.nx) * 105;
          const cy = 34 - ((j + 0.5) / z.ny) * 68;   // 幅軸 worldZ=-fieldY
          // フロンティア: 所有チームが隣接セルで入れ替わる境界 = ゾーンの継ぎ目
          const rT = i + 1 < z.nx ? z.players[z.owner[idx + 1]] : null;
          const dT = j + 1 < z.ny ? z.players[z.owner[idx + z.nx]] : null;
          const frontier = (rT && rT.team !== ownTeam) || (dT && dT.team !== ownTeam);
          const phase = ((i * 7 + j * 13) % 97) / 97;
          if (frontier) {
            partPush(cx, 0.6, cy, 1.4, phase, 0.78, 0.85, 0.98, 0.38 * Math.max(conf, 0.25));
          } else {
            const c = colOf[ownTeam];
            const a = (0.03 + Math.pow(mag, 1.3) * 0.3) * w * lumaOf[ownTeam] * (isSel ? 2.6 : 1);
            partPush(cx, 0.34 + mag * 0.5, cy, 1.1 + mag * 1.0 + (isSel ? 0.55 : 0), phase,
              c[0], c[1], c[2], a);
          }
        }
      }
      if (field && options.fieldMode === "particles") {
        let maxAbs = 0;
        for (let i = 0; i < field.grid.length; i++) {
          const av = Math.abs(field.grid[i]);
          if (av > maxAbs) maxAbs = av;
        }
        const norm = 1 / Math.max(0.14, maxAbs);
        const gain = options.heatGain ?? 2.6;
        for (let j = 0; j < field.ny; j++) for (let i = 0; i < field.nx; i++) {
          const v = field.grid[j * field.nx + i] * norm;
          const a0 = clamp(Math.pow(Math.abs(v) * gain * 0.42, 0.8), 0, 1);
          if (a0 < 0.06) continue;
          const cx = -52.5 + ((i + 0.5) / field.nx) * 105;
          const cy = 34 - ((j + 0.5) / field.ny) * 68;   // 幅軸 worldZ=-fieldY
          const cA = v >= 0 ? heatColorPos : heatColorNeg;
          const cB = v >= 0 ? heatColorPos2 : heatColorNeg2;
          const r = lerp(cA[0], cB[0], a0), g2 = lerp(cA[1], cB[1], a0), b = lerp(cA[2], cB[2], a0);
          // 危険度に応じて粒子柱がせり上がる（空間プラグインの粒状リバーブ感）
          const layers = 1 + Math.min(2, Math.floor(a0 * 2.6));
          const phase = ((i * 11 + j * 17) % 89) / 89;
          for (let L = 0; L < layers; L++) {
            partPush(cx, 0.7 + L * (0.75 + a0 * 0.95) + a0 * 0.6, cy,
              1.25 + a0 * 1.6 - L * 0.2, phase + L * 0.31,
              r, g2, b, a0 * (0.5 - L * 0.13));
          }
        }
      }

      // 軌跡（ボール = 光跡コメット / 選手 = 点線ラントレイル）
      if (options.trails && scene.ballTrail) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        const tr = scene.ballTrail;
        for (let i = 1; i < tr.length; i++) {
          const u = i / tr.length;
          const a = Math.pow(u, 1.5) * 0.85;               // テール減衰 → ヘッド輝き
          const s = 0.22 + u * 0.72;
          useFlat(M4.trs(tr[i].x, 0.09 + (tr[i].z || 0) * 0.5, -tr[i].y, s, 1, s), [0.86, 0.93, 1], { alpha: a, soft: 0.85 });
          drawMesh(mQuad);
        }
        if (scene.playerTrail) {
          // 等間隔ドット（点線）: 走路の見た目を放送グラフィクスに揃える
          const pt = scene.playerTrail;
          let acc = 0;
          for (let i = 1; i < pt.length; i++) {
            const d = Math.hypot(pt[i].x - pt[i - 1].x, pt[i].y - pt[i - 1].y);
            acc += d;
            if (acc < 1.4) continue;
            acc = 0;
            const u = i / pt.length;
            useFlat(M4.trs(pt[i].x, 0.09, -pt[i].y, 0.42, 1, 0.42), pt.color, { alpha: 0.15 + u * 0.75, soft: 0.35 });
            drawMesh(mQuad);
          }
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      // パスライン（フライト中の点線 — カット=赤系・ボール付近が明るい・受け手にリング）
      if (scene.passLine) {
        const pl = scene.passLine;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        const dx = pl.x2 - pl.x1, dy = pl.y2 - pl.y1;
        const len = Math.hypot(dx, dy);
        const nDots = Math.max(2, Math.floor(len / 1.5));
        const col = pl.cut ? [1, 0.42, 0.32] : [0.85, 0.92, 1];
        for (let i = 0; i <= nDots; i++) {
          const uD = i / nDots;
          const a2 = 0.10 + 0.55 * Math.max(0, 1 - Math.abs(uD - pl.u) * 2.6);
          useFlat(M4.trs(pl.x1 + dx * uD, 0.1, -(pl.y1 + dy * uD), 0.34, 1, 0.34), col, { alpha: a2, soft: 0.4 });
          drawMesh(mQuad);
        }
        useFlat(M4.trs(pl.x2, 0.05, -pl.y2, 3.2, 1, 3.2), col, { alpha: 0.5 * (0.35 + 0.65 * pl.u), ring: 0.8, soft: 0.12 });
        drawMesh(mQuad);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      // PSY オーラ（選択選手の覚醒状態 — 低:青 / 至適:金 / 過覚醒:赤）
      if (scene.psyAura) {
        const au = scene.psyAura;
        const pulse = 0.75 + 0.25 * Math.sin(time * (2.2 + au.k * 3.4));
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        useFlat(M4.trs(au.x, 0.045, -au.y, 5.4 + au.k * 1.2, 1, 5.4 + au.k * 1.2), au.color,
          { alpha: (0.3 + 0.45 * au.k) * pulse, ring: 0.86, soft: 0.16 });
        drawMesh(mQuad);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      // 選手（奥→手前ソートで半透明カプセル — 透明感）
      const contribMap = scene.contribMap || new Map();
      // #156 キック検出: フライト中の出し手（from）に振り抜き包絡を与える（u=進行度＝時刻の関数・決定論）
      let kicker = null, kickEnv = 0;
      if (state.carrier && state.carrier.mode === "flight" && state.carrier.from) {
        const u = state.carrier.u || 0;
        if (u < 0.34) { kicker = state.carrier.from.team + ":" + state.carrier.from.no; kickEnv = 1 - u / 0.34; }
      }
      const sorted = state.players.slice().sort((a, b) => {
        const da = (eye[0] - a.x) ** 2 + (eye[2] + a.y) ** 2;   // 幅軸 worldZ=-fieldY
        const db = (eye[0] - b.x) ** 2 + (eye[2] + b.y) ** 2;
        return db - da;
      });
      // ソフト分離（描画のみ）: 近接ペアの体の重なりを押し離す — データ座標は不変
      const sepMap = new Map();
      {
        const on = state.players.filter(p => p.onPitch);
        for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
          const a = on[i], b = on[j];
          const ddx = b.x - a.x, ddy = b.y - a.y;
          const d = Math.hypot(ddx, ddy);
          if (d >= 0.6 || d < 1e-4) continue;
          const push = Math.min(0.3, (0.6 - d) * 0.5);
          const ux = ddx / d, uy = ddy / d;
          const ka = a.team + ":" + a.no, kb = b.team + ":" + b.no;
          const sa = sepMap.get(ka) || { x: 0, y: 0 };
          const sb = sepMap.get(kb) || { x: 0, y: 0 };
          sa.x -= ux * push; sa.y -= uy * push;
          sb.x += ux * push; sb.y += uy * push;
          sepMap.set(ka, sa); sepMap.set(kb, sb);
        }
      }
      const bodyAlpha = options.solidPlayers ? 1 : 0.87;
      for (const p of sorted) {
        const T = match.teams[p.team];
        const isGK = p.role === "GK";
        const shirt = hex2rgb(isGK ? T.kit.gk : T.kit.shirt);
        const shorts = hex2rgb(isGK ? T.kit.gk : T.kit.shorts);
        const alpha = p.leaving ? 1 - p.leaving * 0.9 : 1;
        if (alpha <= 0.05) continue;
        const px = p.x, pz = -p.y;   // 幅軸 worldZ=-fieldY（放送/コーチボード慣習に一致）

        // #134: 接地ソフト影 — ジャンプ中（空中戦）は縮小・減衰（浮いた説得力）。
        const figJump = scene.aerial
          ? (p.team + ":" + p.no === scene.aerial.winnerKey ? scene.aerial.jumpH
            : p.team + ":" + p.no === scene.aerial.loserKey ? scene.aerial.jumpH * 0.6 : 0)
          : 0;
        const shScale = 1.6 * (1 - 0.45 * figJump);       // 空中ほど小さく
        const shAlpha = (0.42 - 0.24 * figJump) * alpha;  // 空中ほど薄く

        // 影・リング（地面レイヤ）
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        // #157 円盤影はシャドウマップ無効時のみ（有効時はキャストシャドウと二重にしない）
        if (!shadowOn) { useFlat(M4.trs(px, 0.02, pz, shScale, 1, shScale), [0, 0, 0], { alpha: shAlpha, soft: 0.62 }); drawMesh(mQuad); }
        // 危険度リング（攻撃寄与）
        const cv = contribMap.get(p.team + p.no) || 0;
        if (cv > 0.12) {
          const rc = p.team === (match.possessionPlus || "BRA") ? [1, 0.62, 0.15] : [0.32, 0.62, 1];
          useFlat(M4.trs(px, 0.04, pz, 3.4 + cv * 2.6, 1, 3.4 + cv * 2.6), rc, { alpha: clamp(cv, 0, 0.85) * alpha, ring: 0.8, soft: 0.1 });
          drawMesh(mQuad);
        }
        // 保持者リング（ボールが足元にある選手 — ポゼッションの可視化）
        if (p.hasBall) {
          const pulse = 0.65 + 0.3 * Math.sin(time * 5.2);
          useFlat(M4.trs(px, 0.05, pz, 2.6, 1, 2.6), [0.99, 0.93, 0.72], { alpha: 0.85 * pulse * alpha, ring: 0.82, soft: 0.12 });
          drawMesh(mQuad);
        }
        // #133: 編集モードの掴み対象ハイライト（明るいシアン・脈動 — 掴んでいる対象を明示）
        const es = scene.editSel;
        if (scene.editMode && es && es.kind === "player" && es.team === p.team && es.no === p.no) {
          const pulse = 0.6 + 0.32 * Math.sin(time * 6.5);
          useFlat(M4.trs(px, 0.06, pz, 5.2, 1, 5.2), [0.32, 0.95, 1], { alpha: 0.95 * pulse, ring: 0.8, soft: 0.08 });
          drawMesh(mQuad);
        }
        // 選択/ホバーリング
        else if (selected && selected.team === p.team && selected.no === p.no) {
          const pulse = 0.72 + 0.2 * Math.sin(time * 4);
          useFlat(M4.trs(px, 0.05, pz, 4.4, 1, 4.4), [1, 1, 1], { alpha: 0.9 * pulse, ring: 0.78, soft: 0.08 });
          drawMesh(mQuad);
        } else if (hover && hover.team === p.team && hover.no === p.no) {
          useFlat(M4.trs(px, 0.05, pz, 4.0, 1, 4.0), [0.9, 0.95, 1], { alpha: 0.5, ring: 0.78, soft: 0.1 });
          drawMesh(mQuad);
        }
        gl.depthMask(true);

        // 体（人型フィギュア: 胴・頭・腕2・二節脚 + 歩走ゲイト・接触演出）
        const half = state.half || 1;
        const dir = (match.dir && match.dir[p.team]) ? match.dir[p.team][half === 1 ? "h1" : "h2"] : 1;
        const figKey = p.team + ":" + p.no;
        const sep = sepMap.get(figKey);
        const ex = {
          stumble: scene.tackle && scene.tackle.loserKey === figKey ? scene.tackle.u : 0,
          shield: scene.shield && scene.shield.holderKey === figKey
            ? { x: scene.shield.px, z: scene.shield.pz } : null,
          jump: 0, header: false,
        };
        if (scene.aerial) {
          if (figKey === scene.aerial.winnerKey) { ex.jump = scene.aerial.jumpH; ex.header = true; }
          else if (figKey === scene.aerial.loserKey) { ex.jump = scene.aerial.jumpH * 0.6; }
        }
        if (kicker && figKey === kicker) {   // #156 蹴り足＝選手ごとの利き足（決定論）
          ex.kick = kickEnv; ex.kickLeg = N.hash2(N.seedOf(figKey), 3) < 0.5 ? -1 : 1;
        }
        const numTx = (options.kitNumbers !== false) ? kitNumTex(p.team, p.no, isGK) : null;
        drawFigure(
          figKey, px + (sep ? sep.x : 0), pz - (sep ? sep.y : 0), dt,
          shirt, shorts, toneOf(p.team, p.no),
          bodyAlpha * alpha, Math.atan2(dir, 0),
          state.ball.x, -state.ball.y, ex, numTx, time
        );
        gl.disable(gl.BLEND);
      }

      // 粒子場（選手の上に重ねる — 加算グロー）
      partDraw(time);

      // ボール（視認性: 少し大きめ + グロー）— 幅軸 worldZ=-fieldY
      const b = state.ball, bz = -b.y;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      useFlat(M4.trs(b.x, 0.015, bz, 1.0 + b.z * 0.5, 1, 1.0 + b.z * 0.5), [0, 0, 0], { alpha: clamp(0.42 - b.z * 0.06, 0.08, 0.42), soft: 0.6 });
      drawMesh(mQuad);
      // #133: 編集モードのボール掴みアフォーダンス（掴めることを明示・選択中は明るく脈動）
      if (scene.editMode) {
        const bSel = scene.editSel && scene.editSel.kind === "ball";
        const pulse = 0.5 + 0.32 * Math.sin(time * (bSel ? 6.5 : 3.2));
        useFlat(M4.trs(b.x, 0.055, bz, bSel ? 4.2 : 2.9, 1, bSel ? 4.2 : 2.9),
          bSel ? [0.32, 0.95, 1] : [0.98, 0.86, 0.5], { alpha: (bSel ? 0.95 : 0.5) * pulse, ring: 0.8, soft: 0.1 });
        drawMesh(mQuad);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      useLambert(M4.trs(b.x, 0.3 + b.z, bz, 0.3, 0.3, 0.3), [0.98, 0.99, 1], { emiss: 0.5 });
      drawMesh(mSphere);
      // #82/#154: 審判 — 選手と同じスキンド人型経路（黒キット・解析には非算入）
      if (state.referees) for (let ri = 0; ri < state.referees.length; ri++) {
        const rf = state.referees[ri];
        const rz = -rf.y;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        useFlat(M4.trs(rf.x, 0.02, rz, 1.4, 1, 1.4), [0, 0, 0], { alpha: 0.4, soft: 0.62 });
        drawMesh(mQuad);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        drawFigure("REF:" + ri, rf.x, rz, dt,
          [0.13, 0.13, 0.15], [0.10, 0.10, 0.12], REF_TONE, 1,
          Math.atan2(b.x - rf.x, bz - rz), b.x, bz, null, null, time);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      useTex(billboard(b.x, 0.3 + b.z, bz, 2.6, 2.6), txGlow, { alpha: 0.5, fog: 1e9 });
      drawMesh(mVQuad);
      gl.depthMask(true);
      gl.disable(gl.BLEND);

      // ラベル（最前面 — 粒子・ボールの後）
      if (options.labels) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        for (const p of sorted) {
          const alpha = p.leaving ? 1 - p.leaving * 0.9 : 1;
          if (alpha <= 0.05) continue;
          const d = Math.hypot(eye[0] - p.x, eye[1] - 2, eye[2] + p.y);
          const s = clamp(d * 0.028, 1.15, 3.2);
          useTex(billboard(p.x, 2.55 + s * 0.28, -p.y, s * 1.9, s * 0.98), labelTex(p.team, p, p.captain), { alpha: alpha * 0.98, fog: 1e9 });
          drawMesh(mVQuad);
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      // 速度ラベル（放送グラフィクス風「24 | SANO / 18 km/h」— 番号ラベルとは独立）
      if (scene.speedLabels && scene.speedLabels.length) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        for (const L of scene.speedLabels) {
          const T = match.teams[L.team];
          const p = T.squad.find(q => q.no === L.no);
          if (!p) continue;
          const d = Math.hypot(eye[0] - L.x, eye[1] - 2, eye[2] + L.y);
          const s = clamp(d * 0.045, 1.7, 5.6);   // 放送グラフィクス並みの視認性
          const kitCss = T.kit ? T.kit.shirt : (T.color || "#FFE24A");
          const spd = speedTagTex(Math.min(L.kmh, 36), kitCss);
          const yBase = options.labels ? 3.75 : 2.9;      // 番号ラベルと重ならない高さ
          if (L.withName) {
            const tag = nameTagTex(L.team, p);
            useTex(billboard(L.x, yBase + s * 0.62, -L.y, s * 2.4, s * 0.375), tag.tx, { alpha: 0.95, fog: 1e9 });
            drawMesh(mVQuad);
          }
          if (L.kmh >= 1) {
            useTex(billboard(L.x, yBase + s * (L.withName ? 0.28 : 0.34), -L.y, s * 1.55, s * 0.34), spd.tx, { alpha: 0.95, fog: 1e9 });
            drawMesh(mVQuad);
          }
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      // #159 ポストプロセス: オフスクリーン → （Cinematic: bloom）→ トーンマップ/グレーディング/FXAA → 画面
      if (postOn) {
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
        const bloomOn = !!(R.quality && R.quality.flags && R.quality.flags.bloom);
        if (bloomOn) {
          gl.viewport(0, 0, post.bw, post.bh);
          gl.bindFramebuffer(gl.FRAMEBUFFER, post.bloomFBO[0]);   // 輝度抽出
          gl.useProgram(prBright);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, post.tex);
          gl.uniform1i(U(prBright, "uTex"), 0); gl.uniform1f(U(prBright, "uThresh"), 0.72);
          drawFS();
          gl.useProgram(prBlur);                                 // 分離ガウス（横→縦）
          gl.uniform1i(U(prBlur, "uTex"), 0);
          gl.bindFramebuffer(gl.FRAMEBUFFER, post.bloomFBO[1]);
          gl.bindTexture(gl.TEXTURE_2D, post.bloomTex[0]); gl.uniform2f(U(prBlur, "uDir"), 1 / post.bw, 0); drawFS();
          gl.bindFramebuffer(gl.FRAMEBUFFER, post.bloomFBO[0]);
          gl.bindTexture(gl.TEXTURE_2D, post.bloomTex[1]); gl.uniform2f(U(prBlur, "uDir"), 0, 1 / post.bh); drawFS();
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(prPost);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, post.tex); gl.uniform1i(U(prPost, "uTex"), 0);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, post.bloomTex[0]); gl.uniform1i(U(prPost, "uBloom"), 2);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform2f(U(prPost, "uTexel"), 1 / post.w, 1 / post.h);
        gl.uniform1f(U(prPost, "uBloomOn"), bloomOn ? 1 : 0);
        gl.uniform1f(U(prPost, "uExposure"), 1.06);
        gl.uniform1f(U(prPost, "uTonemap"), 0.45);   // 控えめ（既存の作り込みを濁さない）
        gl.uniform1f(U(prPost, "uContrast"), 1.05);
        gl.uniform1f(U(prPost, "uSat"), 1.08);
        gl.uniform1f(U(prPost, "uVig"), 0.24);
        drawFS();
      }
    };

    // ピッキング（クリック → 選手）
    api.pick = (mx, my, state) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((mx - rect.left) / rect.width) * 2 - 1;
      const y = -(((my - rect.top) / rect.height) * 2 - 1);
      // 逆射影: クリップ→ビュー→ワールド方向
      const asp = canvas.width / Math.max(1, canvas.height);
      const f = 1 / Math.tan((cam.fov * Math.PI) / 360);
      const dirCam = [x * asp / f, y / f, -1];
      // view の回転部転置で世界方向へ
      const d = [
        view[0] * dirCam[0] + view[1] * dirCam[1] + view[2] * dirCam[2],
        view[4] * dirCam[0] + view[5] * dirCam[1] + view[6] * dirCam[2],
        view[8] * dirCam[0] + view[9] * dirCam[1] + view[10] * dirCam[2],
      ];
      const o = eyePos();
      let best = null, bestT = 1e9;
      for (const p of state.players) {
        if (!p.onPitch) continue;
        const c = [p.x, 1.0, -p.y];   // 幅軸 worldZ=-fieldY
        const oc = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
        const bq = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2];
        const cq = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - 1.44;
        const disc = bq * bq - (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) * cq;
        if (disc < 0) continue;
        const tHit = (-bq - Math.sqrt(disc)) / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        if (tHit > 0 && tHit < bestT) { bestT = tHit; best = { team: p.team, no: p.no }; }
      }
      return { hit: best, moved };
    };

    // #82: 画面座標 → 地面(y=0)との交点 → ピッチ座標 {x, y}（pick と同じ光線）
    api.groundAt = (mx, my) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((mx - rect.left) / rect.width) * 2 - 1;
      const y = -(((my - rect.top) / rect.height) * 2 - 1);
      const asp = canvas.width / Math.max(1, canvas.height);
      const f = 1 / Math.tan((cam.fov * Math.PI) / 360);
      const dirCam = [x * asp / f, y / f, -1];
      const d = [
        view[0] * dirCam[0] + view[1] * dirCam[1] + view[2] * dirCam[2],
        view[4] * dirCam[0] + view[5] * dirCam[1] + view[6] * dirCam[2],
        view[8] * dirCam[0] + view[9] * dirCam[1] + view[10] * dirCam[2],
      ];
      const o = eyePos();
      if (Math.abs(d[1]) < 1e-6) return null;
      const tHit = -o[1] / d[1];
      if (tHit <= 0) return null;
      const wx = o[0] + d[0] * tHit, wz = o[2] + d[2] * tHit;
      return { x: clamp(wx, -52.5, 52.5), y: clamp(-wz, -34, 34) };   // worldZ = -fieldY
    };
    api.editMode = false;

    api.setMatch = (m) => {
      match = m;
      labelCache.clear();
      textCache.clear();
      figState.clear();
      gl.deleteTexture(txAd);
      txAd = canvasTex(gl, makeAdCanvas(match));   // 広告ボードを新試合のメタで再生成
    };
    api.gl = gl;
    return api;
  };
})();
