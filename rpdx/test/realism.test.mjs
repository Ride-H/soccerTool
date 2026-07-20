// リアリズム回帰 — 佐野ゴールのスプリント再現・プレッシャー距離・リスタートの受け手
import { test } from "node:test";
import assert from "node:assert/strict";
import { RPDX, MATCH, MATCHES } from "./load.mjs";

const E = RPDX.engine;
const act = (m) => E.actualScenario(m);
const m1s = (mm, ss = 0) => mm * 60 + ss;

test("realism: 得点後 — 全員が自陣へ帰陣してからキックオフ", () => {
  const sc = act(MATCH);
  for (const g of MATCH.events.filter(e => e.type === "goal")) {
    const rt = MATCH.ballAnchors.find(a => a.x === 0 && a.y === 0 && a.t > g.t && a.t < g.t + 130);
    assert.ok(rt, `${g.min} 再開アンカー`);
    const st = E.stateAt(MATCH, sc, rt.t + 1);
    let okN = 0, n = 0;
    for (const p of st.players) {
      if (!p.onPitch || p.entering) continue;
      const dir = MATCH.dir[p.team][st.half === 1 ? "h1" : "h2"];
      n++;
      if (dir > 0 ? p.x <= 1.5 : p.x >= -1.5) okN++;    // 自陣（1.5m許容）
    }
    assert.ok(okN >= n - 2, `${g.min} 自陣帰還 ${okN}/${n}`);
  }
});

test("realism: 佐野ゴール — BRAビルドアップ→佐野のパスカット→独走保持", () => {
  const sc = act(MATCH);
  assert.equal(E.carrierAt(MATCH, sc, m1s(28, 34)).team, "BRA", "カット前はBRA保持");
  for (const ss of [42, 45, 48, 51]) {
    const c = E.carrierAt(MATCH, sc, m1s(28, ss));
    assert.equal(c.team + c.no, "JPN24", `28:${ss} は佐野が保持`);
  }
  let cut = null;
  for (let t = m1s(28, 38); t <= m1s(28, 44); t += 0.25) {
    const d = RPDX.duel.tackleAt(MATCH, sc, t);
    if (d && d.winner.team === "JPN" && d.winner.no === 24) { cut = d; break; }
  }
  assert.ok(cut, "カットが接触（インターセプト）として検出される");
});

test("realism: 佐野ゴール — ドリブル中ボールが足元2.2m以内（離れない）", () => {
  const sc = act(MATCH);
  for (let t = m1s(28, 43); t <= m1s(28, 51.5); t += 0.5) {
    const st = E.stateAt(MATCH, sc, t);
    const sano = st.players.find(p => p.onPitch && p.team === "JPN" && p.no === 24);
    const d = Math.hypot(sano.x - st.ball.x, sano.y - st.ball.y);
    assert.ok(d < 2.2, `t=${t} ボール距離 ${d.toFixed(2)}m`);
  }
});

test("realism: 佐野ゴール — 伊東が右を並走・前田が左に張る", () => {
  const sc = act(MATCH);
  const ito = E.stateFrozenPos(MATCH, sc, "JPN", 14, 1732);
  const maeda = E.stateFrozenPos(MATCH, sc, "JPN", 11, 1732);
  assert.ok(ito.x < -26 && ito.y > 4, `伊東 (${ito.x.toFixed(1)}, ${ito.y.toFixed(1)})`);
  assert.ok(maeda.x < -26 && maeda.y < -4, `前田 (${maeda.x.toFixed(1)}, ${maeda.y.toFixed(1)})`);
});

test("realism: 集団サージ — カウンターで最終ライン撤退・前線押上げが同時に起きる", () => {
  const sc = act(MATCH);
  const meanX = (t, team, roles) => {
    const st = E.stateAt(MATCH, sc, t);
    const ps = st.players.filter(p => p.onPitch && p.team === team && roles.includes(p.role));
    return ps.reduce((s, p) => s + p.x, 0) / ps.length;
  };
  // KP 1690:-0.3 → 1733:-1.0 の急流（日本のカウンター）
  const braDef0 = meanX(1692, "BRA", ["CB", "FB"]);
  const braDef1 = meanX(1714, "BRA", ["CB", "FB"]);
  assert.ok(braDef1 < braDef0 - 2, `BRA最終ライン撤退 ${braDef0.toFixed(1)} → ${braDef1.toFixed(1)}`);
  const jpnFw0 = meanX(1692, "JPN", ["ST", "W"]);
  const jpnFw1 = meanX(1714, "JPN", ["ST", "W"]);
  assert.ok(jpnFw1 < jpnFw0 - 2, `JPN前線押上げ ${jpnFw0.toFixed(1)} → ${jpnFw1.toFixed(1)}`);
});

test("realism: チェーン・コーナーでボックスが密集（攻3+守4）", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = act(m);
    const range = E.playedRange(m);
    let checked = 0;
    for (let t = range.t0 + 5; t < range.t1 && checked < 2; t += 2) {
      const c = E.carrierAt(m, sc, t);
      if (!c || c.restart !== "corner" || c.mode !== "hold") continue;
      const tC = c.seg.tf + c.seg.rdelay * 0.85;
      if (Math.abs(t - tC) > 2.5) continue;
      const st = E.stateAt(m, sc, tC);
      const gx = Math.sign(c.seg.rx) * 52.5;
      let atk = 0, def = 0;
      for (const p of st.players) {
        if (!p.onPitch) continue;
        if (Math.abs(p.x - gx) < 18 && Math.abs(p.y) < 20.2) {
          if (p.team === c.team) atk++; else def++;
        }
      }
      assert.ok(atk >= 3, `${m.meta.id} corner攻撃側 ${atk}`);
      assert.ok(def >= 4, `${m.meta.id} corner守備側 ${def}`);
      checked++;
      t = c.seg.t1 + 5;
    }
    assert.ok(checked >= 1, `${m.meta.id} コーナー密集検証 ${checked}件`);
  }
});

test("realism: 45分の直接FK — 守備側の壁が形成される", () => {
  const sc = act(MATCH);
  const ev = MATCH.events.find(e => e.type === "yellow" && e.no === 15);   // 45' 鎌田（BRAのFK）
  const spot = { x: 20, y: -14 };
  const d = Math.hypot(52.5 - spot.x, spot.y);
  const ux = (52.5 - spot.x) / d, uy = -spot.y / d;
  const wx = spot.x + ux * 9.15, wy = spot.y + uy * 9.15;
  const st = E.stateAt(MATCH, sc, ev.t + 9);
  let wall = 0;
  for (const p of st.players) {
    if (!p.onPitch || p.team !== "JPN") continue;
    if (Math.hypot(p.x - wx, p.y - wy) < 4.5) wall++;
  }
  assert.ok(wall >= 2, `壁 ${wall}人（地点${wx.toFixed(1)},${wy.toFixed(1)}）`);
});

test("realism: 佐野29'ゴール — 独走がスプリント速度（≥20km/h）で再現される", () => {
  const sc = act(MATCH);
  let peak = 0;
  for (let t = 1726; t <= 1732.5; t += 0.25) {
    peak = Math.max(peak, E.speedKmh(MATCH, sc, "JPN", 24, t));
  }
  assert.ok(peak >= 20 && peak < 35.7, `佐野ピーク ${peak.toFixed(1)}km/h`);
});

test("realism: 佐野29'ゴール — カゼミーロが帰陣チェイス（≥13km/h）・終端で佐野の背後", () => {
  const sc = act(MATCH);
  let peak = 0;
  for (let t = 1726; t <= 1732.5; t += 0.25) {
    peak = Math.max(peak, E.speedKmh(MATCH, sc, "BRA", 5, t));
  }
  assert.ok(peak >= 13, `カゼミーロ・チェイス ${peak.toFixed(1)}km/h`);
  // シュート時点: 佐野が前・カゼミーロが後方（抜き去りの構図）
  const sano = E.stateFrozenPos(MATCH, sc, "JPN", 24, 1732);
  const case5 = E.stateFrozenPos(MATCH, sc, "BRA", 5, 1732);
  assert.ok(sano.x < case5.x - 3, `佐野${sano.x.toFixed(1)} < カゼミーロ${case5.x.toFixed(1)}−3`);
});

for (const m of Object.values(MATCHES)) {
  const id = m.meta.id;

  test(`realism[${id}]: プレッシャー — オープンプレー保持者への最近接守備者は中央値2〜6m`, () => {
    const sc = act(m);
    const range = E.playedRange(m);
    const ds = [];
    for (let t = range.t0 + 60; t < range.t1; t += 17) {
      const st = E.stateAt(m, sc, t);
      const c = st.carrier;
      if (!c || c.mode !== "hold" || c.u < 0.85) continue;
      if (c.restart || st.ball.free < 0.9) continue;
      const holder = st.players.find(p => p.onPitch && p.team === c.team && p.no === c.no);
      if (!holder) continue;
      let dn = 1e9;
      for (const p of st.players) {
        if (!p.onPitch || p.team === c.team || p.role === "GK") continue;
        dn = Math.min(dn, Math.hypot(p.x - holder.x, p.y - holder.y));
      }
      ds.push(dn);
    }
    ds.sort((a, b) => a - b);
    const med = ds[ds.length >> 1];
    assert.ok(ds.length > 80, `サンプル ${ds.length}`);
    assert.ok(med >= 1.5 && med <= 6, `プレス距離中央値 ${med.toFixed(2)}m`);
  });

  test(`realism[${id}]: スローイン/GKの次の保持は同チームの別選手（自己パスに見えない）`, () => {
    const sc = act(m);
    const range = E.playedRange(m);
    let ok = 0, all = 0;
    let prev = null;
    for (let t = range.t0 + 5; t < range.t1; t += 1) {
      const c = E.carrierAt(m, sc, t);
      if (!c) { prev = null; continue; }
      const segKey = c.seg.t0;
      if (prev && prev.segKey !== segKey) {
        if (prev.restart === "throwin" || prev.restart === "goalkick") {
          all++;
          if (c.team === prev.team && c.no !== prev.no) ok++;
        }
      }
      prev = { segKey, team: c.team, no: c.no, restart: c.restart };
    }
    assert.ok(all >= 20, `リスタート後継 ${all}`);
    // 記録イベント拘束窓（ゴール/FK等）と重なった場合のみ例外を許容
    assert.ok(ok / all >= 0.9, `同チーム別選手率 ${ok}/${all}`);
  });

  test(`realism[${id}]: コーナーの次の保持者はゴール前（クロスの絵になる）`, () => {
    const sc = act(m);
    const range = E.playedRange(m);
    let near = 0, all = 0;
    let prev = null;
    for (let t = range.t0 + 5; t < range.t1; t += 1) {
      const c = E.carrierAt(m, sc, t);
      if (!c) { prev = null; continue; }
      const segKey = c.seg.t0;
      if (prev && prev.segKey !== segKey && prev.restart === "corner") {
        all++;
        const p = E.stateFrozenPos(m, sc, c.team, c.no, c.seg.tf + 0.1);
        const gx = Math.sign(prev.rx) * 52.5;
        if (Math.hypot(p.x - gx, p.y) < 30) near++;
      }
      prev = { segKey, restart: c.restart, rx: c.seg.rx };
    }
    if (all >= 3) assert.ok(near / all >= 0.6, `ゴール前受け ${near}/${all}`);
  });
}

/* ================= #28 相互分離（社会力の斥力・重なり解消） ================= */

test("#28 separation: ランダムな重なりが解消（保持者ペア・祝祭除外で最小距離≥0.25m）", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = E.actualScenario(m), range = E.playedRange(m);
    const goals = m.events.filter(e => e.type === "goal").map(e => e.t);
    // 交代直後45sはフェーズブレンド（新旧スロットのlerp混合）— 分離の視野外なので除外。
    // #141: 退場のリシェイプ（10人化）も同型の45sブレンド窓なので同様に除外する。
    const subTs = [];
    for (const team of E.teamKeys(m)) {
      for (const sub of (sc.subs && sc.subs[team]) || []) subTs.push(sub.t);
      for (const o of E.outagesOf(m, sc, team)) subTs.push(o.t);
    }
    let n05 = 0, minD = 99, n = 0;
    for (let t = range.t0 + 30; t < range.t1; t += 7) {
      if (goals.some(g => t >= g && t <= g + 45)) continue;
      if (subTs.some(st2 => t >= st2 && t <= st2 + 46)) continue;
      const st = E.stateAt(m, sc, t);
      const ps = st.players.filter(p => p.onPitch && !p.entering);
      const cKey = st.carrier && st.carrier.mode === "hold" ? st.carrier.team + ":" + st.carrier.no : null;
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        if (cKey && (a.team + ":" + a.no === cKey || b.team + ":" + b.no === cKey)) continue;
        // GKペアは除外: GKは実ボール微調整（後段）が分離の視野外 + ゴール前混雑は正当な近接
        if (a.role === "GK" || b.role === "GK") continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        n++; if (d < 0.5) n05++; if (d < minD) minD = d;
      }
    }
    assert.ok(n > 100000, `サンプル ${n}`);
    assert.ok(minD >= 0.25, `${m.meta.id} 最小ペア距離 ${minD.toFixed(2)}m（導入前は~0.02m）`);
    assert.ok(n05 <= 12, `${m.meta.id} d<0.5m ペア ${n05}（導入前は29）`);
  }
});

test("#28 separation: 決定論・変位上限0.8m・遠いペアには作用しない", () => {
  const m = MATCH, sc = E.actualScenario(m);
  for (const t of [700, 2500, 4600]) {
    const a = E.stateAt(m, sc, t).players.map(p => [p.no, p.team, p.x, p.y]);
    E.clearCaches();
    const b = E.stateAt(m, sc, t).players.map(p => [p.no, p.team, p.x, p.y]);
    assert.deepEqual(a, b, `決定論 @${t}`);
  }
});

/* ================= #30 意図的オフボールラン（オーバーラップ / 裏抜け） ================= */

test("#30 runs: 攻勢×ボールサイドで FB/WB が押し上がる（オーバーラップの非対称性）", () => {
  let onDepth = 0, onN = 0, offDepth = 0, offN = 0;
  for (const m of Object.values(MATCHES)) {
    const sc = E.actualScenario(m), range = E.playedRange(m);
    for (let t = range.t0 + 60; t < range.t1; t += 9) {
      const st = E.stateAt(m, sc, t);
      const bs = E.ballSlowAt(m, t);
      for (const team of E.teamKeys(m)) {
        const dir = m.dir[team][st.half === 1 ? "h1" : "h2"];
        const P = E.possessionAt(m, t) * E.attackSign(m, team);
        const prog = (dir * bs.x + 52.5) / 105;
        if (P < 0.15 || prog < 0.62) continue;            // 攻勢×前進局面のみ
        const fbs = st.players.filter(p => p.onPitch && p.team === team && (p.role === "FB" || p.role === "WB"));
        for (const p of fbs) {
          const sameSide = (p.y * bs.y) > 0 && Math.abs(bs.y) > 8;
          const depth = dir * p.x;
          if (sameSide) { onDepth += depth; onN++; } else { offDepth += depth; offN++; }
        }
      }
    }
  }
  assert.ok(onN > 30 && offN > 30, `サンプル on=${onN} off=${offN}`);
  assert.ok(onDepth / onN > offDepth / offN + 1.0,
    `ボールサイドFB深度 ${(onDepth / onN).toFixed(1)}m > 逆サイド ${(offDepth / offN).toFixed(1)}m +1m`);
});

test("#30 runs: 攻勢時に前線がオフサイド境界へ近づく（裏抜けの脅威）・境界は破らない", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = E.actualScenario(m), range = E.playedRange(m);
    const gapAtk = [], gapDef = [];
    for (let t = range.t0 + 60; t < range.t1; t += 9) {
      const st = E.stateAt(m, sc, t);
      const bs = E.ballSlowAt(m, t);
      for (const team of E.teamKeys(m)) {
        const dir = m.dir[team][st.half === 1 ? "h1" : "h2"];
        const P = E.possessionAt(m, t) * E.attackSign(m, team);
        const prog = (dir * bs.x + 52.5) / 105;
        const off = E.offsideLineAt(m, sc, team, t);
        const fwds = st.players.filter(p => p.onPitch && p.team === team && ["ST", "W"].includes(p.role));
        if (!fwds.length) continue;
        const maxDepth = Math.max(...fwds.map(p => dir * p.x));
        const gap = off.offsideDepth - maxDepth;          // 小さいほど境界に近い
        if (P > 0.15 && prog > 0.6) gapAtk.push(gap);
        else if (P < -0.15) gapDef.push(gap);
      }
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    assert.ok(gapAtk.length > 20 && gapDef.length > 20, `${m.meta.id} サンプル atk=${gapAtk.length} def=${gapDef.length}`);
    assert.ok(mean(gapAtk) < mean(gapDef),
      `${m.meta.id} 攻勢時ギャップ ${mean(gapAtk).toFixed(1)}m < 守勢時 ${mean(gapDef).toFixed(1)}m`);
  }
});

/* ================= #44 スタミナ→行動フィードバック ================= */

test("#44 fatigue: フル出場選手の平均速度が終盤に低下（8〜45%・全チーム）", () => {
  for (const m of Object.values(MATCHES)) {
    const sc = E.actualScenario(m), range = E.playedRange(m);
    for (const team of E.teamKeys(m)) {
      const full = [];
      for (const p of m.teams[team].squad) {
        const pr = E.presenceOf(m, sc, team, p.no);
        if (pr && pr.from <= range.t0 + 1 && pr.to >= range.t1 - 1 && p.pos !== "GK") full.push(p.no);
      }
      assert.ok(full.length >= 3, `${m.meta.id} ${team} フル出場 ${full.length}人`);
      let e = 0, eN = 0, l = 0, lN = 0;
      for (const no of full) {
        for (let t = range.t0 + 120; t < range.t0 + 1000; t += 20) { e += E.speedKmh(m, sc, team, no, t); eN++; }
        for (let t = range.t1 - 1000; t < range.t1 - 30; t += 20) { l += E.speedKmh(m, sc, team, no, t); lN++; }
      }
      const decline = 1 - (l / lN) / (e / eN);
      assert.ok(decline > 0.08 && decline < 0.45,
        `${m.meta.id} ${team} 終盤速度低下率 ${(decline * 100).toFixed(1)}%（疲労→行動FB）`);
    }
  }
});

test("#44 fatigue: 疲労は presence 起点 — 途中出場選手は入場直後フレッシュ（低疲労）", () => {
  const m = MATCH, sc = E.actualScenario(m);
  // 66' マルティネッリ(BRA22) 投入: 入場5分後の疲労 < フル出場カゼミーロ(BRA5)の同時刻疲労
  const t = m.time.h2.start + (66 - 45) * 60 + 300;
  const fSub = E.fatigueOf(m, sc, "BRA", 22, t);
  const fFull = E.fatigueOf(m, sc, "BRA", 8, t);   // B.ギマランイス（フル出場）
  assert.ok(fSub < fFull * 0.45, `sub ${fSub.toFixed(3)} << full ${fFull.toFixed(3)}`);
});
