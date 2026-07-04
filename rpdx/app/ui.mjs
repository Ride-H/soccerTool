/* =========================================================================
   RPDX.app — アプリケーション層
   HUD / タイムライン / 配置エディタ / 交代シム / シナリオ結果 / モーダル
   ========================================================================= */
(() => {
  const R = globalThis.RPDX;
  const E = R.engine, D = R.danger, S = R.subs, G = R.generic, F = R.formations, SIM = R.sim;
  const $ = (s) => document.querySelector(s);
  const clamp = R.noise.clamp;

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
    },
    zoneView: "BOTH",
    selected: null, hover: null,
    rosterTab: null,
    pickOut: null, pickIn: null,
    editorSel: null, editorDrag: null,
    lastIx: null, lastField: null, lastZone: null,
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
      ensureCurveFor(sc, { includeGK: App.options.includeGK }, () => {});
    });
  };

  /* ----------------------------- 曲線計算 ----------------------------- */
  const curveStore = new Map();
  const curveKeyOf = (sc, opts) =>
    `${App.match.meta.id}|${E.scenarioKey(sc)}|8|${opts.includeGK ? 1 : 0}`;
  const ensureCurveFor = (sc, opts, cb) => {
    const key = curveKeyOf(sc, opts);
    if (curveStore.has(key)) { cb && cb(); return; }
    D.curveAsync(App.match, sc, { step: 8, includeGK: opts.includeGK },
      (p) => { $("#curveStatus").textContent = `D²曲線 ${Math.round(p * 100)}%`; },
      (pts) => {
        curveStore.set(key, pts);
        $("#curveStatus").textContent = "";
        cb && cb();
      });
  };
  const actualCurve = () => curveStore.get(curveKeyOf(E.actualScenario(App.match), { includeGK: App.options.includeGK }));
  const activeCurve = () => curveStore.get(curveKeyOf(activeScenario(), { includeGK: App.options.includeGK }));

  /* ------------------------------ 起動 ------------------------------ */
  // URLパラメータ: ?t=秒 &cam=broadcast|tactical|goal|pitch|fly &play=0|1 &speed=n
  const urlq = new URLSearchParams(location.search);
  let renderer, tlCtx;
  const boot = () => {
    renderer = R.render3d.create($("#gl"), App.match);
    App.rosterTab = teamOrder()[1] || teamOrder()[0]; // 既定: 日本
    const fit = () => { renderer.resize(); fitTimeline(); fitEditor(); };
    window.addEventListener("resize", fit);
    fit();
    buildStatic();
    if (urlq.has("t")) App.t = clamp(+urlq.get("t") || 0, 0, E.playedRange(App.match).t1);
    if (urlq.has("speed")) App.speed = +urlq.get("speed") || 12;
    if (urlq.has("cam")) {
      renderer.setPreset(urlq.get("cam"), true);
      document.querySelectorAll("#viewbar .cam").forEach(x => x.classList.toggle("on", x.dataset.cam === urlq.get("cam")));
    }
    if (urlq.has("sel")) {
      const [tm, no] = urlq.get("sel").split(":");
      if (App.match.teams[tm]) selectPlayer(tm, +no);
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
        $("#btnPlay").textContent = App.playing ? "❚❚ 停止" : "▶ 再生";
      }, 250);
    });
    // 事前計算の進捗をローディングにも反映
    const origStatus = $("#curveStatus");
    const obs = new MutationObserver(() => {
      const m = origStatus.textContent.match(/(\d+)%/);
      if (m) { $("#loadFill").style.width = m[1] + "%"; $("#loadMsg").textContent = `D²-Field v2 曲線を事前計算中… ${m[1]}%`; }
    });
    obs.observe(origStatus, { childList: true });
    requestAnimationFrame(loop);
  };

  const buildStatic = () => {
    const [a, b] = teamOrder();
    drawFlag($("#flagA"), a, App.match.teams[a].color);
    drawFlag($("#flagB"), b, App.match.teams[b].color);
    $("#nameA").textContent = App.match.teams[a].nameEn || a;
    $("#nameB").textContent = App.match.teams[b].nameEn || b;
    buildRosterTabs();
    buildRoster();
    buildEditorStatic();
    buildScenarioChips();
    buildSubList();
    buildKikenTiles();
    buildZoneViewBtns();
    buildInfoModal();
    buildModelModal();
    renderOutcome();
    $("#tlLegend").innerHTML = teamOrder().map(k =>
      `<span><i class="sw" style="background:${seriesColor(k)}"></i>${App.match.teams[k].name} 危険度</span>`
    ).join("") + `<span><i class="sw" style="background:transparent;border-top:2px dashed ${GOLD}"></i>シナリオ</span>`;
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

  const buildRoster = () => {
    const team = App.rosterTab, T = App.match.teams[team];
    const list = $("#plist");
    list.innerHTML = "";
    const kit = T.kit;
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
      const yellow = App.match.events.some(e => e.type === "yellow" && e.team === team && e.no === p.no && e.t <= App.t);
      row.innerHTML =
        `<span class="dot ${st.s === "on" ? "on" : st.s === "used" ? "used" : "off"}"></span>` +
        `<span class="pnum" style="background:${isGK ? kit.gk : kit.shirt};color:${isGK ? kit.gkNumber : kit.number}">${p.no}</span>` +
        `<span class="pname">${p.ja}${p.captain ? " ©" : ""}${yellow ? '<span class="ycard" title="警告"></span>' : ""}</span>` +
        `<span class="ppos">${p.pos}</span><span class="pstat">${st.label}</span>`;
      row.onclick = () => onRosterClick(team, p, st);
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
    sel.innerHTML = Object.keys(F.SHAPES).map(k =>
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
    }
    rows.sort((a, b) => a.t - b.t);
    $("#subList").innerHTML = rows.map(r =>
      `<div class="srow">${r.html}${isSim() ? `<button class="btn" style="padding:1px 7px;font-size:10px" data-del="${r.k}:${r.i}">✕</button>` : ""}</div>`
    ).join("");
    if (isSim()) {
      $("#subList").querySelectorAll("[data-del]").forEach(btn => {
        btn.onclick = () => {
          const [k, i] = btn.dataset.del.split(":");
          const r = S.withoutSub(App.match, App.scenario, k, +i);
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
      const p = T.squad.find(q => q.no === g.no);
      evRows.push(`<div class="ev add"><span class="min">${g.min}</span>
        <span>${T.name} <b>${p?.ja ?? g.no}</b> のゴール<br><span class="why">${g.detail}</span></span></div>`);
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
      <div class="hint">決定論 — 同じシナリオは常に同じ結果。判定は危険度プロセス曲線（20人・GK除外）に基づく。</div>`;
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
    $("#sbText").innerHTML = `<span class="chip ${stCls}">${worst.status}</span> ` +
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
    $("#inspName").textContent = p.ja + (p.captain ? " ©" : "");
    $("#inspSub").textContent = `${p.name} · ${p.pos} · ${p.club} · ${p.caps}キャップ${p.goals ? ` ${p.goals}G` : ""}`;
    const A = p.attrs;
    $("#inspAttrs").innerHTML = [["速度", A.pac], ["持久", A.sta], ["守備", A.def], ["攻撃", A.att], ["技術", A.tec], ["空中", A.aer]]
      .map(([k, v]) => `<div class="attr"><span>${k}</span><div class="track"><div class="fill" style="width:${v}%;background:${seriesColor(team)}"></div></div><span class="num">${v}</span></div>`).join("");
    $("#inspector").classList.add("open");
    updateInspector(true);
  };
  $("#inspClose").onclick = () => { App.selected = null; $("#inspector").classList.remove("open"); buildRoster(); };

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
  };

  /* ----------------------------- タイムライン ----------------------------- */
  const fitTimeline = () => {
    const cv = $("#tlCanvas");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(cv.clientWidth * dpr);
    cv.height = Math.round(cv.clientHeight * dpr);
    tlCtx = cv.getContext("2d");
    tlCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
      if (near.length) html += `<br><span style="color:var(--muted)">${near[0].min || ""} ${near[0].label}</span>`;
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
    $("#btnPlay").textContent = p ? "❚❚ 停止" : "▶ 再生";
  };
  $("#btnPlay").onclick = () => setPlaying(!App.playing);
  const evTimes = () => E.eventsOf(App.match, activeScenario())
    .filter(e => ["goal", "yellow", "save", "kickoff", "halftime"].includes(e.type)).map(e => e.t);
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
  const checkCrossings = (t0, t1) => {
    if (t1 - t0 <= 0 || t1 - t0 > App.speed * 0.6 + 2) return;
    const sc = activeScenario();
    for (const ev of E.eventsOf(App.match, sc)) {
      if (ev.t > t0 && ev.t <= t1) {
        if (ev.type === "goal") toast(`GOAL ${ev.min || ""} ${ev.label.replace(/^GOAL(〔SIM〕)? /, "")}`, ev.sim ? GOLD : seriesColor(ev.team, true));
        else if (ev.type === "yellow") toast(`警告 ${ev.min || ""} ${ev.label.replace("警告 ", "")}`, "#FFC61A");
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
    $("#infoBody").innerHTML = `
      <h4>${m.meta.competition} ${m.meta.stage}</h4>
      <div style="color:var(--muted)">${m.meta.date} ${m.meta.kickoffLocal || ""} · ${m.meta.venue} · 観衆 ${m.meta.attendance.toLocaleString()}名 · 主審 ${m.meta.referee}</div>
      <div style="font-size:21px;font-weight:300;margin:8px 0;letter-spacing:.04em">${m.teams[a].name} ${m.meta.score[a]} – ${m.meta.score[b]} ${m.teams[b].name}</div>
      ${m.meta.motm ? `<div class="chip warn">MOM ${m.teams[m.meta.motm.team].squad.find(p => p.no === m.meta.motm.no).ja}</div>` : ""}
      <h4>スタメン（FIFA公式記録）</h4>
      <div><b style="color:${seriesColor(a, true)}">${m.teams[a].name}</b>（${m.teams[a].phases[0].shape} / ${m.teams[a].coach}）</div>
      <div style="margin:4px 0 8px">${xiRows(a)}</div>
      <div><b style="color:${seriesColor(b, true)}">${m.teams[b].name}</b>（${m.teams[b].phases[0].shape} / ${m.teams[b].coach}）</div>
      <div style="margin:4px 0 8px">${xiRows(b)}</div>
      <h4>スタッツ（実測）</h4>
      <table class="stat-table">${(m.stats || []).map(s => `<tr><td class="a">${s[a] ?? s.BRA}</td><td class="k">${s.key}</td><td class="b">${s[b] ?? s.JPN}</td></tr>`).join("")}</table>
      <h4>イベント（クリックでジャンプ）</h4>
      ${m.events.filter(e => e.label && e.type !== "kickoff").map(e =>
        `<div style="cursor:pointer;padding:2px 0" data-jump="${e.t}"><span class="mono" style="color:var(--muted)">${e.min || E.clockAt(m, e.t).disp}</span> ${e.label}</div>`).join("")}
      <h4>データ出典</h4>
      <div style="color:var(--muted);font-size:11.5px">背番号・XI・交代・警告・得点・スタッツ: FIFA公式記録（Tactical Line-up / Match Report）・Wikipedia・ESPN照合（2026-07-03検証）。
      選手座標・能力値は実スタッツ（支配率69/31, xG2.07/0.33）と実況記述に整合するよう較正した決定論モデル。${m.meta.note || ""}</div>`;
    $("#infoBody").querySelectorAll("[data-jump]").forEach(d => d.onclick = () => {
      App.t = +d.dataset.jump - 8;
      $("#modalInfo").classList.remove("open");
    });
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
      <h4>ポゼッション・チェーン</h4>
      ボールは<b>保持チームの選手の足元</b>に付きます。保持者列（ホールド→パス→奪取）を実測支配率69/31と
      整合するよう決定論生成し、金色リングが現在の保持者を示します。交代・布陣変更でチェーンも再構成されます。
      <h4>結果再構成（What-if Outcome）</h4>
      交代・布陣は<b>試合結果そのもの</b>を変えます:
      (1) 得点者/アシスト者がピッチ外なら実ゴールは消滅
      (2) 直前の攻撃危険度が実試合比55%未満に落ちても消滅
      (3) 危険度増分の積分から決定論ポアソンで追加ゴールが発生。
      すべて乱数なし — 同じシナリオは常に同じ結末です。
      <h4>ムーブメント・エンジン</h4>
      位置は<b>純関数 f(t)</b> — 帯域制限ノイズ＋攻守モーフ＋イベントアンカー＋チェーン調整の合成で、
      どの時刻へスクラブしても完全に同一の世界を返します。速度上限（≤9.9m/s）は各項の周波数×振幅と
      lerpブレンドで<b>構成的に保証</b>。
      <h4>交代 — ロジック不可侵</h4>
      FIFA規則（5人・3窓・HT非カウント・再入場禁止・GK同士・常時11人）は<b>バリデータ層</b>が強制。
      AI提案も布陣エディタも手動編集もこの層を必ず通過します。
      <h4>検証</h4>
      Node.js テスト（背番号・XI・交代・時計・速度上限・決定論・規則・単調性・結果再構成）全通過。
      チャート配色はCVD分離で機械検証済み。`;
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
    setMatch(R.data.MATCH);
    $("#modalCustom").classList.remove("open");
    toast("日本×ブラジル戦（実データ）に戻しました", "#7FA6FF");
  };

  const setMatch = (m) => {
    App.match = m;
    App.scenario = null; App.scenarios = [];
    App.t = 0; App.selected = null; App.pickOut = null; App.pickIn = null;
    App.editorSel = null; App.editorDrag = null;
    App.lastIx = null; App.lastField = null; App.lastZone = null;
    App.zoneView = "BOTH";
    E.clearCaches(); D.clearCaches(); curveStore.clear();
    renderer.setMatch(m);
    App.rosterTab = teamOrder()[1] || teamOrder()[0];
    buildStatic();
    updateSubSlots();
    $("#inspector").classList.remove("open");
    ensureCurveFor(E.actualScenario(m), { includeGK: false }, () => {});
  };

  /* ------------------------------ 3D操作 ------------------------------ */
  $("#gl").addEventListener("click", (e) => {
    const st = E.stateAt(App.match, activeScenario(), App.t);
    const r = renderer.pick(e.clientX, e.clientY, st);
    if (r.moved > 6) return;
    if (r.hit) selectPlayer(r.hit.team, r.hit.no);
  });
  document.querySelectorAll("#viewbar .cam").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#viewbar .cam").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      renderer.setPreset(b.dataset.cam);
    };
  });
  const FIELD_MODES = [["particles", "粒子"], ["surface", "面"], ["off", "OFF"]];
  const cycleFieldMode = () => {
    const i = FIELD_MODES.findIndex(m => m[0] === App.options.fieldMode);
    const next = FIELD_MODES[(i + 1) % FIELD_MODES.length];
    App.options.fieldMode = next[0];
    $("#fieldModeLbl").textContent = next[1];
    $("#togField").classList.toggle("on", next[0] !== "off");
  };
  $("#togField").onclick = cycleFieldMode;
  const bindTog = (id, key) => {
    $(id).onclick = () => {
      App.options[key] = !App.options[key];
      $(id).classList.toggle("on", App.options[key]);
    };
  };
  bindTog("#togZones", "zones");
  bindTog("#togTrail", "trails");
  bindTog("#togLabel", "labels");
  const setGK = (inc) => {
    App.options.includeGK = inc;
    $("#gk20").classList.toggle("on", !inc);
    $("#gk22").classList.toggle("on", inc);
    ensureCurveFor(E.actualScenario(App.match), { includeGK: inc }, () => {});
    if (isSim()) ensureCurveFor(App.scenario, { includeGK: inc }, () => {});
  };
  $("#gk20").onclick = () => setGK(false);
  $("#gk22").onclick = () => setGK(true);
  $("#toggleL").onclick = () => $("#dockL").classList.toggle("shown");
  $("#toggleR").onclick = () => $("#dockR").classList.toggle("shown");

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
    if (e.code === "Space") { e.preventDefault(); setPlaying(!App.playing); }
    else if (e.code === "ArrowRight") App.t = Math.min(App.t + 15, E.playedRange(App.match).t1);
    else if (e.code === "ArrowLeft") App.t = Math.max(App.t - 15, 0);
    else if (e.code === "KeyH") cycleFieldMode();
    else if (e.code === "KeyZ") $("#togZones").click();
    else if (e.code === "KeyT") $("#togTrail").click();
    else if (e.code === "KeyL") $("#togLabel").click();
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
  let frameCount = 0;
  const loop = (now) => {
    const dt = Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    const range = E.playedRange(App.match);
    const t0 = App.t;
    if (App.playing) {
      App.t = Math.min(App.t + dt * App.speed, range.t1);
      if (App.t >= range.t1) setPlaying(false);
      checkCrossings(t0, App.t);
    }

    const sc = activeScenario();
    const state = E.stateAt(App.match, sc, App.t);

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
      $("#halfLbl").textContent = state.half === 1 ? "前半" : "後半";
      // 累積支配率（ポゼッション・チェーン）
      const poss = E.possessionStats(App.match, sc, App.t);
      const pa = Math.round((poss[a] || 0.5) * 100);
      $("#possA").style.width = pa + "%";
      $("#possAv").textContent = pa;
      $("#possBv").textContent = 100 - pa;
      // 現在の保持者
      const cr = state.carrier;
      if (cr && cr.mode === "hold") {
        const p = App.match.teams[cr.team].squad.find(q => q.no === cr.no);
        $("#carrierChip").textContent = `保持 ${App.match.teams[cr.team].name} ${cr.no} ${p?.label ?? ""}`;
      } else if (cr && cr.mode === "flight") {
        $("#carrierChip").textContent = "パス進行中";
      } else {
        $("#carrierChip").textContent = "";
      }
      updateInspector();
      const min = Math.floor(App.t / 30);
      if (min !== lastRosterMin) { lastRosterMin = min; buildRoster(); }
    }

    // 3D シーン
    const contribMap = new Map();
    if (App.lastIx) {
      for (const k of teamOrder()) for (const c of App.lastIx[k].contrib) contribMap.set(k + c.no, c.val);
    }
    let ballTrail = null, playerTrail = null;
    if (App.options.trails) {
      ballTrail = [];
      for (let i = 16; i >= 1; i--) ballTrail.push(E.ballAt(App.match, sc, Math.max(0, App.t - i * 0.42)));
      if (App.selected) {
        const pr = E.presenceOf(App.match, sc, App.selected.team, App.selected.no);
        if (pr && App.t > pr.from && App.t <= pr.to) {
          playerTrail = [];
          for (let i = 12; i >= 1; i--) {
            const tt = Math.max(pr.from + 0.1, App.t - i * 0.55);
            playerTrail.push(E.stateFrozenPos(App.match, sc, App.selected.team, App.selected.no, tt));
          }
          const col = seriesColor(App.selected.team, true);
          const v = parseInt(col.slice(1), 16);
          playerTrail.color = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
        }
      }
    }
    renderer.frame(now / 1000, dt, {
      state,
      field: App.options.fieldMode !== "off" ? App.lastField : null,
      zone: App.options.zones ? App.lastZone : null,
      zoneView: App.zoneView,
      options: App.options,
      selected: App.selected,
      hover: App.hover,
      contribMap, ballTrail, playerTrail,
    });
    drawTimeline();
    if (++frameCount < maxFrames) requestAnimationFrame(loop);
  };

  /* boot */
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
