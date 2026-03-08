# Dooray WebRTC Audio Controller v0.2.0

Dooray 화상회의 오디오 품질을 개선하는 Chrome Extension입니다.

## 주요 기능

- **VAD 자동 마이크 제어**: 음성 활동 감지(Voice Activity Detection)로 말할 때만 마이크 자동 ON/OFF
- **하울링 자동 감지 & 억제**: FFT 주파수 분석으로 하울링(피드백) 발생 시 자동 게인 감소
- **볼륨 부스트**: 소리가 작을 때 최대 4배까지 증폭
- **RNNoise AI 노이즈 제거**: Mozilla 개발 딥러닝 기반 실시간 노이즈 제거 (AudioWorklet + WASM)
- **에코 캔슬레이션 강화**: 브라우저 내장 에코 캔슬레이션 최적화
- **주파수 필터링**: 고역/저역 통과 필터로 불필요한 잡음 차단
- **다이나믹 컴프레서**: 소리 크기 편차 줄여 일정한 음량 유지
- **프리셋**: 조용한 환경 / 소음 환경 / 회의실 / 볼륨 최대 4가지 프리셋
- **실시간 모니터링**: 오디오 레벨 미터, 하울링 감지 표시
- **대시보드**: 별도 탭에서 FFT 스펙트럼, 파형 시각화 및 상세 파라미터 제어
- **파이프라인 플레이그라운드**: 오디오 처리 파이프라인 구조 시각화 및 학습용 인터랙티브 페이지

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
├── manifest.json              # Extension 설정 (Manifest V3)
├── content.js                 # MAIN world - WebRTC 인터셉트 & 오디오 파이프라인 & VAD
├── bridge.js                  # ISOLATED world - 팝업 ↔ content script 중개
├── background.js              # Service worker - 아이콘 상태 관리 & 설정 브로드캐스트
├── popup.html / popup.js      # 팝업 UI & 로직
├── dashboard.html / dashboard.js  # 대시보드 - 실시간 모니터링 & 상세 제어
├── pipeline-playground.html   # 파이프라인 시각화 플레이그라운드
├── rnnoise-worklet.js         # RNNoise AudioWorklet 프로세서 (WASM base64 내장)
└── icons/                     # Extension 아이콘
```

## 오디오 처리 체인

```
마이크 → getUserMedia (constraints 강화)
       → HPF (저주파 잡음 차단)
       → LPF (고주파 잡음 차단)
       → RNNoise (AI 노이즈 제거)
       → DynamicsCompressor (음량 평탄화)
       → PreGainAnalyser (하울링 감지 + VAD 음성 감지)
       → Notch Filters (하울링 억제)
       → GainNode (볼륨 부스트)
       → wet/dry Routing (VAD 자동 마이크 ON/OFF)
       → PostGainAnalyser (레벨 미터)
       → WebRTC 전송
```

## VAD (Voice Activity Detection)

음성 활동 감지 기반 자동 마이크 제어 기능:

- **자동 마이크 OFF**: 말하지 않을 때 설정된 복구 지연 후 마이크 자동 비활성화
- **자동 마이크 ON**: 음성 감지 시 즉시 마이크 활성화
- **설정 가능 파라미터**:
  - 감지 임계값 (-60dB ~ -20dB, 기본 -35dB)
  - 복구 지연 (500ms ~ 5000ms, 기본 2000ms)
  - 히스테리시스 (0 ~ 10dB, 기본 3dB) - 온/오프 경계 진동 방지

## 기술 스택

- Manifest V3 Chrome Extension
- Web Audio API (AudioContext, AudioWorklet, AnalyserNode)
- RNNoise (WebAssembly) - Mozilla 딥러닝 노이즈 제거
- WebRTC getUserMedia / RTCPeerConnection 인터셉트
- chrome.storage.local + runtime messaging (팝업/대시보드 실시간 동기화)
