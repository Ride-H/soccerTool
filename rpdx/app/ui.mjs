/* =========================================================================
   RPDX.app — アプリケーション層
   HUD / タイムライン / 配置エディタ / 交代シム / シナリオ結果 / モーダル
   ========================================================================= */
(() => {
  const R = globalThis.RPDX;
  const E = R.engine, D = R.danger, S = R.subs, G = R.generic, F = R.formations, SIM = R.sim, PSY = R.psy;
  const DUEL = R.duel, PHYS = R.physio, UQ = R.uq;
  const $ = (s) => document.querySelector(s);
  const clamp = R.noise.clamp;
  const hex2rgb = (h) => {
    const v = parseInt(h.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  };

  const SERIES = { plus: "#BA8608", plusBright: "#FFC61A", minus: "#4A7DFF", minusBright: "#7FA6FF" };
  const STATUS = { OK: "ok", WARNING: "warn", CRITICAL: "crit" };
  const GOLD = "#E7CD96";

  const App = (R.app = {
    match: R.data.MATCH,
    scenario: null, scenarios: [],
    t: 0, playing: false, speed: 12,
    options: {
      labels: true, trails: true, includeGK: false,
      fieldMode: "particles",     // particles | surface | off
      zones: true, solidPlayers: false,
      speedLabels: true, psy: true,
      kitNumbers: true, goalReplay: true,   // #134: 描画リアル感v1（背番号・ゴールリプレイ）
    },
    replay: null,   // #134: ゴール・スロー・リプレイ制御 {endT, restoreT, restoreSpeed, restoreCam}
    zoneView: "BOTH",
    camPreset: "broadcast",   // #134: 現在のカメラプリセット（リプレイ後の復帰先）
    selected: null, hover: null,
    editFrame: null, editSel: null, editHist: null,   // #133: 編集アンドゥ/リドゥ履歴
    rosterTab: null,
    pickOut: null, pickIn: null,
    editorSel: null, editorDrag: null,
    lastIx: null, lastField: null, lastZone: null,
    lastPsy: null, lastPsySel: null, speedMap: new Map(), sprintSet: new Set(),
    hotZone: null,
  });

  const teamOrder = () => App.match.teamOrder || Object.keys(App.match.teams);
  const seriesColor = (k, bright) => {
    const plus = App.match.possessionPlus || teamOrder()[0];
    return k === plus ? (bright ? SERIES.plusBright : SERIES.plus) : (bright ? SERIES.minusBright : SERIES.minus);
  };
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + "km" : Math.round(m) + "m");

  /* ------------------------------ 旗 ------------------------------ */
  const drawFlag = (cv, code, color) => {
    const g = cv.getContext("2d");
    g.clearRect(0, 0, 52, 36);
    if (code === "JPN") {
      g.fillStyle = "#F4F6FA"; g.fillRect(0, 0, 52, 36);
      g.fillStyle = "#BC002D"; g.beginPath(); g.arc(26, 18, 10.5, 0, 7); g.fill();
    } else if (code === "ARG") {
      g.fillStyle = "#74ACDF"; g.fillRect(0, 0, 52, 36);
      g.fillStyle = "#F4F6FA"; g.fillRect(0, 12, 52, 12);
      g.fillStyle = "#F6B40E"; g.beginPath(); g.arc(26, 18, 4.6, 0, 7); g.fill();
      g.strokeStyle = "#F6B40E"; g.lineWidth = 1;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.beginPath(); g.moveTo(26 + Math.cos(a) * 5.5, 18 + Math.sin(a) * 5.5);
        g.lineTo(26 + Math.cos(a) * 7.5, 18 + Math.sin(a) * 7.5); g.stroke();
      }
    } else if (code === "EGY") {
      g.fillStyle = "#CE1126"; g.fillRect(0, 0, 52, 12);
      g.fillStyle = "#F4F6FA"; g.fillRect(0, 12, 52, 12);
      g.fillStyle = "#0A0A0A"; g.fillRect(0, 24, 52, 12);
      g.fillStyle = "#C09300"; g.beginPath();
      g.moveTo(26, 13.5); g.lineTo(29.5, 22.5); g.lineTo(26, 21); g.lineTo(22.5, 22.5); g.closePath(); g.fill();
    } else if (code === "BRA") {
      g.fillStyle = "#009C3B"; g.fillRect(0, 0, 52, 36);
      g.fillStyle = "#FFDF00"; g.beginPath();
      g.moveTo(26, 4); g.lineTo(48, 18); g.lineTo(26, 32); g.lineTo(4, 18); g.closePath(); g.fill();
      g.fillStyle = "#002776"; g.beginPath(); g.arc(26, 18, 7.5, 0, 7); g.fill();
    } else {
      g.fillStyle = color || "#888"; g.fillRect(0, 0, 52, 36);
      g.fillStyle = "rgba(255,255,255,.85)";
      g.font = "800 15px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(code.slice(0, 3), 26, 19);
    }
  };

  /* --------------------------- シナリオ管理 --------------------------- */
  const activeScenario = () => App.scenario || E.actualScenario(App.match);
  const isSim = () => App.scenario && !App.scenario.actual;
  const forkIfActual = () => {
    if (isSim()) return App.scenario;
    const sc = S.fromActual(App.match, `シナリオ ${App.scenarios.length + 1}`);
    App.scenarios.push(sc);
    App.scenario = sc;
    return sc;
  };
  // シナリオ編集の共通適用: 差替→UI再構築→結果再計算
  const refreshScenario = (nextSc) => {
    const i = App.scenarios.indexOf(App.scenario);
    if (i >= 0) App.scenarios[i] = nextSc; else App.scenarios.push(nextSc);
    App.scenario = nextSc;
    buildScenarioChips(); buildSubList(); buildRoster(); drawEditor();
    computeOutcome(nextSc);
  };
  const computeOutcome = (sc) => {
    renderOutcome("計算中");
    // 1) 正準曲線（GK除外20人）で結果を確定 → 2) 表示曲線を再計算
    ensureCurveFor(sc, { includeGK: false }, () => {
      if (App.scenario !== sc) return;
      const oc = SIM.attach(App.match, sc, { includeGK: false });
      renderOutcome();
      // 結果が変わったら通知（初回確定時のみ）
      if (oc && !sc.__notified && (oc.removed.length + oc.added.length > 0)) {
        sc.__notified = true;
        const [a, b] = teamOrder();
        toast(`結果が変化 — ${App.match.teams[a].name} ${oc.score[a]}–${oc.score[b]} ${App.match.teams[b].name}（実試合 ${oc.actualScore[a]}–${oc.actualScore[b]}）`, GOLD);
      }
      // outcome付与後の世界の正準曲線（PSYレイヤーが参照）+ 表示曲線
      ensureCurveFor(sc, { includeGK: false }, () => {});
      ensureCurveFor(sc, { includeGK: App.options.includeGK }, () => {});
    });
  };

  /* ----------------------------- 曲線計算 ----------------------------- */
  const curveStore = new Map();
  const curveKeyOf = (sc, opts) =>
    `${App.match.meta.id}|${E.scenarioKey(sc)}|8|${opts.includeGK ? 1 : 0}`;

  /* Web Worker オフロード（#38）: core script タグ（DOM非依存の計算層）のテキストから
     Blob Worker を生成し、危険度曲線をメインスレッド外で計算する。
     Worker 不可（CSP/file制限/エラー）時は従来のチャンク計算へ自動フォールバック。
     シナリオは scenlib で直列化して渡す — 内容ベース hash なので同一世界・同一結果。 */
  let dWorker = null, dwSeq = 0, dwFailed = false;
  const dwCbs = new Map();
  const workerCurve = (match, sc, opts, onDone) => {
    // file:// では Blob Worker が origin=null で拒否される環境があるため最初から使わない（メインスレッド計算へ）
    if (dwFailed || typeof Worker === "undefined" || location.protocol === "file:") return false;
    try {
      if (!dWorker) {
        const core = document.getElementById("rpdx-core");
        if (!core || !core.textContent.includes("R.danger")) return false;
        const glue = `
self.onmessage = (e) => {
  const { id, matchId, scen, opts, geomOnly } = e.data;
  try {
    const R = globalThis.RPDX;
    const m = R.data.MATCHES[matchId];
    if (R.danger.isGeomOnly() !== !!geomOnly) R.danger.setGeomOnly(!!geomOnly);
    const scenario = scen ? R.scenlib.parse(m, scen).scenario : R.engine.actualScenario(m);
    if (e.data.withOutcome && scen) R.sim.attach(m, scenario);   // outcome込みの世界を決定論再構成
    const pts = R.danger.curve(m, scenario, opts);
    postMessage({ id, pts });
  } catch (err) { postMessage({ id, error: String(err && err.message || err) }); }
};`;
        dWorker = new Worker(URL.createObjectURL(
          new Blob([core.textContent + glue], { type: "text/javascript" })));
        dWorker.onmessage = (e) => {
          const cb = dwCbs.get(e.data.id);
          dwCbs.delete(e.data.id);
          if (e.data.error) { console.warn("worker curve error:", e.data.error); cb && cb(null); }
          else cb && cb(e.data.pts);
        };
        dWorker.onerror = (e) => {
          console.warn("curve worker failed — チャンク計算へフォールバック", e.message || "");
          dwFailed = true;
          for (const cb of dwCbs.values()) cb(null);
          dwCbs.clear();
          try { dWorker.terminate(); } catch {}
          dWorker = null;
        };
      }
      const id = ++dwSeq;
      dwCbs.set(id, onDone);
      dWorker.postMessage({
        id, matchId: match.meta.id,
        scen: sc.actual ? null : globalThis.RPDX.scenlib.serialize(sc),
        withOutcome: !!sc.outcome,
        opts: { step: opts.step || 8, includeGK: !!opts.includeGK },
        geomOnly: D.isGeomOnly(),
      });
      return true;
    } catch (e) {
      console.warn("worker unavailable:", e && e.message);
      dwFailed = true;
      return false;
    }
  };

  const ensureCurveFor = (sc, opts, cb) => {
    const key = curveKeyOf(sc, opts);
    if (curveStore.has(key)) { cb && cb(); return; }
    const finish = (pts) => {
      curveStore.set(key, pts);
      $("#curveStatus").textContent = "";
      cb && cb();
    };
    const fallback = () => D.curveAsync(App.match, sc, { step: 8, includeGK: opts.includeGK },
      (p) => { $("#curveStatus").textContent = `D²曲線 ${Math.round(p * 100)}%`; },
      finish);
    $("#curveStatus").textContent = "D²曲線 計算中…";
    // 無応答フォールバック: Worker が2.5秒応答しなければチャンク計算へ切替
    //（ヘッドレス仮想時間や環境制限で Worker が進まないケースの保険。
    //  二重完了は done ガードで抑止 — 結果は決定論なのでどちらでも同一値）
    let done = false;
    const once = (fn) => (arg) => { if (done) return; done = true; fn(arg); };
    const finishOnce = once(finish);
    const fallbackOnce = once(fallback);
    const sent = workerCurve(App.match, sc, { step: 8, includeGK: opts.includeGK },
      (pts) => { if (pts) finishOnce(pts); else fallbackOnce(); });
    if (!sent) { fallbackOnce(); return; }
    setTimeout(() => fallbackOnce(), 2500);
  };
  const actualCurve = () => curveStore.get(curveKeyOf(E.actualScenario(App.match), { includeGK: App.options.includeGK }));
  const activeCurve = () => curveStore.get(curveKeyOf(activeScenario(), { includeGK: App.options.includeGK }));
  // PSY は正準曲線（step8・GK除外）を参照する — キャッシュ済みの時だけ呼ぶ（同期再計算のヒッチ防止）
  const psyReady = () => curveStore.has(curveKeyOf(activeScenario(), { includeGK: false }));

  /* ------------------------------ 起動 ------------------------------ */
  // URLパラメータ: ?t=秒 &cam=broadcast|tactical|goal|pitch|fly &play=0|1 &speed=n
  const urlq = new URLSearchParams(location.search);

  /* ------ 国際化 i18n v1（#42・静的クロームのみ・?lang=en で英語）------
     動的な解析文言（フェーズ名・リスタート種別・危険度説明等）は日本語のまま=部分対応。 */
  const I18N = {
    en: {
      "放送": "Broadcast", "俯瞰": "Tactical", "ゴール裏": "Goal line", "追従": "Follow", "自由飛行": "Free-fly",
      "危険場": "Danger", "ゾーン": "Zones", "軌跡": "Trails", "番号": "Numbers", "速度": "Speed",
      "背番号": "Kit №", "リプレイ": "Replay", "品質": "Quality",
      "試合情報": "Match Info", "モデル": "Model", "カスタム": "Custom",
      "再生": "Play", "停止": "Pause", "前": "Prev", "次": "Next",
      "選手": "Players", "配置": "Formation", "交代": "Subs", "シナリオ結果": "Scenario Result",
      "陣形を適用": "Apply", "分": "min", "現在": "Now", "交代を追加": "Add sub", "クリア": "Clear",
      "微調整を解除": "Reset tweaks", "実試合に戻す": "Reset to actual",
      "算定モジュール": "Modules", "ゾーニング視点": "Zoning View", "脅威寄与 TOP": "Top Threats", "危険度": "Index",
    },
  };
  const LANG = urlq.get("lang") === "en" ? "en" : "ja";
  const t = (ja) => (LANG !== "ja" && I18N[LANG] && I18N[LANG][ja]) || ja;
  const applyI18n = () => {
    if (LANG === "ja") return;
    document.documentElement.lang = LANG;
    document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  };

  let renderer, tlCtx;
  const boot = () => {
    $("#appVer") && ($("#appVer").textContent = "v" + (R.VERSION || "?"));   // バージョン表示
    // #152: 品質ティア確定（?tier= > 端末保存 > 自動判定・迷ったら軽量）— レンダラ生成前
    R.quality && R.quality.init();
    // 試合レジストリ切替（?match=<id>）— レンダラ生成前に確定させる。
    // #92b: 既定起動は「未較正テンプレ（自チーム起点）」。収録実試合は ?match=<id>／スイッチャで選択。
    const mq = urlq.get("match");
    if (mq && mq !== "template" && mq !== "__tpl__" && R.data.MATCHES && R.data.MATCHES[mq]) App.match = R.data.MATCHES[mq];
    else App.match = getTemplateMatch();
    // #91残: ?data= バンドルに customMatch があれば起動試合をそれで確定（レンダラ生成前）
    if (urlq.has("data")) {
      try {
        const ob = JSON.parse(decodeURIComponent(urlq.get("data")));
        if (ob && ob.customMatch) App.match = G.createMatch(ob.customMatch);
        else if (ob && ob.match && R.data.MATCHES[ob.match]) App.match = R.data.MATCHES[ob.match];
      } catch { /* 後段の適用処理が拒否する */ }
    }
    try {
      renderer = R.render3d.create($("#gl"), App.match);
    } catch (err) {
      // WebGL2 未対応環境（iOS の Files/Quick Look プレビュー等）: 固まらせず原因と導線を表示
      const l = $("#loading");
      if (l) {
        l.style.display = "flex";
        l.innerHTML =
          '<div style="max-width:330px;text-align:center;padding:22px;color:#e6ecf8;font:14px/1.75 system-ui,-apple-system,sans-serif">' +
          '<div style="font-size:30px;font-weight:200;letter-spacing:.22em;margin-bottom:14px">RPD<span style="color:#E7CD96">–X</span></div>' +
          '<b>3D表示（WebGL2）を初期化できませんでした。</b><br>' +
          'この開き方（iOS の「ファイル」プレビュー等）は 3D に対応していません。<br><br>' +
          '<b>Safari で URL から</b>開いてください。オフライン常用は「ホーム画面に追加」を推奨。' +
          '<div style="color:#7f8ea6;margin-top:12px;font-size:11px;font-family:monospace">' + String(err && err.message || err) + '</div></div>';
      }
      return;
    }
    App.rosterTab = teamOrder()[1] || teamOrder()[0]; // 既定: 日本
    const fit = () => { renderer.resize(); fitTimeline(); fitEditor(); fitPsy(); };
    window.addEventListener("resize", fit);
    fit();
    buildStatic();
    applyI18n();
    if (urlq.has("t")) App.t = clamp(+urlq.get("t") || 0, 0, E.playedRange(App.match).t1);
    if (urlq.has("speed")) App.speed = +urlq.get("speed") || 12;
    if (urlq.has("cam")) {
      App.camPreset = urlq.get("cam");
      renderer.setPreset(urlq.get("cam"), true);
      document.querySelectorAll("#viewbar .cam").forEach(x => x.classList.toggle("on", x.dataset.cam === urlq.get("cam")));
    }
    if (urlq.has("sel")) {
      const [tm, no] = urlq.get("sel").split(":");
      if (App.match.teams[tm]) selectPlayer(tm, +no);
    }
    if (urlq.has("scenario")) {
      // #34: 直列化シナリオの深いリンク（scenlib 形式 JSON）— 検証NG時は無視
      try {
        const { scenario, validation } = globalThis.RPDX.scenlib.parse(App.match, decodeURIComponent(urlq.get("scenario")));
        if (validation.ok) refreshScenario(scenario);
        else console.warn("scenario param invalid:", validation.errors);
      } catch (e) { console.warn("scenario param parse error", e); }
    }
    if (urlq.has("data")) {
      // #91: 統合バンドル JSON の深いリンク（端末内のみ・検証NG時は無視）
      try {
        const r = globalThis.RPDX.scenlib.parseBundle(App.match, decodeURIComponent(urlq.get("data")));
        if (!r.error && r.validation && r.validation.ok) { refreshScenario(r.scenario); if (r.frame) App.editFrame = r.frame; }
        else console.warn("data param invalid:", r.error || (r.validation && r.validation.errors));
      } catch (e) { console.warn("data param parse error", e); }
    }
    if (urlq.get("demo") === "sim") {
      // 検証/デモ用: 66' 鎌田→久保 のwhat-ifシナリオを自動生成
      let sc = S.fromActual(App.match, "久保投入 66'");
      sc.subs.JPN = sc.subs.JPN.filter(s => s.out !== 15);
      const r = S.withSub(App.match, sc, "JPN", { t: 2880 + 21 * 60, out: 15, in: 8 });
      if (r.validation.ok) refreshScenario(r.scenario);
    } else if (urlq.get("demo") === "blitz") {
      // 検証/デモ用: 日本を4-4-2へ（開始から）→ 決定論で同点に追いつく結果変化
      let sc = S.fromActual(App.match, "日本4-4-2");
      const r = S.withFormation(App.match, sc, "JPN", 0, "442");
      if (r.validation.ok) refreshScenario(r.scenario);
    }
    if (urlq.has("zone")) { App.zoneView = urlq.get("zone"); buildZoneViewBtns(); }
    if (urlq.get("field")) { App.options.fieldMode = urlq.get("field"); $("#fieldModeLbl").textContent = FIELD_MODES.find(m => m[0] === App.options.fieldMode)?.[1] || "粒子"; }
    if (urlq.get("zones") === "0") { App.options.zones = false; $("#togZones").classList.remove("on"); }
    ensureCurveFor(E.actualScenario(App.match), { includeGK: false }, () => {
      $("#loadFill").style.width = "100%";
      setTimeout(() => {
        $("#loading").style.display = "none";
        App.playing = urlq.get("play") !== "0";
        $("#btnPlay").textContent = App.playing ? "❚❚ " + t("停止") : "▶ " + t("再生");
      }, 250);
    });
    // 保険: どんな環境（file:// 等で曲線計算が詰まる等）でもローディングで固まらないよう強制解除
    setTimeout(() => {
      const l = $("#loading");
      if (l && l.style.display !== "none") { l.style.display = "none"; App.playing = urlq.get("play") !== "0"; }
    }, 4500);
    // 事前計算の進捗をローディングにも反映
    const origStatus = $("#curveStatus");
    const obs = new MutationObserver(() => {
      const m = origStatus.textContent.match(/(\d+)%/);
      if (m) { $("#loadFill").style.width = m[1] + "%"; $("#loadMsg").textContent = `D²-Field v2 曲線を事前計算中… ${m[1]}%`; }
    });
    obs.observe(origStatus, { childList: true });
    startWhenReady();
  };

  const buildStatic = () => {
    const [a, b] = teamOrder();
    drawFlag($("#flagA"), a, App.match.teams[a].color);
    drawFlag($("#flagB"), b, App.match.teams[b].color);
    $("#nameA").textContent = App.match.teams[a].nameEn || a;
    $("#nameB").textContent = App.match.teams[b].nameEn || b;
    document.title = `RPD-X | ${App.match.teams[a].name} × ${App.match.teams[b].name} — D²-Field 戦術解析`;
    buildRosterTabs();
    buildRoster();
    buildEditorStatic();
    buildScenarioChips();
    buildSubList();
    buildKikenTiles();
    buildPsyPanel();
    buildMatchSel();
    buildShockTeamSel();
    // #92: 未較正（汎用推定）試合は明示。収録実試合（calibrated未設定）では非表示。
    const cc = $("#calibChip");
    if (cc) cc.style.display = App.match.meta.calibrated === false ? "" : "none";
    buildZoneViewBtns();
    buildInfoModal();
    buildModelModal();
    renderOutcome();
    $("#tlLegend").innerHTML = teamOrder().map(k =>
      `<span><i class="sw" style="background:${seriesColor(k)}"></i>${App.match.teams[k].name} 危険度</span>`
    ).join("") + `<span><i class="sw" style="background:transparent;border-top:2px dashed ${GOLD}"></i>シナリオ</span>` +
      `<span title="ピンの来歴: ○=公式記録のイベント / ◆=SIMが生成したイベント（モデル）">○記録 ◆SIM生成</span>`;
    $("#fieldLegend").innerHTML =
      `<span><i class="sw" style="background:linear-gradient(90deg,#FF9D2E,#FF3B2E)"></i>${App.match.teams[teamOrder()[0]].name}の脅威</span>` +
      `<span><i class="sw" style="background:linear-gradient(90deg,#3F8CFF,#7FE7FF)"></i>${App.match.teams[teamOrder()[1]].name}の脅威</span>`;
  };

  /* --------------------------- ロスター UI --------------------------- */
  const buildRosterTabs = () => {
    const wrap = $("#rosterTabs");
    wrap.innerHTML = "";
    for (const k of teamOrder()) {
      const b = document.createElement("button");
      b.className = "btn" + (App.rosterTab === k ? " on" : "");
      b.textContent = App.match.teams[k].name;
      b.onclick = () => {
        App.rosterTab = k; App.editorSel = null;
        buildRosterTabs(); buildRoster(); drawEditor(); renderSuggestions(null);
      };
      wrap.appendChild(b);
    }
  };

  const rosterState = (team, no, t) => {
    const sc = activeScenario();
    const pr = E.presenceOf(App.match, sc, team, no);
    if (!pr) return { s: "bench", label: "ベンチ" };
    if (t < pr.from) return { s: "willon", label: S.tToLabel(App.match, pr.from) + " IN" };
    if (t >= pr.to && pr.to < E.playedRange(App.match).t1) return { s: "used", label: S.tToLabel(App.match, pr.to) + " OUT" };
    return { s: "on", label: "出場中" };
  };

  // #92b: 未較正（テンプレ/カスタム）試合のみ、左リストで背番号・名前を直接編集できる。
  let rosterEdit = null;   // { team, no } 編集中の行
  const rosterEditable = () => App.match.meta.calibrated === false;

  const commitRosterEdit = (team, oldNo) => {
    const numEl = $("#redNum"), nameEl = $("#redName"), posEl = $("#redPos");
    if (!numEl || !nameEl) return;
    const r = G.editEntry(App.match, team, oldNo, {
      no: numEl.value === "" ? null : +numEl.value,
      name: nameEl.value,
      pos: posEl ? posEl.value : undefined,
    });
    if (!r.ok) { toast(r.error, "var(--crit-t)"); return; }
    const newNo = r.newNo;
    if (newNo !== oldNo) {
      // scenario 級上書き・交代の参照も再マップ（golden安全: 未較正試合のみ）
      const sc = App.scenario;
      if (sc) {
        for (const key of ["attrOverrides", "nameOverrides"]) {
          const o = sc[key];
          if (o && o[team] && o[team][oldNo] != null) { o[team][newNo] = o[team][oldNo]; delete o[team][oldNo]; }
        }
        for (const s of (sc.subs?.[team] || [])) { if (s.out === oldNo) s.out = newNo; if (s.in === oldNo) s.in = newNo; }
      }
      if (App.selected && App.selected.team === team && App.selected.no === oldNo) App.selected.no = newNo;
      if (App.pickOut && App.pickOut.team === team && App.pickOut.no === oldNo) App.pickOut.no = newNo;
      if (App.pickIn && App.pickIn.team === team && App.pickIn.no === oldNo) App.pickIn.no = newNo;
    }
    // 背番号・ポジション（GKスワップ含む）・名前はXI/識別/属性に影響 → 全キャッシュを更新
    E.clearCaches(); D.clearCaches(); PSY.clearCaches(); PHYS.clearCaches(); curveStore.clear();
    rosterEdit = null;
    buildStatic();
    drawEditor();
    updateSubSlots();
    // 危険度カーブ・シナリオ結果は curveStore 由来 → クリア後に必ず再計算する（setCore と同じ正準パターン）
    ensureCurveFor(E.actualScenario(App.match), { includeGK: false }, () => {
      ensureCurveFor(E.actualScenario(App.match), { includeGK: App.options.includeGK }, () => {});
      if (isSim()) computeOutcome(App.scenario); else renderOutcome();
    });
    toast("ロスターを更新（未較正・端末内のみ）", GOLD);
  };

  const buildRoster = () => {
    const team = App.rosterTab, T = App.match.teams[team];
    const list = $("#plist");
    list.innerHTML = "";
    const kit = T.kit;
    const editable = rosterEditable();
    const sorted = [...T.squad].sort((x, y) => {
      const sx = rosterState(team, x.no, App.t).s, sy = rosterState(team, y.no, App.t).s;
      const ord = { on: 0, willon: 1, bench: 2, used: 3 };
      return (ord[sx] - ord[sy]) || (x.no - y.no);
    });
    for (const p of sorted) {
      const st = rosterState(team, p.no, App.t);
      const row = document.createElement("div");
      row.className = "prow";
      row.dataset.no = p.no;
      const isGK = p.pos === "GK";
      // 編集中の行: 背番号・名前の入力欄（未較正のみ）
      if (rosterEdit && rosterEdit.team === team && rosterEdit.no === p.no) {
        row.classList.add("editing");
        row.innerHTML =
          `<input id="redNum" class="numin" type="number" min="1" max="99" value="${p.no}" style="width:44px" aria-label="背番号">` +
          `<select id="redPos" class="sel" style="width:50px" aria-label="ポジション">${["GK", "DF", "MF", "FW"].map(o => `<option value="${o}"${p.pos === o ? " selected" : ""}>${o}</option>`).join("")}</select>` +
          `<input id="redName" type="text" value="${(p.ja || "").replace(/"/g, "&quot;")}" style="flex:1;min-width:0" aria-label="選手名">` +
          `<button class="btn" id="redSave" aria-label="保存">✓</button>` +
          `<button class="btn" id="redCancel" aria-label="取消">✕</button>`;
        list.appendChild(row);
        $("#redSave").onclick = (e) => { e.stopPropagation(); commitRosterEdit(team, p.no); };
        $("#redCancel").onclick = (e) => { e.stopPropagation(); rosterEdit = null; buildRoster(); };
        $("#redName").onkeydown = (e) => { if (e.key === "Enter") commitRosterEdit(team, p.no); if (e.key === "Escape") { rosterEdit = null; buildRoster(); } };
        continue;
      }
      const yellow = App.match.events.some(e => e.type === "yellow" && e.team === team && e.no === p.no && e.t <= App.t);
      row.innerHTML =
        `<span class="dot ${st.s === "on" ? "on" : st.s === "used" ? "used" : "off"}"></span>` +
        `<span class="pnum" style="background:${isGK ? kit.gk : kit.shirt};color:${isGK ? kit.gkNumber : kit.number}">${p.no}</span>` +
        `<span class="pname">${p.ja}${p.captain ? " ©" : ""}${yellow ? '<span class="ycard" title="警告"></span>' : ""}</span>` +
        `<span class="ppos">${p.pos}</span><span class="pstat">${st.label}</span>` +
        (editable ? `<button class="redit" title="背番号・名前を編集" aria-label="背番号・名前を編集（未較正）">✎</button>` : "");
      row.onclick = () => onRosterClick(team, p, st);
      if (editable) {
        const eb = row.querySelector(".redit");
        if (eb) eb.onclick = (e) => { e.stopPropagation(); rosterEdit = { team, no: p.no }; buildRoster(); };
      }
      if (App.selected && App.selected.team === team && App.selected.no === p.no) row.classList.add("sel");
      if (App.pickOut && App.pickOut.team === team && App.pickOut.no === p.no) row.classList.add("pick-out");
      if (App.pickIn && App.pickIn.team === team && App.pickIn.no === p.no) row.classList.add("pick-in");
      list.appendChild(row);
    }
  };

  const onRosterClick = (team, p, st) => {
    // 配置エディタでスロット選択中: ベンチ選手クリック = 先発差替
    if (App.editorSel && st.s === "bench" && team === App.rosterTab && p.pos !== "GK") {
      const sc = forkIfActual();
      const r = S.withStarter(App.match, sc, team, App.editorSel, p.no);
      if (!r.validation.ok) { toast(r.validation.errors[0], "var(--crit-t)"); return; }
      App.editorSel = null;
      refreshScenario(r.scenario);
      toast(`先発差替 — ${p.ja}`, GOLD);
      return;
    }
    selectPlayer(team, p.no);
    if (st.s === "on") { App.pickOut = { team, no: p.no, ja: p.ja }; }
    else if (st.s === "bench") { App.pickIn = { team, no: p.no, ja: p.ja }; }
    updateSubSlots();
    buildRoster();
  };

  const updateSubSlots = () => {
    const so = $("#slotOut"), si = $("#slotIn");
    if (App.pickOut) { so.textContent = `OUT #${App.pickOut.no} ${App.pickOut.ja}`; so.classList.add("filled"); }
    else { so.textContent = "OUT — ピッチ上の選手をクリック"; so.classList.remove("filled"); }
    if (App.pickIn) { si.textContent = `IN #${App.pickIn.no} ${App.pickIn.ja}`; si.classList.add("filled"); }
    else { si.textContent = "IN — ベンチの選手をクリック"; si.classList.remove("filled"); }
  };

  /* --------------------------- 配置エディタ --------------------------- */
  const buildEditorStatic = () => {
    const sel = $("#fmShape");
    // #81: 10人シェイプ（10_*）は退場リシェイプ専用 — 手動の陣形変更（11人前提）からは除外
    sel.innerHTML = Object.keys(F.SHAPES).filter(k => !k.startsWith("10_")).map(k =>
      `<option value="${k}">${F.SHAPE_LABELS?.[k] || k}</option>`).join("");
  };
  const fitEditor = () => {
    const cv = $("#fmPitch");
    if (!cv) return;
    const w = cv.clientWidth || 292;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(w * 0.82 * dpr);
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawEditor();
  };

  // スロット表示座標（攻撃方向=上）
  const edXY = (cv, xNorm, yNorm) => {
    const W = cv.clientWidth || 292, H = (cv.clientHeight || 234);
    const px = W / 2 - yNorm * (W / 2 - 26);
    const py = H - 20 - xNorm * (H - 40);
    return [px, py];
  };

  const editorPhase = () => {
    const sc = activeScenario();
    const team = App.rosterTab;
    const roster = E.rosterAt(App.match, sc, team, App.t);
    return { sc, team, roster, shape: F.SHAPES[roster.shape] };
  };

  const drawEditor = () => {
    const cv = $("#fmPitch");
    if (!cv || !cv.getContext || !App.rosterTab) return;
    const g = cv.getContext("2d");
    const W = cv.clientWidth || 292, H = cv.clientHeight || 234;
    g.clearRect(0, 0, W, H);
    // ピッチ
    g.fillStyle = "#081209"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(196,212,240,.18)"; g.lineWidth = 1;
    g.strokeRect(10, 8, W - 20, H - 16);
    g.beginPath(); g.moveTo(10, H / 2); g.lineTo(W - 10, H / 2); g.stroke();
    g.beginPath(); g.arc(W / 2, H / 2, 22, 0, 7); g.stroke();
    // ゴール口（上=攻撃方向）
    g.strokeStyle = "rgba(231,205,150,.5)";
    g.strokeRect(W / 2 - 26, 8, 52, 14);
    g.strokeStyle = "rgba(196,212,240,.18)";
    g.strokeRect(W / 2 - 26, H - 22, 52, 14);
    g.font = "600 8px ui-monospace, monospace";
    g.fillStyle = "rgba(231,205,150,.6)";
    g.textAlign = "center";
    g.fillText("ATTACK ↑", W / 2, 30);

    const { sc, team, roster, shape } = editorPhase();
    const T = App.match.teams[team];
    for (const slot of shape) {
      const no = roster.assign[slot.id];
      if (no == null) continue;
      const p = T.squad.find(q => q.no === no);
      let tw = E.tweakOf(sc, team, slot.id) || { dx: 0, dy: 0 };
      if (App.editorDrag && App.editorDrag.slotId === slot.id && App.editorDrag.tw) tw = App.editorDrag.tw;
      const [px, py] = edXY(cv, clamp(slot.x + tw.dx, 0.02, 0.98), clamp(slot.y + tw.dy, -1, 1));
      const isGK = slot.role === "GK";
      const selHere = App.editorSel === slot.id;
      // ゾーン微調整の跡
      if (tw.dx || tw.dy) {
        const [bx, by] = edXY(cv, slot.x, slot.y);
        g.strokeStyle = "rgba(231,205,150,.35)";
        g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(bx, by); g.lineTo(px, py); g.stroke();
        g.setLineDash([]);
      }
      g.beginPath(); g.arc(px, py, 10, 0, 7);
      g.fillStyle = isGK ? T.kit.gk : T.kit.shirt; g.fill();
      g.lineWidth = selHere ? 2.5 : 1;
      g.strokeStyle = selHere ? GOLD : "rgba(8,12,20,.7)";
      g.stroke();
      g.fillStyle = isGK ? T.kit.gkNumber : T.kit.number;
      g.font = "800 9.5px ui-monospace, monospace";
      g.textBaseline = "middle";
      g.fillText(String(no), px, py + 0.5);
      g.textBaseline = "alphabetic";
      g.fillStyle = selHere ? GOLD : "rgba(236,241,250,.82)";
      g.font = "600 8px -apple-system, 'Hiragino Sans', sans-serif";
      g.fillText((p?.label || p?.ja || "").slice(0, 5), px, py + 20);
    }
    // フェーズリスト
    const phases = E.phasesOf(App.match, sc, team);
    const overridden = !!(sc.lineup && sc.lineup[team]);
    $("#fmPhases").innerHTML = phases.map(ph => `
      <div class="phrow">
        <span class="min">${ph.from <= 0 ? "開始" : S.tToLabel(App.match, ph.from)}</span>
        <span>${F.SHAPE_LABELS?.[ph.shape] || ph.shape}</span>
        <span style="color:var(--faint)">${overridden ? "編集済" : "実試合"}</span>
        ${overridden && ph.from > 0 ? `<button class="x" data-phdel="${ph.from}" title="このフェーズを削除">✕</button>` : ""}
      </div>`).join("");
    $("#fmPhases").querySelectorAll("[data-phdel]").forEach(b => {
      b.onclick = () => {
        const sc2 = forkIfActual();
        const r = S.withoutPhase(App.match, sc2, team, +b.dataset.phdel);
        if (!r.validation.ok) { toast(r.validation.errors[0], "var(--crit-t)"); return; }
        refreshScenario(r.scenario);
      };
    });
  };

  // エディタ操作: ドラッグ=微調整 / クリック2回=入替
  (() => {
    const cv = $("#fmPitch");
    const hitSlot = (mx, my) => {
      const { sc, team, roster, shape } = editorPhase();
      let best = null, bd = 16;
      for (const slot of shape) {
        if (roster.assign[slot.id] == null) continue;
        const tw = E.tweakOf(sc, team, slot.id) || { dx: 0, dy: 0 };
        const [px, py] = edXY(cv, clamp(slot.x + tw.dx, 0.02, 0.98), clamp(slot.y + tw.dy, -1, 1));
        const d = Math.hypot(mx - px, my - py);
        if (d < bd) { bd = d; best = slot; }
      }
      return best;
    };
    const rel = (e) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    cv.addEventListener("pointerdown", (e) => {
      const [mx, my] = rel(e);
      const slot = hitSlot(mx, my);
      if (!slot) { App.editorSel = null; drawEditor(); return; }
      cv.setPointerCapture(e.pointerId);
      const { sc, team } = editorPhase();
      const base = E.tweakOf(sc, team, slot.id) || { dx: 0, dy: 0 };
      App.editorDrag = { slotId: slot.id, x0: mx, y0: my, base, tw: null };
    });
    cv.addEventListener("pointermove", (e) => {
      const dr = App.editorDrag;
      if (!dr) return;
      const [mx, my] = rel(e);
      if (!dr.tw && Math.hypot(mx - dr.x0, my - dr.y0) < 6) return;
      const W = cv.clientWidth || 292, H = cv.clientHeight || 234;
      dr.tw = {
        dx: clamp(dr.base.dx - (my - dr.y0) / (H - 40), -S.TWEAK_X, S.TWEAK_X),
        dy: clamp(dr.base.dy - (mx - dr.x0) / (W / 2 - 26), -S.TWEAK_Y, S.TWEAK_Y),
      };
      drawEditor();
    });
    cv.addEventListener("pointerup", () => {
      const dr = App.editorDrag;
      App.editorDrag = null;
      if (!dr) return;
      const team = App.rosterTab;
      if (dr.tw) {
        // ドラッグ確定 → 微調整を適用
        const sc = forkIfActual();
        const r = S.withTweak(App.match, sc, team, dr.slotId, dr.tw.dx, dr.tw.dy);
        if (!r.validation.ok) { toast(r.validation.errors[0], "var(--crit-t)"); drawEditor(); return; }
        refreshScenario(r.scenario);
        return;
      }
      // クリック: 選択 → 2つ目で入替
      if (App.editorSel && App.editorSel !== dr.slotId) {
        const sc = forkIfActual();
        const r = S.withSlotSwap(App.match, sc, team, App.t, App.editorSel, dr.slotId);
        App.editorSel = null;
        if (!r.validation.ok) { toast(r.validation.errors[0], "var(--crit-t)"); drawEditor(); return; }
        refreshScenario(r.scenario);
        toast("配置を入替", GOLD);
      } else {
        App.editorSel = App.editorSel === dr.slotId ? null : dr.slotId;
        drawEditor();
      }
    });
  })();

  $("#fmApply").onclick = () => {
    const team = App.rosterTab;
    const shape = $("#fmShape").value;
    const min = parseInt($("#fmMin").value, 10) || 0;
    const sc = forkIfActual();
    const r = S.withFormation(App.match, sc, team, min, shape);
    if (!r.validation.ok) { toast(r.validation.errors[0], "var(--crit-t)"); return; }
    refreshScenario(r.scenario);
    toast(`${App.match.teams[team].name} → ${F.SHAPE_LABELS?.[shape] || shape}（${min <= 1 ? "開始" : min + "'"}）`, GOLD);
  };
  $("#fmClearTweaks").onclick = () => {
    if (!isSim() || !App.scenario.tweaks?.[App.rosterTab]) return;
    const next = S.fork(App.match, App.scenario);
    delete next.tweaks[App.rosterTab];
    refreshScenario(next);
    toast("微調整を解除", GOLD);
  };
  $("#fmReset").onclick = () => {
    if (!isSim()) return;
    const r = S.clearLineup(App.match, App.scenario, App.rosterTab);
    App.editorSel = null;
    refreshScenario(r.scenario);
    toast(`${App.match.teams[App.rosterTab].name}の布陣を実試合に戻しました`, GOLD);
  };

  /* --------------------------- 交代適用 --------------------------- */
  const applySub = (team, out, inn, t) => {
    const sc = forkIfActual();
    const r = S.withSub(App.match, sc, team, { t, out, in: inn });
    if (!r.validation.ok) {
      $("#subErrors").innerHTML = r.validation.errors.map(e => `⚠ ${e}`).join("<br>");
      return false;
    }
    $("#subErrors").textContent = "";
    App.pickOut = null; App.pickIn = null;
    updateSubSlots();
    refreshScenario(r.scenario);
    const pOut = App.match.teams[team].squad.find(q => q.no === out);
    const pIn = App.match.teams[team].squad.find(q => q.no === inn);
    toast(`${S.tToLabel(App.match, t)} ${pOut.ja} → ${pIn.ja}`, seriesColor(team, true));
    return true;
  };

  $("#subApply").onclick = () => {
    if (!App.pickOut || !App.pickIn) { $("#subErrors").textContent = "⚠ OUTとINの両方を選択してください"; return; }
    if (App.pickOut.team !== App.pickIn.team) { $("#subErrors").textContent = "⚠ OUTとINは同一チームから選択してください"; return; }
    const min = parseInt($("#subMin").value, 10) || 60;
    applySub(App.pickOut.team, App.pickOut.no, App.pickIn.no, S.minuteToT(App.match, min));
  };
  $("#subNow").onclick = () => { $("#subMin").value = S.tToMinute(App.match, App.t); };
  $("#subClear").onclick = () => { App.pickOut = null; App.pickIn = null; $("#subErrors").textContent = ""; updateSubSlots(); buildRoster(); };
  $("#btnReset").onclick = () => {
    App.scenario = null; App.editorSel = null;
    buildScenarioChips(); buildSubList(); buildRoster(); drawEditor(); renderSuggestions(null); renderOutcome();
    toast("実試合データに戻しました", "#94A2BD");
  };

  // #80: 外的失点（仮定）の注入
  const buildShockTeamSel = () => {
    const sel = $("#shockTeam");
    if (sel) sel.innerHTML = teamOrder().map(k => `<option value="${k}">${App.match.teams[k].name}</option>`).join("");
  };
  $("#shockAdd") && ($("#shockAdd").onclick = () => {
    const team = $("#shockTeam").value, min = +$("#shockMin").value, kind = $("#shockKind").value;
    const sc = forkIfActual();
    const r = S.withShockGoal(App.match, sc, { t: S.minuteToT(App.match, min), team, kind });
    if (!r.validation.ok) { toast(r.validation.errors[0], "var(--crit-t)"); return; }
    refreshScenario(r.scenario);
    toast(kind === "manual"
      ? `🧾 スコアを記帳 +1（${App.match.teams[team].name}・${min}'）— 実記録は不変（what-if）`
      : `⚡ 仮定の外的失点を注入（${App.match.teams[team].name}・${min}'）— 実試合への断定ではありません`, GOLD);
  });
  // #128: 減点（記録/生成ゴールの手動取消）
  $("#removeAdd") && ($("#removeAdd").onclick = () => {
    const team = $("#shockTeam").value, min = +$("#removeMin").value;
    const sc = forkIfActual();
    const r = S.withRemoveGoal(App.match, sc, { team, t: S.minuteToT(App.match, min) });
    if (!r.validation.ok) { toast(r.validation.errors[0], "var(--crit-t)"); return; }
    refreshScenario(r.scenario);
    toast(`➖ ${App.match.teams[team].name} の ${min}' 前後のゴールを取消（what-if・実記録は不変）`, GOLD);
  });

  $("#btnAdvise").onclick = () => {
    const sc = activeScenario();
    const adv = S.advise(App.match, sc, App.t, App.rosterTab, { includeGK: App.options.includeGK });
    renderSuggestions(adv);
  };
  const renderSuggestions = (adv) => {
    const box = $("#suggestions");
    if (!adv) { box.innerHTML = ""; return; }
    if (adv.suggestions.length === 0) {
      box.innerHTML = `<div class="suggestion"><div class="why">交代枠が残っていないか、有効な候補がありません（残枠 ${adv.context.remaining}）</div></div>`;
      return;
    }
    box.innerHTML = adv.suggestions.map((s, i) => `
      <div class="suggestion">
        <div class="head"><span class="eyebrow">#${i + 1}</span> OUT ${s.outJa} → IN ${s.inJa}
          <button class="btn" style="margin-left:auto;padding:3px 9px" data-adv="${i}">適用</button></div>
        <div class="why">${s.reason}</div>
      </div>`).join("");
    box.querySelectorAll("[data-adv]").forEach(btn => {
      btn.onclick = () => {
        const s = adv.suggestions[+btn.dataset.adv];
        applySub(App.rosterTab, s.out, s.in, App.t);
        renderSuggestions(null);
      };
    });
    box.insertAdjacentHTML("beforeend",
      `<div class="why" style="margin-top:6px;color:var(--faint)">文脈: 被危険度${Math.round(adv.context.oppDanger)} / 自危険度${Math.round(adv.context.ownDanger)} / 残枠${adv.context.remaining} — 全提案は規則検証済み</div>`);
  };

  const buildScenarioChips = () => {
    const wrap = $("#scenarioChips");
    wrap.innerHTML = "";
    const mk = (label, active, onclick, removable, sc) => {
      const c = document.createElement("span");
      c.className = "chip" + (active ? " active" : "");
      c.textContent = label;
      c.onclick = onclick;
      if (removable) {
        const x = document.createElement("b");
        x.textContent = " ✕";
        x.style.cursor = "pointer";
        x.onclick = (e) => {
          e.stopPropagation();
          App.scenarios = App.scenarios.filter(s => s !== sc);
          if (App.scenario === sc) App.scenario = null;
          buildScenarioChips(); buildSubList(); buildRoster(); drawEditor(); renderOutcome();
        };
        c.appendChild(x);
      }
      wrap.appendChild(c);
    };
    mk("実試合", !isSim(), () => {
      App.scenario = null;
      buildScenarioChips(); buildSubList(); buildRoster(); drawEditor(); renderOutcome();
    }, false);
    for (const sc of App.scenarios) {
      mk(sc.label, App.scenario === sc, () => {
        App.scenario = sc;
        buildScenarioChips(); buildSubList(); buildRoster(); drawEditor();
        if (!sc.outcome) computeOutcome(sc);
        else { ensureCurveFor(sc, { includeGK: App.options.includeGK }, () => {}); renderOutcome(); }
      }, true, sc);
    }
    $("#simChip").style.display = isSim() ? "" : "none";
  };

  const buildSubList = () => {
    const sc = activeScenario();
    const rows = [];
    for (const k of teamOrder()) {
      const T = App.match.teams[k];
      for (let i = 0; i < (sc.subs[k] || []).length; i++) {
        const s = sc.subs[k][i];
        const o = T.squad.find(p => p.no === s.out), n = T.squad.find(p => p.no === s.in);
        rows.push({ t: s.t, k, i, html: `<span class="min num">${s.min || S.tToLabel(App.match, s.t)}</span>` +
          `<span class="pnum" style="background:${T.kit.shirt};color:${T.kit.number};width:20px;height:16px;font-size:9.5px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center">${k[0]}</span>` +
          `<span style="flex:1">${o?.ja ?? s.out} → <b>${n?.ja ?? s.in}</b></span>` });
      }
      // #81: 退場（数的不利）行 — 赤カードで明示・✕で取り消し
      for (let i = 0; i < ((sc.outages && sc.outages[k]) || []).length; i++) {
        const og = sc.outages[k][i];
        const p = T.squad.find(q => q.no === og.no);
        rows.push({ t: og.t, k, i, outage: true, html: `<span class="min num">${S.tToLabel(App.match, og.t)}</span>` +
          `<span style="width:14px;height:18px;background:#C33;border-radius:2px;display:inline-block;box-shadow:0 0 0 1px rgba(255,255,255,.25)" title="退場"></span>` +
          `<span style="flex:1"><b>${p?.ja ?? og.no}</b> 退場（${og.kind === "injury-no-sub" ? "負傷・枠なし" : "レッド"}）→ 10人</span>` });
      }
    }
    // #123: 配置編集の履歴行 — 時刻グループごとに表示・✕で該当時刻のみ取り消し
    {
      const groups = new Map();
      for (const a of (sc.editAnchors || [])) {
        const gk = Math.round(a.t);
        const g = groups.get(gk) || { n: 0, ball: false };
        g.n++; groups.set(gk, g);
      }
      for (const b2 of (sc.editBall || [])) {                     // #127: ボール編集も同グループへ
        const gk = Math.round(b2.t);
        const g = groups.get(gk) || { n: 0, ball: false };
        g.ball = true; groups.set(gk, g);
      }
      for (const [gt, g] of [...groups.entries()].sort((x, y) => x[0] - y[0])) {
        const what = g.n ? `${g.n}人${g.ball ? "＋ボール" : ""}` : "ボール";
        rows.push({ t: gt, k: "E", i: gt, edit: true, html: `<span class="min num">${S.tToLabel(App.match, gt)}</span>` +
          `<span title="配置編集">✏</span>` +
          `<span style="flex:1">配置編集（${what}）— この時刻を通過</span>` });
      }
    }
    // #80: 外的失点（仮定）行 — ⚡で明示・✕で取り消し
    const SHOCK_JA = { "manual": "手動記帳", "ref-penalty": "誤審PK", "ref-offside-missed": "オフサイド見逃し", "deflection": "デフレクション",
      "keeper-error": "GKミス", "set-piece": "セットピース混戦", "own-goal": "オウンゴール" };
    for (let i = 0; i < (sc.shockGoals || []).length; i++) {
      const sg = sc.shockGoals[i];
      const T = App.match.teams[sg.team];
      const manual = sg.kind === "manual";
      rows.push({ t: sg.t, k: sg.team, i, shock: true, html: `<span class="min num">${S.tToLabel(App.match, sg.t)}</span>` +
        `<span title="${manual ? "スコア修正（記帳）" : "外的失点（仮定）"}">${manual ? "🧾" : "⚡"}</span>` +
        `<span style="flex:1"><b>${T?.name ?? sg.team}</b> に${manual ? "得点を記帳" : "仮定ゴール"}（${SHOCK_JA[sg.kind] || sg.kind}）</span>` });
    }
    // #128: 減点行 — ➖ で明示・✕で取り消し
    for (let i = 0; i < (sc.removeGoals || []).length; i++) {
      const rg = sc.removeGoals[i];
      const T = App.match.teams[rg.team];
      rows.push({ t: rg.t, k: rg.team, i, rmgoal: true, html: `<span class="min num">${S.tToLabel(App.match, rg.t)}</span>` +
        `<span title="ゴール取消（what-if）">➖</span>` +
        `<span style="flex:1"><b>${T?.name ?? rg.team}</b> のゴールを取消（手動・実記録は不変）</span>` });
    }
    rows.sort((a, b) => a.t - b.t);
    $("#subList").innerHTML = rows.map(r =>
      `<div class="srow">${r.html}${isSim() ? `<button class="btn" style="padding:1px 7px;font-size:10px" data-del="${r.outage ? "o" : r.shock ? "q" : r.rmgoal ? "r" : r.edit ? "e" : "s"}:${r.k}:${r.i}">✕</button>` : ""}</div>`
    ).join("");
    if (isSim()) {
      $("#subList").querySelectorAll("[data-del]").forEach(btn => {
        btn.onclick = () => {
          const [kind, k, i] = btn.dataset.del.split(":");
          const r = kind === "o" ? S.withoutOutage(App.match, App.scenario, k, +i)
            : kind === "q" ? S.withoutShockGoal(App.match, App.scenario, +i)
            : kind === "r" ? S.withoutRemoveGoal(App.match, App.scenario, +i)
            : kind === "e" ? globalThis.RPDX.scenlib.withoutEditGroup(App.match, App.scenario, +i)
            : S.withoutSub(App.match, App.scenario, k, +i);
          refreshScenario(r.scenario);
        };
      });
    }
  };

  /* --------------------------- シナリオ結果 --------------------------- */
  const renderOutcome = (busy) => {
    const panel = $("#outcomePanel");
    if (!isSim()) { panel.style.display = "none"; return; }
    panel.style.display = "";
    const body = $("#outcomeBody");
    const oc = App.scenario.outcome;
    if (busy || !oc) {
      body.innerHTML = `<div class="hint">危険度曲線から結果を再計算中…</div>`;
      return;
    }
    const [a, b] = teamOrder();
    const changed = oc.removed.length + oc.added.length > 0;
    const evRows = [];
    for (const r of oc.removed) {
      const T = App.match.teams[r.team];
      const p = T.squad.find(q => q.no === r.no);
      evRows.push(`<div class="ev del"><span class="min">${r.min || ""}</span>
        <span><span class="txt">${T.name} ${p?.ja ?? r.no} のゴール</span><br><span class="why">消滅 — ${r.reason}</span></span></div>`);
    }
    for (const g of oc.added) {
      const T = App.match.teams[g.team];
      const p = g.no != null ? T.squad.find(q => q.no === g.no) : null;
      const who = g.shock ? `<b>仮定ゴール</b>（得点者は特定しない）` : `<b>${p?.ja ?? g.no}</b> のゴール`;
      evRows.push(`<div class="ev add"><span class="min">${g.min}</span>
        <span>${T.name} ${who}${g.shock ? " ⚡" : ""}<br><span class="why">${g.detail}</span></span></div>`);
    }
    body.innerHTML = `
      <div class="scoreline">
        <span class="simscore num">${oc.score[a]}<span style="color:var(--gold)"> – </span>${oc.score[b]}</span>
        <span class="arrow">←</span>
        <span class="act num">実試合 ${oc.actualScore[a]}–${oc.actualScore[b]}</span>
        ${changed ? "" : `<span class="chip" style="margin-left:auto">結果不変</span>`}
      </div>
      ${evRows.join("")}
      <div class="delta">
        ${teamOrder().map(k => `
          <div class="d">
            <div class="k">${App.match.teams[k].nameEn || k} 機会創出Δ</div>
            <div class="v" style="color:${seriesColor(k, true)}">${oc.teamDelta[k].deltaPct >= 0 ? "+" : ""}${oc.teamDelta[k].deltaPct}%</div>
          </div>`).join("")}
      </div>
      <div class="hint">決定論 — 同じシナリオは常に同じ結果。判定は危険度プロセス曲線（20人・GK除外）に基づく。<br>
      これは「起こり得た未来」の<b>予測ではなく</b>、モデル規則による決定論的<b>再構成</b>です。
      実ゴールの再現はアンカー（記録準拠の再現指定）に基づくため、What-if の説明は因果の発見ではありません。</div>
      ${oc.score[a] !== oc.score[b] ? `<div style="margin-top:8px"><button class="btn gold" id="btnRecovery">巻き返し案を比較（ビハインド側・モデル比較）</button></div><div id="recoveryBox"></div>` : ""}`;
    // #80(B): 巻き返しシナリオ・ビルダー
    const rbtn = $("#btnRecovery");
    if (rbtn) rbtn.onclick = () => {
      rbtn.disabled = true; rbtn.textContent = "計算中…";
      setTimeout(() => {
        const res = globalThis.RPDX.scenlib.recoveryPlans(App.match, App.scenario);
        const box = $("#recoveryBox");
        if (!res.trailer || !res.plans.length) { box.innerHTML = `<div class="hint">有効な巻き返し候補がありません</div>`; rbtn.style.display = "none"; return; }
        const [ta, tb] = teamOrder();
        box.innerHTML = res.plans.map((pl, i) => `
          <div class="suggestion">
            <div class="head"><span class="eyebrow">#${i + 1}</span> ${pl.label}
              <span class="num" style="margin-left:auto">${pl.score[ta]}–${pl.score[tb]}</span>
              <button class="btn" style="margin-left:8px;padding:3px 9px" data-rec="${i}">適用</button></div>
            <div class="why">目的関数 ${pl.objective}（Δ攻撃 ${pl.atkGainPct >= 0 ? "+" : ""}${pl.atkGainPct}% / 被リスク +${pl.riskPct}%）— 断定ではなくモデル上の比較</div>
          </div>`).join("");
        box.querySelectorAll("[data-rec]").forEach(bn => bn.onclick = () => {
          const pl = res.plans[+bn.dataset.rec];
          pl.scenario.label = pl.label;
          refreshScenario(pl.scenario);
          toast(`巻き返し案を適用 — ${pl.label}`, GOLD);
        });
        rbtn.style.display = "none";
      }, 30);
    };
  };

  /* --------------------------- D²ダッシュボード --------------------------- */
  const MODJA = {
    SDI: "空間支配侵蝕", CPR: "保持者圧迫余裕", PLV: "パスレーン開通",
    OVL: "局所数的優位（人数）", TPA: "持続圧力（時間）", TRV: "侵攻速度（時間）",
  };
  const buildKikenTiles = () => {
    $("#kikenTiles").innerHTML = teamOrder().map(k => `
      <div class="kiken-tile" style="margin-top:6px">
        <span class="val num" id="kv-${k}" style="color:${seriesColor(k, true)}">0</span>
        <div><div class="lbl">${App.match.teams[k].name}の攻撃脅威</div><span class="chip ok" id="kc-${k}">OK</span></div>
      </div>`).join("");
    $("#modBars").innerHTML = teamOrder().map(k => `
      <div style="margin-top:8px">
        <div class="eyebrow" style="color:${seriesColor(k, true)}">${App.match.teams[k].nameEn || k}</div>
        ${D.MODULES.map(m => `
          <div class="modbar" title="${MODJA[m]}">
            <span class="k">${m}</span>
            <div class="track"><div class="fill" id="mb-${k}-${m}" style="background:${seriesColor(k)}"></div></div>
            <span class="v num" id="mv-${k}-${m}">0</span>
          </div>`).join("")}
      </div>`).join("");
  };

  /* --------------------------- PSY パネル --------------------------- */
  let psyCtx = null;
  const fitPsy = () => {
    const cv = $("#psySpark");
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round((cv.clientWidth || 292) * dpr);
    cv.height = Math.round(54 * dpr);
    psyCtx = cv.getContext("2d");
    psyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const buildPsyPanel = () => {
    $("#psyMomo").innerHTML = teamOrder().map(k => `
      <div class="momo-row" title="心理モメンタム（イベント連鎖・忘却付き / テニス解析の移植）">
        <span class="tag" style="color:${seriesColor(k, true)}">${k}</span>
        <div class="momo-track"><div class="momo-zero"></div><div class="momo-fill" id="momo-${k}"></div></div>
        <span class="mv num" id="momoV-${k}">0</span>
      </div>`).join("");
    $("#psyTeams").innerHTML = teamOrder().map(k => `
      <div class="psy-team">
        <div class="eyebrow" style="color:${seriesColor(k, true)}">${App.match.teams[k].nameEn || k} — 出場11人平均</div>
        <div class="psy-mini">
          <div class="cell"><div class="k">集中</div><div class="v num" id="psy-${k}-cn">—</div></div>
          <div class="cell"><div class="k">覚醒</div><div class="v num" id="psy-${k}-ar">—</div></div>
          <div class="cell"><div class="k">精神疲労</div><div class="v num" id="psy-${k}-mf">—</div></div>
          <div class="cell"><div class="k">HRV%</div><div class="v num" id="psy-${k}-hrv">—</div></div>
        </div>
      </div>`).join("");
    $("#psyHint").textContent = PSY.DISCLAIMER;
  };
  const updatePsyPanel = (psy) => {
    for (const k of teamOrder()) {
      const m = psy[k].momentum;                       // [-1.2, 1.2]
      const fill = $(`#momo-${k}`);
      const w = Math.min(Math.abs(m) / 1.2, 1) * 50;
      fill.style.left = m >= 0 ? "50%" : `${50 - w}%`;
      fill.style.width = `${w}%`;
      fill.style.background = seriesColor(k, true);
      $(`#momoV-${k}`).textContent = (m >= 0 ? "+" : "") + m.toFixed(2);
      $(`#psy-${k}-cn`).textContent = Math.round(psy[k].cn);
      $(`#psy-${k}-ar`).textContent = Math.round(psy[k].ar);
      $(`#psy-${k}-mf`).textContent = Math.round(psy[k].mf);
      $(`#psy-${k}-hrv`).textContent = Math.round(psy[k].hrv);
    }
    drawPsySpark();
  };
  const drawPsySpark = () => {
    if (!psyCtx) return;
    const cv = $("#psySpark");
    const W = cv.clientWidth || 292, H = 54;
    const g = psyCtx;
    const range = E.playedRange(App.match);
    const pts = PSY.momentumCurve(App.match, activeScenario(), 12);
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(5,9,17,.55)";
    g.fillRect(0, 0, W, H);
    const X = (t) => (t / range.t1) * W;
    const Y = (m) => H / 2 - (m / 1.2) * (H / 2 - 5);
    // ゼロ線 + HT
    g.strokeStyle = "rgba(196,212,240,.22)";
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    g.strokeStyle = "rgba(196,212,240,.3)"; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(X(App.match.time.h1.end), 3); g.lineTo(X(App.match.time.h1.end), H - 3); g.stroke();
    g.setLineDash([]);
    // ゴールピン
    for (const ev of E.eventsOf(App.match, activeScenario())) {
      if (ev.type !== "goal") continue;
      g.fillStyle = seriesColor(ev.team, true);
      g.beginPath(); g.arc(X(ev.t), ev.team === teamOrder()[0] ? 6 : H - 6, 2.2, 0, 7); g.fill();
    }
    // モメンタム曲線
    for (const k of teamOrder()) {
      g.strokeStyle = seriesColor(k, true); g.lineWidth = 1.5; g.globalAlpha = 0.9;
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = X(pts[i].t), y = Y(pts[i].v[k]);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    // 再生ヘッド
    g.strokeStyle = GOLD;
    g.beginPath(); g.moveTo(X(App.t), 2); g.lineTo(X(App.t), H - 2); g.stroke();
  };

  /* --------------------------- 試合スイッチャ --------------------------- */
  // #92: テンプレ試合はレジストリに常時登録せず（収録2試合の golden/テスト不変）、
  //   ここでオンデマンド生成してキャッシュする。自チーム運用の「未較正の起点」。
  let templateMatchCache = null;
  const getTemplateMatch = () => (templateMatchCache ??= G.templateMatch());
  const TPL_ID = "__tpl__";

  const buildMatchSel = () => {
    const sel = $("#matchSel");
    const reg = R.data.MATCHES || { [App.match.meta.id]: App.match };
    const ids = Object.keys(reg);
    const isTpl = App.match.meta.calibrated === false;
    sel.style.display = "";
    const opts = ids.map(id => {
      const m = reg[id];
      const [a, b] = m.teamOrder || Object.keys(m.teams);
      return `<option value="${id}"${m === App.match ? " selected" : ""}>${m.teams[a].name} ${m.meta.score[a]}–${m.meta.score[b]} ${m.teams[b].name}</option>`;
    });
    const inReg = ids.includes(App.match.meta.id) || App.match === templateMatchCache;
    if (!inReg) opts.push(`<option value="__cur__" selected>📄 取込カスタム（${App.match.teams[App.match.teamOrder[0]].name}×${App.match.teams[App.match.teamOrder[1]].name}）</option>`);
    opts.push(`<option value="${TPL_ID}"${isTpl && inReg ? " selected" : ""}>🧪 テンプレ試合（未較正・自チーム起点）</option>`);
    sel.innerHTML = opts.join("");
    sel.onchange = () => {
      if (sel.value === "__cur__") return;   // 現在の取込カスタム（何もしない）
      const m = sel.value === TPL_ID ? getTemplateMatch() : reg[sel.value];
      if (m && m !== App.match) {
        setMatch(m);
        toast(`試合を切替 — ${m.meta.competition} ${m.meta.stage}`, GOLD);
      }
    };
  };

  const buildZoneViewBtns = () => {
    const wrap = $("#zoneViewBtns");
    const opts = [["BOTH", "中立"], ...teamOrder().map(k => [k, App.match.teams[k].name + "目線"])];
    wrap.innerHTML = "";
    for (const [v, label] of opts) {
      const b = document.createElement("button");
      b.className = "btn" + (App.zoneView === v ? " on" : "");
      b.textContent = label;
      b.onclick = () => { App.zoneView = v; buildZoneViewBtns(); };
      wrap.appendChild(b);
    }
  };

  const updateDashboard = (ix) => {
    let worst = null;
    for (const k of teamOrder()) {
      const v = ix[k];
      $(`#kv-${k}`).textContent = Math.round(v.total);
      const chip = $(`#kc-${k}`);
      chip.className = "chip " + STATUS[v.status];
      chip.textContent = v.status;
      for (const m of D.MODULES) {
        $(`#mb-${k}-${m}`).style.width = clamp(v.mods[m], 0, 100) + "%";
        $(`#mv-${k}-${m}`).textContent = Math.round(v.mods[m]);
      }
      if (!worst || v.total > worst.total) worst = { ...v, team: k };
    }
    // ステータス帯
    const stCls = STATUS[worst.status];
    // #81: 数的状況バッジ（10 vs 11 等）— outages 発生中のみ表示
    let numBadge = "";
    {
      const sc = activeScenario();
      if (sc.outages) {
        const [a, b] = teamOrder();
        const na = Object.keys(E.rosterAt(App.match, sc, a, App.t).assign).length;
        const nb = Object.keys(E.rosterAt(App.match, sc, b, App.t).assign).length;
        if (na !== nb) numBadge = `<span class="chip warn" title="数的不利（what-if）">${na} vs ${nb}</span> `;
      }
    }
    $("#sbText").innerHTML = numBadge + `<span class="chip ${stCls}">${worst.status}</span> ` +
      (worst.status === "OK"
        ? "構造安定 — D²-Field 平常域"
        : `${App.match.teams[worst.team].name}の攻撃脅威 ${Math.round(worst.total)} — ${worst.status === "CRITICAL" ? "失点危険域" : "警戒域"}`);
    // 寄与TOP
    const rows = [];
    for (const k of teamOrder()) for (const c of ix[k].contrib.slice(0, 3)) rows.push({ ...c, team: k });
    rows.sort((a, b) => b.val - a.val);
    $("#contribList").innerHTML = rows.slice(0, 5).map(c => {
      const T = App.match.teams[c.team];
      const p = T.squad.find(q => q.no === c.no);
      return `<div class="contrib-row">
        <span class="pnum" style="background:${T.kit.shirt};color:${T.kit.number};width:22px;height:18px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:10px;font-weight:800">${c.no}</span>
        <span style="width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p?.ja ?? c.no}</span>
        <div class="track"><div style="height:100%;width:${clamp(c.val, 0, 1) * 100}%;background:${seriesColor(c.team)}"></div></div>
        <span class="num" style="font-family:var(--mono);font-size:10px;color:var(--muted);width:26px;text-align:right">${(c.val * 100).toFixed(0)}</span>
      </div>`;
    }).join("");
  };

  /* ----------------------------- インスペクタ ----------------------------- */
  const selectPlayer = (team, no) => {
    App.selected = { team, no };
    const T = App.match.teams[team];
    const p = T.squad.find(q => q.no === no);
    const isGK = p.pos === "GK";
    $("#inspNum").textContent = p.no;
    $("#inspNum").style.background = isGK ? T.kit.gk : T.kit.shirt;
    $("#inspNum").style.color = isGK ? T.kit.gkNumber : T.kit.number;
    const nmOv = E.nameOverrideOf(App.match, activeScenario(), team, no);
    const dispJa = (nmOv && (nmOv.ja || nmOv.name)) || p.ja;
    $("#inspName").textContent = dispJa + (p.captain ? " ©" : "") + (nmOv || E.attrsOf(App.match, activeScenario(), team, no) !== p.attrs ? "" : "");
    $("#inspSub").textContent = `${(nmOv && nmOv.name) || p.name} · ${p.pos} · ${p.club} · ${p.caps}キャップ${p.goals ? ` ${p.goals}G` : ""}`;
    const A = E.attrsOf(App.match, activeScenario(), team, no);
    $("#inspAttrs").innerHTML = [["速度", A.pac], ["持久", A.sta], ["守備", A.def], ["攻撃", A.att], ["技術", A.tec], ["空中", A.aer]]
      .map(([k, v]) => `<div class="attr"><span>${k}</span><div class="track"><div class="fill" style="width:${v}%;background:${seriesColor(team)}"></div></div><span class="num">${v}</span></div>`).join("");
    $("#inspector").classList.add("open");
    updateInspector(true);
    // 代謝負荷サマリ（#21 physio — チャンク計算・キャッシュ命中時は即時）
    $("#inspMet").textContent = "…";
    $("#inspSpr").textContent = "…";
    PHYS.summaryAsync(App.match, activeScenario(), team, no, (s) => {
      if (!App.selected || App.selected.team !== team || App.selected.no !== no) return;
      if (!s) { $("#inspMet").textContent = "—"; $("#inspSpr").textContent = "—"; return; }
      $("#inspMet").textContent = `${s.avgP.toFixed(1)} W/kg · ${Math.round(s.loadKJ)} kJ/kg`;
      $("#inspSpr").textContent = `${s.sprints}回 / ${Math.round(s.hsr)}m`;
    });
  };
  // #89: 能力値・名前の編集（シナリオ級上書き → 結果再計算）
  const ATTR_KEYS = [["pac","速度"],["sta","持久"],["def","守備"],["att","攻撃"],["tec","技術"],["aer","空中"]];
  const buildInspEdit = () => {
    const sel = App.selected; if (!sel) return;
    const A = E.attrsOf(App.match, activeScenario(), sel.team, sel.no);
    const nm = E.nameOverrideOf(App.match, activeScenario(), sel.team, sel.no);
    const p = App.match.teams[sel.team].squad.find(q => q.no === sel.no);
    const rows = ATTR_KEYS.map(([k, lbl]) =>
      `<label style="display:flex;align-items:center;gap:6px;font-size:11px;margin:2px 0">${lbl}
       <input type="range" min="20" max="99" value="${A[k]}" data-attr="${k}" style="flex:1">
       <span class="num" data-num="${k}" style="width:24px;text-align:right">${A[k]}</span></label>`).join("");
    // #81: 退場（数的不利 what-if）— 在場中・非GKのみ・現在時刻で発生
    const pres = E.presenceOf(App.match, activeScenario(), sel.team, sel.no);
    const canDismiss = p.pos !== "GK" && pres && App.t >= pres.from && App.t < pres.to;
    $("#inspEditForm").innerHTML =
      `<label style="display:block;font-size:11px">名前<input type="text" id="edName" value="${(nm && nm.ja) || p.ja}" style="width:100%"></label>`
      + rows
      + `<div style="display:flex;gap:6px;margin-top:6px"><button class="btn" id="edApply">適用</button><button class="btn" id="edReset">リセット</button></div>`
      + (canDismiss ? `<div style="display:flex;gap:6px;margin-top:6px;align-items:center">
           <button class="btn danger" id="edDismiss" title="この時刻に退場（what-if）— チームは10人に">🟥 ${S.tToLabel(App.match, App.t)} 退場</button>
           <select class="sel" id="edDismissShape" title="10人リシェイプ" style="flex:1">
             <option value="">自動 (${F.SHAPE_LABELS[F.tenManShapeFor(E.rosterAt(App.match, activeScenario(), sel.team, App.t).shape)]})</option>
             ${["10_441","10_432","10_531"].map(k => `<option value="${k}">${F.SHAPE_LABELS[k]}</option>`).join("")}
           </select></div>` : "")
      + `<div class="chip est" style="margin-top:4px">能力値=モデル推定・編集はwhat-if（記録は不変）。位置は変わらず危険度の重みが変わります。</div>`;
    $("#inspEditForm").querySelectorAll("input[type=range]").forEach(r =>
      r.oninput = () => { $("#inspEditForm").querySelector(`[data-num="${r.dataset.attr}"]`).textContent = r.value; });
    $("#edApply").onclick = () => {
      const sc = forkIfActual();
      const ov = {};
      $("#inspEditForm").querySelectorAll("input[type=range]").forEach(r => ov[r.dataset.attr] = +r.value);
      (sc.attrOverrides ??= {})[sel.team] ??= {}; sc.attrOverrides[sel.team][sel.no] = ov;
      const newName = $("#edName").value.trim();
      if (newName && newName !== p.ja) { (sc.nameOverrides ??= {})[sel.team] ??= {}; sc.nameOverrides[sel.team][sel.no] = { ja: newName, name: newName, label: newName }; }
      refreshScenario(sc);
      $("#inspEditForm").style.display = "none";
      selectPlayer(sel.team, sel.no);
    };
    $("#edReset").onclick = () => {
      const sc = App.scenario;
      if (sc && sc.attrOverrides && sc.attrOverrides[sel.team]) delete sc.attrOverrides[sel.team][sel.no];
      if (sc && sc.nameOverrides && sc.nameOverrides[sel.team]) delete sc.nameOverrides[sel.team][sel.no];
      if (sc) refreshScenario(sc);
      $("#inspEditForm").style.display = "none";
      selectPlayer(sel.team, sel.no);
    };
    // #81: 退場 what-if の適用
    $("#edDismiss") && ($("#edDismiss").onclick = () => {
      const sc = forkIfActual();
      const reshape = $("#edDismissShape").value || undefined;
      const r = S.withOutage(App.match, sc, sel.team, { t: App.t, no: sel.no, kind: "red-card", ...(reshape ? { reshape } : {}) });
      if (!r.validation.ok) { toast(r.validation.errors[0], "var(--crit-t)"); return; }
      refreshScenario(r.scenario);
      const T = App.match.teams[sel.team];
      toast(`🟥 ${p.ja} 退場 — ${T.name}は10人（${r.dropped ? `後続の交代${r.dropped}件を取り下げ・` : ""}what-if）`, "#E8473B");
      $("#inspEditForm").style.display = "none";
      $("#inspector").classList.remove("open");
    });
  };
  $("#inspEditBtn") && ($("#inspEditBtn").onclick = () => {
    const f = $("#inspEditForm");
    if (f.style.display === "none") { buildInspEdit(); f.style.display = "block"; }
    else f.style.display = "none";
  });
  $("#inspClose").onclick = () => { App.selected = null; $("#inspector").classList.remove("open"); $("#inspEditForm").style.display = "none"; buildRoster(); };

  let lastInspect = 0;
  const updateInspector = (force) => {
    if (!App.selected) return;
    if (!force && performance.now() - lastInspect < 500) return;
    lastInspect = performance.now();
    const { team, no } = App.selected;
    const dist = E.distanceCovered(App.match, activeScenario(), team, no, App.t);
    $("#inspDist").textContent = fmtDist(dist);
    const fat = E.fatigueOf(App.match, activeScenario(), team, no, App.t);
    $("#inspFat").textContent = Math.round(fat * 100) + "%";
    const c = App.lastIx?.[team]?.contrib.find(q => q.no === no);
    $("#inspThreat").textContent = c ? (c.val * 100).toFixed(0) : "—";
    const st = rosterState(team, no, App.t);
    const evs = E.eventsOf(App.match, activeScenario());
    const goals = evs.filter(e => e.type === "goal" && e.team === team && e.no === no && e.t <= App.t).length;
    const yellow = App.match.events.some(e => e.type === "yellow" && e.team === team && e.no === no && e.t <= App.t);
    $("#inspStat").innerHTML = `${st.label}${goals ? ` · G×${goals}` : ""}${yellow ? ' · <span class="ycard"></span>' : ""}`;
    // PSY（正準曲線が用意できてから — 決定論・非予測のヒューリスティック推定）
    const ps = psyReady() ? PSY.playerAt(App.match, activeScenario(), team, no, App.t) : null;
    App.lastPsySel = ps;
    $("#inspCn").textContent = ps ? Math.round(ps.cn) : "—";
    $("#inspAr").textContent = ps ? Math.round(ps.ar) : "—";
    $("#inspMf").textContent = ps ? Math.round(ps.mf) + "%" : "—";
    $("#inspHrv").textContent = ps ? Math.round(ps.hrv) + "%" : "—";
  };

  /* ----------------------------- タイムライン ----------------------------- */
  const trailCache = new Map();   // 軌跡メモ（キーにscenarioKeyを含むため明示無効化は不要）
  let tlLastSig = null;           // 再描画スキップ用（停止中に毎フレーム描かない）
  const fitTimeline = () => {
    const cv = $("#tlCanvas");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(cv.clientWidth * dpr);
    cv.height = Math.round(cv.clientHeight * dpr);
    tlCtx = cv.getContext("2d");
    tlCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tlLastSig = null;
  };

  // 記号マーカー（絵文字を使わない）
  const drawMarker = (g, kind, x, y, color) => {
    g.save();
    if (kind === "goal") {
      g.beginPath(); g.arc(x, y, 3.6, 0, 7);
      g.fillStyle = "#F2F5F9"; g.fill();
      g.lineWidth = 1.6; g.strokeStyle = color; g.stroke();
    } else if (kind === "simgoal") {
      g.translate(x, y); g.rotate(Math.PI / 4);
      g.fillStyle = GOLD;
      g.fillRect(-3.2, -3.2, 6.4, 6.4);
      g.strokeStyle = "rgba(8,12,20,.8)"; g.lineWidth = 1; g.strokeRect(-3.2, -3.2, 6.4, 6.4);
    } else if (kind === "ghost") {
      g.beginPath(); g.arc(x, y, 3.4, 0, 7);
      g.strokeStyle = "rgba(148,162,189,.55)"; g.lineWidth = 1.3; g.stroke();
      g.strokeStyle = "rgba(255,122,110,.9)"; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(x - 4.5, y - 4.5); g.lineTo(x + 4.5, y + 4.5); g.stroke();
      g.beginPath(); g.moveTo(x + 4.5, y - 4.5); g.lineTo(x - 4.5, y + 4.5); g.stroke();
    } else if (kind === "yellow") {
      g.fillStyle = "#FFC61A";
      g.fillRect(x - 1.8, y - 4.5, 3.6, 9);
    } else if (kind === "red") {
      g.fillStyle = "#E5484D";
      g.fillRect(x - 1.8, y - 4.5, 3.6, 9);
    } else if (kind === "save") {
      g.translate(x, y); g.rotate(Math.PI / 4);
      g.strokeStyle = "#7FA6FF"; g.lineWidth = 1.5;
      g.strokeRect(-2.8, -2.8, 5.6, 5.6);
    } else if (kind === "sub") {
      g.strokeStyle = color; g.lineWidth = 1.5; g.lineCap = "round";
      g.beginPath(); g.moveTo(x - 3.5, y - 1.2); g.lineTo(x + 3.5, y - 1.2); g.lineTo(x + 1.2, y - 3.8); g.stroke();
      g.beginPath(); g.moveTo(x + 3.5, y + 1.6); g.lineTo(x - 3.5, y + 1.6); g.lineTo(x - 1.2, y + 4.2); g.stroke();
    }
    g.restore();
  };

  const drawTimeline = () => {
    if (!tlCtx) return;
    // 内容が変わらないフレームは描かない（停止中のCPU/GPU節約）
    const sc0 = activeScenario();
    const sig = `${App.t.toFixed(2)}|${App.match.meta.id}|${E.scenarioKey(sc0)}|` +
      `${actualCurve() ? 1 : 0}${activeCurve() ? 1 : 0}`;
    if (sig === tlLastSig) return;
    tlLastSig = sig;
    const cv = $("#tlCanvas");
    const W = cv.clientWidth, H = cv.clientHeight;
    const g = tlCtx;
    const range = E.playedRange(App.match);
    const X = (t) => (t / range.t1) * W;
    const Y = (v) => H - 8 - (v / 100) * (H - 26);
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(5,9,17,.7)";
    g.fillRect(0, 0, W, H);

    // 15分グリッド + HT
    g.strokeStyle = "rgba(196,212,240,.1)"; g.lineWidth = 1;
    g.fillStyle = "rgba(92,108,140,.9)"; g.font = "9px ui-monospace, Menlo, monospace";
    for (let min = 15; min * 60 < range.t1; min += 15) {
      const t = min <= 45 ? min * 60 : App.match.time.h2.start + (min - 45) * 60;
      if (t > range.t1) break;
      g.beginPath(); g.moveTo(X(t), 14); g.lineTo(X(t), H - 8); g.stroke();
      g.fillText(`${min}'`, X(t) + 3, H - 11);
    }
    const htX = X(App.match.time.h1.end);
    g.strokeStyle = "rgba(196,212,240,.35)";
    g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(htX, 6); g.lineTo(htX, H - 6); g.stroke();
    g.setLineDash([]);
    g.fillStyle = "rgba(148,162,189,.9)";
    g.fillText("HT", htX + 3, 12);

    // フェーズ帯（#32）: 上端3pxに局面を色分け（保持チーム色の濃淡・set-piece=白系）
    if (globalThis.RPDX.tactics) {
      const strip = globalThis.RPDX.tactics.phaseStrip(App.match, sc0, Math.min(300, W >> 1));
      const PHC = {
        "set-piece": "rgba(230,236,248,.75)", "transition": "rgba(255,160,64,.8)",
        "build-up": "rgba(110,130,170,.55)", "progression": "rgba(120,170,255,.6)",
        "finishing": "rgba(255,90,90,.8)",
      };
      const teamTint = (team) => team === App.match.possessionPlus ? 1 : 0.55;
      const x0 = X(range.t0), x1 = X(range.t1);
      const bw = (x1 - x0) / strip.length;
      for (let i = 0; i < strip.length; i++) {
        const s = strip[i];
        g.globalAlpha = s.team ? teamTint(s.team) : 0.4;
        g.fillStyle = PHC[s.phase] || "rgba(120,120,120,.4)";
        g.fillRect(x0 + i * bw, 2, Math.ceil(bw), 3);
      }
      g.globalAlpha = 1;
    }

    // 閾値ガイド
    for (const [v, lbl] of [[D.WARN_AT, "WARN 45"], [D.CRIT_AT, "CRIT 75"]]) {
      g.strokeStyle = "rgba(196,212,240,.2)"; g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(0, Y(v)); g.lineTo(W, Y(v)); g.stroke();
      g.setLineDash([]);
      g.fillStyle = "rgba(148,162,189,.7)";
      g.fillText(lbl, W - 52, Y(v) - 3);
    }

    // 曲線
    const act = actualCurve();
    const cur = activeCurve();
    const smoothV = (pts, i, key) => {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(pts.length - 1, i + 2); j++) { s += pts[j].v[key]; n++; }
      return s / n;
    };
    const drawCurve = (pts, key, color, dashed, alpha, fill) => {
      if (!pts) return;
      if (fill) {
        g.globalAlpha = alpha * 0.14; g.fillStyle = color;
        g.beginPath();
        g.moveTo(X(pts[0].t), Y(0));
        for (let i = 0; i < pts.length; i++) g.lineTo(X(pts[i].t), Y(smoothV(pts, i, key)));
        g.lineTo(X(pts[pts.length - 1].t), Y(0));
        g.closePath(); g.fill();
        g.globalAlpha = 1;
      }
      g.strokeStyle = color; g.globalAlpha = alpha; g.lineWidth = dashed ? 1.6 : 2;
      if (dashed) g.setLineDash([5, 4]);
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = X(pts[i].t), y = Y(smoothV(pts, i, key));
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
    };
    const simActive = isSim() && cur && cur !== act;
    for (const k of teamOrder()) {
      drawCurve(act, k, seriesColor(k), false, simActive ? 0.3 : 0.9, !simActive);
      if (simActive) drawCurve(cur, k, seriesColor(k, true), true, 0.95);
    }

    // イベントピン（シナリオ実効イベント + 消滅ゴーストピン）
    const sc = activeScenario();
    const evs = E.eventsOf(App.match, sc);
    const pins = [];
    for (const ev of evs) {
      if (ev.type === "goal") pins.push({ t: ev.t, kind: ev.sim ? "simgoal" : "goal", c: seriesColor(ev.team, true) });
      else if (ev.type === "yellow") pins.push({ t: ev.t, kind: "yellow" });
      else if (ev.type === "red") pins.push({ t: ev.t, kind: "red" });
      else if (ev.type === "save") pins.push({ t: ev.t, kind: "save" });
    }
    if (sc.outcome) for (const r of sc.outcome.removed) pins.push({ t: r.t, kind: "ghost" });
    for (const k of teamOrder()) for (const s of (sc.subs[k] || []))
      pins.push({ t: s.t, kind: "sub", c: seriesColor(k, true) });
    for (const p of pins) {
      const x = X(p.t);
      g.strokeStyle = "rgba(230,238,250,.18)";
      g.beginPath(); g.moveTo(x, 16); g.lineTo(x, H - 8); g.stroke();
      drawMarker(g, p.kind, x, 9, p.c || "#94A2BD");
    }

    // 再生ヘッド（ゴールド）
    const px = X(App.t);
    g.fillStyle = "rgba(231,205,150,.08)";
    g.fillRect(0, 0, px, H);
    g.strokeStyle = GOLD; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
    g.fillStyle = GOLD;
    g.beginPath(); g.arc(px, H - 8, 3.6, 0, 7); g.fill();
  };

  // スクラブ + ツールチップ
  (() => {
    const cv = $("#tlCanvas");
    let scrubbing = false;
    const toT = (e) => {
      const r = cv.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1) * E.playedRange(App.match).t1;
    };
    cv.addEventListener("pointerdown", (e) => { scrubbing = true; cv.setPointerCapture(e.pointerId); App.t = toT(e); });
    cv.addEventListener("pointermove", (e) => {
      if (scrubbing) App.t = toT(e);
      const tip = $("#tlTip");
      const t = toT(e);
      const cur = activeCurve() || actualCurve();
      let html = `<b>${E.clockAt(App.match, t).disp}</b>`;
      if (cur) {
        const i = clamp(Math.round(t / 8), 0, cur.length - 1);
        for (const k of teamOrder()) html += `<br><span style="color:${seriesColor(k, true)}">${k}</span> 危険度 ${Math.round(cur[i].v[k])}`;
      }
      const evs = E.eventsOf(App.match, activeScenario());
      const near = evs.filter(ev => Math.abs(ev.t - t) < 60 && ev.label);
      if (near.length) html += `<br><span style="color:var(--muted)">${near[0].min || ""} ${near[0].label}${near[0].sim ? "〔SIM生成〕" : "〔記録〕"}</span>`;
      tip.innerHTML = html;
      tip.style.display = "block";
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 320) + "px";
      tip.style.top = (e.clientY - 64) + "px";
    });
    cv.addEventListener("pointerup", () => { scrubbing = false; });
    cv.addEventListener("pointerleave", () => { $("#tlTip").style.display = "none"; });
  })();

  /* --------------------------- 再生コントロール --------------------------- */
  const SPEEDS = [1, 4, 12, 30, 60];
  const buildSpeed = () => {
    const grp = $("#speedGrp");
    grp.innerHTML = "";
    for (const s of SPEEDS) {
      const b = document.createElement("button");
      b.textContent = "×" + s;
      b.className = App.speed === s ? "on" : "";
      b.onclick = () => { App.speed = s; buildSpeed(); };
      grp.appendChild(b);
    }
  };
  buildSpeed();
  const setPlaying = (p) => {
    App.playing = p;
    $("#btnPlay").textContent = p ? "❚❚ " + t("停止") : "▶ " + t("再生");
  };
  $("#btnPlay").onclick = () => setPlaying(!App.playing);
  const evTimes = () => E.eventsOf(App.match, activeScenario())
    .filter(e => ["goal", "yellow", "red", "save", "kickoff", "halftime"].includes(e.type)).map(e => e.t);
  $("#btnPrevEv").onclick = () => {
    const ts = evTimes().filter(t => t < App.t - 2);
    App.t = ts.length ? Math.max(...ts) : 0;
  };
  $("#btnNextEv").onclick = () => {
    const ts = evTimes().filter(t => t > App.t + 2);
    App.t = ts.length ? Math.min(...ts) : E.playedRange(App.match).t1;
  };

  /* ------------------------------ トースト ------------------------------ */
  const toast = (text, color) => {
    const d = document.createElement("div");
    d.className = "toast";
    d.innerHTML = `<span class="tdot" style="background:${color || "var(--muted)"}"></span><span>${text}</span>`;
    $("#toasts").appendChild(d);
    setTimeout(() => { d.style.opacity = "0"; d.style.transition = "opacity .4s"; setTimeout(() => d.remove(), 450); }, 3800);
  };
  // #134: ゴール・スロー・リプレイ — 得点通過時に ~5秒巻き戻してスローでゴール裏カメラ再生。
  // 既存 stateAt/アンカーのみ参照＝結果・再現性は不変（純カメラ+時刻演出）。編集フレーム中/多重発火は抑止。
  const maybeGoalReplay = (ev) => {
    if (!App.options.goalReplay || !App.playing || App.replay || App.editFrame) return;
    const st = E.stateAt(App.match, activeScenario(), ev.t);
    const side = st.ball.x >= 0 ? 1 : -1;
    App.replay = { endT: Math.min(ev.t + 2.6, E.playedRange(App.match).t1), restoreT: App.t, restoreSpeed: App.speed, restoreCam: App.camPreset || "broadcast" };
    App.t = Math.max(0, ev.t - 5);      // 巻き戻し（大ジャンプ＝checkCrossings は t1-t0<=0 で発火せず）
    App.speed = 1.2;                     // スロー（通常12x → 1.2x）
    renderer.replayCam(side, false);
    const badge = $("#replayBadge"); if (badge) badge.style.display = "";
  };
  const endGoalReplay = () => {
    if (!App.replay) return;
    App.t = App.replay.restoreT; App.speed = App.replay.restoreSpeed;
    renderer.setPreset(App.replay.restoreCam, false);
    App.replay = null;
    const badge = $("#replayBadge"); if (badge) badge.style.display = "none";
  };
  const checkCrossings = (t0, t1) => {
    if (t1 - t0 <= 0 || t1 - t0 > App.speed * 0.6 + 2) return;
    const sc = activeScenario();
    for (const ev of E.eventsOf(App.match, sc)) {
      if (ev.t > t0 && ev.t <= t1) {
        if (ev.type === "goal") {
          toast(`GOAL ${ev.min || ""} ${ev.label.replace(/^GOAL(〔SIM〕)? /, "")}`, ev.sim ? GOLD : seriesColor(ev.team, true));
          maybeGoalReplay(ev);   // #134: ゴール・スロー・リプレイ（純カメラ演出・SIM不変）
        }
        else if (ev.type === "yellow") toast(`警告 ${ev.min || ""} ${ev.label.replace("警告 ", "")}`, "#FFC61A");
        else if (ev.type === "red") toast(`退場 ${ev.min || ""} ${ev.label.replace(/^退場 /, "")}`, "#E5484D");
        else if (ev.type === "save") toast(ev.label, "#7FA6FF");
        else if (ev.type === "halftime" || ev.type === "fulltime") toast(ev.label, "#94A2BD");
      }
    }
    for (const k of teamOrder()) for (const s of (sc.subs[k] || [])) {
      if (s.t > t0 && s.t <= t1) {
        const T = App.match.teams[k];
        const o = T.squad.find(p => p.no === s.out), n = T.squad.find(p => p.no === s.in);
        toast(`交代 ${T.name} ${o?.ja} → ${n?.ja}`, seriesColor(k, true));
        buildRoster();
      }
    }
  };

  /* ------------------------------ モーダル ------------------------------ */
  document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => $("#" + b.dataset.close).classList.remove("open"));
  document.querySelectorAll(".modal-back").forEach(m => m.addEventListener("pointerdown", (e) => { if (e.target === m) m.classList.remove("open"); }));
  $("#btnInfo").onclick = () => $("#modalInfo").classList.add("open");
  $("#btnModel").onclick = () => $("#modalModel").classList.add("open");
  $("#btnCustom").onclick = () => {
    if (!$("#customJson").value) $("#customJson").value = JSON.stringify(G.template(), null, 2);
    $("#modalCustom").classList.add("open");
  };

  const buildInfoModal = () => {
    const m = App.match, [a, b] = teamOrder();
    const xiRows = (k) => {
      const T = m.teams[k];
      const shape = F.SHAPES[T.phases[0].shape];
      return shape.map(s => {
        const p = T.squad.find(q => q.no === T.phases[0].assign[s.id]);
        return `<span class="chip" style="margin:2px 3px 2px 0">${p.no} ${p.ja}</span>`;
      }).join("");
    };
    // #92c: 出典表示を較正状態・シナリオ状態に整合させる（未較正/what-if で実記録の断定を出さない）
    const cal = m.meta.calibrated !== false;            // 収録実試合か（テンプレ/カスタムは false）
    const sim = isSim();                                // what-if シナリオが有効か
    const provNote = !cal
      ? `<div class="chip est" style="margin:6px 0">この試合は<b>モデル生成（未較正・実測非依存）</b>。数値は決定論モデルの汎用推定で、公式記録の出典はありません。能力値・名前・背番号・配置は編集可（自チーム起点）。</div>`
      : (sim ? `<div class="chip warn" style="margin:6px 0">現在 <b>what-if シナリオ</b>表示中 — 下記の記録・スコア・出典は<b>収録実試合</b>のもので、現在のシナリオ結果ではありません（シナリオ結果は右下「結果」パネル）。</div>` : "");
    $("#infoBody").innerHTML = `
      <h4>${m.meta.competition} ${m.meta.stage}</h4>
      <div style="color:var(--muted)">${m.meta.date} ${m.meta.kickoffLocal || ""} · ${m.meta.venue} · 観衆 ${m.meta.attendance.toLocaleString()}名 · 主審 ${m.meta.referee}</div>
      <div style="font-size:21px;font-weight:300;margin:8px 0;letter-spacing:.04em">${m.teams[a].name} ${m.meta.score[a]} – ${m.meta.score[b]} ${m.teams[b].name}${cal ? "" : ' <span class="chip est" style="vertical-align:middle">モデル生成</span>'}</div>
      ${provNote}
      ${m.meta.motm ? `<div class="chip warn">MOM ${m.teams[m.meta.motm.team].squad.find(p => p.no === m.meta.motm.no).ja}</div>` : ""}
      <h4>スタメン${cal ? "（FIFA公式記録）" : "（モデル生成・未較正）"}</h4>
      <div><b style="color:${seriesColor(a, true)}">${m.teams[a].name}</b>（${m.teams[a].phases[0].shape} / ${m.teams[a].coach}）</div>
      <div style="margin:4px 0 8px">${xiRows(a)}</div>
      <div><b style="color:${seriesColor(b, true)}">${m.teams[b].name}</b>（${m.teams[b].phases[0].shape} / ${m.teams[b].coach}）</div>
      <div style="margin:4px 0 8px">${xiRows(b)}</div>
      <h4>スタッツ${cal ? "（実測 — 各行に出典 / プロバイダにより差があり得ます）" : "（モデル推定・未較正 — 実測の出典はありません）"}</h4>
      <table class="stat-table">${(m.stats || []).map(s => `<tr><td class="a">${s[a] ?? s.BRA}</td><td class="k">${s.key}${cal && s.src ? `<div class="statsrc">出典: ${s.src}</div>` : ""}</td><td class="b">${s[b] ?? s.JPN}</td></tr>`).join("")}</table>
      <h4>パスネットワーク上位（モデル推定 — 保持チェーン由来・実パス記録ではない）</h4>
      ${(() => {
        const range = E.playedRange(m);
        const net = E.passNetwork(m, E.actualScenario(m), range.t1);
        return teamOrder().map(k => {
          const T = net[k];
          const nameOf = (no) => m.teams[k].squad.find(q => q.no === no)?.label ?? no;
          const pairs = T.pairs.slice(0, 4).map(pr => `<span class="chip" style="margin:2px 3px 2px 0">${pr.a} ${nameOf(pr.a)} ⇄ ${pr.b} ${nameOf(pr.b)} ×${pr.n}</span>`).join("");
          const cent = T.central.slice(0, 3).map(c => `${c.no} ${nameOf(c.no)} ${(c.c * 100).toFixed(0)}%`).join(" · ");
          return `<div style="margin:4px 0 8px"><b style="color:${seriesColor(k, true)}">${m.teams[k].name}</b>（推定パス${T.total}本）<br>${pairs}<br><span style="color:var(--muted);font-size:11px">次数中心性: ${cent}</span></div>`;
        }).join("");
      })()}
      <h4>相手分析体制の脆弱性プロファイル（モデル仮定 — 実在体制への断定ではない）</h4>
      ${(() => {
        const O = globalThis.RPDX.opponent;
        const declared = teamOrder().map(k => [k, O.setupOf(m, k)]).filter(([, s]) => s);
        const row = (label, p, setup) => {
          const sat = O.htSaturation(m, E.actualScenario(m), setup);   // #60: 前半の処理飽和
          return `<tr><td class="k">${label}</td>` +
          `<td>収集${p.budget.collect.toFixed(1)}分 / 会議${p.budget.meeting.toFixed(1)}分 / <b>共有 実質${sat.shareEff.toFixed(1)}分</b></td>` +
          `<td title="前半の情報フロー圧/処理能力">${Math.round(sat.meanSat * 100)}%</td>` +
          ["delay", "sway", "sysDep", "overall"].map(x => `<td title="${p.labels[x]}">${O.stars(p.scores[x])}</td>`).join("") + "</tr>";
        };
        const head = `<tr><td class="k"></td><td>HT15分の配分</td><td>飽和</td><td>遅延</td><td>ブレ</td><td>依存</td><td><b>総合</b></td></tr>`;
        const body = declared.length
          ? declared.map(([k, s]) => row(m.teams[k].name + "（宣言値）", O.profile(s), s)).join("")
          : Object.values(O.ARCHETYPES).map(a2 => row(a2.label, O.profile(a2), a2)).join("");
        return `<table class="stat-table" style="font-size:11px">${head}${body}</table>
        <div style="color:var(--muted);font-size:11px;margin-top:2px">${declared.length ? "パック宣言の体制パラメータによる評価" : "本試合パックは体制未宣言 — 3類型アーキタイプの一般比較を表示"}。ハーフタイム（15分）の意思決定脆弱性を体制パラメータ（人数・段数・ツール/属人依存）から決定論算出。飽和=前半の情報フロー圧IFL(t)×体制の生成率÷処理能力の平均（#60）。</div>`;
      })()}
      <h4>実効フォーメーション & 形（モデル推定・現在時刻のスナップショット）</h4>
      ${(() => {
        const T2 = globalThis.RPDX.tactics, sc = E.actualScenario(m), t = App.t;
        const vor = T2.voronoiShare(m, sc, t);
        const row = (k) => {
          const s = T2.shapeMetrics(m, sc, k, t);
          return `<tr><td class="k"><b style="color:${seriesColor(k, true)}">${m.teams[k].name}</b></td>` +
            `<td>${s.effShape}</td><td>${s.width.toFixed(0)}</td><td>${s.depth.toFixed(0)}</td>` +
            `<td>${Math.round(s.area)}</td><td>${s.lineGap.toFixed(1)}</td><td>${Math.round(vor[k] * 100)}%</td></tr>`;
        };
        const head = `<tr><td class="k"></td><td>実効ライン</td><td>幅m</td><td>縦m</td><td>凸包m²</td><td>ライン間m</td><td>占有</td></tr>`;
        return `<table class="stat-table" style="font-size:11px">${head}${teamOrder().map(row).join("")}</table>
        <div style="color:var(--muted);font-size:11px;margin-top:2px">現在時刻 ${E.clockAt(m, t).disp} の合成配置から中立に算出（宣言陣形ではなく実際の並び）。凸包面積=小さいほどコンパクト。占有=Voronoi近似の空間支配率。位置・結果には影響しない読み取り専用の解釈。</div>`;
      })()}
      <h4>守備構造 v1（#117 — モデル推定・読み取り専用）</h4>
      <div id="defStructBox"><button class="btn" id="btnDefStruct">計算して表示（現在のシナリオ・数秒）</button>
        <div style="color:var(--muted);font-size:11px;margin-top:2px">被CPR/被PLV/被OVL/被TRV（相手に許した量）と非保持時ブロック（GK除外・ボール相対）。実測ではなくモデル推定上の観察です。</div></div>
      <h4>イベント（クリックでジャンプ）</h4>
      ${m.events.filter(e => e.label && e.type !== "kickoff").map(e =>
        `<div style="cursor:pointer;padding:2px 0" data-jump="${e.t}"><span class="mono" style="color:var(--muted)">${e.min || E.clockAt(m, e.t).disp}</span> ${e.label}</div>`).join("")}
      <h4>データ出典</h4>
      <div style="color:var(--muted);font-size:11.5px">${cal
        ? `背番号・XI・交代・警告・得点・スタッツは本試合の<b>公式記録</b>（FIFA Tactical Line-up / Match Report・Wikipedia・ESPN 照合）に基づく。選手座標・能力値は実スタッツと実況記述に整合するよう較正した決定論モデル。`
        : `本試合は<b>モデル生成（未較正・実測非依存）</b>。すべての数値は選手情報のみから決定論生成した汎用推定で、<b>公式記録の出典はありません</b>。自チームの構成に合わせて能力値・名前・背番号・配置を編集し、JSON で往復共有できます。`}${m.meta.note ? " " + m.meta.note : ""}</div>
      <div style="color:var(--faint);font-size:11px;margin-top:8px;font-family:var(--mono)">RPD-X v${R.VERSION || "?"}</div>`;
    $("#infoBody").querySelectorAll("[data-jump]").forEach(d => d.onclick = () => {
      App.t = +d.dataset.jump - 8;
      $("#modalInfo").classList.remove("open");
    });
    // #117: 守備構造 v1 — オンデマンド計算（シナリオ追従・重い走査はクリック時のみ）
    const dbtn = $("#btnDefStruct");
    if (dbtn) dbtn.onclick = () => {
      dbtn.disabled = true; dbtn.textContent = "計算中…";
      setTimeout(() => {
        const T2 = globalThis.RPDX.tactics, sc = activeScenario();
        const prof = T2.defenseProfile(m, sc);
        const rows = teamOrder().map(k => {
          const c = prof.conceded[k];
          const blk = T2.defenseBlock(m, sc, k) || {};
          return `<tr><td class="k"><b style="color:${seriesColor(k, true)}">${m.teams[k].name}</b></td>
            <td>${c.CPR}</td><td>${c.PLV}</td><td>${c.OVL}</td><td>${c.TRV}</td><td>${c.total}</td>
            <td>${blk.lineHeight ?? "—"}</td><td>${blk.width ?? "—"}×${blk.depth ?? "—"}</td><td>${blk.slideGap ?? "—"}</td><td>${blk.centralClosure ?? "—"}</td></tr>`;
        }).join("");
        $("#defStructBox").innerHTML = `
          <table class="stat-table" style="font-size:11px">
            <tr><td class="k"></td><td>被CPR</td><td>被PLV</td><td>被OVL</td><td>被TRV</td><td>被KIKEN</td><td>ライン高m</td><td>幅×縦m</td><td>スライド差m</td><td>中央閉鎖</td></tr>
            ${rows}</table>
          <div style="color:var(--muted);font-size:11px;margin-top:2px">被○○=相手に許した量（小さいほど消せている）。ブロックは非保持時のみ・GK除外。中央閉鎖=ボール→自ゴール中央3レーンの遮断率（def編集で変化=#106接続）。モデル推定上の観察であり実測・断定ではありません。</div>`;
      }, 30);
    };
  };

  const buildModelModal = () => {
    $("#modelBody").innerHTML = `
      <h4>D²-Field v2 — 距離だけでなく、人数と時間も語る</h4>
      v1は「20人の相対距離」だけで危険度を合成していました。v2はそこに<b>人数</b>（局所数的優位・最終ライン欠員）と
      <b>時間</b>(持続圧力の減衰積分・ボールの侵攻速度)を加えた6モジュール構造です。
      既定は<b>GK除外20人=チャンス創出度</b>。トグルで<b>22人=得点期待度</b>に切替できます。
      <h4>6モジュール</h4>
      <div class="formula">T(x,y)   = exp(−(d_goal/24)^1.7) × 角度開口(ゴールマウス7.32m)
── 空間・距離 ──────────────────────────
[SDI] 空間支配侵蝕   = Σ ctrl(cell)·T(cell) / Σ T(cell)
[CPR] 保持者圧迫余裕 = T(ball) × (1 − e^(−d_最近守備²/49)) × 保持度
[PLV] パスレーン開通 = max_受け手 [Π(1−e^(−d_lane²/9)) × T(受け手) × 余裕]
── 人数 ───────────────────────────
[OVL] 局所数的優位   = σ(1.15·(nAtk−nDef)@ball16m)·0.55
                     + 最終ライン欠員 clamp((2.8−cover)/2.8)·0.45
── 時間 ───────────────────────────
[TPA] 持続圧力       = Σ_32s 0.85^k · 圧力原値(t−4k)   （波状攻撃で蓄積）
[TRV] 侵攻速度       = clamp(v_ゴール接近/7.5) × T(ball)   （カウンターで急伸）

KIKEN = 100 × clamp((.18·SDI+.15·CPR+.13·PLV+.22·OVL+.20·TPA+.12·TRV)^0.66 × 1.60)</div>
      <div><span class="chip warn">WARNING ≥ 45</span> <span class="chip crit" style="margin-left:6px">CRITICAL ≥ 75</span>
      — 実試合の3得点すべてが直前にCRITICALへ到達するよう較正済（52'の決定機セーブも97）。</div>
      <h4>ポゼッション・チェーン v2</h4>
      ボールは<b>保持チームの選手の足元</b>に付きます。保持者列は<b>持続性マルコフ</b>
      （k_keep = 1−τ(1−π), τ=0.42）で生成 — 定常分布は実測支配率のまま、連続保持が
      優勢側~7本/劣勢側~3.4本の実試合水準になります（独立抽選だと1.4本でパス交換に見える）。
      パスは中距離カーネル・自己再抽選なし、<b>奪取は前保持者の近傍</b>（タックル収束アンカー付き）。
      さらに<b>スローイン/コーナー/ゴールキック</b>（1試合~60回）を決定論挿入し、テイカーが
      ライン際・コーナーアークへ移動して再開します。<b>記録イベント（得点・シュート・セーブ）の
      直前窓では保持チームを記録へ拘束</b>（アンカーと同じ記録優先の原則）。
      金色リングが現在の保持者、ステータス帯がリスタート種別を示します。
      <h4>結果再構成（What-if Outcome）</h4>
      交代・布陣は<b>試合結果そのもの</b>を変えます:
      (1) 得点者/アシスト者がピッチ外なら実ゴールは消滅
      (2) 直前の攻撃危険度が実試合比55%未満に落ちても消滅
      (3) 危険度増分の積分から決定論ポアソンで追加ゴールが発生。
      すべて乱数なし — 同じシナリオは常に同じ結末です。
      <b>これは予測ではありません</b>: モデル規則による決定論的な再構成であり、実ゴール再現は
      アンカー（記録準拠の再現指定）に基づくため、その説明は因果の発見ではありません。
      <h4>支配核と「幾何のみ」モード</h4>
      空間支配のガウス核は既定で σ = 5.5 + pace/100×3（paceは<b>モデル推定能力値</b>）。
      推定属性への依存を分離検証できるよう、「幾何のみ（等能力 σ=7.0）」モードを算定モジュール
      パネルで切替できます。切替は危険度・PSY・シナリオ結果に一貫適用（キャッシュ分離）されます。
      <h4>保持シーケンス蓄積 / 意思決定負荷（推定）</h4>
      TPA（32秒減衰）より長い「攻撃の流れ」を見るため、同一チーム連続保持の危険度積分
      （pt·分）を表示します。保持者の意思決定負荷は 開通レーン数 × 最近接プレッサー距離 ×
      守備密度の幾何ヒューリスティック — <b>ターンオーバー確率などの予測値ではありません</b>。
      <h4>本ツールの位置づけ</h4>
      公式記録の可視化と、決定論モデルによる<b>解釈支援（教育・分析検討用）</b>です。
      予測・ベッティング・スカウティング用途の製品ではなく、選手・審判・チームの実際の
      心理状態や能力を断定するものでもありません。
      <h4>ムーブメント・エンジン</h4>
      位置は<b>純関数 f(t)</b> — 帯域制限ノイズ＋攻守モーフ＋イベントアンカー＋チェーン調整の合成で、
      どの時刻へスクラブしても完全に同一の世界を返します。速度上限（≤9.9m/s）は各項の周波数×振幅と
      lerpブレンドで<b>構成的に保証</b>。
      <h4>交代 — ロジック不可侵</h4>
      FIFA規則（5人・3窓・HT非カウント・再入場禁止・GK同士・常時11人）は<b>バリデータ層</b>が強制。
      AI提案も布陣エディタも手動編集もこの層を必ず通過します。
      <h4>PSY レイヤー v1 — 心理生理（推定・非予測）</h4>
      テニス解析のアルゴリズムをサッカーへ移植した<b>読み取り専用の解釈レイヤー</b>です。
      位置・イベント・結果には一切影響しません。
      <div class="formula">モメンタム M(t) = Σ_ev w(ev)·±·e^(−Δt/300s)   （忘却係数付きイベント連鎖の連続化）
覚醒 AR   = 基線48 + Σ活性化インパルス·(1−0.4·MF) + 接戦×終盤 + 現在危険度 − 12·MF
精神疲労 MF = time-on-task + 被危険度曝露の減衰積分(τ25分) + 0.22·身体疲労 + 文脈(警告/失点/ビハインド)
集中力 CN  = 100·e^(−(AR−60)²/2σ²)·(1−0.45·MF)·(1−0.15·身体疲労)   （Yerkes-Dodson 逆U字）
自律神経   = 交感 SNS=0.30+0.55·AR/100+0.18·MF ⇄ 副交感 / HRVプロキシ=(1−SNS)(1−0.4·MF) 安静比%</div>
      <b>重要</b>: これは生体計測ではなく、決定論ヒューリスティックによる<b>解釈支援</b>です。
      心理状態の断定・予測ではありません。効果量は文献の定性形状のみ借用し、実試合への適合最適化は行っていません。
      出典: テニス・モメンタム連鎖（PMC11687916）/ HRVと試合プレッシャー / Yerkes-Dodson / 精神疲労とHRV反応性低下。
      <h4>検証</h4>
      Node.js テスト（背番号・XI・交代・時計・速度上限・決定論・規則・単調性・結果再構成・PSY性質・
      チェーン品質・接触・生理負荷・フィルタ・UQ）全通過。チャート配色はCVD分離で機械検証済み。
      <h4>検証を実行 — UQ（区間つきの断定・Issue #19）</h4>
      <div>D²-Field の「ゴール30秒前警報」を<b>全収録試合</b>で評価し、Wilson 90%信頼区間つきで表示します。</div>
      <div style="margin:8px 0"><button class="btn gold" id="btnRunUQ">全収録試合で警報性能を評価</button></div>
      <div class="formula" id="uqOut">未実行（ボタンで評価 — 曲線未計算の試合は先に計算します）</div>`;
    $("#btnRunUQ").onclick = () => {
      const out = $("#uqOut");
      const matches = Object.values(R.data.MATCHES || { [App.match.meta.id]: App.match });
      out.textContent = "危険度曲線を準備中…";
      const prep = (i) => {
        if (i >= matches.length) {
          const r = UQ.evaluate(matches);
          out.textContent = UQ.reportText(r) +
            "\nゴール別直前ピーク: " + r.rows.map(x => `${x.match.slice(-7)} ${x.min} ${Math.round(x.peak)}`).join(" / ");
          return;
        }
        D.curveAsync(matches[i], E.actualScenario(matches[i]), { step: 8, includeGK: false },
          (p) => { out.textContent = `曲線計算中 ${i + 1}/${matches.length} — ${Math.round(p * 100)}%`; },
          () => prep(i + 1));
      };
      prep(0);
    };
  };

  $("#customTemplate").onclick = () => { $("#customJson").value = JSON.stringify(G.template(), null, 2); };
  $("#customLoad").onclick = () => {
    try {
      const cfg = JSON.parse($("#customJson").value);
      const m = G.createMatch(cfg);
      setMatch(m);
      $("#customErr").textContent = "";
      $("#modalCustom").classList.remove("open");
      toast("カスタム試合を読み込みました（モデル生成）", "#7FA6FF");
    } catch (err) {
      $("#customErr").textContent = "⚠ " + err.message;
    }
  };
  $("#customBack").onclick = () => {
    setMatch(getTemplateMatch());
    $("#modalCustom").classList.remove("open");
    toast("既定のテンプレ（チームA×チームB）に戻しました", "#7FA6FF");
  };

  /* ---- #91: シナリオ JSON 往復（端末内のみ・送信/蓄積なし・golden安全） ---- */
  const bMsg = (t, err) => { const el = $("#bundleMsg"); if (el) { el.textContent = t; el.style.color = err ? "var(--crit-t)" : "var(--muted)"; } };
  const applyBundle = (text, src) => {
    // #91残: バンドルは自己完結 — customMatch があれば未較正試合を完全再構築してから適用。
    //   収録試合IDのバンドルなら該当試合へ自動切替（別試合へ誤適用しない）。
    let obj = text;
    try { obj = typeof text === "string" ? JSON.parse(text) : text; }
    catch (e) { bMsg("⚠ JSON 解析に失敗: " + (e && e.message), true); return false; }
    if (obj && obj.customMatch) {
      try { setMatch(G.createMatch(obj.customMatch)); }
      catch (e) { bMsg("⚠ カスタム試合の再構築に失敗: " + (e && e.message), true); return false; }
    } else if (obj && obj.match && R.data.MATCHES[obj.match] && obj.match !== App.match.meta.id) {
      setMatch(R.data.MATCHES[obj.match]);
    }
    const r = R.scenlib.parseBundle(App.match, obj);
    if (r.error) { bMsg("⚠ " + r.error, true); return false; }
    if (!r.validation || !r.validation.ok) { bMsg("⚠ 検証NG: " + ((r.validation && r.validation.errors) || []).join(" / "), true); return false; }
    refreshScenario(r.scenario);
    if (r.frame) App.editFrame = r.frame;
    $("#modalCustom").classList.remove("open");
    toast("シナリオを取り込みました（端末内）" + (src ? "・" + src : ""), "#7FA6FF");
    return true;
  };
  const readBundleFile = (file) => {
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => applyBundle(rd.result, file.name);
    rd.onerror = () => bMsg("⚠ ファイル読込に失敗", true);
    rd.readAsText(file);
  };
  $("#bundleExport") && ($("#bundleExport").onclick = () => {
    const sc = activeScenario();
    const json = R.scenlib.serializeBundle(App.match, sc, App.editFrame || null);
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = "rpdx-scenario.json"; a.click();
      bMsg("書き出し完了（" + json.length + "B）— 端末内のみ");
    } catch (e) { bMsg("⚠ 書き出し失敗: " + (e && e.message), true); }
  });
  $("#bundleFile") && ($("#bundleFile").onchange = (e) => { readBundleFile(e.target.files && e.target.files[0]); e.target.value = ""; });
  // ドラッグ&ドロップ（モーダル全体）
  const cm = $("#modalCustom");
  if (cm) {
    cm.addEventListener("dragover", (e) => { e.preventDefault(); });
    cm.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readBundleFile(f);
    });
  }
  // localStorage（任意・端末内のみ・サーバ非経由）
  const LS_KEY = "rpdx.scenario.v1";
  $("#bundleStore") && ($("#bundleStore").onclick = () => {
    try {
      localStorage.setItem(LS_KEY, R.scenlib.serializeBundle(App.match, activeScenario(), App.editFrame || null));
      bMsg("この端末に保存しました（localStorage・送信なし）");
    } catch (e) { bMsg("⚠ 端末保存に失敗: " + (e && e.message), true); }
  });
  $("#bundleRestore") && ($("#bundleRestore").onclick = () => {
    let text = null;
    try { text = localStorage.getItem(LS_KEY); } catch { /* ignore */ }
    if (!text) { bMsg("⚠ 端末に保存されたシナリオがありません", true); return; }
    applyBundle(text, "端末");
  });

  const setMatch = (m) => {
    App.match = m;
    App.scenario = null; App.scenarios = [];
    App.t = 0; App.selected = null; App.pickOut = null; App.pickIn = null;
    App.editorSel = null; App.editorDrag = null;
    App.lastIx = null; App.lastField = null; App.lastZone = null;
    App.lastPsy = null; App.lastPsySel = null; App.hotZone = null;
    App.speedMap.clear(); App.sprintSet.clear();
    App.zoneView = "BOTH";
    E.clearCaches(); D.clearCaches(); PSY.clearCaches(); PHYS.clearCaches(); curveStore.clear();
    App.tackle = null;
    renderer.setMatch(m);
    App.rosterTab = teamOrder()[1] || teamOrder()[0];
    buildStatic();
    updateSubSlots();
    $("#inspector").classList.remove("open");
    ensureCurveFor(E.actualScenario(m), { includeGK: false }, () => {});
  };

  /* ------------------------------ 3D操作 ------------------------------ */
  $("#gl").addEventListener("click", (e) => {
    if (App.editFrame) return;   // #82: 編集中は選択でなく座標編集（下の pointer handlers）
    const st = E.stateAt(App.match, activeScenario(), App.t);
    const r = renderer.pick(e.clientX, e.clientY, st);
    if (r.moved > 6) return;
    if (r.hit) selectPlayer(r.hit.team, r.hit.no);
  });
  document.querySelectorAll("#viewbar .cam").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#viewbar .cam").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      App.camPreset = b.dataset.cam;   // #134: リプレイ後の復帰先として記憶
      renderer.setPreset(b.dataset.cam);
    };
  });

  /* -------- #82: 停止フレームの手動編集（選手・ボール・審判の座標） -------- */
  const setEditMode = (on) => {
    if (on) {
      setPlaying(false);
      App.editFrame = E.editFrameAt(App.match, activeScenario(), App.t);
      App.editSel = null;
      renderer.editMode = true;
      renderer.setPreset("tactical");                 // 俯瞰＝タップ精度が最良
      document.querySelectorAll("#viewbar .cam").forEach(x => x.classList.toggle("on", x.dataset.cam === "tactical"));
      resetEditHist();                                // #133: 履歴を初期化
      renderEditAnalysis();
    } else {
      App.editFrame = null; App.editSel = null; App.editHist = null;
      renderer.editMode = false;
    }
    $("#btnEdit") && $("#btnEdit").classList.toggle("on", on);
    $("#editBar") && $("#editBar").classList.toggle("open", on);
  };
  const renderEditAnalysis = () => {
    const el = $("#editAnalysis");
    if (!el || !App.editFrame) return;
    try {
      const a = globalThis.RPDX.tactics.frameAnalysis(App.match, App.editFrame,
        { team: teamOrder()[1] || teamOrder()[0], includeGK: App.options.includeGK });
      const tips = a.suggestions.map((s, i) => (i + 1) + ". " + s.text).join("　／　");
      el.textContent = "方向的解析（モデル推定・位置系）: " + tips;
    } catch (e) { el.textContent = "解析エラー"; console.warn(e); }
  };
  $("#btnEdit") && ($("#btnEdit").onclick = () => setEditMode(!App.editFrame));
  $("#editExit") && ($("#editExit").onclick = () => setEditMode(false));
  $("#editRef") && ($("#editRef").onclick = () => { if (App.editFrame) App.editFrame.referees.push({ x: 0, y: 0 }); });
  $("#editReplay") && ($("#editReplay").onclick = () => {
    if (!App.editFrame) return;
    const r = globalThis.RPDX.scenlib.scenarioFromFrame(App.match, App.editFrame, activeScenario());
    if (!r.validation.ok) { console.warn("re-synth invalid", r.validation.errors); return; }
    const tFrom = App.editFrame.t;
    setEditMode(false);
    refreshScenario(r.scenario);
    App.t = tFrom;
    $("#curveStatus") && ($("#curveStatus").textContent = "編集フレームから再合成（" + r.moved + "点）");
  });
  $("#editSave") && ($("#editSave").onclick = () => {
    if (!App.editFrame) return;
    const json = globalThis.RPDX.scenlib.serializeFrame(App.editFrame);
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = "rpdx-frame.json"; a.click();
    } catch (e) { console.warn("save failed", e); }
    $("#curveStatus") && ($("#curveStatus").textContent = "フレーム保存 (" + json.length + "B)");
  });
  // #133: 整列/アンドゥ ツール（遅延アロー＝下方で定義される const を参照するため TDZ を回避）
  $("#editUndo") && ($("#editUndo").onclick = () => undoEdit());
  $("#editRedo") && ($("#editRedo").onclick = () => redoEdit());
  $("#editMirror") && ($("#editMirror").onclick = () => mirrorTeam());
  $("#editAlign") && ($("#editAlign").onclick = () => alignBackline());

  // 編集ドラッグ: pick半径内の最寄りエンティティ（選手/ボール/審判）をタップ→選択→地面交点へ移動。
  // #133: 選択は永続（ドラッグ後も保持＝ナッジ/整列の対象）・タッチは半径拡大・履歴でアンドゥ/リドゥ。
  const glcv = $("#gl");
  // タッチ端末は掴み半径を広げる（画面倍率連動の近似）。マウスは従来精度。
  const grabRadius = () => (window.matchMedia && window.matchMedia("(pointer:coarse)").matches ? 5.5 : 3.7);
  const editNearest = (g) => {
    if (!App.editFrame || !g) return null;
    let best = null, bd = grabRadius();
    for (const p of App.editFrame.players) {
      if (!p.onPitch) continue;
      const d = Math.hypot(p.x - g.x, p.y - g.y);
      if (d < bd) { bd = d; best = p; }
    }
    const b = App.editFrame.ball;
    if (b) { const d = Math.hypot(b.x - g.x, b.y - g.y); if (d < bd + 0.8) { bd = d; best = b; } }  // ボールは少し掴みやすく
    for (const rf of App.editFrame.referees) {
      const d = Math.hypot(rf.x - g.x, rf.y - g.y);
      if (d < bd) { bd = d; best = rf; }
    }
    return best;
  };
  // 選択エンティティの記述（renderer ハイライト用）
  const editSelDesc = () => {
    const s = App.editSel; if (!s || !App.editFrame) return null;
    if (s === App.editFrame.ball) return { kind: "ball" };
    if (App.editFrame.players.includes(s)) return { kind: "player", team: s.team, no: s.no };
    const ri = App.editFrame.referees.indexOf(s);
    if (ri >= 0) return { kind: "ref", idx: ri };
    return null;
  };
  // ---- 編集履歴（アンドゥ/リドゥ・#133）: 位置スナップショットのスタック ----
  const snapFrame = () => {
    if (!App.editFrame) return null;
    return {
      players: App.editFrame.players.map(p => [p.team, p.no, p.x, p.y]),
      ball: [App.editFrame.ball.x, App.editFrame.ball.y],
      refs: App.editFrame.referees.map(r => [r.x, r.y]),
    };
  };
  const applySnap = (s) => {
    if (!s || !App.editFrame) return;
    for (const [team, no, x, y] of s.players) {
      const p = App.editFrame.players.find(q => q.team === team && q.no === no);
      if (p) { p.x = x; p.y = y; }
    }
    App.editFrame.ball.x = s.ball[0]; App.editFrame.ball.y = s.ball[1];
    s.refs.forEach((r, i) => { if (App.editFrame.referees[i]) { App.editFrame.referees[i].x = r[0]; App.editFrame.referees[i].y = r[1]; } });
    App.editFrame.edited = true;
    renderEditAnalysis();
    updateEditButtons();
  };
  const resetEditHist = () => { App.editHist = { stack: [snapFrame()], idx: 0 }; updateEditButtons(); };
  const pushEditHist = () => {
    if (!App.editHist) { resetEditHist(); return; }
    const h = App.editHist;
    h.stack = h.stack.slice(0, h.idx + 1);   // リドゥ枝を破棄
    h.stack.push(snapFrame());
    if (h.stack.length > 40) h.stack.shift(); else h.idx++;
    updateEditButtons();
  };
  const undoEdit = () => { const h = App.editHist; if (!h || h.idx <= 0) return; h.idx--; applySnap(h.stack[h.idx]); };
  const redoEdit = () => { const h = App.editHist; if (!h || h.idx >= h.stack.length - 1) return; h.idx++; applySnap(h.stack[h.idx]); };
  const updateEditButtons = () => {
    const h = App.editHist;
    const u = $("#editUndo"), r = $("#editRedo");
    if (u) u.disabled = !h || h.idx <= 0;
    if (r) r.disabled = !h || h.idx >= h.stack.length - 1;
  };

  // ---- 整列ツール（#133）: 選択選手のチームに対する幾何ヘルパ。結果は editFrame 位置＝editAnchors に落ちる ----
  const selTeamOutfield = () => {
    const d = editSelDesc();
    const team = d && d.kind === "player" ? d.team : (App.editSel && App.editSel.team) || teamOrder()[0];
    return App.editFrame.players.filter(p => p.onPitch && p.team === team && p.role !== "GK");
  };
  const mirrorTeam = () => {                      // 左右（幅方向 y）ミラー
    if (!App.editFrame) return;
    for (const p of selTeamOutfield()) p.y = -p.y;
    App.editFrame.edited = true; pushEditHist(); renderEditAnalysis();
  };
  const alignBackline = () => {                   // 最終ライン（自ゴール側の低位3人）を平均 x へ一直線
    if (!App.editFrame) return;
    const half = App.editFrame.half || 1;
    const ps = selTeamOutfield();
    if (ps.length < 3) return;
    const team = ps[0].team;
    const dir = (App.match.dir && App.match.dir[team]) ? App.match.dir[team][half === 1 ? "h1" : "h2"] : 1;
    const sorted = [...ps].sort((a, b) => dir * a.x - dir * b.x);   // 自ゴール側から昇順
    const back = sorted.slice(0, Math.min(4, sorted.length));
    const avg = back.reduce((s, p) => s + p.x, 0) / back.length;
    for (const p of back) p.x = avg;
    App.editFrame.edited = true; pushEditHist(); renderEditAnalysis();
  };
  const nudgeSel = (dx, dy) => {
    if (!App.editFrame || !App.editSel) return;
    App.editSel.x = clamp(App.editSel.x + dx, -52.5, 52.5);
    App.editSel.y = clamp(App.editSel.y + dy, -34, 34);
    App.editFrame.edited = true; pushEditHist(); renderEditAnalysis();
  };

  let editDragging = false, editDragMoved = false;
  glcv.addEventListener("pointerdown", (e) => {
    if (!App.editFrame) return;
    const g = renderer.groundAt(e.clientX, e.clientY);
    const hit = editNearest(g);
    if (hit) { App.editSel = hit; editDragging = true; editDragMoved = false; try { glcv.setPointerCapture(e.pointerId); } catch (_) {} }
    else { App.editSel = null; }   // 空タップで選択解除
    updateEditButtons();
  });
  glcv.addEventListener("pointermove", (e) => {
    if (!App.editFrame || !App.editSel || !editDragging) return;
    const g = renderer.groundAt(e.clientX, e.clientY);
    if (!g) return;
    App.editSel.x = g.x; App.editSel.y = g.y;
    App.editFrame.edited = true; editDragMoved = true;
  });
  glcv.addEventListener("pointerup", () => {
    if (editDragging && editDragMoved) { pushEditHist(); renderEditAnalysis(); }
    editDragging = false;   // 選択は保持（ナッジ/整列の対象）
  });
  if (urlq.get("edit") === "1") setTimeout(() => setEditMode(true), 60);   // ヘッドレス検証用
  const FIELD_MODES = [["particles", "粒子"], ["surface", "面"], ["off", "OFF"]];
  const cycleFieldMode = () => {
    const i = FIELD_MODES.findIndex(m => m[0] === App.options.fieldMode);
    const next = FIELD_MODES[(i + 1) % FIELD_MODES.length];
    App.options.fieldMode = next[0];
    $("#fieldModeLbl").textContent = next[1];
    $("#togField").classList.toggle("on", next[0] !== "off");
  };
  $("#togField").onclick = cycleFieldMode;
  // #134: 表示オプションの端末内保存（localStorage・送信なし）— 重い/演出系トグルを跨セッションで維持。
  const LS_OPT = "rpdx_opts_v1";
  const PERSIST_OPTS = ["kitNumbers", "goalReplay", "labels", "speedLabels", "psy", "trails"];
  const saveOpts = () => {
    try {
      const o = {}; for (const k of PERSIST_OPTS) o[k] = App.options[k];
      localStorage.setItem(LS_OPT, JSON.stringify(o));
    } catch { /* localStorage 不可でも無視 */ }
  };
  const loadOpts = () => {
    try {
      const o = JSON.parse(localStorage.getItem(LS_OPT) || "{}");
      for (const k of PERSIST_OPTS) if (typeof o[k] === "boolean") App.options[k] = o[k];
    } catch { /* ignore */ }
  };
  loadOpts();
  const bindTog = (id, key) => {
    const el = $(id); if (!el) return;
    el.classList.toggle("on", App.options[key]);   // 保存値を初期表示へ反映
    el.onclick = () => {
      App.options[key] = !App.options[key];
      el.classList.toggle("on", App.options[key]);
      saveOpts();
    };
  };
  bindTog("#togZones", "zones");
  bindTog("#togTrail", "trails");
  bindTog("#togLabel", "labels");
  bindTog("#togSpeed", "speedLabels");
  bindTog("#togPsy", "psy");
  bindTog("#togNum", "kitNumbers");
  bindTog("#togReplay", "goalReplay");
  // #152: 品質ティア表示＋手動オーバーライド（自動→シネマ→軽量→自動・端末内保存のみ）
  if (R.quality && $("#togTier")) {
    const TIER_JA = { cinematic: "シネマ", lightweight: "軽量" };
    const updTier = () => {
      const st = R.quality.state();
      $("#tierLbl").textContent = (st.source === "override" ? "" : "自動·") + (TIER_JA[st.tier] || st.tier) +
        (st.level > 0 ? "↓" + st.level : "");
      $("#togTier").classList.toggle("on", st.source === "override");
    };
    $("#togTier").onclick = () => {
      const st = R.quality.state();
      const next = st.source !== "override" ? "cinematic" : (st.tier === "cinematic" ? "lightweight" : "auto");
      R.quality.setOverride(next);
      try {
        if (next === "auto") localStorage.removeItem("rpdx_tier_v1");
        else localStorage.setItem("rpdx_tier_v1", next);
      } catch (_) { /* localStorage 不可でも動作 */ }
      updTier();
    };
    R.quality.onChange(updTier);
    updTier();
  }
  const setGK = (inc) => {
    App.options.includeGK = inc;
    $("#gk20").classList.toggle("on", !inc);
    $("#gk22").classList.toggle("on", inc);
    ensureCurveFor(E.actualScenario(App.match), { includeGK: inc }, () => {});
    if (isSim()) ensureCurveFor(App.scenario, { includeGK: inc }, () => {});
  };
  $("#gk20").onclick = () => setGK(false);
  $("#gk22").onclick = () => setGK(true);
  // 支配核モード（Issue #13: pace属性依存の分離 — 幾何のみ=全員一律σ）
  const setCore = (geom) => {
    if (D.isGeomOnly() === geom) return;
    D.setGeomOnly(geom);                  // danger内部キャッシュは自動クリア
    PSY.clearCaches();
    curveStore.clear();
    $("#corePace").classList.toggle("on", !geom);
    $("#coreGeom").classList.toggle("on", geom);
    ensureCurveFor(E.actualScenario(App.match), { includeGK: false }, () => {
      ensureCurveFor(E.actualScenario(App.match), { includeGK: App.options.includeGK }, () => {});
      if (isSim()) computeOutcome(App.scenario);
    });
    toast(geom ? "支配核: 幾何のみ（等能力・推定属性に非依存）" : "支配核: pace反映（モデル推定属性）", GOLD);
  };
  $("#corePace").onclick = () => setCore(false);
  $("#coreGeom").onclick = () => setCore(true);
  $("#toggleL").onclick = () => $("#dockL").classList.toggle("shown");
  $("#toggleR").onclick = () => $("#dockR").classList.toggle("shown");
  // #105: モバイルはビューバー/タイムラインを既定で畳み、⚙/📈 で開閉（ピッチ全体を基本に・下部は排他）
  $("#viewToggle") && ($("#viewToggle").onclick = () => {
    $("#viewbar").classList.toggle("open");
    $("#timelineWrap").classList.remove("open");
  });
  $("#tlToggle") && ($("#tlToggle").onclick = () => {
    const open = $("#timelineWrap").classList.toggle("open");
    $("#viewbar").classList.remove("open");
    if (open) fitTimeline();
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
    // #133: 編集モードのアンドゥ/リドゥ・ナッジ（矢印は時刻スクラブより優先）
    if (App.editFrame) {
      const z = (e.ctrlKey || e.metaKey) && e.code === "KeyZ";
      if (z && e.shiftKey) { e.preventDefault(); redoEdit(); return; }
      if (z) { e.preventDefault(); undoEdit(); return; }
      if (App.editSel && e.code.startsWith("Arrow")) {
        e.preventDefault();
        const s = e.shiftKey ? 1.0 : 0.5;     // Shift で 1m・既定 0.5m
        if (e.code === "ArrowLeft") nudgeSel(0, -s);
        else if (e.code === "ArrowRight") nudgeSel(0, s);
        else if (e.code === "ArrowUp") nudgeSel(s, 0);
        else if (e.code === "ArrowDown") nudgeSel(-s, 0);
        return;
      }
    }
    if (e.code === "Space") { e.preventDefault(); setPlaying(!App.playing); }
    else if (e.code === "ArrowRight") App.t = Math.min(App.t + 15, E.playedRange(App.match).t1);
    else if (e.code === "ArrowLeft") App.t = Math.max(App.t - 15, 0);
    else if (e.code === "KeyH") cycleFieldMode();
    else if (e.code === "KeyZ") $("#togZones").click();
    else if (e.code === "KeyT") $("#togTrail").click();
    else if (e.code === "KeyL") $("#togLabel").click();
    else if (e.code === "KeyV") $("#togSpeed").click();
    else if (e.code === "KeyP") $("#togPsy").click();
    else if (e.code === "KeyG") setGK(!App.options.includeGK);
    else if (e.code.startsWith("Digit")) {
      const i = +e.code.slice(5) - 1;
      const cams = document.querySelectorAll("#viewbar .cam");
      if (cams[i]) cams[i].click();
    } else if (e.key === "?") document.body.classList.toggle("showkeys");
  });

  /* ------------------------------ メインループ ------------------------------ */
  let lastNow = performance.now(), lastHUD = 0, lastRosterMin = -1;
  const maxFrames = +(urlq.get("shotframes") || 0) || Infinity; // ヘッドレス検証用
  const govOn = !!R.quality && maxFrames === Infinity && urlq.get("gov") !== "0";  // #152
  let frameCount = 0, curveReadyAt = -1;
  const loop = (nowReal) => {
    // #153: ショットモード（shotframes指定時）は合成クロック＝フレーム番号×16.6ms。
    // ドライバや実行環境のタイミングに依らずフレーム列が決定論になる
    // （ゲイト位相・カメラ慣性・パルス位相・HUD更新タイミングまで同一）。
    const now = maxFrames !== Infinity ? frameCount * (1000 / 60) : nowReal;
    if (maxFrames !== Infinity && frameCount === 0) lastNow = now - 1000 / 60;
    const rawMs = now - lastNow;                       // #152: 未クランプのフレーム所要（守衛の標本）
    const dt = Math.min(rawMs / 1000, 0.1);
    lastNow = now;
    // 正準曲線の準備完了を検知したら即HUD更新（ヘッドレスでPSY/曲線が確実に載る）
    if (curveReadyAt < 0 && curveStore.has(curveKeyOf(E.actualScenario(App.match), { includeGK: false }))) {
      curveReadyAt = frameCount;
      lastHUD = 0;
    }
    const range = E.playedRange(App.match);
    const t0 = App.t;
    if (App.playing) {
      App.t = Math.min(App.t + dt * App.speed, range.t1);
      if (App.t >= range.t1) setPlaying(false);
      checkCrossings(t0, App.t);
      // #134: リプレイ終了 → 元の時刻・速度・カメラへ復帰
      if (App.replay && App.t >= App.replay.endT) endGoalReplay();
    } else if (App.replay) {
      endGoalReplay();   // 停止したらリプレイも解除
    }

    const sc = activeScenario();
    const state = App.editFrame || E.stateAt(App.match, sc, App.t);

    // HUD 更新（8Hz）
    if (now - lastHUD > 125) {
      lastHUD = now;
      const ix = D.indexSmooth(App.match, sc, App.t, { includeGK: App.options.includeGK });
      App.lastIx = ix;
      if (App.options.fieldMode !== "off") App.lastField = D.fieldAt(App.match, state, { includeGK: App.options.includeGK });
      if (App.options.zones) App.lastZone = D.zoneField(App.match, state);
      updateDashboard(ix);
      const [a, b] = teamOrder();
      $("#scoreA").textContent = state.score[a];
      $("#scoreB").textContent = state.score[b];
      $("#clock").textContent = state.clock.disp;
      // ピリオド表記は clock.half（1..4）を使う。state.half は方向用に延長を1/2へ写像するため表示に使わない（#141）
      $("#halfLbl").textContent = ["", "前半", "後半", "延長前半", "延長後半"][state.clock.half] || "後半";
      // 累積支配率（ポゼッション・チェーン）
      const poss = E.possessionStats(App.match, sc, App.t);
      const pa = Math.round((poss[a] || 0.5) * 100);
      $("#possA").style.width = pa + "%";
      $("#possAv").textContent = pa;
      $("#possBv").textContent = 100 - pa;
      // 現在の保持者（リスタート中は種別を明示）
      const cr = state.carrier;
      const RESTART_JA = { throwin: "スローイン", corner: "コーナーキック", goalkick: "ゴールキック", kickoff: "キックオフ" };
      if (cr && cr.restart && App.t <= cr.tf + cr.rdelay + 0.5) {
        const p = App.match.teams[cr.team].squad.find(q => q.no === cr.no);
        $("#carrierChip").textContent = `${RESTART_JA[cr.restart]} — ${App.match.teams[cr.team].name} ${cr.no} ${p?.label ?? ""}`;
      } else if (cr && cr.mode === "hold") {
        const p = App.match.teams[cr.team].squad.find(q => q.no === cr.no);
        $("#carrierChip").textContent = `保持 ${App.match.teams[cr.team].name} ${cr.no} ${p?.label ?? ""}`;
      } else if (cr && cr.mode === "flight") {
        $("#carrierChip").textContent = cr.restart ? `${RESTART_JA[cr.restart]}へ` : "パス進行中";
      } else {
        $("#carrierChip").textContent = "";
      }
      updateInspector();
      const min = Math.floor(App.t / 30);
      if (min !== lastRosterMin) { lastRosterMin = min; buildRoster(); }

      // PSY（正準曲線キャッシュ後のみ — 決定論・読み取り専用）
      if (App.options.psy && psyReady()) {
        App.lastPsy = PSY.teamAt(App.match, sc, App.t);
        updatePsyPanel(App.lastPsy);
      }
      // 保持者の意思決定負荷（#9 — 幾何のみ・非予測）
      const dd = App.options.psy ? PSY.decisionAt(App.match, sc, App.t, state) : null;
      if (dd) {
        const p = App.match.teams[dd.team].squad.find(q => q.no === dd.no);
        $("#psyDD").innerHTML =
          `保持者の意思決定負荷（推定）: <b style="color:${seriesColor(dd.team, true)}">${Math.round(dd.dd)}</b>` +
          ` — ${p?.label ?? dd.no} · 開通レーン${dd.options} · 最近接${dd.presserDist.toFixed(1)}m`;
      } else {
        $("#psyDD").textContent = "";
      }
      // タックル/接触（#22 — 描画のスタンブル演出が消費）
      App.tackle = DUEL.tackleAt(App.match, sc, App.t);
      // 保持シーケンス蓄積（#14）
      if (psyReady()) {
        const sq = D.seqAccumAt(App.match, sc, App.t, { includeGK: false });
        $("#seqInfo").innerHTML = sq
          ? `保持シーケンス: <b style="color:${seriesColor(sq.team, true)}">${App.match.teams[sq.team].name}</b> ` +
            `${sq.passes}本目 · <span class="num">${E.clockAt(App.match, sq.t0).disp}</span>開始 · 危険度蓄積 <b class="num">${sq.accum.toFixed(1)}</b> pt·分`
          : "";
      }
      // 選手速度（8Hzで値を更新・描画は毎フレームの位置に追従）
      App.speedMap.clear(); App.sprintSet.clear();
      if (App.options.speedLabels) {
        for (const p of state.players) {
          if (!p.onPitch || p.entering) continue;      // 入場走り込み中は対象外
          const v = E.speedKmh(App.match, sc, p.team, p.no, App.t);
          const key = p.team + ":" + p.no;
          App.speedMap.set(key, v);
          // ヒステリシス（無状態・決定論）: 現在≥20 かつ 0.8秒前≥17 で疾走
          // （第2サンプルは疾走候補のみ計算 — 不要な位置評価を95%削減）
          if (v >= 20 && E.speedKmh(App.match, sc, p.team, p.no, App.t - 0.8) >= 17) {
            App.sprintSet.add(key);
          }
        }
      }
      // 危険ホットゾーン矩形（WARNING以上のチームの脅威極大セル）
      App.hotZone = null;
      if (App.lastField && App.lastIx) {
        const f = App.lastField;
        let team = null, total = 0;
        for (const k of teamOrder()) {
          const v = App.lastIx[k].total;
          if (v >= D.WARN_AT && v > total) { total = v; team = k; }
        }
        if (team) {
          const sign = team === f.plus ? 1 : -1;
          let best = -1, bi = 0;
          for (let i = 0; i < f.grid.length; i++) {
            const v = f.grid[i] * sign;
            if (v > best) { best = v; bi = i; }
          }
          if (best > 0.02) {
            const ci = bi % f.nx, cj = (bi / f.nx) | 0;
            App.hotZone = {
              x: -52.5 + ((ci + 0.5) / f.nx) * 105,
              y: -34 + ((cj + 0.5) / f.ny) * 68,
              w: (105 / f.nx) * 3.4, h: (68 / f.ny) * 3.4,
              color: hex2rgb(seriesColor(team, true)),
              alpha: 0.16 + 0.3 * clamp((total - D.WARN_AT) / (100 - D.WARN_AT)),
            };
          }
        }
      }
    }

    // 3D シーン
    const contribMap = new Map();
    if (App.lastIx) {
      for (const k of teamOrder()) for (const c of App.lastIx[k].contrib) contribMap.set(k + c.no, c.val);
    }
    let ballTrail = null, playerTrail = null;
    if (App.options.trails) {
      // 軌跡は0.42s/0.62s格子に量子化してメモ化 — 毎フレームの純関数再評価を排除
      const sk = E.scenarioKey(sc) + "|" + App.match.meta.id;
      if (trailCache.size > 30000) trailCache.clear();
      ballTrail = [];
      for (let i = 16; i >= 1; i--) {
        const q = Math.max(0, Math.round((App.t - i * 0.42) / 0.42));
        const key = "b|" + sk + "|" + q;
        let pt = trailCache.get(key);
        if (!pt) { pt = E.ballAt(App.match, sc, q * 0.42); trailCache.set(key, pt); }
        ballTrail.push(pt);
      }
      if (App.selected) {
        const pr = E.presenceOf(App.match, sc, App.selected.team, App.selected.no);
        if (pr && App.t > pr.from && App.t <= pr.to) {
          playerTrail = [];
          for (let i = 22; i >= 1; i--) {
            const q = Math.round(Math.max(pr.from + 0.1, App.t - i * 0.62) / 0.62);
            const key = "p|" + sk + "|" + App.selected.team + App.selected.no + "|" + q;
            let pt = trailCache.get(key);
            if (!pt) {
              pt = E.stateFrozenPos(App.match, sc, App.selected.team, App.selected.no,
                Math.max(pr.from + 0.1, q * 0.62));
              trailCache.set(key, pt);
            }
            playerTrail.push(pt);
          }
          const col = seriesColor(App.selected.team, true);
          const v = parseInt(col.slice(1), 16);
          playerTrail.color = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
        }
      }
    }
    // 速度ラベル（値は8Hz更新・位置は現フレームの選手に追従）
    let speedLabels = null;
    if (App.options.speedLabels && App.speedMap.size) {
      speedLabels = [];
      const selKey = App.selected ? App.selected.team + ":" + App.selected.no : null;
      for (const p of state.players) {
        if (!p.onPitch) continue;
        const key = p.team + ":" + p.no;
        const isSel = key === selKey;
        if (!isSel && !App.sprintSet.has(key)) continue;
        speedLabels.push({
          x: p.x, y: p.y, team: p.team, no: p.no,
          kmh: Math.round(App.speedMap.get(key) || 0),
          name: p.name, withName: isSel, sel: isSel,
        });
      }
      speedLabels.sort((a, b) => (b.sel - a.sel) || (b.kmh - a.kmh));
      speedLabels = speedLabels.slice(0, 5);
    }
    // PSY オーラ（選択選手の覚醒状態を色相で — 低:青 / 至適:金 / 過覚醒:赤）
    let psyAura = null;
    if (App.options.psy && App.selected && App.lastPsySel && App.lastPsySel.on) {
      const p = state.players.find(q => q.onPitch && q.team === App.selected.team && q.no === App.selected.no);
      if (p) {
        const ar = App.lastPsySel.ar;
        const cLow = [0.31, 0.49, 1], cOpt = [0.91, 0.8, 0.59], cHi = [1, 0.35, 0.28];
        const u = clamp((ar - 30) / 45);
        const v = clamp((ar - 72) / 22);
        const col = [
          cLow[0] + (cOpt[0] - cLow[0]) * u + (cHi[0] - cOpt[0]) * v,
          cLow[1] + (cOpt[1] - cLow[1]) * u + (cHi[1] - cOpt[1]) * v,
          cLow[2] + (cOpt[2] - cLow[2]) * u + (cHi[2] - cOpt[2]) * v,
        ];
        psyAura = { x: p.x, y: p.y, color: col, k: ar / 100, mf: App.lastPsySel.mf / 100 };
      }
    }
    // パスライン（フライト中: 出し手→受け手の点線・カットは赤系 — sample解析映像準拠）
    let passLine = null;
    const crF = state.carrier;
    if (crF && crF.mode === "flight" && crF.from) {
      const a = state.players.find(p => p.onPitch && p.team === crF.from.team && p.no === crF.from.no);
      const b = state.players.find(p => p.onPitch && p.team === crF.team && p.no === crF.no);
      if (a && b) passLine = { x1: a.x, y1: a.y, x2: b.x, y2: b.y, u: crF.u, cut: crF.from.team !== crF.team };
    }
    // 接触・シールド演出（描画のみ — データ不変）
    let tackleFx = null;
    if (App.tackle) {
      const u = 1 - (App.t - App.tackle.t0) / 1.3;
      if (u > 0 && u <= 1) tackleFx = { loserKey: App.tackle.loser.team + ":" + App.tackle.loser.no, u };
    }
    let shieldFx = null;
    const sh = DUEL.shieldAt(state);
    if (sh) {
      const pr = state.players.find(q => q.onPitch && q.team === sh.presser.team && q.no === sh.presser.no);
      if (pr) shieldFx = { holderKey: sh.holder.team + ":" + sh.holder.no, px: pr.x, pz: -pr.y };
    }
    // 空中戦（コーナークロス）— 勝者/敗者のジャンプ・ヘッド演出（描画のみ）
    let aerialFx = null;
    const aer = DUEL.aerialAt(state);
    if (aer) {
      aerialFx = {
        winnerKey: aer.winner.team + ":" + aer.winner.no,
        loserKey: aer.loser.team + ":" + aer.loser.no,
        jumpH: Math.sin(Math.PI * (1 - aer.u)),   // 踏切→頂点→着地の弧
      };
    }
    renderer.frame(now / 1000, dt, {
      state,
      field: App.options.fieldMode !== "off" ? App.lastField : null,
      zone: App.options.zones ? App.lastZone : null,
      zoneView: App.zoneView,
      options: App.options,
      selected: App.selected,
      hover: App.hover,
      editMode: !!App.editFrame, editSel: editSelDesc(),   // #133: 掴み対象のハイライト・ボールアフォーダンス
      contribMap, ballTrail, playerTrail,
      speedLabels, psyAura,
      hotZone: App.hotZone,
      tackle: tackleFx, shield: shieldFx, passLine, aerial: aerialFx,
    });
    drawTimeline();
    // #152: 滑らかさ守衛 — ヘッドレス検証（shotframes）と ?gov=0 では凍結（決定論スクショ保護）
    if (govOn) R.quality.tick(rawMs, now / 1000);
    if (++frameCount < maxFrames) requestAnimationFrame(loop);
    else if (maxFrames !== Infinity) globalThis.__RPDX_SHOT_DONE = frameCount;   // #153: 視覚回帰の描画完了シグナル
  };
  // ヘッドレス（shotframes指定時）: 正準曲線の完了を待ってから描画開始
  // — 仮想時間を計算に集中させ、全フレームにPSY/曲線が確実に載る
  // #153: 開始直前にカメラをプリセットへ即時スナップ（起動中の実時間で進んだ追従イージングを
  // 破棄し、以後の仮想時間フレーム列を決定論化する）
  const startLoop = () => {
    if (maxFrames !== Infinity && renderer) renderer.setPreset(App.camPreset || "broadcast", true);
    requestAnimationFrame(loop);
  };
  const startWhenReady = () => {
    if (maxFrames === Infinity) { startLoop(); return; }
    const ready = () => curveStore.has(curveKeyOf(E.actualScenario(App.match), { includeGK: false }));
    const wait = () => (ready() ? startLoop() : setTimeout(wait, 40));
    wait();
  };

  /* boot */
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
