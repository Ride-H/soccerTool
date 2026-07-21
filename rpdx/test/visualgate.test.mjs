// #153 視覚回帰ゲート — PNGデコーダ単体（全フィルタ）と描画層の決定論契約
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodePNG, regionStats, diffCount } from "./visual/png.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 最小PNGを合成（8bit RGBA・非インターレース）— フィルタ挙動を既知値で検証する
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const makePNG = (width, height, scanlines /* [filter, ...rawBytes][] */) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = 0;   // 8bit RGBA 非インターレース
  const raw = Buffer.concat(scanlines.map((s) => Buffer.from(s)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
};

test("#153 png: フィルタ0/1/2/3/4 を既知値で正しく復元", () => {
  // 2x5・各行が異なるフィルタ。以下の期待値はPNG仕様に沿って机上計算した値
  //（フィルタはアルファも対象。Sub=左+raw / Up=上+raw / Average=raw+floor((左+上)/2) / Paeth=raw+最良予測子）。
  const png = makePNG(2, 5, [
    [0, 10, 20, 30, 255, 50, 60, 70, 255],       // None
    [1, 5, 6, 7, 255, 10, 11, 12, 0],            // Sub
    [2, 2, 3, 4, 0, 5, 6, 7, 0],                 // Up
    [3, 10, 10, 10, 128, 4, 4, 4, 0],            // Average
    [4, 1, 1, 1, 0, 2, 2, 2, 0],                 // Paeth
  ]);
  const img = decodePNG(png);
  assert.equal(img.width, 2); assert.equal(img.height, 5);
  const px = (x, y) => Array.from(img.rgba.slice((y * 2 + x) * 4, (y * 2 + x) * 4 + 4));
  assert.deepEqual(px(0, 0), [10, 20, 30, 255], "None 左");
  assert.deepEqual(px(1, 0), [50, 60, 70, 255], "None 右");
  assert.deepEqual(px(0, 1), [5, 6, 7, 255], "Sub 左（左隣なし=raw）");
  assert.deepEqual(px(1, 1), [15, 17, 19, 255], "Sub 右（左画素+raw）");
  assert.deepEqual(px(0, 2), [7, 9, 11, 255], "Up 左（上+raw）");
  assert.deepEqual(px(1, 2), [20, 23, 26, 255], "Up 右");
  assert.deepEqual(px(0, 3), [13, 14, 15, 255], "Average 左（左=0）");
  assert.deepEqual(px(1, 3), [20, 22, 24, 255], "Average 右");
  assert.deepEqual(px(0, 4), [14, 15, 16, 255], "Paeth 左（予測子=上）");
  assert.deepEqual(px(1, 4), [22, 24, 26, 255], "Paeth 右（予測子=上）");
});

test("#153 png: regionStats / diffCount が期待どおり", () => {
  // 4x1: 緑・緑・黒・白
  const png = makePNG(4, 1, [[0,
    10, 200, 20, 255, 12, 180, 30, 255, 0, 0, 0, 255, 250, 250, 250, 255]]);
  const img = decodePNG(png);
  const st = regionStats(img, 0, 0, 4, 1);
  assert.equal(st.n, 4);
  assert.ok(Math.abs(st.greenRatio - 0.5) < 1e-9, "緑優勢 2/4");
  assert.ok(Math.abs(st.darkRatio - 0.25) < 1e-9, "暗色 1/4");
  const img2 = decodePNG(makePNG(4, 1, [[0,
    10, 200, 20, 255, 12, 180, 30, 255, 0, 0, 0, 255, 0, 250, 250, 255]]));
  const d = diffCount(img, img2, 20);
  assert.equal(d.pixels, 1, "白→シアンの1画素だけ許容差超");
});

test("#153 決定論契約: 描画層（app/*.mjs）に Math.random を残さない", () => {
  for (const f of ["quality.mjs", "render3d.mjs", "ui.mjs"]) {
    const src = readFileSync(join(root, "app", f), "utf8");
    assert.ok(!src.includes("Math.random"), `${f} に Math.random（視覚回帰の再現性を壊す）`);
  }
});

test("#153 決定論契約: 位相・テクスチャがシード化されている", () => {
  const src = readFileSync(join(root, "app", "render3d.mjs"), "utf8");
  assert.ok(src.includes("N.hash(N.seedOf(String(key)))"), "ゲイト位相が選手キー由来シード");
  assert.match(src, /seqRand\(0x51ED01\)/, "芝ノイズがシード化");
  assert.match(src, /seqRand\(0x51ED02\)/, "観客テクスチャがシード化");
});
