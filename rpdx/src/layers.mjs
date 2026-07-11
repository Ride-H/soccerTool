/* =========================================================================
   RPDX.layers — レイヤ・プラグイン・アーキテクチャ（Issue #41 v1・レジストリ+契約）
   ---------------------------------------------------------------------------
   異分野から輸入した解析レイヤ（危険度/心理/接触/生理/フィルタ/UQ/戦術/相手分析/
   シナリオ）を、拡張の「正式な受け口」として一元登録する読み取り専用レジストリ。
   各レイヤの実装モジュールは一切変更せず、公開関数への参照だけを収集して束ねる。

     register({id,label,kind,api,readonly,deps}) … レイヤを登録（id重複は例外）
     list()  … 登録済みレイヤの配列
     get(id) … レイヤ1件（未登録は null）
     has(id) … 登録有無

   契約（v1）: kind="analysis" のレイヤは全て readonly=true。api の各関数は合成状態
   を読むだけで、位置・イベント・危険度・結果を変えない（golden 不変が保証）。
   deps はレジストリ内の他レイヤ id（実行トポロジ・UI自動配線は将来スコープ）。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const L = (R.layers = {});
  const reg = new Map();

  L.register = (spec) => {
    if (!spec || typeof spec.id !== "string" || !spec.id)
      throw new Error("layers.register: id は必須");
    if (reg.has(spec.id))
      throw new Error("layers.register: id 重複 — " + spec.id);
    const api = spec.api || {};
    for (const [k, fn] of Object.entries(api))
      if (typeof fn !== "function")
        throw new Error(`layers.register(${spec.id}): api.${k} は関数参照でなければならない`);
    const entry = {
      id: spec.id,
      label: spec.label || spec.id,
      kind: spec.kind || "analysis",
      readonly: spec.readonly !== false,          // 既定 true（読み取り専用契約）
      deps: Object.freeze([...(spec.deps || [])]),
      api: Object.freeze({ ...api }),
    };
    reg.set(spec.id, Object.freeze(entry));
    return entry;
  };
  L.list = () => [...reg.values()];
  L.get = (id) => reg.get(id) || null;
  L.has = (id) => reg.has(id);

  /* ---- 既存レイヤを一括登録（モジュールは不変・公開関数参照のみ収集）---- */
  const src = (id) => R[id] || {};
  const pick = (id, keys) => {
    const o = src(id), out = {};
    for (const k of keys) if (typeof o[k] === "function") out[k] = o[k];
    return out;
  };

  L.register({
    id: "danger", label: "危険度 D²-Field", kind: "analysis", readonly: true, deps: [],
    api: pick("danger", ["threatAt", "indexAt", "indexSmooth", "fieldAt", "zoneField", "curve", "seqAccumAt"]),
  });
  L.register({
    id: "psy", label: "心理・モメンタム（PSY）", kind: "analysis", readonly: true, deps: ["danger"],
    api: pick("psy", ["momentumAt", "playerAt", "teamAt", "decisionAt", "momentumCurve"]),
  });
  L.register({
    id: "duel", label: "デュエル・接触", kind: "analysis", readonly: true, deps: [],
    api: pick("duel", ["tackleAt", "shieldAt", "aerialAt", "foulsOf"]),
  });
  L.register({
    id: "physio", label: "生理・メタボリックパワー", kind: "analysis", readonly: true, deps: [],
    api: pick("physio", ["ecCost", "summary", "summaryAsync"]),
  });
  L.register({
    id: "filter", label: "α-β-γ フィルタ", kind: "analysis", readonly: true, deps: [],
    api: pick("filter", ["abg", "gainsFromTheta"]),
  });
  L.register({
    id: "uq", label: "不確実性定量化（UQ）", kind: "analysis", readonly: true, deps: ["danger"],
    api: pick("uq", ["wilson", "evaluate", "sweep", "reportText"]),
  });
  L.register({
    id: "tactics", label: "戦術フェーズ & 形メトリクス", kind: "analysis", readonly: true, deps: [],
    api: pick("tactics", ["phaseAt", "phaseShares", "phaseStrip", "shapeMetrics", "voronoiShare"]),
  });
  L.register({
    id: "opponent", label: "相手分析体制の脆弱性", kind: "analysis", readonly: true, deps: ["danger", "tactics", "scenlib"],
    api: pick("opponent", ["profile", "setupOf", "htBudget", "htSaturation", "counterPlans", "evaluatePlans"]),
  });
  L.register({
    id: "scenlib", label: "シナリオ・ライブラリ", kind: "analysis", readonly: true, deps: ["danger", "tactics"],
    api: pick("scenlib", ["serialize", "parse", "batch", "subMinuteGrid"]),
  });
})();
