// #153 視覚回帰ゲート — CDPスモーク＋golden画像比較（依存ゼロ・CI組込み）
//
// 実行:  node rpdx/test/visual/smoke.mjs          # 検証（golden が無ければ失敗して案内）
//        UPDATE_GOLDEN=1 node rpdx/test/visual/smoke.mjs   # golden を再生成（意図的な視覚変更PRのみ）
//
// 方針（Issue #153）:
//  - 存在チェックを主（緑ピッチ/芝縞コントラスト/接地影/背番号の描画寄与）、
//    golden ピクセル差分は補助（許容差つき・ソフトウェアレンダラ差を吸収）。
//  - 決定論: 固定URL（?t=…&play=0&shotframes=N）＋描画側乱数のシード化＋
//    アプリの合成クロック（ショットモードはフレーム番号×16.6ms・ui.mjs #153）。
//    ドライバ/環境のタイミングに依らず同一フレーム列が再現される。
//  - シナリオごとに新規タブ（レンダラ隔離）。トグル状態は localStorage 事前注入
//    （#134 の表示オプション永続化経路）で起動時から反映する。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launch } from "./cdp.mjs";
import { decodePNG, regionStats, diffCount } from "./png.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const distHtml = join(root, "..", "dist", "rpdx.html");
const goldenDir = join(here, "golden");
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });

const UPDATE = process.env.UPDATE_GOLDEN === "1";
const FRAMES = 45;
// golden 比較の許容: チャネル差 >20 の画素比。
// golden の正準環境は CI（linux・Chrome for Testing 固定版）— linux では 2.5% の厳密ゲート。
// 他OSはフォントラスタライズが根本的に異なり同一版でも 9〜11% ずれる（実測）ため、
// 広い閾値で「大破綻のみ」検知する（存在チェックが主・golden はローカルでは参考）。
const GOLDEN_TOL = 20;
const GOLDEN_RATIO = process.platform === "linux" ? 0.025 : 0.20;
// ROI（1280x800・サイドパネル/HUD/タイムラインを避けたピッチ領域）
const ROI_TAC = { x0: 430, y0: 240, x1: 850, y1: 620 };   // 俯瞰
const ROI_BRD = { x0: 380, y0: 300, x1: 900, y1: 600 };   // 既定（放送）カメラ

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// 1シナリオ = 新規タブ → （注入）→ 読込 → 実時間ポーリングで45フレーム完了待ち → 検証・撮影
// （フレーム列自体はアプリの合成クロックで決定論 — ポーリング間隔は結果に影響しない）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runScenario = async (browser, { name, query, inject }) => {
  const page = await browser.newPage({ width: 1280, height: 800 });
  try {
    await page.injectOnNewDocument(
      "window.__rafFired=0;const _raf=window.requestAnimationFrame.bind(window);" +
      "window.requestAnimationFrame=(cb)=>_raf((ts)=>{window.__rafFired++;cb(ts)});");
    if (inject) await page.injectOnNewDocument(inject);
    await page.navigate(`file://${distHtml}${query}`);
    let done = 0;
    const t0 = Date.now();
    while (done !== FRAMES && Date.now() - t0 < 150000) {
      await sleep(300);
      done = await page.evaluate("globalThis.__RPDX_SHOT_DONE || 0");
    }
    const raf = await page.evaluate("window.__rafFired || 0");
    check(`${name}: 描画完了（${FRAMES}フレーム）`, done === FRAMES, `__RPDX_SHOT_DONE=${done} rAF=${raf}`);
    check(`${name}: 実行時エラーなし`, (await page.evaluate("document.getElementById('fatal') ? 1 : 0")) === 0);
    check(`${name}: タイトル正常`, (await page.evaluate("document.title")).startsWith("RPD-X"));
    const buf = await page.screenshot();
    writeFileSync(join(outDir, `${name}.png`), buf);
    const img = decodePNG(buf);
    check(`${name}: 寸法`, img.width === 1280 && img.height === 800, `${img.width}x${img.height}`);
    return img;
  } finally {
    await page.dispose();
  }
};

const compareGolden = (name, img, buf) => {
  const goldenPath = join(goldenDir, `${name}.png`);
  if (UPDATE) {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(goldenPath, buf);
    console.log(`● golden 更新: ${name}.png（意図的な視覚変更のPRでのみ・レビュー承認必須）`);
    return;
  }
  if (!existsSync(goldenPath)) {
    check(`${name}: golden の存在`, false, "UPDATE_GOLDEN=1 で生成しレビューを受けて commit する");
    return;
  }
  const g = decodePNG(readFileSync(goldenPath));
  const d = diffCount(img, g, GOLDEN_TOL);
  check(`${name}: golden 差分（許容内）`, !d.sizeMismatch && d.ratio <= GOLDEN_RATIO,
    `diff=${(d.ratio * 100).toFixed(2)}%（許容 ${(GOLDEN_RATIO * 100).toFixed(1)}%・tol=${GOLDEN_TOL}）`);
};

const main = async () => {
  if (!existsSync(distHtml)) throw new Error("dist/rpdx.html が無い（先に node rpdx/build.mjs）");
  const browser = await launch({ width: 1280, height: 800 });

  // --- S1: 俯瞰 — ピッチ/芝縞の存在 + golden ---
  const s1 = await runScenario(browser, { name: "tactical_t1732", query: `?t=1732&play=0&cam=tactical&shotframes=${FRAMES}` });
  {
    const st = regionStats(s1, ROI_TAC.x0, ROI_TAC.y0, ROI_TAC.x1, ROI_TAC.y1);
    check("S1: ピッチ描画（緑優勢率）", st.greenRatio > 0.30, `green=${(st.greenRatio * 100).toFixed(1)}%`);
    const bandW = 16, bands = [];
    for (let bx = ROI_TAC.x0; bx + bandW <= ROI_TAC.x1; bx += bandW) {
      let sum = 0, cnt = 0;
      for (let y = 300; y < 420; y++) for (let x = bx; x < bx + bandW; x++) { sum += s1.rgba[(y * s1.width + x) * 4 + 1]; cnt++; }
      bands.push(sum / cnt);
    }
    let amp = 0, flips = 0;
    for (let i = 1; i < bands.length; i++) {
      amp += Math.abs(bands[i] - bands[i - 1]);
      if (i >= 2 && Math.sign(bands[i] - bands[i - 1]) !== Math.sign(bands[i - 1] - bands[i - 2])) flips++;
    }
    amp /= bands.length - 1;
    check("S1: 芝ストライプのコントラスト", amp > 1.0 && flips >= 4, `帯間平均差=${amp.toFixed(2)} 反転=${flips}`);
    compareGolden("tactical_t1732", s1, readFileSync(join(outDir, "tactical_t1732.png")));
  }

  // --- S2: 既定（放送）カメラ — 接地影の存在 + golden ---
  const s2 = await runScenario(browser, { name: "broadcast_t1732", query: `?t=1732&play=0&shotframes=${FRAMES}` });
  {
    const st = regionStats(s2, ROI_BRD.x0, ROI_BRD.y0, ROI_BRD.x1, ROI_BRD.y1);
    console.log(`  S2 計測: green=${(st.greenRatio * 100).toFixed(1)}% dark=${(st.darkRatio * 100).toFixed(2)}% mean=[${st.mean.map((v) => v.toFixed(0))}]`);
    check("S2: ピッチ描画（緑優勢率）", st.greenRatio > 0.30, `green=${(st.greenRatio * 100).toFixed(1)}%`);
    // 接地影 = 明るいピッチ上の濃い暗色ブロブ。ピッチ自体の暗部と分離するため
    // 「ROI平均輝度の55%未満」の相対しきい値で数える。
    const meanLum = 0.2126 * st.mean[0] + 0.7152 * st.mean[1] + 0.0722 * st.mean[2];
    let shadowPx = 0;
    for (let y = ROI_BRD.y0; y < ROI_BRD.y1; y++) for (let x = ROI_BRD.x0; x < ROI_BRD.x1; x++) {
      const i = (y * s2.width + x) * 4;
      const lum = 0.2126 * s2.rgba[i] + 0.7152 * s2.rgba[i + 1] + 0.0722 * s2.rgba[i + 2];
      if (lum < meanLum * 0.55) shadowPx++;
    }
    const total = (ROI_BRD.x1 - ROI_BRD.x0) * (ROI_BRD.y1 - ROI_BRD.y0);
    console.log(`  S2 接地影候補: ${shadowPx}px（${((shadowPx / total) * 100).toFixed(2)}%・平均輝度=${meanLum.toFixed(0)}）`);
    check("S2: 接地影（相対暗色ブロブ）", shadowPx > 150 && shadowPx / total < 0.2, `${shadowPx}px`);
    compareGolden("broadcast_t1732", s2, readFileSync(join(outDir, "broadcast_t1732.png")));
  }

  // --- S3: 追従（近接）カメラ — 背番号の描画寄与（ON/OFF起動ペアの差分）+ golden ---
  // 近接では胴背面の番号が数百px規模になり、トグルOFF起動（localStorage事前注入・#134経路）
  // との差分で「実際に描かれていること」を機能的に証明できる。
  const s3a = await runScenario(browser, { name: "follow_t1732", query: `?t=1732&play=0&cam=pitch&shotframes=${FRAMES}` });
  compareGolden("follow_t1732", s3a, readFileSync(join(outDir, "follow_t1732.png")));
  const s3b = await runScenario(browser, {
    name: "follow_t1732_nonum",
    query: `?t=1732&play=0&cam=pitch&shotframes=${FRAMES}`,
    inject: `try{localStorage.setItem("rpdx_opts_v1",JSON.stringify({kitNumbers:false}))}catch(e){}`,
  });
  {
    let numDiff = 0;
    for (let y = ROI_BRD.y0; y < ROI_BRD.y1; y++) for (let x = ROI_BRD.x0; x < ROI_BRD.x1; x++) {
      const i = (y * s3a.width + x) * 4;
      if (Math.abs(s3a.rgba[i] - s3b.rgba[i]) > 24 || Math.abs(s3a.rgba[i + 1] - s3b.rgba[i + 1]) > 24) numDiff++;
    }
    console.log(`  S3 計測: 背番号ON/OFF差分=${numDiff}px`);
    // 合成クロック下の決定値=74px（3回連続でビット同一を実測）。>40 は決定値の54%で、
    // 遠景ノイズ床（17px級）とは明確に分離する。
    check("S3: 背番号テクスチャの描画寄与（OFF起動で画素が変わる）", numDiff > 40, `${numDiff}px`);
  }

  // --- S4: Cinematic tier — 方向性キャストシャドウ（#157・VIS-00 の初消費）+ golden ---
  // 既定の自動判定は CI(SwiftShader)で lightweight のため、?tier=cinematic で影経路を強制的に走らせる。
  const s4 = await runScenario(browser, { name: "cinematic_shadow_t1732", query: `?t=1732&play=0&cam=pitch&shotframes=${FRAMES}&tier=cinematic` });
  {
    // 影経路が実際に有効か（Cinematic 確定 + shadowMap フラグ）
    const page = await browser.newPage({ width: 1280, height: 800 });
    await page.navigate(`file://${distHtml}?t=1732&play=0&cam=pitch&shotframes=${FRAMES}&tier=cinematic`);
    for (let i = 0; i < 60; i++) { await sleep(200); if ((await page.evaluate("globalThis.__RPDX_SHOT_DONE||0")) === FRAMES) break; }
    const flag = await page.evaluate("(function(){try{var q=RPDX.quality.state();return q.tier+'/'+RPDX.quality.flags.shadowMap}catch(e){return 'err'}})()");
    await page.dispose();
    check("S4: Cinematic で影フラグが有効", flag === "cinematic/true", `flags=${flag}`);
    // Lightweight(円盤影)との差分が影領域に出る＝影経路が別の絵を描いている
    const d = diffCount(s4, s3a, GOLDEN_TOL);
    console.log(`  S4 計測: cinematic vs lightweight 差分=${(d.ratio * 100).toFixed(2)}%`);
    check("S4: 影ありは影なしと有意に異なる", !d.sizeMismatch && d.ratio > 0.005, `diff=${(d.ratio * 100).toFixed(2)}%`);
    compareGolden("cinematic_shadow_t1732", s4, readFileSync(join(outDir, "cinematic_shadow_t1732.png")));
  }

  await browser.close();
  console.log(failures === 0 ? "\n視覚スモーク: 全チェック合格" : `\n視覚スモーク: ${failures} 件失敗（out/ に実画像あり）`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => { console.error("視覚スモーク実行エラー:", e.message); process.exit(1); });
