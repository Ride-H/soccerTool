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
    pk: [],           // PK コース記録（#189・入力順）
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
  //   type: goal / shot / corner / yellow / red / foul / penalty（エンジンが解釈する型）
  //   penalty は**試合中の PK**。試合時間 t を持ち、得点・シュートと同列に試合の記録へ入る。
  //   PK 戦（withPk）とは別物 — あちらは試合時間を持たず、順番 n だけを持つ。
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

  /* ---------------- 試合中の PK（#196） ----------------
     PK 戦（下の withPk）と混ぜない。違いは:
       試合中の PK … 試合時間 t を持つ／同じチームに連続で与えられ得る／危険度に効く
       PK 戦       … 試合時間を持たない／順番 n で交互／危険度に関係しない
     コースと結果は PK 戦と同じ格子・同じ意味で持つ（記録の読み方を揃えるため）。 */
  L.withPenalty = (s, ev) => {
    if (!ev || ev.t == null) throw new Error("試合中の PK には t が必要");
    if (!ev.team) throw new Error("試合中の PK には team が必要");
    if (typeof ev.scored !== "boolean") throw new Error("試合中の PK には scored（○×）が必要");
    if (ev.cell != null && (!Number.isInteger(ev.cell) || ev.cell < 0 || ev.cell >= L.PK_COLS * L.PK_ROWS))
      throw new Error("試合中の PK の cell が範囲外");
    return L.withEvent(s, { ...ev, type: "penalty" });
  };

  /* ---------------- PK 戦のコース記録（#189） ----------------
     規律は docs/RESPONSIBLE_ANALYSIS.md §6。ここに入るのは**観測して記帳した事実**だけで、
     確率も次の 1 本の予想も持たない。集計は本数と母数で返す（pkTally）。 */

  // ゴールマウス 7.32×2.44m を 3×3 に切る。番号は 0=低左 1=低中 2=低右 / 3..5=中段 / 6..8=上段。
  // 5×3 も検討したが、1 セルあたりの本数が 1 本以下になり、分けても傾向が見えにくくなる。
  L.PK_COLS = 3;
  L.PK_ROWS = 3;
  L.PK_GOAL_W = 7.32;
  L.PK_GOAL_H = 2.44;

  // セル番号 → ゴール面上の中心［m］。w は幅方向（キッカーから見て左が負）、h は高さ。
  L.pkCellCenter = (cell) => {
    const c = cell % L.PK_COLS, r = Math.floor(cell / L.PK_COLS);
    return { w: (c - (L.PK_COLS - 1) / 2) * (L.PK_GOAL_W / L.PK_COLS),
      h: (r + 0.5) * (L.PK_GOAL_H / L.PK_ROWS) };
  };

  const PK_SIDE = { L: 1, C: 1, R: 1 };          // 助走側 / GK の動き（S=静止は GK のみ）
  const PK_GK = { L: 1, C: 1, R: 1, S: 1 };

  // rec: { team, kicker, gk, approach, gkMove, cell, scored, approachAt?, gkMoveAt?, kickAt? }
  // 蹴る**前**の観測（助走側・GK の早期の動き）は時刻つきで残す。結果だけを記録しても
  // 「GK が早く倒れるか」は後から見られない。
  L.withPk = (s, rec) => {
    if (!rec || !rec.team) throw new Error("PK 記録には team が必要");
    if (!Number.isInteger(rec.cell) || rec.cell < 0 || rec.cell >= L.PK_COLS * L.PK_ROWS)
      throw new Error("PK 記録の cell が範囲外");
    if (typeof rec.scored !== "boolean") throw new Error("PK 記録には scored（○×）が必要");
    if (rec.approach != null && !PK_SIDE[rec.approach]) throw new Error("助走側は L/C/R");
    if (rec.gkMove != null && !PK_GK[rec.gkMove]) throw new Error("GK の動きは L/C/R/S");
    const pk = s.pk || [];
    return { ...s, pk: [...pk, { n: pk.length + 1, ...rec }] };
  };

  // PK の取り消しは PK の列だけを見る（イベント・交代とは入力の文脈が別）
  L.undoPk = (s) => ((s.pk && s.pk.length) ? { ...s, pk: s.pk.slice(0, -1) } : s);

  // 集計は**本数と母数**で返す。割合は返さない（§6: 確率を表示しない）。
  // source: "shootout"（既定・PK 戦）/ "match"（試合中の PK）/ "both"
  // 数える関数を分けると、片方だけ直る不具合を生む。対象の指定で 1 本にする。
  L.pkTally = (s, filter = {}) => {
    const src = filter.source || "shootout";
    const shootout = src === "match" ? [] : (s.pk || []);
    const inMatch = src === "shootout" ? []
      : (s.events || []).filter((e) => e.type === "penalty" && e.cell != null);
    const rows = [...shootout, ...inMatch].filter((r) =>
      (!filter.team || r.team === filter.team) && (filter.kicker == null || r.kicker === filter.kicker));
    const cells = new Array(L.PK_COLS * L.PK_ROWS).fill(0);
    let scored = 0;
    for (const r of rows) { cells[r.cell]++; if (r.scored) scored++; }
    return { cells, total: rows.length, scored };
  };

  // 5 本ずつ → 同点ならサドンデス。**PK 戦（s.pk）だけ**を見る。
  // 試合中の PK（events の penalty）は順番を持たないので、ここには入れない。
  L.pkStanding = (s, teams) => {
    const [a, b] = teams;
    const score = { [a]: 0, [b]: 0 }, taken = { [a]: 0, [b]: 0 };
    for (const r of s.pk || []) { taken[r.team] = (taken[r.team] || 0) + 1; if (r.scored) score[r.team]++; }
    const n = (s.pk || []).length;
    const next = n % 2 === 0 ? a : b;                 // 交互（先攻は teams[0]）
    return { n: n + 1, team: next, score, taken };
  };

  /* ---------------- PK 戦の進行（#191） ----------------
     位置エンジンには載せない。エンジンは 22 人の連続な f(t)、PK 戦は 2 人の逐次離散イベントで
     構造が違う（#179・#137 で、構造に合わないものを載せると較正済みレイヤーが壊れることを実測済み）。
     ここは記録の上に乗る集計だけを持つ。成否の予測はしない（#187 §6）。 */
  L.PK_REGULAR = 5;                        // 5 本ずつ → 同点ならサドンデス

  // 決着判定。返値 { decided, winner, phase, score, taken, reason }
  //   phase: "regular"（5 本ずつ）/ "sudden"（サドンデス）
  L.pkResult = (s, teams) => {
    const [a, b] = teams;
    const N = L.PK_REGULAR;
    const score = { [a]: 0, [b]: 0 }, taken = { [a]: 0, [b]: 0 };
    for (const r of s.pk || []) { taken[r.team]++; if (r.scored) score[r.team]++; }
    const rest = (t) => Math.max(0, N - taken[t]);
    const base = { score, taken };
    if (taken[a] <= N && taken[b] <= N) {
      // 残り本数で追いつけなくなったら、5 本を待たずに決着。
      // 両者が 5 本蹴り終えている場合は「打ち切り」ではなく通常の決着。
      const early = taken[a] < N || taken[b] < N;
      const why = early ? "打ち切り" : `${N} 本ずつ`;
      if (score[a] > score[b] + rest(b)) return { decided: true, winner: a, phase: "regular", reason: why, ...base };
      if (score[b] > score[a] + rest(a)) return { decided: true, winner: b, phase: "regular", reason: why, ...base };
      if (taken[a] < N || taken[b] < N) return { decided: false, phase: "regular", ...base };
      if (score[a] !== score[b])
        return { decided: true, winner: score[a] > score[b] ? a : b, phase: "regular", reason: "5 本ずつ", ...base };
      return { decided: false, phase: "sudden", ...base };
    }
    // サドンデス: 同数蹴った時点で差がついていれば決着
    if (taken[a] === taken[b] && score[a] !== score[b])
      return { decided: true, winner: score[a] > score[b] ? a : b, phase: "sudden", reason: "サドンデス", ...base };
    return { decided: false, phase: "sudden", ...base };
  };

  /* 蹴る順番の計画。記録（pk）とは別に持つので、順番を後から変えても
     記録済みの本は 1 本も動かない。 */
  L.withPkOrder = (s, team, nos) => {
    if (!team) throw new Error("順番には team が必要");
    if (!Array.isArray(nos)) throw new Error("順番は背番号の配列");
    return { ...s, pkOrder: { ...(s.pkOrder || {}), [team]: nos.slice() } };
  };

  // n 本目（1 始まり）にそのチームが蹴る予定の背番号。計画が無ければ null。
  L.pkPlanned = (s, team, n) => {
    const list = (s.pkOrder || {})[team];
    if (!list || !list.length) return null;
    return list[(n - 1) % list.length] ?? null;
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
      } else if (ev.type === "penalty") {
        // ボールは PK スポット（ゴールラインから 11m）に据えられ、そこから蹴られる。
        // 決まればゴールへ、外れ/セーブなら枠付近で止まる。
        ballAnchors.push({ t: Math.max(0, t - 10), x: d * 41.5, y: 0, hold: 7 });
        if (ev.scored) {
          ballAnchors.push({ t, x: d * 52.2, y, hold: 4 });
          ballAnchors.push({ t: Math.min(t + RESTART, END - 5), x: 0, y: 0, hold: 6 });
        } else {
          ballAnchors.push({ t, x: d * 52.0, y: y * 2.5, hold: 2 });
        }
        pin(t - L.PRE_ROLL);
        possessionKP.push([Math.max(0, t - 40), (ev.team === kA ? +1 : -1) * 0.7]);
        possessionKP.push([t, (ev.team === kA ? +1 : -1) * (ev.scored ? 0.95 : 0.6)]);
        possessionKP.push([Math.min(t + 60, END), 0]);
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
    // 決まった PK は得点。PK 戦の成否はここに入れない（試合のスコアではない）。
    for (const ev of events)
      if (score[ev.team] != null && (ev.type === "goal" || (ev.type === "penalty" && ev.scored))) score[ev.team]++;

    const subsActual = { [kA]: [], [kB]: [] };
    for (const sb of s.subs) if (subsActual[sb.team]) subsActual[sb.team].push({ t: sb.t, min: minLabel(s, sb.t), out: sb.out, in: sb.in });

    // 試合 ID は入力内容で変える。各層のキャッシュは meta.id で引くので、
    // 内容が変わったのに ID が同じだと**古い世界が返り続ける**（入力しても何も起きない）。
    // 名簿（cfg）も ID に含める。含めないと、チーム名や選手を変えても ID が同じままで
    // 各層のキャッシュが古い世界を返し続ける（UI 側も「変わっていない」と判断して描き直さない）。
    // #196: 入力を**まるごと**ハッシュに入れる。項目を手で並べていたため、あとから足した
    // フィールド（PK の scored / cell）がハッシュに入らず、成功と失敗で同じ ID になり
    // 古い世界が返っていた（#182 と同じ型の不具合を、同じ場所で再発させた）。
    // 手で並べる限りフィールドを足すたびに同じ穴が空くので、全体を入れる。
    let h = N.seedOf(JSON.stringify(s.cfg));
    for (const ev of s.events) h = N.seedOf(`${h}|${JSON.stringify(ev)}`);
    for (const sb of s.subs) h = N.seedOf(`${h}|s${JSON.stringify(sb)}`);
    return {
      ...base,
      // id は入力内容で変える（各層のキャッシュが meta.id で引くため。同じ ID だと古い世界が返り続ける）。
      // seedId は入力に依らず固定＝世界生成のシードは変わらない（過去が作り直されない・#177）。
      meta: { ...base.meta, id: `live-${s.cfg.seed || kA + kB}-${(h >>> 0).toString(36)}`,
        seedId: `live-${s.cfg.seed || kA + kB}`, score, live: true, calibrated: false },
      events, ballAnchors, possessionKP, subsActual,
    };
  };

  /* ---------------- ハーフタイム（#183）----------------
     前半終了は必ず起きるので、人が時計合わせで入れ直す必要は無い。
     壁時計が前半終了を越えていたら、**その瞬間の時刻ちょうど**で止めた session を返す。
     純関数（同じ入力なら同じ結果）にしてあるので、毎フレーム呼んでよい。 */
  /* ---------------- ピリオドの区切り（#183 → #202 で一般化） ----------------
     前半終了だけでなく、後半終了（延長へ入るか決める）・延長前半終了にも同じ処理が要る。
     h2 専用に書いていたものを、どのピリオド境界でも効く形へ広げた。
     ピリオドの順序は h1 → h2 → h3 → h4。 */
  const PERIODS = ["h1", "h2", "h3", "h4"];
  const periodsOf = (match) => PERIODS.filter((k) => match && match.time && match.time[k]);

  // 次に始めるピリオド（いま止まっている区切りの次）。無ければ null。
  const nextPeriod = (s, match, wallMs) => {
    const ks = periodsOf(match);
    const t = L.tAt(s, wallMs);
    for (let i = 0; i < ks.length - 1; i++) {
      const cur = match.time[ks[i]];
      // 開始済みのピリオドは飛ばす（時計の区間に印が付く）。
      // h2 の印は #183 からの互換 — 保存済みのセッションは p を持たない。
      if (s.clock.some((c) => c.p === ks[i + 1] || (ks[i + 1] === "h2" && c.h2))) continue;
      if (t >= cur.end - 0.5) return ks[i + 1];
    }
    return null;
  };

  // 走っている時計が、いま居るピリオドの終わりに達したら止める（達していなければ null）
  L.atHalfBreak = (s, match, wallMs) => {
    if (!L.isRunning(s) || !match || !match.time || !match.time.h1) return null;
    const ks = periodsOf(match);
    const t = L.tAt(s, wallMs);
    for (let i = 0; i < ks.length - 1; i++) {
      const end = match.time[ks[i]].end;
      // 次のピリオドを始めたら、その境界では二度と止めない。
      // 境界の時刻は前後で同じなので、時刻の比較だけだと開始直後にまた止まる（#183 で実機発覚）。
      if (s.clock.some((c) => c.p === ks[i + 1] || (ks[i + 1] === "h2" && c.h2))) continue;
      if (t < end) continue;
      const seg = s.clock[s.clock.length - 1];
      const wallAtEnd = seg.wall + (end - seg.t) * 1000;
      return { ...s, clock: [...s.clock, { wall: wallAtEnd, t: end, rate: 0 }] };
    }
    return null;
  };

  // 次のピリオドへ進む（区切りで止まっている状態から、その先頭で再開する）
  L.startSecondHalf = (s, match, wallMs) => {
    const k = nextPeriod(s, match, wallMs) || "h2";
    const t0 = match && match.time && match.time[k] ? match.time[k].start : L.tAt(s, wallMs);
    // h2 の印は #183 からの互換（保存済みのセッションが持っている）
    return { ...s, clock: [...s.clock, { wall: wallMs, t: t0, rate: 1, p: k, ...(k === "h2" ? { h2: true } : {}) }] };
  };

  // ピリオドの区切りで止まっているか（UI が「◯◯開始」を出す判断に使う）。
  // 返値は次のピリオドのキー（null なら区切りではない）。
  L.breakAt = (s, match, wallMs) => {
    if (!match || !match.time || L.isRunning(s)) return null;
    return nextPeriod(s, match, wallMs);
  };

  // 互換: 前半終了で止まっているか
  L.isAtHalfBreak = (s, match, wallMs) => L.breakAt(s, match, wallMs) === "h2";

  // 名簿（cfg）の差し替え。入力済みのイベント・交代・時計はそのまま持ち越す。
  // 世界は cfg から作り直されるので、チーム名や選手名を後から直しても記録は消えない。
  L.withCfg = (s, cfg) => ({ ...s, cfg });

  /* ---------------- 保存・復帰（#181）----------------
     保存の仕組みは作らない。既存のバンドル（scenlib.serializeBundle）へ載せるための
     「素の値へ落とす／戻す」だけをここに置く。復帰した時計は必ず止まっている
     （読み込んだ瞬間に試合時刻が走り出すと、見ていない間の時間が進んでしまう）。 */
  L.toObj = (s) => ({ cfg: s.cfg, clock: s.clock.map((c) => ({ wall: c.wall, t: c.t, rate: c.rate, ...(c.h2 ? { h2: true } : {}), ...(c.p ? { p: c.p } : {}) })),
    events: s.events.map((e) => ({ ...e })), subs: s.subs.map((x) => ({ ...x })),
    pk: (s.pk || []).map((r) => ({ ...r })),
    ...(s.pkOrder ? { pkOrder: JSON.parse(JSON.stringify(s.pkOrder)) } : {}) });

  L.fromObj = (o, wallMs) => {
    if (!o || !o.cfg) return null;
    const s = { cfg: o.cfg, clock: [], events: (o.events || []).map((e) => ({ ...e })).sort((a, b) => a.t - b.t),
      subs: (o.subs || []).map((x) => ({ ...x })).sort((a, b) => a.t - b.t),
      pk: (o.pk || []).map((r) => ({ ...r })),
      ...(o.pkOrder ? { pkOrder: JSON.parse(JSON.stringify(o.pkOrder)) } : {}) };
    // 保存時点の試合時刻を求め、その時刻で「停止」の 1 区間だけを持たせる
    const saved = { ...s, clock: (o.clock || []).map((c) => ({ ...c })) };
    const at = (o.clock && o.clock.length) ? L.tAt(saved, o.savedAt ?? Date.now()) : 0;
    // どのピリオドまで開始したかを引き継ぐ（復帰後にまた区切りで止まらないように）。
    // #202: h2 だけでなく延長（h3/h4）の印も引き継ぐ。落とすと復帰のたびに
    // 「延長前半終了」へ戻り、同じ区切りで何度も止まる。
    const wasH2 = (o.clock || []).some((c) => c.h2);
    const started = [...new Set((o.clock || []).map((c) => c.p).filter(Boolean))];
    const last = started.length ? started[started.length - 1] : null;
    s.clock = [{ wall: wallMs ?? Date.now(), t: at, rate: 0,
      ...(wasH2 ? { h2: true } : {}), ...(last ? { p: last } : {}) }];
    // 途中のピリオドの印も残す（h4 まで進んでいたら h2・h3 も開始済み）
    for (const k of started.slice(0, -1)) s.clock.unshift({ wall: s.clock[0].wall, t: at, rate: 0, p: k });
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
