/* =========================================================================
   RPDX.live — ライブ実況セッション（中継を見ながら使うための時計とイベント入力）
   収録パックは「試合が終わってから」の完全な記録だが、ライブでは
   (1) 試合時刻が壁時計で進み、(2) イベントは起きた順に少しずつ増える。
   ここはその 2 点だけを担い、世界の生成は既存エンジン（generic.createMatch）に渡す。

   設計の要点:
   - **セッションは不変**。すべての操作は新しいセッションを返す。同じセッションと同じ壁時計を
     与えれば必ず同じ世界になる（f(session, wallMs) の純関数）。
   - **時計は区間の列**。start/pause/resume/sync を「壁時計→試合時刻」の写像の区間として持つ。
     中継のロスタイムやハーフタイムに合わせて sync でずらせる。
   - **過去は書き換わらない**。入力したイベントが世界へ及ぼす影響は PRE_ROLL 秒前までに限る。
     ライブでは「70分に得点を入れたら30分の表示が変わった」は許されないため、
     アンカーとポゼッションの生成をこの窓の中だけに収める。
   ========================================================================= */
(() => {
  const R = (globalThis.RPDX ??= {});
  const L = (R.live = {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // 入力したイベントが過去へさかのぼって効く上限［秒］。これより前の世界は不変。
  L.PRE_ROLL = 60;

  /* ---------------- セッションの生成 ---------------- */
  // cfg は generic.createMatch と同じ形（home/away/added1/added2/seed…）
  L.create = (cfg) => ({
    cfg,
    clock: [],        // 時計の区間: {wall, t, rate}
    events: [],       // 入力したイベント（時刻昇順）
    subs: [],         // 入力した交代 {t, team, out, in}
  });

  /* ---------------- 時計 ---------------- */
  // op: "start"（試合開始）/ "pause"（中断）/ "resume"（再開）/ "sync"（中継に合わせて時刻を合わせる）
  // t を省くと、その時点の試合時刻を引き継ぐ。
  L.withClock = (s, op, wallMs, t) => {
    const cur = L.tAt(s, wallMs);
    const at = (rate, t0) => ({ ...s, clock: [...s.clock, { wall: wallMs, t: t0, rate }] });
    if (op === "start") return at(1, t ?? 0);
    if (op === "pause") return at(0, cur);
    if (op === "resume") return at(1, t ?? cur);
    if (op === "sync") return at(s.clock.length && lastSeg(s).rate ? 1 : 0, t ?? cur);
    throw new Error(`live.withClock: 未知の操作 ${op}`);
  };
  const lastSeg = (s) => s.clock[s.clock.length - 1];

  // 壁時計［ms］→ 試合時刻［秒］。開始前は 0。
  L.tAt = (s, wallMs) => {
    if (!s.clock.length) return 0;
    let seg = s.clock[0];
    for (const c of s.clock) if (c.wall <= wallMs) seg = c; else break;
    if (wallMs < s.clock[0].wall) return s.clock[0].t;
    return seg.t + (seg.rate ? (wallMs - seg.wall) / 1000 : 0);
  };
  L.isRunning = (s) => !!(s.clock.length && lastSeg(s).rate);

  /* ---------------- イベント入力 ---------------- */
  // ev: { t, type, team, no?, assist?, label?, detail? }
  //   type: goal / shot / corner / yellow / red / foul（エンジンが解釈する型）
  L.withEvent = (s, ev) => {
    if (!ev || typeof ev.t !== "number" || !Number.isFinite(ev.t)) throw new Error("live.withEvent: t が必要");
    if (!ev.type) throw new Error("live.withEvent: type が必要");
    const e = { ...ev, min: ev.min ?? minLabel(s, ev.t) };
    return { ...s, events: [...s.events, e].sort((a, b) => a.t - b.t) };
  };
  L.withSub = (s, sub) => {
    if (!sub || typeof sub.t !== "number") throw new Error("live.withSub: t が必要");
    return { ...s, subs: [...s.subs, { ...sub }].sort((a, b) => a.t - b.t) };
  };
  // 直前に入れたものを取り消す（誤入力の訂正）
  L.undo = (s) => {
    const lastEv = s.events[s.events.length - 1], lastSub = s.subs[s.subs.length - 1];
    if (lastSub && (!lastEv || lastSub.t >= lastEv.t)) return { ...s, subs: s.subs.slice(0, -1) };
    if (lastEv) return { ...s, events: s.events.slice(0, -1) };
    return s;
  };

  const minLabel = (s, t) => {
    const h2 = 2700 + (s.cfg.added1 ?? 2) * 60;
    const m = t < h2 ? Math.floor(t / 60) : 45 + Math.floor((t - h2) / 60);
    return `${m}'`;
  };

  /* ---------------- 世界の生成 ---------------- */
  // 入力イベントから、エンジンが必要とするアンカーとポゼッションの起伏を作る。
  // 生成はイベント時刻の [t-PRE_ROLL, t+RESTART] に閉じる＝それより前の世界は不変。
  const RESTART = 55;
  L.matchOf = (s) => {
    const G = R.generic, N = R.noise;
    const base = G.createMatch(s.cfg);                    // 既定の世界（骨格・時間・方向）
    const kA = base.teamOrder[0], kB = base.teamOrder[1];
    const H2 = base.time.h2.start, END = base.time.h2.end;
    const seed = N.seedOf((s.cfg.seed || kA + kB) + "|live");

    const events = [
      { t: 0, type: "kickoff", team: kA, label: "キックオフ" },
      { t: H2, type: "halftime", label: "前半終了" },
      { t: H2, type: "kickoff", team: kB, label: "後半開始" },
    ];
    const ballAnchors = [{ t: 0, x: 0, y: 0, hold: 6 }, { t: H2, x: 0, y: 0, hold: 6 }];
    const possessionKP = [[0, 0]];

    // 過去を書き換えないための要: 起伏を足す前に「PRE_ROLL 秒前の現在値」で曲線を留める。
    // 留めないと、区間 [直前の点, 新しい点] が引き伸ばされて試合開始直後まで値が変わる。
    const pin = (tp) => {
      const tc = clamp(tp, 0, END);
      const v = possessionKP.length ? N.spline(possessionKP, tc)[0] : 0;
      possessionKP.push([tc, v]);
      possessionKP.sort((a, b) => a[0] - b[0]);
      return tc;
    };

    let gi = 0;
    for (const ev of s.events) {
      const t = clamp(ev.t, 0, END);
      events.push({ ...ev, t });
      const d = base.dir[ev.team] ? base.dir[ev.team][t < H2 ? "h1" : "h2"] : 1;
      const y = (N.hash2(seed, 601 + gi) * 2 - 1) * 3;
      if (ev.type === "goal") {
        ballAnchors.push({ t: Math.max(0, t - 9), x: d * 22, y: y * 4 });
        ballAnchors.push({ t: Math.max(0.5, t - 1.2), x: d * 40, y: y * 2.2 });
        ballAnchors.push({ t, x: d * 52.2, y, hold: 4 });
        ballAnchors.push({ t: Math.min(t + RESTART, END - 5), x: 0, y: 0, hold: 6 });
        pin(t - L.PRE_ROLL);
        possessionKP.push([Math.max(0, t - L.PRE_ROLL / 2), (ev.team === kA ? +1 : -1) * 0.55]);
        possessionKP.push([t, (ev.team === kA ? +1 : -1) * 0.95]);
        possessionKP.push([Math.min(t + 90, END), 0]);
      } else if (ev.type === "shot") {
        ballAnchors.push({ t: Math.max(0, t - 6), x: d * 26, y: y * 3 });
        ballAnchors.push({ t, x: d * 44, y: y * 1.5, hold: 2 });
        pin(t - L.PRE_ROLL);
        possessionKP.push([Math.max(0, t - 30), (ev.team === kA ? +1 : -1) * 0.5]);
        possessionKP.push([Math.min(t + 30, END), 0]);
      } else if (ev.type === "corner") {
        ballAnchors.push({ t, x: d * 52.4, y: (y > 0 ? 1 : -1) * 33.8, hold: 3 });
        pin(t - L.PRE_ROLL);
        possessionKP.push([t, (ev.team === kA ? +1 : -1) * 0.7]);
      }
      gi++;
    }
    events.push({ t: END, type: "fulltime", label: "試合終了" });
    possessionKP.push([END, 0]);
    events.sort((a, b) => a.t - b.t);
    ballAnchors.sort((a, b) => a.t - b.t);
    possessionKP.sort((a, b) => a[0] - b[0]);

    const score = { [kA]: 0, [kB]: 0 };
    for (const ev of events) if (ev.type === "goal" && score[ev.team] != null) score[ev.team]++;

    const subsActual = { [kA]: [], [kB]: [] };
    for (const sb of s.subs) if (subsActual[sb.team]) subsActual[sb.team].push({ t: sb.t, min: minLabel(s, sb.t), out: sb.out, in: sb.in });

    // 試合 ID は入力内容で変える。各層のキャッシュは meta.id で引くので、
    // 内容が変わったのに ID が同じだと**古い世界が返り続ける**（入力しても何も起きない）。
    // 名簿（cfg）も ID に含める。含めないと、チーム名や選手を変えても ID が同じままで
    // 各層のキャッシュが古い世界を返し続ける（UI 側も「変わっていない」と判断して描き直さない）。
    let h = N.seedOf(JSON.stringify(s.cfg));
    for (const ev of s.events) h = N.seedOf(`${h}|${ev.t}|${ev.type}|${ev.team}|${ev.no ?? ""}`);
    for (const sb of s.subs) h = N.seedOf(`${h}|s${sb.t}|${sb.team}|${sb.out}|${sb.in}`);
    return {
      ...base,
      // id は入力内容で変える（各層のキャッシュが meta.id で引くため。同じ ID だと古い世界が返り続ける）。
      // seedId は入力に依らず固定＝世界生成のシードは変わらない（過去が作り直されない・#177）。
      meta: { ...base.meta, id: `live-${s.cfg.seed || kA + kB}-${(h >>> 0).toString(36)}`,
        seedId: `live-${s.cfg.seed || kA + kB}`, score, live: true, calibrated: false },
      events, ballAnchors, possessionKP, subsActual,
    };
  };

  // 名簿（cfg）の差し替え。入力済みのイベント・交代・時計はそのまま持ち越す。
  // 世界は cfg から作り直されるので、チーム名や選手名を後から直しても記録は消えない。
  L.withCfg = (s, cfg) => ({ ...s, cfg });

  /* ---------------- 保存・復帰（#181）----------------
     保存の仕組みは作らない。既存のバンドル（scenlib.serializeBundle）へ載せるための
     「素の値へ落とす／戻す」だけをここに置く。復帰した時計は必ず止まっている
     （読み込んだ瞬間に試合時刻が走り出すと、見ていない間の時間が進んでしまう）。 */
  L.toObj = (s) => ({ cfg: s.cfg, clock: s.clock.map((c) => ({ wall: c.wall, t: c.t, rate: c.rate })),
    events: s.events.map((e) => ({ ...e })), subs: s.subs.map((x) => ({ ...x })) });

  L.fromObj = (o, wallMs) => {
    if (!o || !o.cfg) return null;
    const s = { cfg: o.cfg, clock: [], events: (o.events || []).map((e) => ({ ...e })).sort((a, b) => a.t - b.t),
      subs: (o.subs || []).map((x) => ({ ...x })).sort((a, b) => a.t - b.t) };
    // 保存時点の試合時刻を求め、その時刻で「停止」の 1 区間だけを持たせる
    const saved = { ...s, clock: (o.clock || []).map((c) => ({ ...c })) };
    const at = (o.clock && o.clock.length) ? L.tAt(saved, o.savedAt ?? Date.now()) : 0;
    s.clock = [{ wall: wallMs ?? Date.now(), t: at, rate: 0 }];
    return s;
  };

  // 壁時計の「いま」を 1 回で取る（UI から毎フレーム呼ぶ想定）
  L.stateAt = (s, wallMs) => {
    const match = L.matchOf(s);
    const t = clamp(L.tAt(s, wallMs), 0, match.time.h2.end);
    const E = R.engine;
    const scenario = E.actualScenario(match);
    return { t, match, scenario, state: E.stateAt(match, scenario, t), running: L.isRunning(s) };
  };
})();
