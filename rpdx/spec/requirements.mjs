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
    id: "TAC-06", area: "engine", status: "open", issue: 136,
    text: "守備時（自陣被侵入時）の前線が ≤45m まで下がる（ブロックに参加する）",
    source: "issue#136",
    plan: { kind: "test", file: "shape.test.mjs", name: "shape-gate v1: 全試合の形状帯" },
    note: "現状 38.2〜52.7m（rpdx/tools/shape-probe.mjs で実測）。ゲートは skip 状態で登録済み",
  },
  {
    id: "TAC-07", area: "engine", status: "open", issue: 137,
    text: "守備時の縦コンパクトネスが 25–40m 帯に収まる（全局面平均 ≤45m）",
    source: "issue#137",
    plan: { kind: "test", file: "shape.test.mjs", name: "shape-gate v1: 全試合の形状帯" },
    note: "現状 p50 27.1〜40.6m。全局面平均は 31〜54m でまだ帯外のチームがある",
  },
  {
    id: "TAC-08", area: "engine", status: "open", issue: 138,
    text: "攻撃時の最終ラインが 35–50m 帯まで押し上がる",
    source: "issue#138",
    plan: { kind: "test", file: "shape.test.mjs", name: "shape-gate v1: 全試合の形状帯" },
    note: "現状 34.7〜41.6m（帯の下限付近）。ESP/ARG は決勝で標本不足（NaN）",
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
    source: "リプレイ評価 KN-03",
    plan: { kind: "tool", cmd: "rpdx/tools/replay-eval.mjs" },
    note: "#174 で GK（18.3→5.5m/s）とアンカー収束、#178 で順位の入れ替わりと寄せの解放を解消。残り 2 件・最大 11.0m/s",
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

  /* ---------------- まだ検証手段が無いもの（意図的に可視化） ---------------- */
  {
    id: "UX-01", area: "ux", status: "open", issue: 105,
    text: "スマホ実機（〜360px 幅）でピンチズーム/2 本指パンができ、主要パネルがタッチで開閉できる",
    source: "issue#105",
    plan: { kind: "manual", why: "実機のタッチ操作は自動化していない。CDP のタッチエミュレーションで一部は自動化可能（未着手）" },
  },
  {
    id: "UX-02", area: "ux", status: "waived",
    text: "配色・レイアウトの美観",
    source: "—",
    why: "主観であり自動判定に向かない。視覚回帰（VIS-01）で「前回と変わっていないこと」だけを担保する",
  },
];

export const AREAS = ["engine", "danger", "layers", "data", "render", "ux", "build"];
