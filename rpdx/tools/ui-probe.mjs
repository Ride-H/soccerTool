// 画面の使いやすさ・見やすさを**測る**道具（目視だけに頼らない）。
//   node rpdx/tools/ui-probe.mjs [--url=...] [--w=390] [--h=844]
//
// 見るもの:
//   1. 操作標的の大きさ — 試合を見ながら押すボタンは 44px 以上（Apple HIG / WCAG 2.5.5 の目安）
//   2. 文字の大きさ     — 本文が 11px 未満だと高校生でもスタンドで読めない
//   3. 文字と背景のコントラスト比 — WCAG AA（本文 4.5:1 / 大きい文字 3:1）
//   4. 横スクロールの発生 — 幅の狭い端末で画面外へはみ出していないか
// 端末幅は既定でスマートフォン（390×844）。ライブ実況はスタンドで使う想定のため。
import { launch } from "../test/visual/cdp.mjs";

const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); // 値に = を含む（URL 等）ので split は使わない
  return a ? a.slice(a.indexOf("=") + 1) : d; };
const W = +arg("w", 390), H = +arg("h", 844);
const URL_ = arg("url", `file://${new URL("../../dist/rpdx.html", import.meta.url).pathname}?live=1&play=0`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = `(() => {
  const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const bgOf = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor;
    if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c; e = e.parentElement; } return "rgb(11,15,22)"; };
  const out = { targets: [], texts: [], scrollX: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollW: document.documentElement.scrollWidth, winW: window.innerWidth, liveVisible: false };
  const live = document.querySelector("#liveBar");
  // position:fixed だと offsetParent が null になるので、実寸と display で見る
  out.liveVisible = !!(live && getComputedStyle(live).display !== "none" && live.getBoundingClientRect().height > 1);
  const scope = out.liveVisible ? live : document.body;
  for (const b of scope.querySelectorAll("button")) {
    const r = b.getBoundingClientRect();
    if (r.width < 1) continue;
    const st = getComputedStyle(b);
    // 押せるか: 中心の実際の当たり判定が自分（か子）であること。
    // 大きさとコントラストだけ見ても、他のパネルに覆われていたら押せない。
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const covered = !(hit && (hit === b || b.contains(hit)));
    const offscreen = r.left < 0 || r.top < 0 || r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5;
    out.targets.push({ label: (b.textContent || "").trim().slice(0, 12), w: Math.round(r.width), h: Math.round(r.height),
      font: parseFloat(st.fontSize), fg: st.color, bg: bgOf(b), covered, offscreen,
      by: covered && hit ? (hit.id || hit.className || hit.tagName).toString().slice(0, 24) : "" });
  }
  for (const el of scope.querySelectorAll("button, .hint, .eyebrow, b, span")) {
    const txt = (el.textContent || "").trim();
    if (!txt || el.children.length) continue;
    const r = el.getBoundingClientRect(); if (r.width < 1) continue;
    const st = getComputedStyle(el);
    out.texts.push({ txt: txt.slice(0, 14), size: parseFloat(st.fontSize), fg: st.color, bg: bgOf(el) });
  }
  out.contrast = (fg, bg) => 0;
  return JSON.stringify(out);
})()`;

const ratio = (fg, bg) => {
  const f = (c) => { const m = c.match(/[\d.]+/g).map(Number);
    const g = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * g(m[0]) + 0.7152 * g(m[1]) + 0.0722 * g(m[2]); };
  const a = f(fg), b = f(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const b = await launch({ width: W, height: H });
const p = await b.newPage({ width: W, height: H });
await p.navigate(URL_);
let ok = false, t0 = Date.now();
while (!ok && Date.now() - t0 < 40000) { await sleep(300); ok = await p.evaluate("!!(globalThis.RPDX && RPDX.app && RPDX.app.match)"); }
await sleep(1200);
const data = JSON.parse(await p.evaluate(probe));
await p.dispose(); await b.close();

const MIN_TARGET = 44, MIN_FONT = 11, MIN_CONTRAST = 4.5, MIN_CONTRAST_LG = 3;
const bad = [];
console.log(`# 画面の実測（${W}×${H} / ライブバー ${data.liveVisible ? "表示" : "非表示"}）`);
console.log(`\n## 操作標的（${data.targets.length} 個・基準 ${MIN_TARGET}px 以上）`);
for (const t of data.targets) {
  const small = Math.min(t.w, t.h) < MIN_TARGET;
  const cr = ratio(t.fg, t.bg);
  const lowC = cr < (t.font >= 18 ? MIN_CONTRAST_LG : MIN_CONTRAST);
  if (small) bad.push(`標的が小さい: 「${t.label}」 ${t.w}×${t.h}px（基準 ${MIN_TARGET}）`);
  if (lowC) bad.push(`コントラスト不足: 「${t.label}」 ${cr.toFixed(2)}:1（基準 ${t.font >= 18 ? MIN_CONTRAST_LG : MIN_CONTRAST}）`);
  if (t.covered) bad.push(`覆われて押せない: 「${t.label}」（前面は ${t.by}）`);
  if (t.offscreen) bad.push(`画面外へ出ている: 「${t.label}」`);
  const ng = small || lowC || t.covered || t.offscreen;
  console.log(`  ${ng ? "✖" : "✓"} ${t.label.padEnd(12)} ${String(t.w).padStart(4)}×${String(t.h).padStart(3)}px  ${t.font}px  コントラスト ${cr.toFixed(2)}:1${t.covered ? "  覆われ" : ""}${t.offscreen ? "  画面外" : ""}`);
}
const smallTxt = data.texts.filter((x) => x.size < MIN_FONT);
console.log(`\n## 文字（${data.texts.length} 箇所・基準 ${MIN_FONT}px 以上）`);
for (const x of smallTxt) bad.push(`文字が小さい: 「${x.txt}」 ${x.size}px`);
console.log(smallTxt.length ? smallTxt.map((x) => `  ✖ ${x.txt} ${x.size}px`).join("\n") : "  ✓ すべて基準以上");
if (data.scrollX) bad.push(`横スクロールが出ている（内容 ${data.scrollW}px > 画面 ${data.winW}px）`);
console.log(`\n## 横はみ出し\n  ${data.scrollX ? "✖ 横スクロールあり" : "✓ なし"}`);
console.log(`\n実測: 指摘 ${bad.length} 件`);
for (const m of bad) console.log(`  ✖ ${m}`);
process.exit(bad.length ? 1 : 0);
