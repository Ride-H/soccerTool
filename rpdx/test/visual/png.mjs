// #153 視覚回帰ゲート — 依存ゼロの最小PNGデコーダ（node:zlib のみ使用）
// 対応: 8bit・colorType 2(RGB)/6(RGBA)・非インターレース（Chrome の captureScreenshot 出力で十分）
import { inflateSync } from "node:zlib";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const decodePNG = (buf) => {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error("PNGシグネチャ不一致");
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;   // len + type(4) + crc(4)
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0)
    throw new Error(`未対応PNG形式 depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1);
    const filter = raw[rowOff];
    for (let x = 0; x < stride; x++) {
      const rv = raw[rowOff + 1 + x];
      const a = x >= bpp ? cur[x - bpp] : 0;      // 左
      const b = prev[x];                           // 上
      const c = x >= bpp ? prev[x - bpp] : 0;      // 左上
      let v;
      switch (filter) {
        case 0: v = rv; break;
        case 1: v = rv + a; break;
        case 2: v = rv + b; break;
        case 3: v = rv + ((a + b) >> 1); break;
        case 4: v = rv + paeth(a, b, c); break;
        default: throw new Error("未知のPNGフィルタ " + filter);
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp, di = (y * width + x) * 4;
      out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2];
      out[di + 3] = bpp === 4 ? cur[si + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, rgba: out };
};

// 検証用ユーティリティ（smoke と単体テストで共用）
export const lumAt = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return 0.2126 * img.rgba[i] + 0.7152 * img.rgba[i + 1] + 0.0722 * img.rgba[i + 2];
};

export const regionStats = (img, x0, y0, x1, y1) => {
  let n = 0, greenDom = 0, dark = 0, sumR = 0, sumG = 0, sumB = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    const r = img.rgba[i], g = img.rgba[i + 1], b = img.rgba[i + 2];
    n++;
    sumR += r; sumG += g; sumB += b;
    if (g > 40 && g > r * 1.15 && g > b * 1.15) greenDom++;
    if (0.2126 * r + 0.7152 * g + 0.0722 * b < 58) dark++;
  }
  return { n, greenRatio: greenDom / n, darkRatio: dark / n, mean: [sumR / n, sumG / n, sumB / n] };
};

// 2画像の差分（許容差 tol 超の画素数と比率）— サイズ不一致は全画素差扱い
export const diffCount = (a, b, tol) => {
  if (a.width !== b.width || a.height !== b.height)
    return { pixels: a.width * a.height, ratio: 1, sizeMismatch: true };
  let d = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n * 4; i += 4) {
    if (Math.abs(a.rgba[i] - b.rgba[i]) > tol ||
        Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) > tol ||
        Math.abs(a.rgba[i + 2] - b.rgba[i + 2]) > tol) d++;
  }
  return { pixels: d, ratio: d / n, sizeMismatch: false };
};
