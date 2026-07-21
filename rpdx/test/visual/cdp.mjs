// #153 視覚回帰ゲート — 依存ゼロの最小CDPクライアント
// Node 組込み（child_process / 全域 WebSocket・Node 22+）のみで Chrome を起動し
// 生プロトコルで駆動する。Puppeteer/Playwright 等の外部パッケージは使わない。
import { spawn, execSync } from "node:child_process";
import { existsSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Chrome バイナリ解決: CHROME_BIN > PATH(linux CI) > mac の headless-shell / Chrome.app
export const resolveChrome = () => {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]) {
    try {
      const p = execSync(`command -v ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (p) return p;
    } catch { /* 次の候補へ */ }
  }
  const cacheRoot = join(process.env.HOME || "", ".cache", "puppeteer", "chrome-headless-shell");
  if (existsSync(cacheRoot)) {
    const vers = readdirSync(cacheRoot).sort();     // 末尾=最新
    for (let i = vers.length - 1; i >= 0; i--) {
      for (const plat of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64"]) {
        const p = join(cacheRoot, vers[i], plat, "chrome-headless-shell");
        if (existsSync(p)) return p;
      }
    }
  }
  const macApp = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(macApp)) return macApp;
  throw new Error("Chrome が見つかりません（CHROME_BIN で指定可）");
};

export const launch = async ({ width = 1280, height = 800 } = {}) => {
  const bin = resolveChrome();
  const profile = mkdtempSync(join(tmpdir(), "rpdx-vis-"));
  const args = [
    "--headless", "--no-sandbox", "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",                 // GPUなし環境（CI）でWebGL2をソフトウェア描画
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run", "--hide-scrollbars",
    `--window-size=${width},${height}`,
    "about:blank",
  ];
  const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = "";
    const to = setTimeout(() => reject(new Error("DevTools URL がstderrに出ない:\n" + err)), 30000);
    proc.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(to); resolve(m[1]); }
    });
    proc.on("exit", (c) => { clearTimeout(to); reject(new Error("Chrome が起動前に終了 code=" + c + "\n" + err)); });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("WebSocket接続失敗 " + wsUrl)); });

  let nextId = 1;
  const pending = new Map();           // id -> {resolve, reject}
  const eventWaiters = [];             // {method, sessionId, pred, resolve, timer}
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (let i = eventWaiters.length - 1; i >= 0; i--) {
        const w = eventWaiters[i];
        if (w.method === msg.method && (!w.sessionId || w.sessionId === msg.sessionId) && (!w.pred || w.pred(msg.params))) {
          clearTimeout(w.timer);
          eventWaiters.splice(i, 1);
          w.resolve(msg.params);
        }
      }
    }
  };

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
  const waitEvent = (method, { sessionId, pred, timeoutMs = 60000 } = {}) => new Promise((resolve, reject) => {
    const w = { method, sessionId, pred, resolve };
    w.timer = setTimeout(() => {
      const i = eventWaiters.indexOf(w);
      if (i >= 0) eventWaiters.splice(i, 1);
      reject(new Error(`イベント待ちタイムアウト: ${method}`));
    }, timeoutMs);
    eventWaiters.push(w);
  });

  // ページ（タブ）単位のセッションを作る。シナリオごとに新規タブ＝新規レンダラで、
  // 仮想時間・localStorage 注入・描画状態をタブ内に隔離する（プロセス連続起動は
  // 2回目以降にコンポジタがフレームを発行しない事象があるため、タブ方式が安定）。
  const newPage = async ({ width = 1280, height = 800 } = {}) => {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    // ビューポートを明示固定（プラットフォームのウィンドウ装飾差で 1280x713 等になるのを防ぐ）
    await send("Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    return {
      // ページスクリプト実行前に評価されるスクリプトを登録（navigate 前に呼ぶ・localStorage 事前注入等）
      async injectOnNewDocument(source) {
        await send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
      },
      // 決定論の設計メモ（#153・実測済みの落とし穴）:
      //  - CDP 仮想時間（setVirtualTimePolicy）は再付与境界で rAF 連鎖が止まる事象がある
      //    （mac/linux 双方で実測）ため使わない。
      //  - 代わりにアプリ側がショットモードで合成クロック（フレーム番号×16.6ms）を使う
      //    （ui.mjs #153）。ドライバは実時間で SHOT_DONE をポーリングするだけでよい。
      async navigate(url, { timeoutMs = 90000 } = {}) {
        const loaded = waitEvent("Page.loadEventFired", { sessionId, timeoutMs });
        await send("Page.navigate", { url }, sessionId);
        await loaded;
      },
      async evaluate(expr) {
        const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error("ページ内評価エラー: " + (r.exceptionDetails.text || "") + " " + JSON.stringify(r.exceptionDetails.exception || {}));
        return r.result.value;
      },
      async screenshot(opts = {}) {
        // opts.clip = {x,y,width,height,scale}: 部分拡大撮影（継ぎ目・細部の検分用）
        const params = { format: "png" };
        if (opts.clip) params.clip = opts.clip;
        const r = await send("Page.captureScreenshot", params, sessionId);
        return Buffer.from(r.data, "base64");
      },
      async dispose() {
        try { await send("Target.closeTarget", { targetId }); } catch { /* タブ破棄失敗は無視 */ }
      },
    };
  };

  return {
    proc, newPage,
    async close() {
      try { await send("Browser.close"); } catch { /* すでに落ちていれば無視 */ }
      try { proc.kill("SIGKILL"); } catch { /* 同上 */ }
    },
  };
};
