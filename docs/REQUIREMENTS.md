# 要件と検証手段の対応表

このツールが「約束していること」と「それを何が検証しているか」の一覧。
`rpdx/spec/requirements.mjs` が正で、この表は `node rpdx/tools/trace.mjs --md` で生成する。

- **担保**: 現に満たしていて、検証手段（テスト／視覚回帰／ツール）がある
- **未充足**: まだ満たしていない。対応 Issue と「満たしたとき何で検証するか」を必ず持つ
- **対象外**: 意図的に自動検証しない（理由を明記）

画面キャプチャ（視覚回帰）は「前回と同じに描けているか」しか見ない。約束の大半は
数値の検査でしか担保できないので、検証手段の中心はテストとツールに置いている。
時間軸に沿った破綻は `node rpdx/tools/replay-eval.mjs`（リプレイ評価）で見る。

| ID | 区分 | 約束 | 状態 | 検証手段 |
|---|---|---|---|---|
| DET-01 | engine | 純関数 f(t): どの時刻を叩いても同一世界（スクラブ・ジャンプ・順序非依存） | 担保 | engine.test.mjs 「決定論: 同一時刻の二重評価が完全一致」<br>property.test.mjs 「生成シナリオ空間で決定論」<br>property.test.mjs 「スクラブ順序非依存」 |
| DET-02 | engine | 乱数を使わない（描画層に Math.random を残さない・位相とテクスチャはシード化） | 担保 | visualgate.test.mjs 「決定論契約: 描画層（app/*.mjs）に Math.random を残さない」<br>visualgate.test.mjs 「決定論契約: 位相・テクスチャがシード化されている」 |
| DET-03 | engine | 世界状態ダイジェストが golden と一致（意図しない挙動変化の検出） | 担保 | golden.test.mjs 「golden: 世界状態ダイジェストがスナップショットと一致」 |
| PHY-01 | engine | 選手の速度上限 ≤9.9m/s を構成的に保証 | 担保 | engine.test.mjs 「速度上限: 全選手 9.9m/s 以下」<br>property.test.mjs 「生成シナリオ空間で速度上限」 |
| PHY-02 | engine | 常時 11 人×2 チーム・GK 各 1・全員ピッチ内・支配率合計 100% | 担保 | engine.test.mjs 「常時11人×2チーム・全員ピッチ内」<br>property.test.mjs 「生成シナリオ空間で保存則」 |
| PHY-03 | engine | ボールは瞬間移動しない（0.1s で ≤5m）・チェーン境界でも C0 連続 | 担保 | ballphysics.test.mjs 「ballAt: 全走査で 0.1s ステップ移動 ≤ 5m」<br>ballphysics.test.mjs 「リスタート解放はセグメント終端までに完了し境界がC0連続」 |
| PHY-04 | engine | ボールのバウンドとマグヌス曲がりが決定論・端点（アンカー時刻）を保存 | 担保 | ballphysics.test.mjs 「bounceHeight: 端点で接地・頂点が h・反発でピークが e² 減衰」<br>ballphysics.test.mjs 「端点（アンカー時刻）でマグヌス曲がりは0」<br>branchsweep.test.mjs 「engine.ballBounceHeight: 全区間で 0.11m 以上」 |
| PHY-05 | engine | 選手同士がすり抜けない（最小ペア距離を保つ相互分離） | 担保 | engine.test.mjs 「#39: 高速化（基礎位置メモ+空間ハッシュ）後も世界はビット同一」 |
| REC-01 | data | 背番号・XI・交代・警告・得点が公式記録どおり（収録全試合） | 担保 | data.test.mjs<br>packs.test.mjs |
| REC-02 | engine | 全ゴールの直前に危険度が CRITICAL へ到達する（較正） | 担保 | danger.test.mjs 「較正: 実試合の3失点はすべて直前にCRITICAL」 |
| REC-03 | engine | 実測支配率と ±3% で整合する | 担保 | chain.test.mjs |
| REC-04 | engine | 得点者がシュート地点に到達している（イベントと座標の整合） | 担保 | engine.test.mjs 「ゴール再現: 得点者がシュート地点に到達している」 |
| TAC-01 | engine | 最終ラインが 1 枚として同期し、局面で上下する | 担保 | offsideline.test.mjs 「最終ラインが合意 x へ同期」<br>offsideline.test.mjs 「ラインは局面で上下」 |
| TAC-02 | engine | オフサイド境界・判定が規則どおり（2nd-last 守備者×ボール） | 担保 | offsideline.test.mjs 「offsideLineAt/isOffsidePos の整合」 |
| TAC-03 | engine | 協調プレスが点灯し、最近接守備者が寄せる・2 番手がパスレーンを消す | 担保 | pressing.test.mjs 「trigger: 決定論・点灯率2〜20%」<br>pressing.test.mjs 「トリガ点灯中は最近接守備者が平均≤5.5mまで寄せる」<br>pressing.test.mjs 「cover shadow」 |
| TAC-04 | engine | GK が角度を圧縮し、至近の脅威ほど前へ出る（自ゴール半径内・ボールを追い越さない） | 担保 | gk.test.mjs 「GKは常に自ゴール半径内・ボールを追い越さない」<br>gk.test.mjs 「角度圧縮」<br>gk.test.mjs 「至近ほど飛び出す」 |
| TAC-05 | engine | 疲労が終盤の平均速度を落とし、交代した選手との差が出る | 担保 | engine.test.mjs 「疲労モデル: 出場時間とともに増加・交代INはフレッシュ」 |
| TAC-06 | engine | 守備時（自陣被侵入時）の前線が ≤45m まで下がる（ブロックに参加する） | 未充足（#136） | shape.test.mjs 「shape-gate v1: 全試合の形状帯」 |
| TAC-07 | engine | 守備時の縦コンパクトネスが 25–40m 帯に収まる（全局面平均 ≤45m） | 未充足（#137） | shape.test.mjs 「shape-gate v1: 全試合の形状帯」 |
| TAC-08 | engine | 攻撃時の最終ラインが 35–50m 帯まで押し上がる | 未充足（#138） | shape.test.mjs 「shape-gate v1: 全試合の形状帯」 |
| RO-01 | layers | 解釈レイヤー（危険度/PSY/戦術/守備）は世界状態を書き換えない | 担保 | layers.test.mjs<br>defense.test.mjs 「読み取り専用・決定論: 呼び出し前後で世界不変」 |
| RO-02 | danger | 危険度 6 モジュールが [0,100] に収まり、単調性（距離・ゴール距離）を持つ | 担保 | danger.test.mjs 「v2モジュール: 6モジュール」<br>danger.test.mjs 「距離-危険度: 守備者が近づくほど危険度が下がる」<br>danger.test.mjs 「脅威面 T(x,y): ゴール距離に単調」 |
| RO-03 | ux | 編集（シナリオ what-if）は元の記録を書き換えない・保存/再読込で復元できる | 担保 | editframe.test.mjs<br>bundle.test.mjs<br>subsedit.test.mjs 「ショック得点: 追加してから取り消すと元のシナリオへ戻る」 |
| VIS-01 | render | 主要カメラ（放送/戦術/追従/シネマ）が破綻せず描画される | 担保 | 視覚 broadcast_t1732<br>視覚 tactical_t1732<br>視覚 follow_t1732<br>視覚 cinematic_shadow_t1732 |
| VIS-02 | render | 選手は 1 枚の連続メッシュ（25 ボーン）で、関節で表面が連続する | 担保 | skinmesh.test.mjs<br>chargait.test.mjs 「骨格: ボーンの親子と名前表が整合する」 |
| VIS-03 | render | 骨格の体節比が人体標準に収まる（頭身・関節高さ・四肢長） | 担保 | chargait.test.mjs 「比率: 関節高さと体節長が人体の標準比に収まる」 |
| VIS-04 | render | 接地: 足が地面に乗り、沈まない/浮かない（どの歩容・どの速度でも） | 担保 | chargait.test.mjs 「接地: 足は地面に乗り、ロールしても沈まない/浮かない」<br>chargait.test.mjs 「プラント: 接地足は footPlace の目標に厳密に居る」 |
| VIS-05 | render | 素肌は顔・腕・手・腿で同じ材質（膝下だけソックス） | 担保 | charmesh.test.mjs<br>chargait.test.mjs 「肌: 顔/腕/手/腿が同じ素肌 ID・膝下だけソックス」 |
| VIS-06 | render | 品質ティアが端末性能で自動決定され、重いフレームが続くと段階的に軽くなる | 担保 | quality2.test.mjs 「init(): 環境をブラウザから収集する」<br>quality2.test.mjs 「tick(): 初期化前は何もしない・重い/軽いフレームで段階が上下する」 |
| OPS-01 | build | 単一 HTML・依存ゼロでビルドできる（外部 CDN を参照しない） | 担保 | build.test.mjs |
| OPS-02 | build | ロジック層のカバレッジが行 99% / 分岐 90% / 関数 98% を下回らない | 担保 | ツール rpdx/tools/coverage.sh |
| OPS-03 | build | 収録試合のリプレイが実時間で破綻しない（危険度・保持・助言が連続で NaN を出さない） | 担保 | ツール rpdx/tools/replay-eval.mjs |
| OPS-04 | engine | 交代・退場でスロットが割り当て直されても、ピッチに残る選手が瞬間移動しない | 担保 | outage.test.mjs 「退場後の交代はスロットのスワップだけ」<br>outage.test.mjs 「退場の瞬間もシェイプ切替のブレンドが効く」<br>ツール rpdx/tools/replay-eval.mjs |
| OPS-05 | engine | 選手の速度上限 9.9m/s を、どの局面でも 1 フレームも超えない（0.25 秒刻みの全走査） | 未充足（#178） | ツール rpdx/tools/replay-eval.mjs |
| OPS-06 | engine | 形状の判定は 3 値（帯の中／帯の外／測れていない）で、標本不足が「基準内」に化けない | 担保 | shape.test.mjs 「標本不足で判定できない組み合わせが増えていない」<br>ツール rpdx/tools/shape-probe.mjs |
| LIVE-01 | engine | ライブの時計は壁時計の純関数（開始・中断・再開・中継への同期が決定論） | 担保 | live.test.mjs 「時計: 開始・一時停止・再開・中継への同期が壁時計の純関数」 |
| LIVE-02 | engine | 入力（得点・シュート・CK・交代）が世界と解釈レイヤーへ反映される・直前の入力を取り消せる | 担保 | live.test.mjs 「反映: 入力した得点はスコア・イベント・危険度に効く」<br>live.test.mjs 「交代: 入力した交代が名簿へ反映される」<br>live.test.mjs 「入力: イベントと交代は時刻順に保たれ」 |
| LIVE-03 | engine | ライブでイベントを入力しても、既に見た過去（入力時刻 − PRE_ROLL より前）の軌道が 1mm も変わらない | 担保 | live.test.mjs 「因果: 入力しても PRE_ROLL 秒より前の世界は 1mm も変わらない」 |
| LIVE-04 | ux | ライブ実況モードに入る/出る手段があり、ライブ中であることが画面から一目で分かる | 担保 | liveui.test.mjs 「ライブモードの開始と終了」 |
| LIVE-05 | ux | 中継に合わせて時計を操作できる（開始・一時停止・再開・時刻合わせ） | 担保 | liveui.test.mjs 「時計の操作が session へ反映される」 |
| LIVE-06 | ux | 得点・シュート・CK・交代・カードをその場で入力でき、直前の入力を取り消せる | 担保 | liveui.test.mjs 「イベント入力と取り消し」 |
| LIVE-07 | ux | ライブ操作の標的は 44px 以上・他の要素に覆われない・文字は 11px 以上・コントラスト AA | 担保 | ツール rpdx/tools/ui-probe.mjs |
| LIVE-08 | ux | ライブの入力は既存のバンドルへ載って保存・復帰・共有できる（専用の保存機構を作らない） | 担保 | liveui.test.mjs 「保存・復帰: 既存のバンドルへ載せて往復し、世界が bit 一致する」<br>liveui.test.mjs 「保存・復帰: 従来のバンドル（live なし）は今までどおり読める」<br>liveui.test.mjs 「保存・復帰: 時計の続きから再開できる」 |
| OPS-07 | ux | 画面層は prompt/confirm/alert を使わず、端末内へ書くキーは登録制（保存機構を重複させない） | 担保 | uicontract.test.mjs 「prompt/confirm/alert を使わない」<br>uicontract.test.mjs 「端末内へ書くキーは登録済みのものだけ」<br>uicontract.test.mjs 「操作要素には説明」 |
| LIVE-09 | ux | ライブは自チームの名簿で記録できる（名簿の作成・編集は既存のカスタム試合の経路を使う） | 担保 | liveui.test.mjs 「名簿: cfg を差し替えても入力した記録は残る」<br>liveui.test.mjs 「名簿: 収録試合はライブの土台にしない」<br>ツール rpdx/tools/ui-probe.mjs |
| LIVE-10 | ux | ライブは前半終了で自動的に止まり、「後半開始」で後半の先頭から進む（手動の時計合わせは従来どおり） | 担保 | liveui.test.mjs 「ハーフタイム: 前半終了で自動的に止まり、後半開始で先頭から進む」<br>liveui.test.mjs 「ハーフタイム: 後半開始のあとは二度と自動停止しない」 |
| UX-01 | ux | スマホ実機（〜360px 幅）でピンチズーム/2 本指パンができ、主要パネルがタッチで開閉できる | 未充足（#105） | 目視（実機のタッチ操作は自動化していない。CDP のタッチエミュレーションで一部は自動化可能（未着手）） |
| UX-02 | ux | 配色・レイアウトの美観 | 対象外 | 主観であり自動判定に向かない。視覚回帰（VIS-01）で「前回と変わっていないこと」だけを担保する |

