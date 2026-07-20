# マッチパック手順書 — 他の試合・チーム・選手への切替と追加

RPD-X は「マッチパック」（`rpdx/src/data_match*.mjs`）を置くだけで複数の実試合を
切り替えて解析できる。この手順書は、**新しい試合（チーム・選手）を検証済み品質で
追加する完全な手順**を定義する。既定試合（ブラジル×日本）には一切手を触れない。

- 切替 UI: ビューバーの試合セレクタ（登録が2試合以上で自動表示）
- URL 直リンク: `dist/rpdx.html?match=<試合ID>`（ヘッドレス検証・共有に使用）
- 追加方法: `rpdx/src/data_match_<slug>.mjs` を1ファイル追加 → ビルド（自動同梱）

---

## 0. 原則（不可侵）

1. **事実とモデルの分離** — 背番号・氏名・XI・交代・得点・警告・スタッツ・会場は
   「事実」。複数ソースで照合し、出典をファイル冒頭コメントに記す。
   座標アンカー・能力値・ポゼッション波形は「モデル推定」。`meta.note` にその旨を明記する。
2. **複数ソース照合** — 事実データは最低2ソース（例: FIFA 公式 + Wikipedia wikitext、
   ESPN、Al Jazeera）。相互不一致が残る項目は採用しない（または注記して保守的に）。
   Wikipedia は `curl "https://en.wikipedia.org/wiki/<記事名>?action=raw"` の
   wikitext 取得が長大記事でも切断されず最良。
3. **パイプライン不変** — 単一HTML・依存ゼロ・file:// 動作・既存テスト green を維持。
   既定試合の挙動・URL・見た目を変えない。
4. **公開ゲート** — 公開リポへ出す前に公開前スキャン（秘密/PII/絶対パス/内部参照ID = 0件）
   を通す。

## 1. 事実データの収集

集めるもの（チェックリスト）:

- [ ] 大会・ステージ・日付・会場・観衆・主審・MOM
- [ ] 最終スコアと得点（分・得点者・アシスト・状況の記述）
- [ ] 両チームの先発XI（背番号・氏名・ポジション）とフォーメーション
- [ ] 交代（分・OUT/IN の背番号）— 交代窓の規則整合（5人・3窓・HT非カウント）
- [ ] 警告・退場（分・背番号）
- [ ] スタッツ（支配率・シュート・枠内・xG・パス等）
- [ ] キックオフがどちらか（前後半）・前後半のアディショナルタイム（分）

推奨ソース: FIFA 公式マッチセンター / Wikipedia 該当ラウンド記事（wikitext）/
ESPN（gameId）/ Al Jazeera・BBC のライブブログ（ゴールの状況記述が得点再現アンカーの設計材料になる）。

## 2. ファイル作成

`rpdx/src/data_match.mjs`（既定試合）をテンプレートとしてコピーし、
`rpdx/src/data_match_<slug>.mjs` を作る。**必ず守る構造**:

```js
(() => {
  const R = (globalThis.RPDX ??= {});
  R.data ??= {};
  R.data.MATCHES ??= {};
  R.data.MATCHES["<試合ID>"] = { meta: { id: "<試合ID>", ... }, ... };
  // R.data.MATCH には触れない（既定試合は data_match.mjs だけが設定する）
})();
```

主要フィールド:

| フィールド | 内容 | 事実/モデル |
|---|---|---|
| `meta` | 大会・スコア・会場・主審・観衆・`note` | 事実（noteに分離を明記） |
| `time.h1/h2` | 実プレー秒軸。`end = start + 2700 + AT秒` | 事実（AT分） |
| `time.h3/h4`（任意） | 延長前後半。無い試合は完全に従来経路（省略可）。`h3.clock0=5400`, `h4.clock0=6300`。時計は 105+/120+ 表示に自動対応 | 事実（延長AT分） |
| `outagesActual`（任意） | 実試合の退場 `{TEAM:[{t,no,kind}]}`。#81 の10人リシェイプ・在場終了・退場動線・10vs11表示へ合流（GK不可・v1はチーム毎1件） | 事実（分・背番号） |
| `dir` | 前半の攻撃方向（±X）。後半は反転 | 事実（映像/記述から） |
| `teams.*.squad` | `P(no, pos, name, ja, label, born, club, caps, goals, attrs)` | 名簿=事実 / attrs=モデル |
| `teams.*.phases` | 布陣フェーズ（`from`秒, shape, スロット割当） | 事実（記録の陣形） |
| `subsActual` | 交代 `{t, min, out, in}` | 事実 |
| `events` | kickoff/goal/yellow/save/shot/corner/halftime/fulltime — **時刻昇順** | 事実 |
| `possessionKP` | ポゼッション波形 `[t, P]`（P>0=possessionPlus側） | モデル（実測支配率へ較正） |
| `ballAnchors` | ボールの再現アンカー `{t,x,y,hold?}` | モデル（時刻は記録準拠） |
| `playerAnchors` | 得点者等の再現アンカー `{t,team,no,x,y,sigma}` | モデル |
| `stats` | 表示用スタッツ表（各行 `src` に出典） | 事実 |
| `chainForce`（任意） | 保持台本 `[{t0,t1,team,no?}]` — パスカット等の実況ストーリーを保持列へ拘束。`no` 指定でその選手が窓終端まで持ち続ける（独走） | モデル（記述準拠） |
| `possessionShareGain`（任意） | チェーン支配率の較正ノブ（既定0.385）。共通テストの±3〜4%に入るよう調整 | 較正値 |

座標系: `x∈[-52.5,52.5]`, `y∈[-34,34]`。**前半に +X へ攻めるチーム**を `dir.<TEAM>.h1=+1`。
時間軸: 前半 `0..(2700+AT1)`、後半 `h2.start..h2.start+2700+AT2`。
表示分→秒は `m1(mm,ss)` / `m2(mm,ss)` ヘルパをファイル内に定義（テンプレート参照）。

### フォーメーションのシェイプ

`rpdx/src/formations.mjs` の `F.SHAPES` にある形（343/433/4231/442/352/4141/3421/532）
から選ぶ。無い形が必要ならスロット定義を追加する（役割タグ・攻守オフセットを含めて）。

### 能力値 attrs（モデル）

`[pac速度, sta持久, def守備, att攻撃, tec技術, aer空中]` 0-100。
クラブ・出場歴・プレースタイルから保守的に。危険度の支配核が pac に依存する点に注意
（Issue #13）。不明なら `generic.mjs` の BASE_ATTRS 近傍にする。

## 3. ゴール再現アンカーの設計

各ゴールについて実況記述から「起点 → 進行 → シュート地点 → ネット」の3〜5点を
`ballAnchors` に置く（最後は `hold: 4` でネット内静止 → 約55秒後にセンター再開
`{x:0,y:0,hold:6}` — hold 6秒で帰陣完了を待つ）。得点者・アシスト者は `playerAnchors` で
同じ時刻帯に沿わせる。**攻撃方向（そのハーフの dir）と符号を必ず一致させる。**

高精度の独走・スプリント再現のコツ:
- ウェイポイントを**1.5秒間隔・σ1.3**で刻む（まばらな広いσは逐次lerpで滲む）
- シュート後の減速は**非対称σ**で受ける: `{ sigmaL: 1.4, sigmaR: 5 }`（到達鋭く・解放緩やか。
  対称の広いσは**時間を遡って**走路を先食いする）
- ドリブルのボールは選手ウェイポイントの**+1.2m前方**へ（タッチで半歩先を転がる実挙動）
- 保持の筋書きは `chainForce` で拘束（例: ビルドアップ側→カット→`no`指定の独走）

## 4. ポゼッション波形の較正

`possessionKP` を大まかに引き、次で確認する:

```bash
node -e "
import('./rpdx/test/load.mjs').then(({RPDX, MATCHES}) => {
  const m = MATCHES['<試合ID>'];
  const E = RPDX.engine;
  const st = E.possessionStats(m, E.actualScenario(m), E.playedRange(m).t1);
  console.log(st);   // 実測支配率 ±2% 以内を目標
});"
```

ゴール直前は得点チーム側へ波形を振る（危険度曲線がゴールに反応する土台になる）。

## 5. テスト

共通整合テスト（`rpdx/test/packs.test.mjs`）が**レジストリ内の全試合に自動適用**される:
背番号一意・布陣11人・交代規則・イベント昇順・得点数=スコア・アンカー域内・22人整合・決定論。

さらに試合固有のファクトテスト（`rpdx/test/<slug>.test.mjs`）を追加する
（スコア・得点者と分・交代数・警告数など「その試合の事実」を固定する）。

```bash
node --test rpdx/test/*.test.mjs   # 全テスト green が必須
```

## 6. ビルドとヘッドレス確認

```bash
node rpdx/build.mjs   # data_match*.mjs は自動同梱
CHROME=$(ls ~/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-mac-arm64/chrome-headless-shell | tail -1)
"$CHROME" --headless --enable-unsafe-swiftshader --no-sandbox \
  --virtual-time-budget=30000 --window-size=1440,900 \
  --screenshot=shot.png \
  "file://$PWD/dist/rpdx.html?match=<試合ID>&t=<見たい秒>&play=0&shotframes=45"
```

確認項目: スコアボードのチーム名/国旗・XI・イベントトースト・危険度曲線・
PSY パネル（モメンタムが得点で振れるか）・広告ボードの試合表記・試合情報モーダル。

## 7. 公開（任意）

1. 変更ファイルを公開スナップショット（`rpdx-public`）へコピー
2. 公開前スキャンを exit 0 に（秘密/PII/絶対パス/内部参照ID = 0件）
3. noreply アカウントで commit → push（CI がテスト→ビルド→Pages デプロイ）

---

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `packs.test` の交代規則で fail | 交代窓が3を超過（同時刻はまとめて1窓）/ 再入場 / GK交代がGK同士でない |
| ゴールが危険度曲線に出ない | ballAnchors の符号が攻撃方向と逆 / possessionKP が振れていない |
| 選手が変な場所へ走る | playerAnchors の座標符号ミス（そのハーフの dir を再確認） |
| 得点数不一致で fail | events の goal と meta.score のずれ。VAR取消ゴールは events に入れない |
| スコアボードの国旗が単色 | `drawFlag` に国コードを追加（`rpdx/app/ui.mjs`）— 無くても動作はする |
