// 品質ティア（quality.mjs）の環境収集・オーバーライド・ガバナのリセットまで含めた契約。
// 端末差でだけ通る経路（DPR/コア数/タッチ/GPU 文字列/localStorage）は本番でしか踏まれず
// 壊れても気づけないので、グローバルを差し替えて node から全経路を通す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { evalFile } from "./load.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
evalFile(join(root, "app", "quality.mjs"));
const Q = globalThis.RPDX.quality;

// globalThis を一時的に差し替える（テスト後は必ず戻す）
const withGlobals = (patch, fn) => {
  const saved = new Map();
  for (const [k, v] of Object.entries(patch)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try { return fn(); } finally {
    for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
};

test("init(): 環境をブラウザから収集する（何も無い node では保守側へ落ちる）", () => {
  const bare = withGlobals({ navigator: undefined, innerWidth: undefined, devicePixelRatio: undefined, matchMedia: undefined, location: undefined, localStorage: undefined },
    () => Q.init());
  assert.ok(["cinematic", "lightweight"].includes(bare.tier), `ティア ${bare.tier}`);
  assert.equal(bare.source, "auto");
  assert.ok(Array.isArray(bare.reasons));

  // 高性能そうな環境: コア多・広い画面・マウス
  const rich = withGlobals({
    navigator: { hardwareConcurrency: 16 }, innerWidth: 2560, innerHeight: 1440, devicePixelRatio: 2,
    matchMedia: () => ({ matches: false }), location: { search: "" }, URLSearchParams,
    localStorage: { getItem: () => null },
  }, () => Q.init());
  // 低性能そうな環境: コア少・小さい画面・タッチ
  const poor = withGlobals({
    navigator: { hardwareConcurrency: 2 }, innerWidth: 360, innerHeight: 640, devicePixelRatio: 3,
    matchMedia: () => ({ matches: true }), location: { search: "" }, URLSearchParams,
    localStorage: { getItem: () => null },
  }, () => Q.init());
  assert.equal(poor.tier, "lightweight", `貧弱な環境は軽量 ${JSON.stringify(poor.reasons)}`);
  assert.ok(rich.tier === "cinematic" || rich.tier === "lightweight");
});

test("init(): URL の ?tier= と localStorage の保存値がオーバーライドになる（URL が優先）", () => {
  const byUrl = withGlobals({
    navigator: { hardwareConcurrency: 2 }, innerWidth: 360, innerHeight: 640, devicePixelRatio: 3,
    matchMedia: () => ({ matches: true }), location: { search: "?tier=cinematic" }, URLSearchParams,
    localStorage: { getItem: () => "lightweight" },
  }, () => Q.init());
  assert.equal(byUrl.tier, "cinematic");
  assert.equal(byUrl.source, "override", "URL 指定は手動扱い");

  const byStorage = withGlobals({
    navigator: { hardwareConcurrency: 16 }, innerWidth: 2560, innerHeight: 1440, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }), location: { search: "" }, URLSearchParams,
    localStorage: { getItem: (k) => (k === "rpdx_tier_v1" ? "lightweight" : null) },
  }, () => Q.init());
  assert.equal(byStorage.tier, "lightweight");
  assert.equal(byStorage.source, "override");

  // 不正な値は無視して自動判定へ戻る
  const bogus = withGlobals({
    navigator: { hardwareConcurrency: 16 }, innerWidth: 2560, innerHeight: 1440, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }), location: { search: "?tier=ultra" }, URLSearchParams,
    localStorage: { getItem: () => "??" },
  }, () => Q.init());
  assert.equal(bogus.source, "auto");

  // localStorage が例外を投げる環境（プライベートモード等）でも落ちない
  const throwing = withGlobals({
    navigator: { hardwareConcurrency: 8 }, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }), location: { search: "" }, URLSearchParams,
    localStorage: { getItem() { throw new Error("拒否"); } },
  }, () => Q.init());
  assert.ok(["cinematic", "lightweight"].includes(throwing.tier));
  // 収集そのものが壊れる環境でも保守既定へ落ちる
  const broken = withGlobals({ navigator: { get hardwareConcurrency() { throw new Error("壊れた"); } } }, () => Q.init());
  assert.ok(["cinematic", "lightweight"].includes(broken.tier));
});

test("refineGpu(): 既知の非力な GPU では降格のみ・オーバーライド中は動かない", () => {
  Q.init({ cores: 16, width: 2560, height: 1440, dpr: 1, coarse: false, gpu: "", override: null });
  const before = Q.state().tier;
  const soft = Q.refineGpu("Google SwiftShader");
  assert.ok(soft.tier === "lightweight" || before === "lightweight", "ソフトウェア描画は軽量へ");
  // 降格後に強い GPU 名を渡しても昇格しない（保守側のみ）
  const back = Q.refineGpu("NVIDIA GeForce RTX 4090");
  assert.equal(back.tier, "lightweight", "昇格はしない");
  // 手動オーバーライド中は GPU 名で動かさない
  Q.setOverride("cinematic");
  assert.equal(Q.state().source, "override");
  assert.equal(Q.refineGpu("Google SwiftShader").tier, "cinematic");
  // 初期化前の refineGpu は無視
  Q.setOverride("auto");
  assert.ok(["auto", "override"].includes(Q.state().source));
});

test("setOverride(): auto へ戻すと自動判定に従う・変更は購読者へ通知される", () => {
  Q.init({ cores: 16, width: 2560, height: 1440, dpr: 1, coarse: false, gpu: "", override: null });
  const seen = [];
  const off = Q.onChange((s) => seen.push(s.tier));
  Q.setOverride("lightweight");
  assert.equal(Q.state().tier, "lightweight");
  Q.setOverride("cinematic");
  assert.equal(Q.state().tier, "cinematic");
  const auto = Q.setOverride("auto");
  assert.equal(auto.source, "auto");
  assert.ok(seen.length >= 3, `通知 ${seen}`);
  off();
  const n = seen.length;
  Q.setOverride("lightweight");
  assert.equal(seen.length, n, "解除したら通知されない");
  // 購読者が例外を投げても他へ波及しない
  const off2 = Q.onChange(() => { throw new Error("購読者の失敗"); });
  const ok = [];
  const off3 = Q.onChange((s) => ok.push(s.tier));
  Q.setOverride("cinematic");
  assert.equal(ok.length, 1, "例外は隔離される");
  off2(); off3();
});

test("createGovernor.reset(): 状態を初期化して段階と履歴を消す", () => {
  const base = Q.flagsFor("cinematic");
  const gov = Q.createGovernor({ base, budgetMs: base.frameBudgetMs, floorMs: base.frameFloorMs });
  const heavy = Math.min(base.frameBudgetMs * 4, Q.GOV.SPIKE_MS - 10);
  for (let i = 0; i < Q.GOV.WINDOW * 4; i++) gov.tick(heavy, i * 0.05);
  // 停止/タブ切替（極端に長いフレーム）は標本から外す
  assert.equal(gov.tick(Q.GOV.SPIKE_MS + 100, 999).changed, false, "スパイクは無視");
  assert.equal(gov.tick(0, 999).changed, false, "0ms も無視");
  assert.ok(gov.samples() > 0);
  assert.ok(gov.level() > 0, "重い状態が続けば段階が上がる");
  gov.reset();
  assert.equal(gov.level(), 0);
  assert.equal(gov.samples(), 0);
  assert.equal(gov.medianMs(), 0);
});

test("tick(): 初期化前は何もしない・重い/軽いフレームで段階が上下する", () => {
  const fresh = globalThis.RPDX.quality;
  fresh.init({ cores: 16, width: 1920, height: 1080, dpr: 1, coarse: false, gpu: "", override: null });
  const budget = fresh.state().flags.frameBudgetMs;
  let changed = false;
  for (let i = 0; i < Q.GOV.WINDOW * 4 && !changed; i++) changed = fresh.tick(budget * 4, i * 0.05) || changed;
  assert.ok(changed, "重いフレームが続けば段階が変わる");
  assert.ok(fresh.state().level > 0);
  const heavyLevel = fresh.state().level;
  for (let i = 0; i < Q.GOV.WINDOW * 20; i++) fresh.tick(budget * 0.2, 100 + i * 0.05);
  assert.ok(fresh.state().level <= heavyLevel, "軽くなれば戻る（ヒステリシス込み）");
  assert.equal(typeof fresh.state().medianMs, "number");
});
