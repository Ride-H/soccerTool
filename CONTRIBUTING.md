# コントリビューション・ブランチ運用

RPD-X は **依存ゼロ・単一 HTML・決定論** を大前提とします。この前提を崩す変更は受け付けません。

## ブランチモデル

```
feature/*  ──PR──►  dev  ──PR──►  main  ──►  GitHub Pages（自動デプロイ）
   機能単位          統合         保護・公開       ライブ
```

| ブランチ | push | CI | 結合条件 |
|---|---|---|---|
| **main** | 直接 push 禁止（PR のみ） | PR で必須・合格必須 | **CI 合格 + レビュー承認** |
| **dev** | 直接 push 可 | push で即実行・失敗は自動フラグ Issue | — |
| **feature/\*** | 直接 push 可（粗いコミット可） | push で即実行 | CI 合格後 **dev へ PR** |

- `main` への直接 push・force push・ブランチ削除は保護ルールで禁止。
- `main` の結合は必ず PR 経由で、`Test & build` チェック合格 + 1 承認が必要。
- `dev` の CI が落ちると `ci-failure` ラベルの Issue が自動で立ちます（復旧後に手動クローズ）。

## 変更の流れ

```bash
# 1) dev から機能ブランチを切る
git switch dev && git pull
git switch -c feature/<短い説明>

# 2) 作業（粗いコミットで可）
node --test rpdx/test/*.test.mjs     # ローカルで先に緑を確認
node rpdx/build.mjs

# 3) push → CI 実行
git push -u origin feature/<短い説明>

# 4) CI 合格後、dev へ PR
gh pr create --base dev --head feature/<短い説明>

# 5) dev で束ねてから、main へ PR（レビュー + CI 合格で結合 → 自動デプロイ）
gh pr create --base main --head dev
```

## 受け入れの前提（不可侵）

- **依存ゼロ**: 追加の npm パッケージ・外部 CDN・外部フォント/画像を持ち込まない。
- **決定論**: 位置・危険度・PSY 等はすべて時刻 `t` の純関数（同じ入力→同じ出力）。
- **速度上限 ≤ 9.9 m/s** を構成的に維持する（`node --test` が検証）。
- **事実とモデルの区別**: 記録データとモデル推定は明確に分離して表示する
  （[docs/RESPONSIBLE_ANALYSIS.md](docs/RESPONSIBLE_ANALYSIS.md)）。
- **テスト緑**: `node --test rpdx/test/*.test.mjs` が全通過すること。

新しい試合・チーム・選手の追加は [docs/MATCH_PACKS.md](docs/MATCH_PACKS.md) の手順に従ってください。

## 視覚回帰ゲート（golden 画像）の更新ルール（#153）

CI は `node rpdx/test/visual/smoke.mjs` で **視覚スモーク**（決定論固定時刻のスクリーンショットに対する
存在チェック＋golden 画像との許容差比較）を実行します。

- **golden（`rpdx/test/visual/golden/*.png`）は「意図的な視覚変更」の PR でのみ更新**してください。
  更新は `UPDATE_GOLDEN=1 node rpdx/test/visual/smoke.mjs` で再生成し、**PR 本文に更新理由を明記**、
  差分画像をレビューで承認してから結合します。意図しない差分で CI が落ちた場合は golden を
  上書きせず、原因（メッシュ割れ・法線・カメラ・色）を先に直します。
- スモークは依存ゼロ（Node 組込み WebSocket + CDP 生プロトコル + ランナー同梱 Chrome）です。
  ローカル実行は `CHROME_BIN` で Chrome を指定できます（例: macOS の Chrome.app）。
