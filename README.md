# Dooray WebRTC Audio Controller

Dooray 화상회의 오디오 품질을 개선하는 Chrome Extension입니다.

## 주요 기능

- **하울링 자동 감지 & 억제**: FFT 주파수 분석으로 하울링(피드백) 발생 시 자동 게인 감소
- **볼륨 부스트**: 소리가 작을 때 최대 4배까지 증폭
- **RNNoise AI 노이즈 제거**: Mozilla 개발 딥러닝 기반 실시간 노이즈 제거 (AudioWorklet + WASM)
- **에코 캔슬레이션 강화**: 브라우저 내장 에코 캔슬레이션 최적화
- **주파수 필터링**: 고역/저역 통과 필터로 불필요한 잡음 차단
- **다이나믹 컴프레서**: 소리 크기 편차 줄여 일정한 음량 유지
- **프리셋**: 조용한 환경 / 소음 환경 / 회의실 / 볼륨 최대 4가지 프리셋
- **실시간 모니터링**: 오디오 레벨 미터, 하울링 감지 표시

## 설치 방법

### 1. Chrome에 로드

1. Chrome에서 `chrome://extensions` 열기
2. 우측 상단 **개발자 모드** 활성화
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. 이 폴더(`webrtc-audio-controller`) 선택

### 2. 사용

1. Dooray 화상회의 페이지 접속
2. Extension 아이콘 클릭하여 팝업 열기
3. 프리셋 선택 또는 개별 파라미터 조절

## 파일 구조

```
webrtc-audio-controller/
├── manifest.json          # Extension 설정
├── content.js             # MAIN world - WebRTC 인터셉트 & 오디오 파이프라인
├── bridge.js              # ISOLATED world - 팝업 ↔ content script 중개
├── background.js          # Service worker - 아이콘 상태 관리
├── popup.html             # 팝업 UI
├── popup.js               # 팝업 로직
├── rnnoise-worklet.js     # RNNoise AudioWorklet 프로세서
├── rnnoise.wasm           # RNNoise WASM 바이너리 (setup-rnnoise.sh로 다운로드)
├── setup-rnnoise.sh       # WASM 다운로드 스크립트
└── icons/                 # Extension 아이콘
```

## 오디오 처리 체인

```
마이크 → getUserMedia (constraints 강화)
       → HPF (저주파 잡음 차단)
       → LPF (고주파 잡음 차단)
       → RNNoise (AI 노이즈 제거)
       → DynamicsCompressor (음량 평탄화)
       → GainNode (볼륨 부스트)
       → Analyser (레벨 모니터 & 하울링 감지)
       → WebRTC 전송
```

## 기술 스택

- Manifest V3 Chrome Extension
- Web Audio API (AudioContext, AudioWorklet)
- RNNoise (WebAssembly) - Mozilla 딥러닝 노이즈 제거
- WebRTC getUserMedia / RTCPeerConnection 인터셉트
