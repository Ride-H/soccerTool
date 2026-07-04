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
  uniform mat4 uProj, uView, uModel; out vec3 vNor; out vec2 vUv; out vec3 vWorld;
  void main(){ vec4 w = uModel * vec4(aPos,1.0); vWorld = w.xyz; gl_Position = uProj*uView*w;
    vNor = mat3(uModel)*aNor; vUv = aUv; }`;
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
  const FS_TEX = `#version 300 es
  precision highp float; in vec2 vUv; in vec3 vWorld; out vec4 o;
  uniform sampler2D uTex; uniform vec3 uEye, uTint; uniform float uAlpha, uFogD, uEmiss;
  void main(){
    vec4 t = texture(uTex, vUv);
    vec3 c = t.rgb * uTint * (1.0 + uEmiss);
    float fog = clamp(length(uEye - vWorld) / uFogD, 0.0, 1.0); fog = fog*fog*0.55;
    o = vec4(mix(c, vec3(0.043,0.066,0.118), fog), t.a * uAlpha);
    if (o.a < 0.01) discard;
  }`;
  const FS_FLAT = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform vec3 uColor; uniform float uAlpha, uRing, uSoft;
  void main(){
    float r = length(vUv - 0.5) * 2.0;
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
    // 芝ストライプ
    for (let i = 0; i < 14; i++) {
      g.fillStyle = i % 2 ? "#155636" : "#12492E";
      g.fillRect(px(-52.5 + i * 7.5), py(-34), 7.5 * sx, 68 * sy);
    }
    // 芝ノイズ
    for (let i = 0; i < 9000; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      g.fillStyle = `rgba(${20 + Math.random() * 30},${70 + Math.random() * 40},${40 + Math.random() * 25},0.05)`;
      g.fillRect(x, y, 2.2, 2.2);
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
    for (let i = 0; i < 5200; i++) {
      const x = Math.random() * 1024, y = 16 + Math.random() * 168;
      const t = Math.random();
      g.fillStyle = t < 0.24 ? "rgba(255,198,26,0.5)" : t < 0.5 ? "rgba(74,125,255,0.5)" : `rgba(${150 + Math.random() * 105},${150 + Math.random() * 90},${140 + Math.random() * 80},0.42)`;
      g.fillRect(x, y, 2.6, 2.6);
    }
    return cv;
  };

  const makeAdCanvas = () => {
    const cv = document.createElement("canvas");
    cv.width = 2048; cv.height = 64;
    const g = cv.getContext("2d");
    g.fillStyle = "#0B1322"; g.fillRect(0, 0, 2048, 64);
    g.font = "700 30px ui-monospace, Menlo, monospace";
    const items = ["RPD-X", "D²-FIELD // 距離危険度場", "FIFA WORLD CUP 2026™", "BRA 2-1 JPN", "NRG STADIUM HOUSTON", "SAMURAI BLUE", "SELEÇÃO"];
    let x = 30;
    for (let k = 0; k < 3; k++) for (const it of items) {
      g.fillStyle = ["#6FA0FF", "#FFC61A", "#93A3C0"][Math.floor(Math.random() * 3)];
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
  R.render3d.create = (canvas, matchInit) => {
    let match = matchInit;
    const gl = canvas.getContext("webgl2", {
      antialias: true, alpha: false,
      preserveDrawingBuffer: true, powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 not available");
    canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());

    const prLambert = compile(gl, VS_BASE, FS_LAMBERT);
    const prTex = compile(gl, VS_BASE, FS_TEX);
    const prFlat = compile(gl, VS_BASE, FS_FLAT);
    const prSky = compile(gl, VS_SKY, FS_SKY);
    const prPart = compile(gl, VS_PART, FS_PART);
    const U = (pr, n) => gl.getUniformLocation(pr, n);

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
    const txAd = canvasTex(gl, makeAdCanvas());
    const txNet = canvasTex(gl, makeNetCanvas(), false);
    const txGlow = canvasTex(gl, makeGlowCanvas(), false);

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
    canvas.addEventListener("pointerdown", (e) => {
      dragging = e.button === 2 || e.shiftKey ? 2 : 1;
      lastX = e.clientX; lastY = e.clientY; moved = 0;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
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
    canvas.addEventListener("pointerup", () => { dragging = 0; });
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

      // ピッチ
      useTex(M4.trs(0, 0, 0, 118, 1, 80), txPitch);
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

    api.resize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = Math.round(w * api.dpr);
      canvas.height = Math.round(h * api.dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    let lastHeat = -1;
    api.frame = (time, dt, scene) => {
      const { state, field, options, selected, hover } = scene;
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

      // 軌跡（ボール）
      if (options.trails && scene.ballTrail) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        const tr = scene.ballTrail;
        for (let i = 1; i < tr.length; i++) {
          const a = (i / tr.length) * 0.5;
          useFlat(M4.trs(tr[i].x, 0.09, -tr[i].y, 0.5, 1, 0.5), [1, 1, 1], { alpha: a, soft: 0.9 });
          drawMesh(mQuad);
        }
        if (scene.playerTrail) {
          const pt = scene.playerTrail;
          for (let i = 1; i < pt.length; i++) {
            const a = (i / pt.length) * 0.6;
            useFlat(M4.trs(pt[i].x, 0.09, -pt[i].y, 0.7, 1, 0.7), pt.color, { alpha: a, soft: 0.9 });
            drawMesh(mQuad);
          }
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      // 選手（奥→手前ソートで半透明カプセル — 透明感）
      const contribMap = scene.contribMap || new Map();
      const sorted = state.players.slice().sort((a, b) => {
        const da = (eye[0] - a.x) ** 2 + (eye[2] + a.y) ** 2;   // 幅軸 worldZ=-fieldY
        const db = (eye[0] - b.x) ** 2 + (eye[2] + b.y) ** 2;
        return db - da;
      });
      const bodyAlpha = options.solidPlayers ? 1 : 0.87;
      for (const p of sorted) {
        const T = match.teams[p.team];
        const isGK = p.role === "GK";
        const shirt = hex2rgb(isGK ? T.kit.gk : T.kit.shirt);
        const shorts = hex2rgb(isGK ? T.kit.gk : T.kit.shorts);
        const alpha = p.leaving ? 1 - p.leaving * 0.9 : 1;
        if (alpha <= 0.05) continue;
        const px = p.x, pz = -p.y;   // 幅軸 worldZ=-fieldY（放送/コーチボード慣習に一致）

        // 影・リング（地面レイヤ）
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        useFlat(M4.trs(px, 0.02, pz, 1.5, 1, 1.5), [0, 0, 0], { alpha: 0.4 * alpha, soft: 0.55 });
        drawMesh(mQuad);
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
        // 選択/ホバーリング
        if (selected && selected.team === p.team && selected.no === p.no) {
          const pulse = 0.72 + 0.2 * Math.sin(time * 4);
          useFlat(M4.trs(px, 0.05, pz, 4.4, 1, 4.4), [1, 1, 1], { alpha: 0.9 * pulse, ring: 0.78, soft: 0.08 });
          drawMesh(mQuad);
        } else if (hover && hover.team === p.team && hover.no === p.no) {
          useFlat(M4.trs(px, 0.05, pz, 4.0, 1, 4.0), [0.9, 0.95, 1], { alpha: 0.5, ring: 0.78, soft: 0.1 });
          drawMesh(mQuad);
        }
        gl.depthMask(true);

        // 体（カプセル: 上=シャツ/下=ショーツ・フレネル半透明）
        useLambert(
          M4.trs(px, 0, pz, 0.42, 1.78, 0.42),
          shirt,
          { color2: shorts, split: 0.62, emiss: 0.04, alpha: bodyAlpha * alpha }
        );
        drawMesh(mCapsule);
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
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      useLambert(M4.trs(b.x, 0.3 + b.z, bz, 0.3, 0.3, 0.3), [0.98, 0.99, 1], { emiss: 0.5 });
      drawMesh(mSphere);
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

    api.setMatch = (m) => { match = m; labelCache.clear(); };
    api.gl = gl;
    return api;
  };
})();
