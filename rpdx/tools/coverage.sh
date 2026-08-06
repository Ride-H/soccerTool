#!/usr/bin/env bash
# カバレッジ門。ロジック層（rpdx/src と app/character.mjs・app/quality.mjs）の
# 行・分岐・関数が下限を割ったら失敗する。
#   実行: bash rpdx/tools/coverage.sh
#
# 除外の理由:
#   app/render3d.mjs — WebGL コンテキストとキャンバスが要るため node では実行できない。
#     ここは rpdx/test/visual/smoke.mjs（ヘッドレス Chrome の描画比較）で担保している。
#   rpdx/tools/**・rpdx/test/** — 検査する側のコード。
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node --experimental-test-coverage \
  --test-coverage-lines=99 --test-coverage-branches=90 --test-coverage-functions=98 \
  --test-coverage-exclude='rpdx/app/render3d.mjs' \
  --test-coverage-exclude='rpdx/tools/**' --test-coverage-exclude='rpdx/test/**' \
  --test rpdx/test/*.test.mjs
