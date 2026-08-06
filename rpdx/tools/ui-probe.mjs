// 画面の使いやすさ・見やすさを**測る**道具（目視だけに頼らない）。
//   node rpdx/tools/ui-probe.mjs [--url=...] [--w=390] [--h=844] [--scene=名前の一部]
//
// 見るもの:
//   1. 操作標的の大きさ — 試合を見ながら押すボタンは 44px 以上（Apple HIG / WCAG 2.5.5 の目安）
//   2. 文字の大きさ     — 本文が 11px 未満だと高校生でもスタンドで読めない
//   3. 文字と背景のコントラスト比 — WCAG AA（本文 4.5:1 / 大きい文字 3:1）
//   4. 横スクロールの発生 — 幅の狭い端末で画面外へはみ出していないか
// 端末幅は既定でスマートフォン（390×844）。現地でスマホを持って使うのが中核の使い方のため。
//
// 【画面ごとに測る（2026-08-04 改訂）】
// 旧版は「ライブバーが出ていたらライブバーだけ」を測っていた（scope = liveVisible ? live : body）。
// 既定 URL も ?live=1 だったため、**分析画面は一度も測られていなかった**。
// ここでは引き出し・下部シートを 1 つずつ開いて、画面（シーン）ごとに測る。
//
// 閉じている引き出しの中身を「画面外」と数えない。開いていないものは、その画面には
// 存在しないものとして扱う（閉じた引き出しを不具合として数えると、本物の不具合が埋もれる）。
import { launch } from "../test/visual/cdp.mjs";

const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); // 値に = を含む（URL 等）ので split は使わない
  return a ? a.slice(a.indexOf("=") + 1) : d; };
const W = +arg("w", 390), H = +arg("h", 844);
const URL_ = arg("url", `file://${new URL("../../dist/rpdx.html", import.meta.url).pathname}?play=0`);
const only = arg("scene", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// すべての引き出し・シートを閉じた状態へ戻す（シーン間で状態を持ち越さない）
const RESET = `(() => {
  const q = (s) => document.querySelector(s);
  for (const s of ["#dockL", "#dockR"]) q(s) && q(s).classList.remove("shown");
  for (const s of ["#viewbar", "#timelineWrap"]) q(s) && q(s).classList.remove("open");
  q("#inspector") && q("#inspector").classList.remove("open");
  const lb = q("#liveBar");
  if (lb && getComputedStyle(lb).display !== "none" && q("#btnLive")) q("#btnLive").click();
  return "ok";
})()`;

// 測る画面。open は「その画面を出す操作」。要素が無ければその画面は飛ばす。
// mustSee: その画面を開いた目的を果たすために、**スクロールせずに見えていなければ**
// ならない操作部。これを宣言しないと、開いたのに画面外にある操作を見逃す
// （#195: PK パネルが下端の 300px 超はみ出したまま指摘 0 件だった）。
//
// 引き出し（dockL/dockR）に mustSee を置かないのは意図的。あれは縦スクロールする一覧で、
// はみ出しが正常だから。**一覧はスクロールしてよい／操作盤はスクロールさせない**の区別。
const SCENES = [
  { name: "分析画面（初期表示）", open: `"ok"` },
  { name: "左の引き出し（設定・危険度）", open: `document.querySelector("#toggleL").click(), "ok"` },
  { name: "右の引き出し（名簿・配置）", open: `document.querySelector("#toggleR").click(), "ok"` },
  { name: "表示切替バー", open: `document.querySelector("#viewToggle").click(), "ok"`, mustSee: ["#viewbar .cam"] },
  { name: "危険度タイムライン", open: `document.querySelector("#tlToggle").click(), "ok"`, mustSee: ["#btnPlay"] },
  { name: "選手インスペクタ", open: `document.querySelector("#inspector").classList.add("open"), "ok"`, mustSee: ["#inspClose"] },
  { name: "ライブ実況バー", open: `document.querySelector("#btnLive").click(), "ok"`, mustSee: ["#liveStart", "#liveUndo"] },
  { name: "PK コース記録", open: `(document.querySelector("#btnLive").click(), document.querySelector("#livePk").click(), "ok")`,
    mustSee: ["#pkGrid", "#pkOk", "#pkNg"] },
];

const probeFor = (mustSee) => `(() => {
  const MUST = ${JSON.stringify(mustSee || [])};
  const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  // 背景色は「一番手前の不透明でない色」ではなく、**下地と合成した実際の色**を返す。
  // 半透明の重ね（例: 選択中ボタンの薄い金 rgba(200,169,110,0.09)）を不透明として
  // 読むと、下地が暗いのに明るい色として扱われ、コントラスト比が実際より低く出る。
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const m = (getComputedStyle(e).backgroundColor || "").match(/[\\d.]+/g);
      if (!m) continue;
      const a = m.length > 3 ? +m[3] : 1;
      if (a <= 0) continue;
      stack.push([+m[0], +m[1], +m[2], a]);
      if (a >= 1) break;                     // ここで下が見えなくなる
    }
    let [r, g, b] = stack.length && stack[stack.length - 1][3] >= 1
      ? stack.pop().slice(0, 3) : [11, 15, 22];   // 一番下の不透明色（無ければページ地色）
    for (let i = stack.length - 1; i >= 0; i--) {  // 下から順に重ねる
      const [sr, sg, sb, sa] = stack[i];
      r = sr * sa + r * (1 - sa); g = sg * sa + g * (1 - sa); b = sb * sa + b * (1 - sa);
    }
    return \`rgb(\${Math.round(r)}, \${Math.round(g)}, \${Math.round(b)})\`;
  };
  const shown = (el) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false; } return true; };
  // 親のスクロール領域の外へ出ている（横スクロールしないと見えない）要素は、
  // 「その画面に出ているもの」として数えない。数えると、実際にはそこに描かれていない
  // 要素の中心が別の要素に当たり、「覆われて押せない」として大量に誤検出される。
  const clippedByScroll = (el) => {
    const r = el.getBoundingClientRect();
    for (let e = el.parentElement; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (!/auto|scroll|hidden/.test(s.overflowX + s.overflowY)) continue;
      const p = e.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < p.left - 0.5 || cx > p.right + 0.5 || cy < p.top - 0.5 || cy > p.bottom + 0.5) return true;
    }
    return false;
  };
  const out = { targets: [], texts: [], hidden: 0, unseen: [],
    scrollX: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollW: document.documentElement.scrollWidth, winW: window.innerWidth, winH: window.innerHeight };
  // 入力欄も「押す/触る」標的。ボタンだけ見ていると、小さすぎる入力欄を見逃す。
  for (const b of document.querySelectorAll("button, input:not([type=hidden]), select, textarea")) {
    const r = b.getBoundingClientRect();
    if (r.width < 1 || !shown(b)) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // 中心が画面の外＝この画面には出ていない（閉じた引き出しの中身など）。不具合ではない。
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight || clippedByScroll(b)) { out.hidden++; continue; }
    const st = getComputedStyle(b);
    // 押せるか: 中心の実際の当たり判定が自分（か子）であること。
    // 大きさとコントラストだけ見ても、他のパネルに覆われていたら押せない。
    const hit = document.elementFromPoint(cx, cy);
    const covered = !(hit && (hit === b || b.contains(hit)));
    // 端が画面からはみ出しているか。ただし**スクロールして持ってこられる方向**は不備ではない
    // （横スクロールする帯の中のボタンは、はみ出していて当たり前）。
    // その方向にスクロールできる親が無いときだけ「到達できない」と数える。
    // 「スクロールできる」は指定だけでなく**実際に動かせる余地がある**ことまで見る。
    // overflow-y だけ指定しても overflow-x は auto に計算されるため、指定だけで判定すると
    // 「横スクロールで取れる」と誤って結論して、本当に切れている要素を見逃す。
    const scrollable = (dir) => {
      for (let e = b.parentElement; e; e = e.parentElement) {
        const s2 = getComputedStyle(e);
        const spec = dir === "x" ? s2.overflowX : s2.overflowY;
        if (!/auto|scroll/.test(spec)) continue;
        const room = dir === "x" ? e.scrollWidth - e.clientWidth : e.scrollHeight - e.clientHeight;
        if (room > 1) return true;
      }
      return false;
    };
    const outX = r.left < -0.5 || r.right > window.innerWidth + 0.5;
    const outY = r.top < -0.5 || r.bottom > window.innerHeight + 0.5;
    const clipped = (outX && !scrollable("x")) || (outY && !scrollable("y"));
    out.targets.push({ label: ((b.textContent || b.getAttribute("aria-label") || b.placeholder || b.tagName) + "").trim().slice(0, 12),
      w: Math.round(r.width), h: Math.round(r.height),
      font: parseFloat(st.fontSize), fg: st.color, bg: bgOf(b), covered, clipped,
      by: covered && hit ? (hit.id || hit.className || hit.tagName).toString().slice(0, 24) : "" });
  }
  for (const el of document.querySelectorAll("button, .hint, .eyebrow, b, span, td, label, div")) {
    const txt = (el.textContent || "").trim();
    if (!txt || el.children.length) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || !shown(el)) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight || clippedByScroll(el)) continue;
    const st = getComputedStyle(el);
    out.texts.push({ txt: txt.slice(0, 14), size: parseFloat(st.fontSize), fg: st.color, bg: bgOf(el) });
  }
  // その画面を開いた目的を果たす操作部が、スクロールせずに見えているか
  for (const sel of MUST) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || !shown(el)) continue;
      const okY = r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5;
      const okX = r.left >= -0.5 && r.right <= window.innerWidth + 0.5;
      if (!okY || !okX) out.unseen.push({ sel,
        label: ((el.textContent || el.getAttribute("aria-label") || el.tagName) + "").trim().slice(0, 14),
        top: Math.round(r.top), bottom: Math.round(r.bottom) });
      break;   // 同じ選択子は代表 1 個で足りる
    }
  }
  return JSON.stringify(out);
})()`;

const ratio = (fg, bg) => {
  const f = (c) => { const m = c.match(/[\d.]+/g).map(Number);
    const g = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * g(m[0]) + 0.7152 * g(m[1]) + 0.0722 * g(m[2]); };
  const a = f(fg), b = f(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

export const MIN_TARGET = 44, MIN_FONT = 11, MIN_CONTRAST = 4.5, MIN_CONTRAST_LG = 3;

// 直す予定が決まっている不備は、ここに Issue 番号つきで書いて通す。
// **ここに書いたものだけ**を許し、増えたら落ちる（他のゲートと同じ流儀）。
// 黙って除外するのではなく、実測の出力に「既知」として毎回出す。
export const KNOWN_UNSEEN = {};

// 1 画面ぶんの判定。返値 { name, targets, texts, findings[] }
const judge = (name, data) => {
  const findings = [], known = [];
  const seen = new Set();
  const add = (msg) => { if (!seen.has(msg)) { seen.add(msg); findings.push(msg); } };
  for (const t of data.targets) {
    const cr = ratio(t.fg, t.bg);
    if (Math.min(t.w, t.h) < MIN_TARGET) add(`標的が小さい: 「${t.label}」 ${t.w}×${t.h}px（基準 ${MIN_TARGET}）`);
    if (cr < (t.font >= 18 ? MIN_CONTRAST_LG : MIN_CONTRAST))
      add(`コントラスト不足: 「${t.label}」 ${cr.toFixed(2)}:1（基準 ${t.font >= 18 ? MIN_CONTRAST_LG : MIN_CONTRAST}）`);
    if (t.covered) add(`覆われて押せない: 「${t.label}」（前面は ${t.by}）`);
    if (t.clipped) add(`画面から切れている: 「${t.label}」`);
  }
  for (const x of data.texts) if (x.size < MIN_FONT) add(`文字が小さい: 「${x.txt}」 ${x.size}px`);
  if (data.scrollX) add(`横スクロールが出ている（内容 ${data.scrollW}px > 画面 ${data.winW}px）`);
  const allow = KNOWN_UNSEEN[name] || [];
  for (const u of data.unseen || []) {
    const msg = `開いても画面に出ていない: 「${u.label}」（${u.sel}・上${u.top} 下${u.bottom} / 画面 ${data.winH}）`;
    if (allow.includes(u.sel)) known.push(msg + " ← 既知（#197 で解消予定）");
    else add(msg);
  }
  return { name, nTargets: data.targets.length, nTexts: data.texts.length, hidden: data.hidden,
    unseen: (data.unseen || []).length, findings, known };
};

// 実測を走らせて画面ごとの結果を返す（テストからも呼べるようにエクスポート）
export const uiProbe = async ({ url = URL_, width = W, height = H, scene = "", touch = true } = {}) => {
  const b = await launch({ width, height });
  // touch: 実機と同じ pointer:coarse / hover:none で測る。これを外すと、タッチ端末だけに
  // 当たる指定（タップ標的の拡大・hover 依存UIの常時表示）が測定に現れない。
  const p = await b.newPage({ width, height, touch });
  await p.navigate(url);
  let ready = false, t0 = Date.now();
  while (!ready && Date.now() - t0 < 40000) { await sleep(300); ready = await p.evaluate("!!(globalThis.RPDX && RPDX.app && RPDX.app.match)"); }
  await sleep(1200);
  const results = [];
  for (const sc of SCENES) {
    if (scene && !sc.name.includes(scene)) continue;
    await p.evaluate(RESET);
    await sleep(250);
    const okOpen = await p.evaluate(`(() => { try { return ${sc.open}; } catch (e) { return "skip:" + e.message; } })()`);
    if ((okOpen + "").startsWith("skip:")) { results.push({ name: sc.name, skipped: (okOpen + "").slice(5) }); continue; }
    await sleep(450);
    results.push(judge(sc.name, JSON.parse(await p.evaluate(probeFor(sc.mustSee)))));
  }
  await p.dispose(); await b.close();
  return results;
};

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await uiProbe({ url: URL_, width: W, height: H, scene: only });
  console.log(`# 画面の実測（${W}×${H}・タッチ端末・${results.length} 画面）`);
  let total = 0;
  for (const r of results) {
    if (r.skipped) { console.log(`\n## ${r.name}\n  — この画面は出せませんでした（${r.skipped}）`); continue; }
    total += r.findings.length;
    console.log(`\n## ${r.name}（標的 ${r.nTargets} 個 / 文字 ${r.nTexts} 箇所 / この画面に出ていない標的 ${r.hidden} 個）`);
    for (const k of r.known || []) console.log(`  ・ ${k}`);
    if (!r.findings.length) { console.log("  ✓ 指摘なし（既知を除く）"); continue; }
    // 同じ種類が大量に出ると読めないので、種類ごとに数を出してから並べる
    const byKind = {};
    for (const f of r.findings) { const k = f.split(":")[0]; (byKind[k] ||= []).push(f); }
    for (const [k, list] of Object.entries(byKind)) {
      console.log(`  ✖ ${k} ${list.length} 件`);
      for (const f of list.slice(0, 6)) console.log(`      ${f}`);
      if (list.length > 6) console.log(`      … 他 ${list.length - 6} 件`);
    }
  }
  console.log(`\n実測: 指摘 ${total} 件（${results.filter((r) => !r.skipped && !r.findings.length).length}/${results.filter((r) => !r.skipped).length} 画面が基準内）`);
  process.exit(total ? 1 : 0);
}
