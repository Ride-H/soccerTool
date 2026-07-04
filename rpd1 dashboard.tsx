import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play, Pause, SkipBack, AlertTriangle, FileDown, ClipboardList,
  ArrowRightLeft, Shield, Crosshair, Wifi, Timer, X, ChevronRight,
} from "lucide-react";

/* =========================================================================
   RPD-1 v2 : Real-time Pitch Debugger — ハーフタイム・レビュー
   日本 vs ブラジル（想定シナリオ）前半 0:00–47:00 のトラッキングデータを
   タイムラインで再生・スクラブし、危険度（自陣ゴール前重み付け）を解析。
   ※ 招集・背番号・シナリオはサンプルデータです（先頭の定数で編集可）。
   ========================================================================= */

/* ------------------------------ design tokens --------------------------- */
const C = {
  bg: "#0F1626", panel: "#151F36", panel2: "#111A2E", line: "#27385C",
  text: "#EAF0FA", muted: "#8FA2C4", faint: "#5D6E8F",
  jpn: "#1E44C8", jpnDeep: "#0E2570", jpnEdge: "#0A1C57",
  bra: "#FFC61A", braGreen: "#12833F", braDeep: "#0A5C2E",
  ok: "#58C08A", warn: "#FFB020", crit: "#FF4E42", critDeep: "#C81E2E",
  pitchA: "#1D5C3A", pitchB: "#185233", chalk: "rgba(255,255,255,0.55)",
};
const JP_FONT = "'Hiragino Sans','Yu Gothic UI','Noto Sans JP',system-ui,sans-serif";
const NUM = { fontVariantNumeric: "tabular-nums", fontFeatureSettings: "'tnum'" };

/* ------------------------------ 定数（モデル） --------------------------- */
const PITCH_W = 105, PITCH_H = 68, HALF_END = 2820;      // 47:00（AT+2）
const THRESH = 15, K = 5, MARGIN = 9;
const W = { di: 0.30, leak: 0.30, gt: 0.40 };            // SER v2 重み
const WARN_AT = 0.45, CRIT_AT = 0.75, SUSTAIN = 5;       // 閾値 / 継続秒
const ZONE_L = { x: 8, y: 0, w: 20, h: 15, label: "左サイド警戒" };
const ZONE_PA = { x: 0, y: 13.85, w: 16.5, h: 40.3, label: "自陣PA" };
const ZONE_VT = { x: 16.5, y: 22, w: 13.5, h: 24, label: "バイタル" };
const GOAL = { x: 0, y: 34 };
const GOAL_T = 2412;                                      // 40:12 失点（シナリオ）
const DEFAULT_KEY = 109;                                  // エンドリック

/* ------------------------------ スカッド ---------------------------------
   id: 日本=背番号 / ブラジル=100+背番号。pose: [安定x,y] / [崩壊x,y]        */
const JAPAN_XI = [
  { id: 1,  num: 1,  name: "鈴木彩艶",   role: "GK", st: [6, 34],  co: [7, 32] },
  { id: 2,  num: 2,  name: "菅原由勢",   role: "RB", st: [24, 58], co: [40, 42] },
  { id: 4,  num: 4,  name: "板倉滉",     role: "CB", st: [20, 44], co: [38, 35] },
  { id: 3,  num: 3,  name: "町田浩樹",   role: "CB", st: [20, 26], co: [30, 30] },
  { id: 26, num: 26, name: "伊藤洋輝",   role: "LB", st: [24, 10], co: [34, 27] },
  { id: 6,  num: 6,  name: "遠藤航",     role: "DM", st: [34, 38], co: [31, 31] },
  { id: 13, num: 13, name: "守田英正",   role: "CM", st: [38, 30], co: [35, 32] },
  { id: 14, num: 14, name: "伊東純也",   role: "RW", st: [54, 56], co: [48, 40] },
  { id: 10, num: 10, name: "久保建英",   role: "AM", st: [50, 34], co: [34, 37] },
  { id: 7,  num: 7,  name: "三笘薫",     role: "LW", st: [52, 16], co: [44, 26] },
  { id: 9,  num: 9,  name: "上田綺世",   role: "CF", st: [62, 34], co: [56, 33] },
];
const JAPAN_BENCH = [
  { num: 12, name: "大迫敬介", role: "GK" },
  { num: 23, name: "谷晃生",   role: "GK" },
  { num: 5,  name: "長友佑都", role: "LB",    left: 0.97, central: 0.30, def: 0.88 },
  { num: 16, name: "冨安健洋", role: "CB/RB", left: 0.45, central: 0.85, def: 0.92 },
  { num: 20, name: "高井幸大", role: "CB",    left: 0.30, central: 0.82, def: 0.88 },
  { num: 17, name: "田中碧",   role: "CM",    left: 0.40, central: 0.80, def: 0.62 },
  { num: 8,  name: "旗手怜央", role: "CM/LB", left: 0.74, central: 0.62, def: 0.55 },
  { num: 11, name: "堂安律",   role: "RW/AM", left: 0.15, central: 0.50, def: 0.40 },
  { num: 15, name: "中村敬斗", role: "LW",    left: 0.70, central: 0.35, def: 0.35 },
  { num: 18, name: "南野拓実", role: "AM",    left: 0.35, central: 0.55, def: 0.38 },
  { num: 19, name: "前田大然", role: "CF/LW", left: 0.60, central: 0.30, def: 0.45 },
  { num: 21, name: "細谷真大", role: "CF",    left: 0.20, central: 0.45, def: 0.35 },
];
const BRA_XI = [
  { id: 101, num: 1,  name: "アリソン",             role: "GK", st: [100, 34], co: [98, 34] },
  { id: 102, num: 2,  name: "ダニーロ",             role: "RB", st: [78, 12],  co: [22, 9] },
  { id: 103, num: 3,  name: "マルキーニョス",       role: "CB", st: [82, 28],  co: [64, 30] },
  { id: 104, num: 4,  name: "ガブリエウ",           role: "CB", st: [82, 40],  co: [70, 42] },
  { id: 106, num: 6,  name: "ウェンデウ",           role: "LB", st: [78, 56],  co: [64, 50] },
  { id: 105, num: 5,  name: "カゼミーロ",           role: "DM", st: [64, 36],  co: [50, 32] },
  { id: 108, num: 8,  name: "B・ギマランイス",      role: "CM", st: [60, 26],  co: [30, 18] },
  { id: 110, num: 10, name: "ロドリゴ",             role: "AM", st: [56, 38],  co: [16, 22] },
  { id: 111, num: 11, name: "ハフィーニャ",         role: "RW", st: [48, 14],  co: [12, 7] },
  { id: 107, num: 7,  name: "ヴィニシウス",         role: "LW", st: [46, 52],  co: [30, 44] },
  { id: 109, num: 9,  name: "エンドリック",         role: "CF", st: [42, 34],  co: [30, 32] },
];
const BRA_BENCH = [
  { num: 12, name: "ベント",               role: "GK" },
  { num: 23, name: "エデルソン",           role: "GK" },
  { num: 13, name: "E・ミリトン",          role: "CB" },
  { num: 14, name: "ヴァンデルソン",       role: "RB" },
  { num: 16, name: "D・サントス",          role: "LB" },
  { num: 15, name: "アンドレ",             role: "DM" },
  { num: 17, name: "パケタ",               role: "CM/AM" },
  { num: 18, name: "マルティネッリ",       role: "LW" },
  { num: 21, name: "サヴィーニョ",         role: "RW" },
  { num: 19, name: "M・クーニャ",          role: "CF" },
];

/* --------------------- 前半シナリオ（キーポイント補間） -------------------
   [秒, fC(中央吸い寄せ), fL(左サイド過負荷)]                                */
const KP = [
  [0, .04, .03], [540, .05, .04],
  [630, .15, .42], [750, .12, .30], [870, .08, .08],
  [1260, .10, .10],
  [1410, .50, .60], [1560, .46, .55],
  [1680, .20, .18], [2040, .34, .40],
  [2220, .64, .86], [2310, .76, 1.0], [2460, .78, 1.0],
  [2550, .46, .56], [2700, .40, .48], [2820, .50, .60],
];

/* ------------------------------ 数理 ------------------------------------ */
const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const lerp = (a, b, f) => a + (b - a) * f;
const ease = (x) => x * x * (3 - 2 * x);
const fmtClock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function phaseAt(t) {
  if (t <= KP[0][0]) return { fC: KP[0][1], fL: KP[0][2] };
  for (let i = 0; i < KP.length - 1; i++) {
    const a = KP[i], b = KP[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const u = ease((t - a[0]) / ((b[0] - a[0]) || 1));
      return { fC: lerp(a[1], b[1], u), fL: lerp(a[2], b[2], u) };
    }
  }
  const l = KP[KP.length - 1];
  return { fC: l[1], fL: l[2] };
}
function buildPlayers(t, jitter = 0) {
  const { fC, fL } = phaseAt(t);
  const g = clamp(0.5 * fC + 0.6 * fL);       // 日本の崩壊ブレンド
  const b = clamp(0.15 * fC + 0.95 * fL);     // ブラジルの過負荷ブレンド
  const mk = (list, team, f) => list.map((p) => ({
    ...p, team,
    x: lerp(p.st[0], p.co[0], f) + (jitter ? Math.sin(t * 1.3 + p.id) * jitter : 0),
    y: lerp(p.st[1], p.co[1], f) + (jitter ? Math.cos(t * 1.1 + p.id) * jitter : 0),
  }));
  return { players: [...mk(JAPAN_XI, "JPN", g), ...mk(BRA_XI, "BRA", b)], fC, fL };
}
function goalWeight(x, y) {
  let w = Math.pow(clamp(1 - dist(x, y, GOAL.x, GOAL.y) / 55), 1.6);
  if (x <= 16.5 && y >= 13.85 && y <= 54.15) w *= 1.5;   // PA
  if (x <= 5.5 && y >= 24.9 && y <= 43.1) w *= 1.6;      // ゴールマウス
  return w;
}
function ctrlAt(cx, cy, jp, br) {
  let dj = 1e9, db = 1e9;
  for (const p of jp) { const d = dist(cx, cy, p.x, p.y); if (d < dj) dj = d; }
  for (const p of br) { const d = dist(cx, cy, p.x, p.y); if (d < db) db = d; }
  return clamp(0.5 + (dj - db) / (2 * MARGIN));
}
function zoneCtrl(z, jp, br, gx = 8, gy = 6) {
  let acc = 0;
  for (let i = 0; i < gx; i++) for (let j = 0; j < gy; j++)
    acc += ctrlAt(z.x + (i + 0.5) * z.w / gx, z.y + (j + 0.5) * z.h / gy, jp, br);
  return acc / (gx * gy);
}
function computeMetrics(players, keyId, res = "hi") {
  const jp = players.filter((p) => p.team === "JPN" && p.role !== "GK"); // 空間支配はGK除外
  const br = players.filter((p) => p.team === "BRA");
  const key = br.find((p) => p.id === keyId) || br[br.length - 1];
  const ds = jp.map((p) => dist(p.x, p.y, key.x, key.y)).sort((a, b) => a - b).slice(0, K);
  const di = clamp(1 - ds.reduce((s, d) => s + d, 0) / ds.length / THRESH);
  const [zx, zy] = res === "hi" ? [12, 9] : [8, 6];
  const leak = zoneCtrl(ZONE_L, jp, br, zx, zy);
  const [nx, ny] = res === "hi" ? [14, 10] : [10, 7];
  let num = 0, den = 0;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const cx = (i + 0.5) * 52.5 / nx, cy = (j + 0.5) * 68 / ny;
    const w = goalWeight(cx, cy);
    num += ctrlAt(cx, cy, jp, br) * w; den += w;
  }
  const gt = num / den;
  const ser = clamp(di * W.di + leak * W.leak + gt * W.gt);
  const status = ser >= CRIT_AT ? "CRITICAL" : ser >= WARN_AT ? "WARNING" : "OK";
  return { di, leak, gt, ser, status, key };
}
function heatCells(players, nx = 14, ny = 10) {
  const jp = players.filter((p) => p.team === "JPN" && p.role !== "GK");
  const br = players.filter((p) => p.team === "BRA");
  let wMax = 0; const cells = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const cx = (i + 0.5) * 52.5 / nx, cy = (j + 0.5) * 68 / ny;
    const w = goalWeight(cx, cy); if (w > wMax) wMax = w;
    cells.push({ cx, cy, w, c: ctrlAt(cx, cy, jp, br) });
  }
  // 表示強度: 支配 ×（ゴール距離重みで増幅）→ センターより自陣ゴール前が強調される
  for (const cl of cells) cl.v = cl.c * (0.30 + 0.70 * (cl.w / wMax));
  return { cells, cw: 52.5 / nx, ch: 68 / ny };
}
function rankPatch(m) {
  const loc = m.leak * 0.6 + m.gt * 0.4;
  const s = (loc + m.di) || 1, lw = loc / s, cw = m.di / s;
  return {
    lw, cw,
    list: JAPAN_BENCH.filter((b) => b.role !== "GK")
      .map((b) => ({ ...b, score: (b.left * lw + b.central * cw) * (0.5 + 0.5 * b.def) }))
      .sort((a, b) => b.score - a.score),
  };
}
const concedeProb = (se) => Math.round(clamp(se * se * 1.2, 0, 0.97) * 100);
function dangerColor(v) {
  if (v < 0.4) return C.warn;
  if (v < 0.7) return C.crit;
  return C.critDeep;
}
const statusColor = (s) => (s === "CRITICAL" ? C.crit : s === "WARNING" ? C.warn : C.ok);

/* ------------------------------ 小物 ------------------------------------ */
function Meter({ label, value, color, ticks }) {
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
        <span style={{ ...NUM, fontSize: 13, fontWeight: 800, color }}>{Math.round(value * 100)}%</span>
      </div>
      <div style={{ position: "relative", height: 7, background: "#0B1322", borderRadius: 4, marginTop: 3, overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, width: `${clamp(value) * 100}%`, background: color, borderRadius: 4, transition: "width .15s linear" }} />
        {(ticks || []).map((t) => (
          <div key={t} style={{ position: "absolute", top: 0, bottom: 0, left: `${t * 100}%`, width: 1, background: "rgba(255,255,255,.4)" }} />
        ))}
      </div>
    </div>
  );
}
function TeamBadge({ side }) {
  const jpn = side === "JPN";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
      background: jpn ? `linear-gradient(135deg, ${C.jpnDeep}, ${C.jpn})` : `linear-gradient(135deg, #E8B200, ${C.bra})`,
      color: jpn ? "#fff" : "#12300F", minWidth: 0,
    }}>
      <div style={{ width: 10, height: 34, background: jpn ? "#fff" : C.braGreen, borderRadius: 2, flexShrink: 0 }} />
      <div style={{ lineHeight: 1.05, minWidth: 0 }}>
        <div style={{ fontWeight: 900, fontSize: 20, fontStyle: "italic", letterSpacing: 1 }}>{jpn ? "JPN" : "BRA"}</div>
        <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.9, whiteSpace: "nowrap" }}>{jpn ? "日本" : "ブラジル"}</div>
      </div>
    </div>
  );
}

/* ================================ 本体 =================================== */
export default function RPD1HalftimeReview() {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(20);
  const [keyId, setKeyId] = useState(DEFAULT_KEY);
  const [benchTab, setBenchTab] = useState("JPN");
  const [alertOpen, setAlertOpen] = useState(false);
  const [htOpen, setHtOpen] = useState(false);
  const [patched, setPatched] = useState(false);
  const seenWin = useRef(new Set());
  const htShown = useRef(false);
  const prevT = useRef(0);
  const tRef = useRef(0); tRef.current = t;

  /* ---- 前半カーブの事前計算（3秒刻み・低解像度） ---- */
  const curve = useMemo(() => {
    const pts = [];
    for (let s = 0; s <= HALF_END; s += 3) {
      const { players } = buildPlayers(s);
      const m = computeMetrics(players, keyId, "lo");
      pts.push({ t: s, ser: m.ser, gt: m.gt, status: m.status });
    }
    return pts;
  }, [keyId]);

  /* ---- CRITICAL 窓（5秒以上継続）とイベント ---- */
  const { windows, events } = useMemo(() => {
    const wins = []; let cs = null;
    for (const p of curve) {
      if (p.status === "CRITICAL") { if (cs == null) cs = p.t; }
      else if (cs != null) { if (p.t - cs >= SUSTAIN) wins.push({ id: cs, a: cs + SUSTAIN, b: p.t }); cs = null; }
    }
    if (cs != null && HALF_END - cs >= SUSTAIN) wins.push({ id: cs, a: cs + SUSTAIN, b: HALF_END });
    const evs = [{ t: 0, label: "キックオフ", lv: "info" }];
    let prev = "OK";
    for (const p of curve) {
      if (p.status !== prev) {
        if (p.status !== "OK") evs.push({ t: p.t, label: p.status === "CRITICAL" ? "CRITICAL_ERROR 突入" : "WARNING 検知", lv: p.status.toLowerCase() });
        else evs.push({ t: p.t, label: "収束（OK）", lv: "ok" });
        prev = p.status;
      }
    }
    evs.push({ t: GOAL_T, label: "失点 0-1 ハフィーニャ（左サイド突破）", lv: "goal" });
    evs.push({ t: HALF_END, label: "前半終了", lv: "info" });
    return { windows: wins, events: evs.sort((a, b) => a.t - b.t) };
  }, [curve]);

  /* ---- 再生ループ ---- */
  useEffect(() => {
    if (!playing) return;
    let raf, last = performance.now();
    const loop = (now) => {
      const dt = (now - last) / 1000; last = now;
      setT((old) => {
        const nt = Math.min(old + dt * speed, HALF_END);
        if (nt >= HALF_END && !htShown.current) { htShown.current = true; setPlaying(false); setHtOpen(true); }
        return nt;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  /* ---- CRITICAL 窓に前進突入 → 割り込み通知 ---- */
  useEffect(() => {
    const a = prevT.current, b = t; prevT.current = t;
    if (b <= a) return;
    for (const w of windows) {
      if (a < w.a && b >= w.a && !seenWin.current.has(w.id)) {
        seenWin.current.add(w.id); setAlertOpen(true);
      }
    }
  }, [t, windows]);

  /* ---- キーボード ---- */
  useEffect(() => {
    const h = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      if (e.code === "Space") { e.preventDefault(); setPlaying((p) => !p); }
      if (e.code === "ArrowRight") setT((v) => Math.min(v + 30, HALF_END));
      if (e.code === "ArrowLeft") setT((v) => Math.max(v - 30, 0));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* ---- 現在フレーム ---- */
  const frame = useMemo(() => {
    const { players } = buildPlayers(t, 0.3);
    const m = computeMetrics(players, keyId, "hi");
    const heat = heatCells(players);
    const jp = players.filter((p) => p.team === "JPN" && p.role !== "GK");
    const br = players.filter((p) => p.team === "BRA");
    const zones = {
      pa: zoneCtrl(ZONE_PA, jp, br), vt: zoneCtrl(ZONE_VT, jp, br), lw: m.leak,
    };
    const key = m.key;
    const ball = t >= GOAL_T - 14 && t <= GOAL_T + 6
      ? { x: lerp(14, 1, clamp((t - (GOAL_T - 14)) / 14)), y: lerp(9, 31, clamp((t - (GOAL_T - 14)) / 14)) }
      : { x: lerp(52, key.x, 0.4 + 0.5 * phaseAt(t).fL), y: lerp(34, key.y, 0.4 + 0.5 * phaseAt(t).fL) };
    return { players, m, heat, zones, ball, key };
  }, [t, keyId]);

  const { m } = frame;
  const inWindow = windows.some((w) => t >= w.a && t <= w.b);
  const score = t >= GOAL_T ? 1 : 0;
  const sc = statusColor(m.status);
  const ranking = useMemo(() => rankPatch(computeMetrics(buildPlayers(2400).players, keyId, "lo")), [keyId]);
  const top = ranking.list[0];
  const visibleEvents = events.filter((e) => e.t <= t).slice(-7).reverse();

  /* ---- リンクメッシュ（味方 3近傍） ---- */
  const mesh = useMemo(() => {
    const jp = frame.players.filter((p) => p.team === "JPN" && p.role !== "GK");
    const seen = new Set(), edges = [];
    for (const a of jp) {
      jp.filter((b) => b.id !== a.id)
        .map((b) => ({ b, d: dist(a.x, a.y, b.x, b.y) }))
        .sort((u, v) => u.d - v.d).slice(0, 3)
        .forEach(({ b, d }) => {
          const k = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
          if (!seen.has(k)) { seen.add(k); edges.push({ a, b, d }); }
        });
    }
    return edges;
  }, [frame]);

  /* ---- スクラブ ---- */
  const tlRef = useRef(null);
  const seekFromEvent = (e) => {
    const el = tlRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setT(clamp((e.clientX - r.left) / r.width) * HALF_END);
  };

  const exportJson = () => {
    const data = { match: "JPN vs BRA (simulated 1st half)", model: { W, WARN_AT, CRIT_AT, MARGIN, THRESH, K }, curve, events, squads: { JAPAN_XI, JAPAN_BENCH, BRA_XI, BRA_BENCH } };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "rpd1_first_half.json"; a.click();
    URL.revokeObjectURL(url);
  };

  const fy = (y) => PITCH_H - y;

  /* ======================================================================= */
  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: JP_FONT }}>
      <style>{`
        @keyframes pulseK {0%{transform:scale(1);opacity:.8}70%{transform:scale(2.1);opacity:0}100%{opacity:0}}
        @keyframes rise {from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        button:focus-visible, select:focus-visible {outline:2px solid ${C.bra}; outline-offset:2px}
        .rowbtn{border:1px solid ${C.line};background:${C.panel2};color:${C.text};border-radius:8px;padding:7px 11px;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
        .rowbtn:hover{border-color:${C.bra}}
        select.rpd{background:${C.panel2};border:1px solid ${C.line};color:${C.text};border-radius:8px;padding:6px 8px;font-size:12px}
        @media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
      `}</style>

      {/* ============ スコアボード・ヘッダー ============ */}
      <header style={{ borderBottom: `1px solid ${C.line}` }}>
        <div style={{ display: "flex", alignItems: "stretch" }}>
          <TeamBadge side="JPN" />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "6px 8px", background: C.panel, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ ...NUM, fontSize: 30, fontWeight: 900, fontStyle: "italic" }}>0</span>
              <span style={{ color: C.faint, fontWeight: 800 }}>–</span>
              <span style={{ ...NUM, fontSize: 30, fontWeight: 900, fontStyle: "italic", color: score ? C.bra : C.text }}>{score}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: C.muted }}>
              <Timer size={12} />
              <span style={{ ...NUM, fontWeight: 800, color: C.text }}>{fmtClock(t)}</span>
              <span>前半</span>
              <span style={{ padding: "1px 6px", borderRadius: 4, background: "#0B1322", border: `1px solid ${C.line}`, fontSize: 10 }}>想定シナリオ</span>
            </div>
          </div>
          <TeamBadge side="BRA" />
        </div>
        {/* ステータス帯 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 14px", background: m.status === "OK" ? C.panel2 : `${sc}18`, borderTop: `1px solid ${C.line}` }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, background: sc, boxShadow: `0 0 8px ${sc}` }} />
          <span style={{ fontWeight: 800, fontSize: 12.5, color: sc }}>
            {m.status === "OK" ? "SYSTEM NOMINAL — 構造安定" : m.status === "WARNING" ? "WARNING — 空間モジュール劣化" : "CRITICAL_ERROR — 構造崩壊"}
          </span>
          <span style={{ ...NUM, marginLeft: "auto", fontSize: 12, color: C.muted }}>
            SER <b style={{ color: sc }}>{Math.round(m.ser * 100)}%</b>
          </span>
          {patched && <span style={{ fontSize: 11, color: C.ok, fontWeight: 700 }}>後半修正: 長友 IN 適用済</span>}
        </div>
      </header>

      {/* ============ ツールバー ============ */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "10px 14px", borderBottom: `1px solid ${C.line}`, background: C.panel }}>
        <button className="rowbtn" onClick={() => setPlaying((p) => !p)} aria-label="再生/一時停止">
          {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "一時停止" : "再生"}
        </button>
        <button className="rowbtn" onClick={() => { setT(0); seenWin.current.clear(); htShown.current = false; setPatched(false); }}>
          <SkipBack size={14} />先頭へ
        </button>
        <div style={{ display: "flex", border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
          {[1, 8, 20, 60].map((s) => (
            <button key={s} onClick={() => setSpeed(s)} style={{ border: "none", cursor: "pointer", padding: "7px 10px", fontSize: 12, fontWeight: 800, background: speed === s ? C.bra : "transparent", color: speed === s ? "#12300F" : C.muted }}>
              ×{s}
            </button>
          ))}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted }}>
          <Crosshair size={13} />KEY
          <select className="rpd" value={keyId} onChange={(e) => setKeyId(+e.target.value)}>
            {BRA_XI.filter((p) => p.role !== "GK").map((p) => (
              <option key={p.id} value={p.id}>{p.name}（{p.role}）</option>
            ))}
          </select>
        </label>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="rowbtn" onClick={() => setHtOpen(true)}><ClipboardList size={14} />HTレポート</button>
          <button className="rowbtn" onClick={exportJson}><FileDown size={14} />JSON</button>
        </div>
      </div>

      {/* ============ メイン ============ */}
      <div style={{ display: "flex", flexWrap: "wrap" }}>
        {/* ---------- ピッチ（作戦盤） ---------- */}
        <div style={{ flex: "1 1 560px", padding: 12, minWidth: 0 }}>
          <div style={{ position: "relative", border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 10px 30px rgba(0,0,0,.35)" }}>
            <svg viewBox="-3.5 -3.5 112 75" style={{ display: "block", width: "100%", background: C.pitchB }}>
              {/* 芝目 */}
              {Array.from({ length: 8 }).map((_, i) => (
                <rect key={i} x={(i * PITCH_W) / 8} y="0" width={PITCH_W / 8} height={PITCH_H} fill={i % 2 ? C.pitchA : C.pitchB} />
              ))}
              {/* 危険ヒート（自陣半分・ゴール距離で増幅） */}
              {frame.heat.cells.map((cl, i) => cl.v > 0.06 && (
                <rect key={i} x={cl.cx - frame.heat.cw / 2} y={fy(cl.cy) - frame.heat.ch / 2}
                  width={frame.heat.cw} height={frame.heat.ch}
                  fill={dangerColor(cl.v)} opacity={0.12 + 0.5 * cl.v} rx="0.5" />
              ))}
              {/* ピッチライン（チョーク） */}
              <g stroke={C.chalk} strokeWidth="0.35" fill="none">
                <rect x="0" y="0" width={PITCH_W} height={PITCH_H} />
                <line x1={PITCH_W / 2} y1="0" x2={PITCH_W / 2} y2={PITCH_H} />
                <circle cx={PITCH_W / 2} cy={PITCH_H / 2} r="9.15" />
                <rect x="0" y={fy(54.15)} width="16.5" height="40.3" />
                <rect x="0" y={fy(43.1)} width="5.5" height="18.2" />
                <rect x={PITCH_W - 16.5} y={fy(54.15)} width="16.5" height="40.3" />
                <rect x={PITCH_W - 5.5} y={fy(43.1)} width="5.5" height="18.2" />
                <rect x="-1.6" y={fy(37.66)} width="1.6" height="7.32" fill="rgba(255,255,255,.25)" />
              </g>
              {/* ゴール前グロー（GTに連動） */}
              <ellipse cx="1" cy={fy(34)} rx={9 + 8 * m.gt} ry={12 + 9 * m.gt}
                fill={C.crit} opacity={0.08 + 0.4 * m.gt} />
              {/* 監視ゾーン */}
              <g fill="none" strokeDasharray="1.6 1.1" strokeWidth="0.4">
                <rect x={ZONE_L.x} y={fy(ZONE_L.y + ZONE_L.h)} width={ZONE_L.w} height={ZONE_L.h} stroke={dangerColor(frame.zones.lw)} />
                <rect x={ZONE_VT.x} y={fy(ZONE_VT.y + ZONE_VT.h)} width={ZONE_VT.w} height={ZONE_VT.h} stroke={dangerColor(frame.zones.vt)} opacity="0.9" />
              </g>
              <text x={ZONE_L.x + 0.5} y={fy(ZONE_L.y) - 1} fill="rgba(255,255,255,.8)" style={{ fontSize: 2.1, fontWeight: 700 }}>左サイド警戒 {Math.round(frame.zones.lw * 100)}%</text>
              <text x={ZONE_VT.x + 0.5} y={fy(ZONE_VT.y + ZONE_VT.h) - 0.8} fill="rgba(255,255,255,.7)" style={{ fontSize: 2.0 }}>バイタル {Math.round(frame.zones.vt * 100)}%</text>
              {/* リンク（白=適正 / 黄=過密・過疎） */}
              {mesh.map((e, i) => {
                const dense = e.d < 8, sparse = e.d > 20;
                return <line key={i} x1={e.a.x} y1={fy(e.a.y)} x2={e.b.x} y2={fy(e.b.y)}
                  stroke={dense || sparse ? C.warn : "rgba(255,255,255,.75)"}
                  strokeWidth={dense ? 0.5 + (8 - e.d) * 0.07 : sparse ? 0.2 : 0.34}
                  strokeDasharray={sparse ? "0.9 0.9" : "none"} opacity={sparse ? 0.55 : 0.85} />;
              })}
              {/* ブラジル（黄ディスク） */}
              {frame.players.filter((p) => p.team === "BRA").map((p) => (
                <g key={p.id}>
                  {p.id === keyId && (
                    <circle cx={p.x} cy={fy(p.y)} r="3" fill="none" stroke={C.crit} strokeWidth="0.4"
                      style={{ transformOrigin: `${p.x}px ${fy(p.y)}px`, animation: "pulseK 1.5s ease-out infinite" }} />
                  )}
                  <circle cx={p.x} cy={fy(p.y)} r="1.7" fill={C.bra} stroke={p.id === keyId ? C.crit : C.braDeep} strokeWidth="0.35" />
                  <text x={p.x} y={fy(p.y) + 0.75} textAnchor="middle" fill={C.braDeep} style={{ ...NUM, fontSize: 2, fontWeight: 800 }}>{p.num}</text>
                  {p.id === keyId && (
                    <text x={p.x} y={fy(p.y) - 2.6} textAnchor="middle" fill="#FFD9D5" style={{ fontSize: 2, fontWeight: 700 }}>{p.name}</text>
                  )}
                </g>
              ))}
              {/* 日本（青ディスク） */}
              {frame.players.filter((p) => p.team === "JPN").map((p) => (
                <g key={p.id}>
                  <circle cx={p.x} cy={fy(p.y)} r="1.7" fill={C.jpn} stroke={C.jpnEdge} strokeWidth="0.35" />
                  <text x={p.x} y={fy(p.y) + 0.75} textAnchor="middle" fill="#fff" style={{ ...NUM, fontSize: 2, fontWeight: 800 }}>{p.num}</text>
                </g>
              ))}
              {/* ボール */}
              <circle cx={frame.ball.x} cy={fy(frame.ball.y)} r="0.85" fill="#fff" stroke="#222" strokeWidth="0.18" />
            </svg>
            {/* 凡例 */}
            <div style={{ position: "absolute", left: 10, bottom: 8, display: "flex", gap: 10, padding: "4px 9px", background: "rgba(10,16,28,.72)", border: `1px solid ${C.line}`, borderRadius: 7, fontSize: 10.5, color: C.muted }}>
              <span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 99, background: C.jpn, marginRight: 4 }} />日本</span>
              <span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 99, background: C.bra, marginRight: 4 }} />ブラジル</span>
              <span style={{ color: "#fff" }}>— 適正距離</span>
              <span style={{ color: C.warn }}>— 過密/過疎</span>
              <span style={{ color: C.crit }}>■ 危険度（ゴール前ほど増幅）</span>
            </div>
          </div>
        </div>

        {/* ---------- 右レール ---------- */}
        <div style={{ flex: "1 1 300px", maxWidth: 420, padding: 12, display: "flex", flexDirection: "column", gap: 12, minWidth: 280 }}>
          {/* ゴール前危険度（ヘッドライン） */}
          <section style={{ border: `1px solid ${C.line}`, borderLeft: `4px solid ${dangerColor(m.gt)}`, borderRadius: 10, padding: "12px 14px", background: C.panel }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: C.muted }}>
              <Shield size={14} color={dangerColor(m.gt)} />自陣ゴール前 危険度（GOAL_THREAT）
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ ...NUM, fontSize: 42, fontWeight: 900, fontStyle: "italic", color: dangerColor(m.gt), lineHeight: 1.05 }}>
                {Math.round(m.gt * 100)}<span style={{ fontSize: 18 }}>%</span>
              </span>
              <span style={{ fontSize: 11, color: C.muted }}>PA {Math.round(frame.zones.pa * 100)}% ・ バイタル {Math.round(frame.zones.vt * 100)}%</span>
            </div>
            <div style={{ fontSize: 10.5, color: C.faint, marginTop: 2 }}>相手の空間支配 × ゴール距離重み（PA×1.5 / ゴール正面×1.6）</div>
          </section>

          {/* 指標 */}
          <section style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, background: C.panel, display: "grid", gap: 10 }}>
            <Meter label="DRAWN_IN — 中央吸い寄せ" value={m.di} color={C.jpn === "#1E44C8" ? "#6E8CFF" : C.jpn} />
            <Meter label="LEAK — 左サイド解放" value={m.leak} color={dangerColor(m.leak)} />
            <Meter label="SYSTEM_ERROR（総合）" value={m.ser} color={sc} ticks={[WARN_AT, CRIT_AT]} />
            <div style={{ fontSize: 10, color: C.faint }}>SER = DI×{W.di} + LEAK×{W.leak} + GT×{W.gt}　▸ WARN {WARN_AT} / CRIT {CRIT_AT}</div>
          </section>

          {/* ベンチ */}
          <section style={{ border: `1px solid ${C.line}`, borderRadius: 10, background: C.panel, overflow: "hidden" }}>
            <div style={{ display: "flex" }}>
              {["JPN", "BRA"].map((tb) => (
                <button key={tb} onClick={() => setBenchTab(tb)} style={{
                  flex: 1, padding: "9px 0", fontSize: 12, fontWeight: 800, cursor: "pointer", border: "none",
                  background: benchTab === tb ? (tb === "JPN" ? C.jpn : C.bra) : "transparent",
                  color: benchTab === tb ? (tb === "JPN" ? "#fff" : "#12300F") : C.muted,
                }}>
                  {tb === "JPN" ? "日本ベンチ" : "ブラジルベンチ"}
                </button>
              ))}
            </div>
            <div style={{ maxHeight: 190, overflowY: "auto", padding: "6px 10px" }}>
              {(benchTab === "JPN" ? JAPAN_BENCH : BRA_BENCH).map((b) => (
                <div key={b.num} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: `1px dashed ${C.line}`, opacity: b.role === "GK" ? 0.5 : 1 }}>
                  <span style={{ ...NUM, width: 22, textAlign: "right", fontWeight: 800, color: benchTab === "JPN" ? "#8FA8FF" : C.bra }}>{b.num}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>{b.name}</span>
                  <span style={{ fontSize: 10.5, color: C.muted, width: 52 }}>{b.role}</span>
                  {benchTab === "JPN" && b.left != null && (
                    <span style={{ display: "flex", gap: 2 }}>
                      {[["左", b.left], ["中", b.central], ["守", b.def]].map(([lb, v]) => (
                        <span key={lb} title={lb} style={{ width: 18, textAlign: "center", fontSize: 9.5, borderRadius: 3, padding: "1px 0", background: `rgba(110,140,255,${0.12 + v * 0.5})`, color: "#DDE6FF" }}>{lb}</span>
                      ))}
                    </span>
                  )}
                </div>
              ))}
              <div style={{ fontSize: 9.5, color: C.faint, padding: "6px 0 2px" }}>※ 招集・背番号はサンプルデータ（コード先頭で編集可）</div>
            </div>
          </section>

          {/* イベントログ */}
          <section style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, background: C.panel, minHeight: 110 }}>
            <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 6 }}>イベントログ</div>
            {visibleEvents.length === 0 && <div style={{ fontSize: 12, color: C.faint }}>キックオフ待機中…</div>}
            {visibleEvents.map((e, i) => (
              <button key={i} onClick={() => setT(e.t)} style={{ display: "flex", gap: 8, width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: "3px 0", fontSize: 12, color: e.lv === "goal" ? C.bra : e.lv === "critical" ? C.crit : e.lv === "warning" ? C.warn : e.lv === "ok" ? C.ok : C.muted }}>
                <span style={{ ...NUM, color: C.faint, width: 40 }}>{fmtClock(e.t)}</span>
                <span style={{ fontWeight: e.lv === "goal" || e.lv === "critical" ? 800 : 500 }}>{e.lv === "goal" ? "⚽ " : ""}{e.label}</span>
              </button>
            ))}
          </section>
        </div>
      </div>

      {/* ============ タイムライン ============ */}
      <div style={{ padding: "4px 14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, padding: "0 2px 4px" }}>
          <span>前半タイムライン — ドラッグで頭出し</span>
          <span><i style={{ color: C.crit }}>■</i> SER　<i style={{ color: C.warn }}>—</i> ゴール前危険度</span>
        </div>
        <svg ref={tlRef} viewBox="0 0 1000 96" preserveAspectRatio="none"
          style={{ width: "100%", height: 96, display: "block", background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, cursor: "pointer", touchAction: "none" }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekFromEvent(e); }}
          onPointerMove={(e) => e.buttons === 1 && seekFromEvent(e)}>
          {/* ステータス帯 */}
          {curve.map((p, i) => i % 2 === 0 && p.status !== "OK" && (
            <rect key={i} x={(p.t / HALF_END) * 1000} y="0" width={(6 / HALF_END) * 1000} height="5" fill={statusColor(p.status)} />
          ))}
          {/* 閾値ガイド */}
          {[WARN_AT, CRIT_AT].map((th) => (
            <line key={th} x1="0" x2="1000" y1={90 - th * 80} y2={90 - th * 80} stroke={th === CRIT_AT ? C.crit : C.warn} strokeWidth="0.7" strokeDasharray="5 5" opacity="0.5" />
          ))}
          {/* SER エリア */}
          <path d={`M0,90 ${curve.map((p) => `L${(p.t / HALF_END) * 1000},${90 - p.ser * 80}`).join(" ")} L1000,90 Z`} fill={C.crit} opacity="0.16" />
          <path d={`M${curve.map((p, i) => `${i ? "L" : ""}${(p.t / HALF_END) * 1000},${90 - p.ser * 80}`).join(" ")}`} fill="none" stroke="#FF7A66" strokeWidth="1.6" />
          {/* GT ライン */}
          <path d={`M${curve.map((p, i) => `${i ? "L" : ""}${(p.t / HALF_END) * 1000},${90 - p.gt * 80}`).join(" ")}`} fill="none" stroke={C.warn} strokeWidth="1.1" opacity="0.85" />
          {/* 10分グリッド */}
          {[600, 1200, 1800, 2400].map((s) => (
            <g key={s}>
              <line x1={(s / HALF_END) * 1000} x2={(s / HALF_END) * 1000} y1="8" y2="90" stroke={C.line} strokeWidth="0.7" />
              <text x={(s / HALF_END) * 1000 + 4} y="88" fill={C.faint} style={{ fontSize: 9 }}>{s / 60}'</text>
            </g>
          ))}
          {/* 失点ピン */}
          <g transform={`translate(${(GOAL_T / HALF_END) * 1000},0)`}>
            <line x1="0" x2="0" y1="8" y2="90" stroke={C.bra} strokeWidth="1.2" />
            <circle cx="0" cy="14" r="7" fill={C.bra} />
            <text x="0" y="17.5" textAnchor="middle" style={{ fontSize: 9, fontWeight: 900 }} fill="#12300F">⚽</text>
          </g>
          {/* 再生ヘッド */}
          <line x1={(t / HALF_END) * 1000} x2={(t / HALF_END) * 1000} y1="0" y2="96" stroke="#fff" strokeWidth="1.4" />
          <circle cx={(t / HALF_END) * 1000} cy="92" r="4.5" fill="#fff" />
        </svg>
      </div>

      {/* ============ 割り込み通知バナー/モーダル ============ */}
      {inWindow && !alertOpen && (
        <button onClick={() => setAlertOpen(true)} style={{ position: "fixed", left: "50%", bottom: 18, transform: "translateX(-50%)", zIndex: 30, display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 99, border: `1px solid ${C.crit}`, background: "#2A1113", color: "#FFD9D5", fontWeight: 800, fontSize: 13, cursor: "pointer", boxShadow: `0 8px 24px rgba(0,0,0,.5)` }}>
          <AlertTriangle size={16} color={C.crit} /> SYSTEM CLASH WARNING — 詳細 <ChevronRight size={15} />
        </button>
      )}
      {alertOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(5,9,16,.6)", backdropFilter: "blur(2px)" }} onClick={() => setAlertOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: "10%", left: "50%", transform: "translateX(-50%)", width: "min(540px,93vw)", background: C.panel, border: `1px solid ${C.crit}`, borderRadius: 14, animation: "rise .22s ease-out", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", background: "rgba(255,78,66,.1)", borderBottom: `1px solid ${C.crit}55` }}>
              <AlertTriangle size={17} color={C.crit} />
              <b style={{ color: C.crit, letterSpacing: 1 }}>SYSTEM CLASH WARNING</b>
              <button onClick={() => setAlertOpen(false)} style={{ marginLeft: "auto", background: "none", border: "none", color: C.muted, cursor: "pointer" }}><X size={17} /></button>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ fontSize: 14.5, lineHeight: 1.6 }}>
                {[m.di >= 0.5 && "中央過密", m.leak >= 0.5 && "左サイドの完全解放", m.gt >= 0.5 && "自陣ゴール前危険域への進入"].filter(Boolean).join("、")}を検知。
                失点確率 <b style={{ ...NUM, color: C.crit, fontSize: 18 }}>{concedeProb(m.ser)}%</b>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.jpn}66`, background: "rgba(30,68,200,.1)" }}>
                <ArrowRightLeft size={16} color="#8FA8FF" />
                <div style={{ fontSize: 13 }}>
                  <b>AI PATCH 候補:</b> #{top.num} {top.name}（{top.role}）
                  <span style={{ color: C.muted }}>　左{Math.round(top.left * 100)} / 中{Math.round(top.central * 100)} / 守{Math.round(top.def * 100)}</span>
                </div>
              </div>
              <button className="rowbtn" style={{ width: "100%", justifyContent: "center", marginTop: 12, background: C.jpn, borderColor: C.jpn, color: "#fff" }} onClick={() => { setAlertOpen(false); setHtOpen(true); }}>
                詳細比較（HTレポート）を開く
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ ハーフタイム・レポート ============ */}
      {htOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(5,9,16,.65)", backdropFilter: "blur(3px)", overflowY: "auto" }} onClick={() => setHtOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ margin: "5vh auto", width: "min(680px,94vw)", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, animation: "rise .25s ease-out", overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", background: `linear-gradient(90deg, ${C.jpnDeep}, ${C.panel} 55%, #6b5200)`, borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 10 }}>
              <ClipboardList size={18} color={C.bra} />
              <div>
                <b style={{ fontSize: 15 }}>ハーフタイム・レポート</b>
                <div style={{ fontSize: 11, color: C.muted }}>JPN 0–1 BRA ・ 前半 {fmtClock(HALF_END)} 時点の構造解析</div>
              </div>
              <button onClick={() => setHtOpen(false)} style={{ marginLeft: "auto", background: "none", border: "none", color: C.muted, cursor: "pointer" }}><X size={18} /></button>
            </div>
            <div style={{ padding: 18, display: "grid", gap: 14 }}>
              {/* サマリー */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 8 }}>
                {[
                  ["最大SER", `${Math.round(Math.max(...curve.map((p) => p.ser)) * 100)}%`, C.crit],
                  ["最大ゴール前危険度", `${Math.round(Math.max(...curve.map((p) => p.gt)) * 100)}%`, C.warn],
                  ["CRITICAL累計", `${Math.round(curve.filter((p) => p.status === "CRITICAL").length * 3 / 60)}分`, C.crit],
                  ["失点", "1（40:12 左サイド起点）", C.bra],
                ].map(([k, v, col]) => (
                  <div key={k} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", background: C.panel2 }}>
                    <div style={{ fontSize: 10.5, color: C.muted }}>{k}</div>
                    <div style={{ ...NUM, fontSize: 16, fontWeight: 900, color: col }}>{v}</div>
                  </div>
                ))}
              </div>
              {/* 診断 */}
              <div style={{ fontSize: 13, lineHeight: 1.8, color: "#D7E0F2" }}>
                36分以降、{BRA_XI.find((p) => p.id === keyId)?.name}への吸い寄せ（DI 最大71%）と連動して
                <b style={{ color: dangerColor(0.9) }}>左チャンネル→自陣PA左</b>が恒常的に相手支配下に。
                失点は同構造の再現であり、単発事象ではなく<b>構造バグ</b>と判定。
              </div>
              {/* パッチ順位 */}
              <div style={{ border: `1px solid ${C.jpn}55`, borderRadius: 12, padding: 14, background: "rgba(30,68,200,.07)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <ArrowRightLeft size={15} color="#8FA8FF" />
                  <b style={{ fontSize: 13.5 }}>後半修正パッチ — ベンチ適合ランキング</b>
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: C.muted }}>重み: 場所（左+ゴール前）{Math.round(ranking.lw * 100)} / 中央 {Math.round(ranking.cw * 100)}</span>
                </div>
                {ranking.list.slice(0, 3).map((b, i) => (
                  <div key={b.num} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 4px", borderTop: i ? `1px dashed ${C.line}` : "none" }}>
                    <span style={{ ...NUM, fontWeight: 900, width: 18, color: i === 0 ? C.bra : C.faint }}>{i + 1}</span>
                    <span style={{ fontWeight: 800, fontSize: 13.5, width: 110 }}>#{b.num} {b.name}</span>
                    <span style={{ fontSize: 11, color: C.muted, width: 56 }}>{b.role}</span>
                    <div style={{ flex: 1, height: 7, background: "#0B1322", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${b.score * 100}%`, height: "100%", background: i === 0 ? C.bra : "#41528a" }} />
                    </div>
                    <span style={{ ...NUM, fontSize: 12, fontWeight: 800, width: 40, textAlign: "right", color: i === 0 ? C.bra : C.muted }}>{b.score.toFixed(3)}</span>
                  </div>
                ))}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12, alignItems: "center" }}>
                  <div style={{ flex: "1 1 220px", fontSize: 12.5, lineHeight: 1.7 }}>
                    <b style={{ color: "#8FA8FF" }}>推奨:</b> IN #{top.num} {top.name} ⇄ OUT #26 伊藤洋輝（同ポジ直接交代）<br />
                    <span style={{ color: C.muted, fontSize: 11.5 }}>代替案: OUT #9 上田 → 5バック化 ／ 期待効果: 左空間の排他ロック・スライド負荷 約40%減・コーチング再起動</span>
                  </div>
                  <button className="rowbtn" style={{ background: patched ? C.ok : C.jpn, borderColor: patched ? C.ok : C.jpn, color: "#fff", fontWeight: 800 }} onClick={() => setPatched(true)}>
                    {patched ? "✓ 適用済" : "このパッチを適用"}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 10.5, color: C.faint }}>
                相手の残カード: {BRA_BENCH.filter((b) => b.role !== "GK").slice(3).map((b) => b.name).join("・")} — 後半の脅威として監視継続。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
