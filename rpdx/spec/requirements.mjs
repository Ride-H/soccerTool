// 要件レジストリ — 「このツールが約束していること」と「それを何が検証しているか」の対応表。
//
// なぜ必要か: README や Issue に書いた約束が、実際にはどのテストでも見られていない、という
// 抜けが起きる。画面キャプチャ（視覚回帰）は"描けているか"しか見ないので、約束の大半は
// 数値の検査でしか担保できない。ここに約束を列挙し、検証手段を紐づけ、
// `node rpdx/tools/trace.mjs` が「検証手段の無い要件」「消えた/改名されたテストを指す要件」を
// 検出する。要件を足したら必ず検証手段も足す（片方だけの追加は門が落とす）。
//
// check の種類:
//   test   … node --test の 1 テスト（file + name の部分一致で実在を確認）
//   tool   … rpdx/tools 配下の実行物（非ゼロ終了で失敗するもの）
//   visual … rpdx/test/visual/smoke.mjs のシナリオ（描画の回帰）
//   manual … 人の目視でしか確認できないもの（理由を必ず書く。数を増やさない）
// status:
//   held    … 現に満たしていて、検証手段がある
//   open    … まだ満たしていない（対応 Issue あり）。plan に「満たしたとき何で検証するか」を書く
//   waived  … 意図的に検証しない（理由必須）

export const REQUIREMENTS = [
  /* ---------------- 決定論・世界の一貫性 ---------------- */
  {
    id: "DET-01", area: "engine", status: "held",
    text: "純関数 f(t): どの時刻を叩いても同一世界（スクラブ・ジャンプ・順序非依存）",
    source: "README#エンジン保証",
    checks: [
      { kind: "test", file: "engine.test.mjs", name: "決定論: 同一時刻の二重評価が完全一致" },
      { kind: "test", file: "property.test.mjs", name: "生成シナリオ空間で決定論" },
      { kind: "test", file: "property.test.mjs", name: "スクラブ順序非依存" },
    ],
  },
  {
    id: "DET-02", area: "engine", status: "held",
    text: "乱数を使わない（描画層に Math.random を残さない・位相とテクスチャはシード化）",
    source: "README#決定論契約",
    checks: [
      { kind: "test", file: "visualgate.test.mjs", name: "決定論契約: 描画層（app/*.mjs）に Math.random を残さない" },
      { kind: "test", file: "visualgate.test.mjs", name: "決定論契約: 位相・テクスチャがシード化されている" },
    ],
  },
  {
    id: "DET-03", area: "engine", status: "held",
    text: "世界状態ダイジェストが golden と一致（意図しない挙動変化の検出）",
    source: "README#エンジン保証",
    checks: [{ kind: "test", file: "golden.test.mjs", name: "golden: 世界状態ダイジェストがスナップショットと一致" }],
  },

  /* ---------------- 物理・保存則 ---------------- */
  {
    id: "PHY-01", area: "engine", status: "held",
    text: "選手の速度上限 ≤9.9m/s を構成的に保証",
    source: "README#エンジン保証",
    checks: [
      { kind: "test", file: "engine.test.mjs", name: "速度上限: 全選手 9.9m/s 以下" },
      { kind: "test", file: "property.test.mjs", name: "生成シナリオ空間で速度上限" },
    ],
  },
  {
    id: "PHY-02", area: "engine", status: "held",
    text: "常時 11 人×2 チーム・GK 各 1・全員ピッチ内・支配率合計 100%",
    source: "README#エンジン保証",
    checks: [
      { kind: "test", file: "engine.test.mjs", name: "常時11人×2チーム・全員ピッチ内" },
      { kind: "test", file: "property.test.mjs", name: "生成シナリオ空間で保存則" },
    ],
  },
  {
    id: "PHY-03", area: "engine", status: "held",
    text: "ボールは瞬間移動しない（0.1s で ≤5m）・チェーン境界でも C0 連続",
    source: "README#ボール物理",
    checks: [
      { kind: "test", file: "ballphysics.test.mjs", name: "ballAt: 全走査で 0.1s ステップ移動 ≤ 5m" },
      { kind: "test", file: "ballphysics.test.mjs", name: "リスタート解放はセグメント終端までに完了し境界がC0連続" },
    ],
  },
  {
    id: "PHY-04", area: "engine", status: "held",
    text: "ボールのバウンドとマグヌス曲がりが決定論・端点（アンカー時刻）を保存",
    source: "README#ボール物理",
    checks: [
      { kind: "test", file: "ballphysics.test.mjs", name: "bounceHeight: 端点で接地・頂点が h・反発でピークが e² 減衰" },
      { kind: "test", file: "ballphysics.test.mjs", name: "端点（アンカー時刻）でマグヌス曲がりは0" },
      { kind: "test", file: "branchsweep.test.mjs", name: "engine.ballBounceHeight: 全区間で 0.11m 以上" },
    ],
  },
  {
    id: "PHY-05", area: "engine", status: "held",
    text: "選手同士がすり抜けない（最小ペア距離を保つ相互分離）",
    source: "README#相互分離",
    checks: [{ kind: "test", file: "engine.test.mjs", name: "#39: 高速化（基礎位置メモ+空間ハッシュ）後も世界はビット同一" }],
    note: "分離そのものの下限は property の保存則側で見ている。専用の最小距離アサートは PROP-06 で追加予定",
  },

  /* ---------------- 記録との整合（再現性） ---------------- */
  {
    id: "REC-01", area: "data", status: "held",
    text: "背番号・XI・交代・警告・得点が公式記録どおり（収録全試合）",
    source: "README#収録試合",
    checks: [
      { kind: "test", file: "data.test.mjs", name: "" },
      { kind: "test", file: "packs.test.mjs", name: "" },
    ],
  },
  {
    id: "REC-02", area: "engine", status: "held",
    text: "全ゴールの直前に危険度が CRITICAL へ到達する（較正）",
    source: "README#エンジン保証",
    checks: [{ kind: "test", file: "danger.test.mjs", name: "較正: 実試合の3失点はすべて直前にCRITICAL" }],
  },
  {
    id: "REC-03", area: "engine", status: "held",
    text: "実測支配率と ±3% で整合する",
    source: "README#収録試合",
    checks: [{ kind: "test", file: "chain.test.mjs", name: "" }],
  },
  {
    id: "REC-04", area: "engine", status: "held",
    text: "得点者がシュート地点に到達している（イベントと座標の整合）",
    source: "README#エンジン保証",
    checks: [{ kind: "test", file: "engine.test.mjs", name: "ゴール再現: 得点者がシュート地点に到達している" }],
  },

  /* ---------------- 戦術・守備の妥当性 ---------------- */
  {
    id: "TAC-01", area: "engine", status: "held",
    text: "最終ラインが 1 枚として同期し、局面で上下する",
    source: "README#協調ラインコントロール",
    checks: [
      { kind: "test", file: "offsideline.test.mjs", name: "最終ラインが合意 x へ同期" },
      { kind: "test", file: "offsideline.test.mjs", name: "ラインは局面で上下" },
    ],
  },
  {
    id: "TAC-02", area: "engine", status: "held",
    text: "オフサイド境界・判定が規則どおり（2nd-last 守備者×ボール）",
    source: "README#協調ラインコントロール",
    checks: [{ kind: "test", file: "offsideline.test.mjs", name: "offsideLineAt/isOffsidePos の整合" }],
  },
  {
    id: "TAC-03", area: "engine", status: "held",
    text: "協調プレスが点灯し、最近接守備者が寄せる・2 番手がパスレーンを消す",
    source: "README#階層プレッシング",
    checks: [
      { kind: "test", file: "pressing.test.mjs", name: "trigger: 決定論・点灯率2〜20%" },
      { kind: "test", file: "pressing.test.mjs", name: "トリガ点灯中は最近接守備者が平均≤5.5mまで寄せる" },
      { kind: "test", file: "pressing.test.mjs", name: "cover shadow" },
    ],
  },
  {
    id: "TAC-04", area: "engine", status: "held",
    text: "GK が角度を圧縮し、至近の脅威ほど前へ出る（自ゴール半径内・ボールを追い越さない）",
    source: "README#GK守備幾何",
    checks: [
      { kind: "test", file: "gk.test.mjs", name: "GKは常に自ゴール半径内・ボールを追い越さない" },
      { kind: "test", file: "gk.test.mjs", name: "角度圧縮" },
      { kind: "test", file: "gk.test.mjs", name: "至近ほど飛び出す" },
    ],
  },
  {
    id: "TAC-05", area: "engine", status: "held",
    text: "疲労が終盤の平均速度を落とし、交代した選手との差が出る",
    source: "README#スタミナ→行動フィードバック",
    checks: [{ kind: "test", file: "engine.test.mjs", name: "疲労モデル: 出場時間とともに増加・交代INはフレッシュ" }],
  },
  {
    id: "TAC-06", area: "engine", status: "held", issue: 136,
    text: "自陣 30m 以内を相手が持つとき、非GK 7 人以上がボールより後方にいる",
    source: "issue#136",
    checks: [{ kind: "test", file: "shape.test.mjs", name: "ブロック復帰: 押し込まれた時" }],
    note: "5〜7 人 → 7〜8 人（判定した 6 チーム全て合格）。ブロックの高さをボールの深さから決める"
      + "（中盤のみ・前線は出口として残す）。BRA は押し込まれた局面が 9 件しか無く判定対象外。"
      + "**旧文言「前線が ≤45m まで下がる」は誤り**で、45m は最終ライン高さの数字だった",
  },
  {
    id: "TAC-07", area: "engine", status: "open", issue: 137,
    text: "ミドルブロックの厚みが 18–35m、ライン間距離が 6–16m に収まる",
    source: "issue#137",
    plan: { kind: "test", file: "shape.test.mjs", name: "shape-gate v1: 全試合の形状帯" },
    note: "現状 厚み 9.2〜40.7m（4/7 が帯外）・ライン間 11.2〜19.3m（5/7 が上限超え）。"
      + "帯の出典は縦コンパクトネス 30–35m 以内・ユニット間 8–12m。"
      + "【結論 2026-08-05】#138 と同じ根（最終ラインが深すぎる）。ライン高さを直す試作では"
      + "形状の指標がすべて改善したが、警報スキルが −0.20（ランダム以下）・カバーシャドウ逆行・"
      + "選手の重なり・ゴールキック消滅で 11 件のテストが落ちた。単独では直せない",
  },
  {
    id: "TAC-08", area: "engine", status: "open", issue: 138,
    text: "最終ライン高さが試合平均 22–55m、攻撃時 35–55m に入る",
    source: "issue#138",
    plan: { kind: "test", file: "shape.test.mjs", name: "shape-gate v1: 全試合の形状帯" },
    note: "攻撃時 35.3〜41.8m は全チーム合格。試合平均は 14.2〜34.9m で 3/8 が下限割れ（JPN/EGY/ARG）。"
      + "帯の出典はローブロック 22–28m・ミドル 35–45m・ハイプレス 52–55m。"
      + "【結論 2026-08-05】#137・#185 と同根で、位置が「遅い保持基調でモーフしたスロット」で"
      + "決まることが原因。オフサイド境界・協調プレス・相互分離・危険度がすべてこの量に依存するため、"
      + "依存レイヤーの再較正を含む統合設計が要る。パラメータ 1 つでは動かせない",
  },

  {
    id: "TAC-10", area: "engine", status: "held", issue: 135,
    text: "形状の基準値はすべて出典を持ち、局面の窓と出典の窓が一致している",
    source: "issue#135",
    checks: [
      { kind: "test", file: "shape.test.mjs", name: "帯の定義: すべての基準値に出典" },
      { kind: "tool", cmd: "rpdx/tools/shape-probe.mjs" },
    ],
    note: "出典なしの数字を基準にすると実装がその数字へ歪む。旧「守備時の前線 ≤45m」は"
      + "最終ライン高さの数字の誤用で、実サッカーに無い形を正解にしていた",
  },
  {
    id: "TAC-11", area: "engine", status: "held", issue: 135,
    text: "「守備時に何人がボールより後方へ戻るか」をボール深さ別に測れている（全員は戻らない）",
    source: "issue#135",
    checks: [{ kind: "test", file: "shape.test.mjs", name: "後方人数: ボール深さ別に測れていて" }],
    note: "1 つの数字に潰すと「全員戻る／誰も戻らない」の二択しか設計できない。#136 の設計材料",
  },

  /* ---------------- 読み取り専用レイヤー ---------------- */
  {
    id: "RO-01", area: "layers", status: "held",
    text: "解釈レイヤー（危険度/PSY/戦術/守備）は世界状態を書き換えない",
    source: "README#レイヤー契約",
    checks: [
      { kind: "test", file: "layers.test.mjs", name: "" },
      { kind: "test", file: "defense.test.mjs", name: "読み取り専用・決定論: 呼び出し前後で世界不変" },
    ],
  },
  {
    id: "RO-02", area: "danger", status: "held",
    text: "危険度 6 モジュールが [0,100] に収まり、単調性（距離・ゴール距離）を持つ",
    source: "README#危険度",
    checks: [
      { kind: "test", file: "danger.test.mjs", name: "v2モジュール: 6モジュール" },
      { kind: "test", file: "danger.test.mjs", name: "距離-危険度: 守備者が近づくほど危険度が下がる" },
      { kind: "test", file: "danger.test.mjs", name: "脅威面 T(x,y): ゴール距離に単調" },
    ],
  },
  {
    id: "RO-03", area: "ux", status: "held",
    text: "編集（シナリオ what-if）は元の記録を書き換えない・保存/再読込で復元できる",
    source: "README#編集",
    checks: [
      { kind: "test", file: "editframe.test.mjs", name: "" },
      { kind: "test", file: "bundle.test.mjs", name: "" },
      { kind: "test", file: "subsedit.test.mjs", name: "ショック得点: 追加してから取り消すと元のシナリオへ戻る" },
    ],
  },

  /* ---------------- 描画・キャラクター ---------------- */
  {
    id: "VIS-01", area: "render", status: "held",
    text: "主要カメラ（放送/戦術/追従/シネマ）が破綻せず描画される",
    source: "README#視覚回帰",
    checks: [
      { kind: "visual", scenario: "broadcast_t1732" },
      { kind: "visual", scenario: "tactical_t1732" },
      { kind: "visual", scenario: "follow_t1732" },
      { kind: "visual", scenario: "cinematic_shadow_t1732" },
    ],
  },
  {
    id: "VIS-02", area: "render", status: "held",
    text: "選手は 1 枚の連続メッシュ（25 ボーン）で、関節で表面が連続する",
    source: "README#人型選手",
    checks: [
      { kind: "test", file: "skinmesh.test.mjs", name: "" },
      { kind: "test", file: "chargait.test.mjs", name: "骨格: ボーンの親子と名前表が整合する" },
    ],
  },
  {
    id: "VIS-03", area: "render", status: "held",
    text: "骨格の体節比が人体標準に収まる（頭身・関節高さ・四肢長）",
    source: "character-lab issue#11",
    checks: [{ kind: "test", file: "chargait.test.mjs", name: "比率: 関節高さと体節長が人体の標準比に収まる" }],
  },
  {
    id: "VIS-04", area: "render", status: "held",
    text: "接地: 足が地面に乗り、沈まない/浮かない（どの歩容・どの速度でも）",
    source: "character-lab issue#04",
    checks: [
      { kind: "test", file: "chargait.test.mjs", name: "接地: 足は地面に乗り、ロールしても沈まない/浮かない" },
      { kind: "test", file: "chargait.test.mjs", name: "プラント: 接地足は footPlace の目標に厳密に居る" },
    ],
  },
  {
    id: "VIS-05", area: "render", status: "held",
    text: "素肌は顔・腕・手・腿で同じ材質（膝下だけソックス）",
    source: "指摘 2026-07-28",
    checks: [{ kind: "test", file: "charmesh.test.mjs", name: "" }, { kind: "test", file: "chargait.test.mjs", name: "肌: 顔/腕/手/腿が同じ素肌 ID・膝下だけソックス" }],
    note: "AO のばらつき上限は共有コアの造形監査（character-lab 側 D13）でも見ているが、"
      + "検証手段はこのリポジトリの中で完結させる（外部リポジトリへの参照は門が拒否する）",
  },
  {
    id: "VIS-06", area: "render", status: "held",
    text: "品質ティアが端末性能で自動決定され、重いフレームが続くと段階的に軽くなる",
    source: "README#品質ティア",
    checks: [
      { kind: "test", file: "quality2.test.mjs", name: "init(): 環境をブラウザから収集する" },
      { kind: "test", file: "quality2.test.mjs", name: "tick(): 初期化前は何もしない・重い/軽いフレームで段階が上下する" },
    ],
  },

  /* ---------------- 配布・運用 ---------------- */
  {
    id: "OPS-01", area: "build", status: "held",
    text: "単一 HTML・依存ゼロでビルドできる（外部 CDN を参照しない）",
    source: "README#配布",
    checks: [{ kind: "test", file: "build.test.mjs", name: "" }],
  },
  {
    id: "OPS-02", area: "build", status: "held",
    text: "ロジック層のカバレッジが行 99% / 分岐 90% / 関数 98% を下回らない",
    source: "指摘 2026-07-30",
    checks: [{ kind: "tool", cmd: "rpdx/tools/coverage.sh" }],
  },
  {
    id: "OPS-03", area: "build", status: "held",
    text: "収録試合のリプレイが実時間で破綻しない（危険度・保持・助言が連続で NaN を出さない）",
    source: "指摘 2026-07-31",
    checks: [{ kind: "tool", cmd: "rpdx/tools/replay-eval.mjs" }],
  },

  {
    id: "OPS-04", area: "engine", status: "held",
    text: "交代・退場でスロットが割り当て直されても、ピッチに残る選手が瞬間移動しない",
    source: "issue#173",
    checks: [
      { kind: "test", file: "outage.test.mjs", name: "退場後の交代はスロットのスワップだけ" },
      { kind: "test", file: "outage.test.mjs", name: "退場の瞬間もシェイプ切替のブレンドが効く" },
      { kind: "tool", cmd: "rpdx/tools/replay-eval.mjs" },
    ],
    note: "交代と退場を時刻順に畳むよう変更（以前は全交代→退場リシェイプの順で、後の交代が再割当を引き直していた）。"
      + "決勝 102' の 36m/s → 5.2m/s、退場時 12.7m/s → 7.9m/s",
  },
  {
    id: "OPS-05", area: "engine", status: "open", issue: 178,
    text: "選手の速度上限 9.9m/s を、どの局面でも 1 フレームも超えない（0.25 秒刻みの全走査）",
    source: "issue#178",
    plan: { kind: "test", file: "property.test.mjs", name: "名簿変更の前後で位置が飛ばない" },
    note: "位置を返す経路が 2 つあり、フェーズ切替のブレンドが描画側にしか入っていなかったのを是正"
      + "（退場時 161m/s → 上限内）。0.25 秒刻みの全走査で 11 件 → 2 件。"
      + "0.05 秒刻みで名簿変更の近傍を見ると 16 件が残り、台帳（KNOWN_JUMPS）で固定している。"
      + "【結論 2026-08-05】残りは単一のバグではなく、**名簿から集計する層すべてが交代時に離散的に"
      + "飛ぶ**系統。層を止めて切り分けた実測: 協調ライン制御 7 件（守備者）/ 相互分離 4 件 / "
      + "残り 9 件（中盤・前線の基礎位置）。位置には phaseBlendedPos を入れたが、集計層"
      + "（合意ライン・分離場・プレス順位）には同じブレンドが無い。直すには集計層も前後の名簿で"
      + "二重に評価して混ぜる設計変更が要る。入場時の斥力を徐々に効かせる案は実測で悪化した（16→17件）",
  },
  {
    id: "OPS-06", area: "engine", status: "held",
    text: "形状の判定は 3 値（帯の中／帯の外／測れていない）で、標本不足が「基準内」に化けない",
    source: "issue#175",
    checks: [
      { kind: "test", file: "shape.test.mjs", name: "標本不足で判定できない組み合わせが増えていない" },
      { kind: "tool", cmd: "rpdx/tools/shape-probe.mjs" },
    ],
    note: "判定できない組み合わせは許可リストと完全一致を要求する。増えたら（＝検査が静かに消えたら）落ちる",
  },

  /* ---------------- ライブ実況（中継と並走） ---------------- */
  {
    id: "LIVE-01", area: "engine", status: "held",
    text: "ライブの時計は壁時計の純関数（開始・中断・再開・中継への同期が決定論）",
    source: "指摘 2026-07-31",
    checks: [{ kind: "test", file: "live.test.mjs", name: "時計: 開始・一時停止・再開・中継への同期が壁時計の純関数" }],
  },
  {
    id: "LIVE-02", area: "engine", status: "held",
    text: "入力（得点・シュート・CK・交代）が世界と解釈レイヤーへ反映される・直前の入力を取り消せる",
    source: "指摘 2026-07-31",
    checks: [
      { kind: "test", file: "live.test.mjs", name: "反映: 入力した得点はスコア・イベント・危険度に効く" },
      { kind: "test", file: "live.test.mjs", name: "交代: 入力した交代が名簿へ反映される" },
      { kind: "test", file: "live.test.mjs", name: "入力: イベントと交代は時刻順に保たれ" },
    ],
  },
  {
    id: "LIVE-03", area: "engine", status: "held",
    text: "ライブでイベントを入力しても、既に見た過去（入力時刻 − PRE_ROLL より前）の軌道が 1mm も変わらない",
    source: "issue#177",
    checks: [{ kind: "test", file: "live.test.mjs", name: "因果: 入力しても PRE_ROLL 秒より前の世界は 1mm も変わらない" }],
    note: "チェーンの抽選シードを「その時刻までに起きたこと」だけから作る。収録パックは較正済みの成果物なので"
      + "従来のシナリオ全体ハッシュのまま（世界は bit 不変・golden 安全）",
  },

  {
    id: "LIVE-04", area: "ux", status: "held",
    text: "ライブ実況モードに入る/出る手段があり、ライブ中であることが画面から一目で分かる",
    source: "issue#180",
    checks: [{ kind: "test", file: "liveui.test.mjs", name: "ライブモードの開始と終了" }],
  },
  {
    id: "LIVE-05", area: "ux", status: "held",
    text: "中継に合わせて時計を操作できる（開始・一時停止・再開・時刻合わせ）",
    source: "issue#180",
    checks: [{ kind: "test", file: "liveui.test.mjs", name: "時計の操作が session へ反映される" }],
  },
  {
    id: "LIVE-06", area: "ux", status: "held",
    text: "得点・シュート・CK・交代・カードをその場で入力でき、直前の入力を取り消せる",
    source: "issue#180",
    checks: [{ kind: "test", file: "liveui.test.mjs", name: "イベント入力と取り消し" }],
  },
  {
    id: "LIVE-07", area: "ux", status: "held",
    text: "ライブ操作の標的は 44px 以上・他の要素に覆われない・文字は 11px 以上・コントラスト AA",
    source: "issue#180",
    checks: [{ kind: "tool", cmd: "rpdx/tools/ui-probe.mjs" }],
    note: "目視だけに頼らず実測する。標的の重なりは elementFromPoint で検査（大きさだけ見ても覆われていたら押せない）",
  },

  {
    id: "LIVE-08", area: "ux", status: "held",
    text: "ライブの入力は既存のバンドルへ載って保存・復帰・共有できる（専用の保存機構を作らない）",
    source: "issue#181",
    checks: [
      { kind: "test", file: "liveui.test.mjs", name: "保存・復帰: 既存のバンドルへ載せて往復し、世界が bit 一致する" },
      { kind: "test", file: "liveui.test.mjs", name: "保存・復帰: 従来のバンドル（live なし）は今までどおり読める" },
      { kind: "test", file: "liveui.test.mjs", name: "保存・復帰: 時計の続きから再開できる" },
    ],
    note: "復帰した時計は必ず停止状態（読み込んだ瞬間に試合時刻が走り出さない）",
  },

  {
    id: "OPS-07", area: "ux", status: "held",
    text: "画面層は prompt/confirm/alert を使わず、端末内へ書くキーは登録制（保存機構を重複させない）",
    source: "指摘 2026-08-01",
    checks: [
      { kind: "test", file: "uicontract.test.mjs", name: "prompt/confirm/alert を使わない" },
      { kind: "test", file: "uicontract.test.mjs", name: "端末内へ書くキーは登録済みのものだけ" },
      { kind: "test", file: "uicontract.test.mjs", name: "操作要素には説明" },
    ],
    note: "prompt 等はスマホで使えずヘッドレス検証も止まる。保存キーの登録制は「既存の仕組みで足りないか」を一度考えさせるため",
  },

  {
    id: "LIVE-09", area: "ux", status: "held",
    text: "ライブは自チームの名簿で記録できる（名簿の作成・編集は既存のカスタム試合の経路を使う）",
    source: "issue#182",
    checks: [
      { kind: "test", file: "liveui.test.mjs", name: "名簿: cfg を差し替えても入力した記録は残る" },
      { kind: "test", file: "liveui.test.mjs", name: "名簿: 収録試合はライブの土台にしない" },
      { kind: "tool", cmd: "rpdx/tools/ui-probe.mjs" },
    ],
    note: "ライブ専用の名簿エディタは作らない。チーム名だけ画面から入れ、詳細は既存のカスタム試合とロスターの ✎ を使う",
  },

  {
    id: "LIVE-10", area: "ux", status: "held",
    text: "ライブは前半終了で自動的に止まり、「後半開始」で後半の先頭から進む（手動の時計合わせは従来どおり）",
    source: "issue#183",
    checks: [
      { kind: "test", file: "liveui.test.mjs", name: "ハーフタイム: 前半終了で自動的に止まり、後半開始で先頭から進む" },
      { kind: "test", file: "liveui.test.mjs", name: "ハーフタイム: 後半開始のあとは二度と自動停止しない" },
    ],
    note: "h1.end と h2.start は同じ時刻なので、時刻の比較だけで判断すると後半開始の直後にまた止まる（実機で発覚）",
  },

  {
    id: "TAC-09", area: "engine", status: "open", issue: 184,
    text: "GK の 90 分換算走行距離が実サッカーの範囲（3,000〜6,000m）に入る",
    source: "issue#184",
    plan: { kind: "test", file: "gk.test.mjs", name: "GK: 歩き回りで走行距離が増える" },
    note: "563〜838m → 943〜3,171m まで改善。角度圧縮の 4 性質を壊さない範囲の上限がここで、"
      + "全チームを帯に入れるには GK の位置の作り方（二等分線への貼り付け）自体の見直しが要る。"
      + "【結論 2026-08-05】押し込まれる側の GK は角度圧縮が最優先で二等分線から離れられず、"
      + "振幅を上げると 9m で「ボール側へ寄る」性質が崩れる。#179 と同じく、位置が閉じた式で"
      + "決まる構造に由来する。速度制限つきの生成（#84）へ合流させる",
  },

  {
    id: "UX-03", area: "ux", status: "held", issue: 188,
    text: "PK カメラで、キッカー・GK・ゴールマウス左右端・クロスバー・ボールが 1 画面に入る",
    source: "issue#188",
    checks: [{ kind: "visual", scenario: "S5: PK カメラに要素が収まる" }],
    note: "縦画角は固定なので縦長の画面では横が切れる（実測 390×844 でポストが x=±1.15）。"
      + "ゴール幅 + 余白が横に収まる距離まで引くよう、アスペクトに応じて距離を決める。"
      + "判定は画素ではなく正規化デバイス座標（api.project）— 画素は GPU 差で揺れるうえ"
      + "「入っているか」を直接は測れない",
  },
  {
    id: "UX-04", area: "ux", status: "held", issue: 189,
    text: "PK を 1 本ずつ記録できる（蹴る前の観測・コース・○×）。保存はライブセッションに載せる",
    source: "issue#189",
    checks: [
      { kind: "test", file: "live.test.mjs", name: "PK: 1 本ずつ記録され、入力順に並び" },
      { kind: "test", file: "live.test.mjs", name: "PK: 保存と復元で記録が往復する" },
      { kind: "test", file: "live.test.mjs", name: "PK: 取り消しは PK の列だけを戻す" },
      { kind: "tool", cmd: "rpdx/tools/ui-probe.mjs" },
    ],
    note: "蹴る前の観測（助走側・GK の早い動き）を時刻つきで残す。結果だけでは「GK が早く倒れるか」"
      + "が後から見られない。集計は本数と母数のみ（§6: 確率を出さない）",
  },
  {
    id: "UX-05", area: "ux", status: "held", issue: 190,
    text: "PK コースの記録本数をゴールマウス上に表示し、凡例と配色を危険度と分ける",
    source: "issue#190",
    checks: [
      { kind: "test", file: "live.test.mjs", name: "PK: セルごとの本数が 0 と 1 で区別でき" },
      { kind: "test", file: "uicontract.test.mjs", name: "画面文言の「予測」「確率」は必ず否定とセット" },
      { kind: "tool", cmd: "rpdx/tools/ui-probe.mjs" },
    ],
    note: "既存の粒子場を再利用。粒の数＝本数（明るさではなく数で示すので 0 本には 1 粒も出ない）。"
      + "色は青緑で危険度（距離×人数×時間）と分け、凡例に「危険度の色とは別物」と母数を出す。"
      + "確率を出さないため Wilson 区間・標本数閾値は不要（#187 §6 の設計上の効き）",
  },
  {
    id: "UX-06", area: "ux", status: "held", issue: 191,
    text: "PK 戦の進行（5 本ずつ・打ち切り・サドンデス）と蹴る順番を、位置エンジンに載せずに扱う",
    source: "issue#191",
    checks: [
      { kind: "test", file: "live.test.mjs", name: "PK戦: 残り本数で追いつけなくなったら" },
      { kind: "test", file: "live.test.mjs", name: "PK戦: 5 本ずつで同点ならサドンデスへ入り" },
      { kind: "test", file: "live.test.mjs", name: "PK戦: 順番を変えても記録済みの本は" },
    ],
    note: "engine.mjs の差分ゼロ。エンジンは 22 人の連続な f(t)、PK 戦は 2 人の逐次離散イベントで"
      + "構造が違う（#179・#137 で、構造に合わないものを載せると較正済みレイヤーが壊れることを実測）。"
      + "成否の予測はしない — 記録から数えた結果だけを持つ",
  },
  {
    id: "OPS-08", area: "ops", status: "held", issue: 193,
    text: "視覚回帰の golden は 3D レンダリングだけを比較し、UI の変更で再ベースラインを要求しない",
    source: "issue#193",
    checks: [{ kind: "visual", scenario: "golden 差分（許容内）" }],
    note: "画面に出ているパネル類の矩形を実測して比較から外す。実測: マスク前 8〜10% → 後 0.90〜1.43%"
      + "（環境差の大半は UI の文字描画だった）。基準線が下がったぶん許容を 20% → 5% に締めた。"
      + "UI の変更（ボタンの余白）では落ちず、3D の退行（芝の色）では 78% で落ちることを注入で確認",
  },
  {
    id: "TAC-12", area: "engine", status: "held", issue: 196,
    text: "試合中の PK と PK 戦を別のデータとして持つ（互いの集計・順番・危険度を汚さない）",
    source: "issue#196",
    checks: [
      { kind: "test", file: "live.test.mjs", name: "試合中の PK: 試合時間を持ち、同じチームに連続で" },
      { kind: "test", file: "live.test.mjs", name: "PK 戦と試合中の PK が互いの集計・順番を汚さない" },
      { kind: "test", file: "live.test.mjs", name: "試合中の PK: 危険度に効く／PK 戦は効かない" },
      { kind: "test", file: "live.test.mjs", name: "試合 ID: 入力のどの項目を変えても世界が作り直される" },
    ],
    note: "試合中の PK は試合時間 t を持ち同じチームに連続で与えられ得る／PK 戦は順番 n で交互。"
      + "調査で「試合中の PK を表す型が存在しない」ことが分かり、既存の pk は実質 PK 戦のデータだった。"
      + "実装中に試合 ID のハッシュが項目を手で並べており scored/cell が漏れる不具合（#182 と同じ型）を"
      + "踏んだため、入力をまるごとハッシュに入れるよう変えた",
  },
  {
    id: "UX-07", area: "ux", status: "held", issue: 197,
    text: "PK 戦は全画面モードで、危険度・タイムラインを消し、試合時刻を終端に置く",
    source: "issue#197",
    checks: [{ kind: "tool", cmd: "rpdx/tools/ui-probe.mjs" }],
    note: "入るときに試合時刻・カメラ・フォーカス・再生状態を預かり、抜けたら戻す。"
      + "隠したパネルは inert でタブ順から外す（#42: display:none だけだとフォーカスが body へ飛ぶ）。"
      + "Esc で抜けられる。**品質ティア（#152）には触らない** — 消すのはモードの判断であり描画予算の"
      + "判断ではない。実測: 格子と ○× が 320/360/390px でスクロールなしに収まる",
  },
  {
    id: "UX-08", area: "ux", status: "held", issue: 201,
    text: "アディショナルタイムを試合中に入力でき、終端と保存へ反映される",
    source: "issue#201",
    checks: [
      { kind: "test", file: "live.test.mjs", name: "AT: 変更すると終端が動き、入力済みの記録は" },
      { kind: "test", file: "bundle.test.mjs", name: "バンドル: アディショナルタイムが往復する" },
    ],
    note: "実際のロスタイムは試合終盤に発表されるので、試合中に変えられる必要がある。"
      + "着手時に「バンドルの customMatch に added が無く、往復で既定値へ戻る」潜在バグを発見して同時に修正"
      + "（実測 終端 6180 → 5820 秒）。記録は live.withCfg が保持する",
  },
  {
    id: "UX-09", area: "ux", status: "held", issue: 202,
    text: "自作の試合で延長戦を行える（後半終了で選び、延長前半・延長後半へ進む）",
    source: "issue#202",
    checks: [
      { kind: "test", file: "live.test.mjs", name: "延長: 未指定なら従来どおり" },
      { kind: "test", file: "live.test.mjs", name: "延長: 後半終了で止まり、延長前半・延長後半へ順に進む" },
      { kind: "test", file: "live.test.mjs", name: "延長: 途中で延長を足しても記録が失われず" },
      { kind: "test", file: "bundle.test.mjs", name: "バンドル: 延長の有無と延長の AT が往復する" },
    ],
    note: "エンジンは #141 で h3/h4 に一般対応済みだったので、生成経路とピリオド進行だけを足した。"
      + "#183 のハーフタイム処理（h2 専用）を、どのピリオド境界でも効く形へ一般化。"
      + "復帰時に開始済みピリオドの印を引き継がないと、同じ区切りで何度も止まる",
  },
  {
    id: "UX-10", area: "ux", status: "held", issue: 203,
    text: "試合が終わって同点なら、延長するか／PK 戦へ進むかをその場で選べ、選ぶと PK 戦モードへ移る",
    source: "issue#203",
    checks: [
      { kind: "test", file: "live.test.mjs", name: "終端: 最後のピリオドの終端と同点かを返す" },
      { kind: "test", file: "live.test.mjs", name: "区切り: 時計を先へ飛ばしても" },
      { kind: "tool", cmd: "rpdx/tools/ui-probe.mjs" },
    ],
    note: "live.matchEnd は事実（終端か・同点か・スコア）だけを返し、決めるのは UI。"
      + "prompt/confirm は使わず画面内の操作で選ばせる。最初の選択肢へフォーカスを移す（#42）。"
      + "一度断られたら聞き直さない。実機で「時計を先へ飛ばすと次のピリオドを取り違える」不具合"
      + "（下限だけで判定していた）を発見して修正",
  },
  {
    id: "POL-01", area: "docs", status: "held", issue: 187,
    text: "PK コース記録は事実（記録）層として扱い、確率・次の 1 本・順位付けを表示しない",
    source: "issue#187",
    checks: [
      { kind: "test", file: "uicontract.test.mjs", name: "統治文書に PK コース記録の特則がある" },
      { kind: "test", file: "uicontract.test.mjs", name: "画面文言の「予測」「確率」は必ず否定とセット" },
      { kind: "test", file: "uicontract.test.mjs", name: "「傾向がある」「次は」の断定を画面文言に入れない" },
    ],
    note: "確率を出さない設計にすることで、少ない標本から確率を作る問題が構造的に発生しない"
      + "（1 試合で PK は 5 本、同じ選手なら 1 本）",
  },
  {
    id: "POL-02", area: "docs", status: "held", issue: 187,
    text: "記録してよい場と、データ取得の適法性の責任範囲を README と統治文書に明示する",
    source: "issue#187",
    checks: [{ kind: "test", file: "uicontract.test.mjs", name: "統治文書に PK コース記録の特則がある" }],
    note: "公式戦・練習試合など観戦が認められている場のみ。他チームの練習の偵察は対象外。"
      + "取得の適法性は利用者の責任で、本ツールは責任を負わない",
  },

  /* ---------------- まだ検証手段が無いもの（意図的に可視化） ---------------- */
  {
    id: "UX-01", area: "ux", status: "held", issue: 105,
    text: "スマホ幅・タッチ端末で、全画面のタップ標的が 44px 以上・文字 11px 以上・コントラスト AA を満たす",
    source: "issue#105",
    checks: [{ kind: "tool", cmd: "rpdx/tools/ui-probe.mjs" }],
    note: "8 画面を pointer:coarse / hover:none を再現して実測。147 件 → 0 件。"
      + "ピンチズーム/2本指パンは実装済み。#195: 画面ごとに「開いた目的を果たす操作部」を宣言し、"
      + "スクロールせずに見えていることまで見る（一覧はスクロールしてよい／操作盤はさせない）",
  },
  {
    id: "UX-02", area: "ux", status: "waived",
    text: "配色・レイアウトの美観",
    source: "—",
    why: "主観であり自動判定に向かない。視覚回帰（VIS-01）で「前回と変わっていないこと」だけを担保する",
  },
];

export const AREAS = ["engine", "danger", "layers", "data", "render", "ux", "build"];
