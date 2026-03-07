#!/bin/bash
#
# RNNoise WASM 파일 다운로드 스크립트
#
# RNNoise는 Mozilla가 개발한 RNN 기반 실시간 노이즈 제거 라이브러리입니다.
# WASM 빌드를 다운로드하여 Extension에서 사용할 수 있도록 합니다.
#
# 사용법: bash setup-rnnoise.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WASM_FILE="$SCRIPT_DIR/rnnoise.wasm"

echo "=== RNNoise WASM 다운로드 ==="
echo ""

# 방법 1: timephy/rnnoise-wasm 공식 WASM 빌드 (rnnoise-wasm npm 패키지)
echo "[1/2] rnnoise-wasm npm 패키지에서 WASM 파일 추출..."

if command -v npm &> /dev/null; then
    TEMP_DIR=$(mktemp -d)
    cd "$TEMP_DIR"
    npm pack @timephy/rnnoise-wasm 2>/dev/null || true

    if ls *.tgz 1> /dev/null 2>&1; then
        tar xzf *.tgz
        FOUND_WASM=$(find . -name "*.wasm" | head -1)
        if [ -n "$FOUND_WASM" ]; then
            cp "$FOUND_WASM" "$WASM_FILE"
            echo "✅ WASM 파일 다운로드 완료: $WASM_FILE"
            rm -rf "$TEMP_DIR"
            exit 0
        fi
    fi
    rm -rf "$TEMP_DIR"
fi

# 방법 2: 직접 빌드 안내
echo ""
echo "[2/2] npm 패키지를 사용할 수 없는 경우, 직접 빌드할 수 있습니다:"
echo ""
echo "  # Docker + Emscripten 빌드 (timephy/rnnoise-wasm):"
echo "  git clone https://github.com/timephy/rnnoise-wasm.git"
echo "  cd rnnoise-wasm"
echo "  npm install && npm run build"
echo "  cp src/generated/*.wasm $WASM_FILE"
echo ""
echo "  # 또는 Jitsi 버전:"
echo "  git clone https://github.com/jitsi/rnnoise-wasm.git"
echo ""
echo "또는 npm에서 직접 추출:"
echo "  npm pack @timephy/rnnoise-wasm && tar xzf *.tgz && find . -name '*.wasm'"
echo ""

# 방법 3: 폴백 - 빈 WASM (폴백 노이즈 억제가 동작)
if [ ! -f "$WASM_FILE" ]; then
    echo "⚠️  WASM 파일을 찾을 수 없습니다."
    echo "   Extension은 폴백 모드(스펙트럼 노이즈 억제)로 동작합니다."
    echo "   RNNoise WASM을 사용하려면 rnnoise.wasm 파일을 이 디렉토리에 배치하세요."
fi
