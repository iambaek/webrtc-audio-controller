/**
 * Dooray WebRTC Audio Controller - Content Script (MAIN world)
 *
 * WebRTC getUserMedia를 인터셉트하여 오디오 처리 파이프라인을 삽입합니다.
 * - 에코 캔슬레이션 강화 (브라우저 내장)
 * - 볼륨 부스트 (GainNode)
 * - 주파수 필터링 (HPF / LPF)
 * - 다이나믹 컴프레서 (레인지 제어)
 * - 하울링 감지 및 자동 억제 (FFT 분석)
 * - RNNoise (Mozilla) 딥러닝 기반 노이즈 제거 (AudioWorklet + WASM)
 *
 * ※ MAIN world에서 실행되므로 chrome.runtime 사용 불가.
 *    bridge.js (ISOLATED world)와 window.postMessage로 통신합니다.
 */

(function () {
  'use strict';

  if (window.__doorayAudioControllerInjected) return;
  window.__doorayAudioControllerInjected = true;

  // ── Extension 리소스 URL (bridge.js로부터 수신) ──
  let extensionUrls = { rnnoiseWorklet: null, rnnoiseWasm: null };

  // ── 설정 기본값 ──
  const DEFAULT_SETTINGS = {
    enabled: true,
    gain: 1.5,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    noiseGateThreshold: -50,
    compressorThreshold: -24,
    compressorRatio: 4,
    compressorKnee: 10,
    compressorAttack: 0.003,
    compressorRelease: 0.25,
    howlingDetection: true,
    howlingSuppressionGain: 0.1,
    highPassFrequency: 80,
    lowPassFrequency: 14000,
    rnnoiseEnabled: true,
  };

  let currentSettings = { ...DEFAULT_SETTINGS };
  let audioContexts = [];
  let processingNodes = [];

  // ── 설정 로드/저장 (localStorage) ──
  function loadSettings() {
    try {
      const saved = localStorage.getItem('dooray_audio_settings');
      if (saved) currentSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    } catch (e) { /* ignore */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem('dooray_audio_settings', JSON.stringify(currentSettings));
    } catch (e) { /* ignore */ }
  }

  // ── Bridge 통신 (window.postMessage) ──
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;

    if (data?.source === 'dooray-audio-bridge') {
      // Extension URL 수신
      if (data.type === 'EXTENSION_URLS') {
        extensionUrls = data.urls;
        console.log('[DoorayAudio] Extension URL 수신:', extensionUrls);
        return;
      }

      // 팝업으로부터의 요청 처리
      const requestId = data.requestId;
      const msg = data.payload;

      if (!msg || !msg.type) return;

      let responsePayload = null;

      switch (msg.type) {
        case 'GET_SETTINGS':
          responsePayload = { settings: currentSettings, active: processingNodes.length > 0 };
          break;

        case 'UPDATE_SETTINGS':
          currentSettings = { ...currentSettings, ...msg.settings };
          saveSettings();
          applySettingsToAllNodes();
          responsePayload = { success: true };
          break;

        case 'GET_AUDIO_LEVELS':
          responsePayload = { levels: getAudioLevels() };
          break;

        case 'RESET_SETTINGS':
          currentSettings = { ...DEFAULT_SETTINGS };
          saveSettings();
          applySettingsToAllNodes();
          responsePayload = { success: true, settings: currentSettings };
          break;
      }

      if (responsePayload && requestId) {
        window.postMessage({
          source: 'dooray-audio-main',
          requestId: requestId,
          payload: responsePayload
        }, '*');
      }
    }
  });

  // ── 실시간 레벨 측정 ──
  function getAudioLevels() {
    const levels = [];
    for (const node of processingNodes) {
      if (node.analyser) {
        const data = new Uint8Array(node.analyser.fftSize);
        node.analyser.getByteTimeDomainData(data);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const val = (data[i] - 128) / 128;
          sum += val * val;
          const absVal = Math.abs(val);
          if (absVal > peak) peak = absVal;
        }
        const rms = Math.sqrt(sum / data.length);
        const db = 20 * Math.log10(Math.max(rms, 1e-10));
        levels.push({
          rms,
          db,
          peak,
          howlingDetected: node.howlingDetected || false
        });
      }
    }
    return levels;
  }

  // ── 하울링 감지 & 억제 (프리-알로케이트 노치 필터) ──
  //
  // 설계 원칙:
  //   1. 노치 필터를 파이프라인에 미리 생성 (allpass=투명 통과)
  //      → disconnect/reconnect 없이 type만 변경하여 활성화
  //      → 오디오 끊김/글리치 완전 제거
  //   2. 감지용 분석기(preGainAnalyser)는 게인 노드 앞에 배치
  //   3. 하울링 감지 시 노치 필터(notch) 활성화 + 게인 강력 감소
  //   4. 복원은 3초 이상 미감지 후 서서히 진행
  //
  const HOWLING_DETECT_INTERVAL_MS = 50; // 50ms 간격 (20Hz 분석)
  const MAX_NOTCH_FILTERS = 3;          // 프리-알로케이트 노치 필터 수
  const NOTCH_Q = 10;                   // 넓은 노치 대역 (이전 Q=30은 너무 좁았음)
  const DETECTION_THRESHOLD = 2;        // 연속 감지 횟수 (빠른 반응)
  const RECOVERY_THRESHOLD = 60;        // 연속 미감지 횟수 (60 × 50ms = 3초)
  const ENERGY_DIFF_THRESHOLD = 15;     // 피크 돌출 임계값 dB (낮을수록 민감)
  const MAX_ENERGY_THRESHOLD = -45;     // 최소 피크 에너지 dB (약한 하울링도 감지)
  const NOTCH_HOLD_TIME_MS = 3000;      // 노치 필터 유지 시간 (감지 해소 후)

  function createHowlingDetector(audioCtx, preGainAnalyser, gainNode, notchFilters) {
    const bufferLength = preGainAnalyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    const freqResolution = audioCtx.sampleRate / (preGainAnalyser.fftSize || 4096);

    let isHowling = false;
    let consecutiveDetections = 0;
    let consecutiveNonDetections = 0;

    // 각 프리-알로케이트 노치 필터의 상태
    const notchStates = notchFilters.map(() => ({
      active: false, freq: 0, lastDetected: 0
    }));

    function findDominantHowlingFreq() {
      preGainAnalyser.getFloatFrequencyData(dataArray);

      let totalEnergy = 0, count = 0;
      for (let i = 0; i < bufferLength; i++) {
        const energy = dataArray[i];
        if (isFinite(energy) && energy > -100) {
          totalEnergy += energy;
          count++;
        }
      }
      const avgEnergy = count > 0 ? totalEnergy / count : -100;

      const peaks = [];
      for (let i = 2; i < bufferLength - 2; i++) {
        const energy = dataArray[i];
        if (!isFinite(energy)) continue;

        const freq = i * freqResolution;
        if (freq < 200 || freq > 4000) continue;

        const isLocalPeak = energy > dataArray[i - 1] && energy > dataArray[i + 1]
                         && energy > dataArray[i - 2] && energy > dataArray[i + 2];
        const diff = energy - avgEnergy;

        if (isLocalPeak && diff > ENERGY_DIFF_THRESHOLD && energy > MAX_ENERGY_THRESHOLD) {
          peaks.push({ freq, energy, diff, bin: i });
        }
      }

      peaks.sort((a, b) => b.diff - a.diff);
      return peaks.slice(0, MAX_NOTCH_FILTERS);
    }

    // 노치 필터 활성화: type을 'notch'로 변경 (disconnect 불필요)
    function activateNotch(index, freq) {
      if (index >= notchFilters.length) return;
      // 이미 유사 주파수에 활성화되어 있으면 주파수만 미세 조정
      if (notchStates[index].active && Math.abs(notchStates[index].freq - freq) < 80) {
        notchFilters[index].frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.01);
        notchStates[index].lastDetected = Date.now();
        return;
      }
      notchFilters[index].type = 'notch';
      notchFilters[index].frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.01);
      notchFilters[index].Q.value = NOTCH_Q;
      notchStates[index] = { active: true, freq, lastDetected: Date.now() };
      console.warn(`[DoorayAudio] 노치 필터[${index}] 활성화: ${Math.round(freq)}Hz (Q=${NOTCH_Q})`);
    }

    // 노치 필터 비활성화: type을 'allpass'로 복원 (투명 통과)
    function deactivateNotch(index) {
      if (index >= notchFilters.length || !notchStates[index].active) return;
      notchFilters[index].type = 'allpass';
      console.log(`[DoorayAudio] 노치 필터[${index}] 해제: ${Math.round(notchStates[index].freq)}Hz`);
      notchStates[index].active = false;
    }

    function deactivateAllNotches() {
      for (let i = 0; i < notchFilters.length; i++) {
        if (notchStates[i].active) {
          notchFilters[i].type = 'allpass';
          notchStates[i].active = false;
        }
      }
    }

    const intervalId = setInterval(() => {
      if (audioCtx.state === 'closed') {
        clearInterval(intervalId);
        return;
      }

      if (!currentSettings.howlingDetection || !currentSettings.enabled) {
        if (isHowling) {
          gainNode.gain.setTargetAtTime(currentSettings.gain, audioCtx.currentTime, 0.3);
          isHowling = false;
          consecutiveDetections = 0;
        }
        deactivateAllNotches();
        return;
      }

      const peaks = findDominantHowlingFreq();

      if (peaks.length > 0) {
        consecutiveDetections++;
        consecutiveNonDetections = 0;

        if (consecutiveDetections >= DETECTION_THRESHOLD) {
          // 감지된 피크 주파수에 노치 필터 활성화
          for (let i = 0; i < MAX_NOTCH_FILTERS; i++) {
            if (i < peaks.length) {
              activateNotch(i, peaks[i].freq);
            }
          }

          if (!isHowling) {
            isHowling = true;
            // 게인도 강력하게 감소 (노치만으로 부족할 수 있음)
            gainNode.gain.setTargetAtTime(
              currentSettings.howlingSuppressionGain, // 기본값 0.1
              audioCtx.currentTime, 0.03
            );
            console.warn(`[DoorayAudio] 하울링 감지! ${peaks.map(p => Math.round(p.freq) + 'Hz').join(', ')} (${Math.round(peaks[0].diff)}dB 돌출)`);
          }
        }
      } else {
        consecutiveNonDetections++;

        // 만료된 노치 필터 개별 해제 (NOTCH_HOLD_TIME_MS 이후)
        const now = Date.now();
        for (let i = 0; i < notchStates.length; i++) {
          if (notchStates[i].active && now - notchStates[i].lastDetected > NOTCH_HOLD_TIME_MS) {
            deactivateNotch(i);
          }
        }

        // 충분히 오래 미감지 시 게인 복원 (3초)
        if (consecutiveNonDetections >= RECOVERY_THRESHOLD && isHowling) {
          isHowling = false;
          consecutiveDetections = 0;
          deactivateAllNotches();
          gainNode.gain.setTargetAtTime(currentSettings.gain, audioCtx.currentTime, 0.5);
          console.log('[DoorayAudio] 하울링 해소, 게인 복원');
        }
      }

      for (const node of processingNodes) {
        if (node.gainNode === gainNode) node.howlingDetected = isHowling;
      }
    }, HOWLING_DETECT_INTERVAL_MS);

    return intervalId;
  }

  // ── RNNoise AudioWorklet 초기화 ──
  // 새 워크릿은 WASM이 base64로 JS에 내장되어 있어 별도 .wasm 파일 로드 불필요
  async function initRNNoiseWorklet(audioCtx) {
    if (!extensionUrls.rnnoiseWorklet) {
      console.warn('[DoorayAudio] rnnoiseWorklet URL이 null입니다');
      return false;
    }
    try {
      const startTime = performance.now();
      await audioCtx.audioWorklet.addModule(extensionUrls.rnnoiseWorklet);
      const elapsed = (performance.now() - startTime).toFixed(0);
      console.log(`[DoorayAudio] RNNoise AudioWorklet 등록 완료 (WASM 내장, ${elapsed}ms)`);
      return true;
    } catch (e) {
      console.error('[DoorayAudio] AudioWorklet 등록 실패:', e.message || e);
      console.error('[DoorayAudio] 가능한 원인: CSP(Content-Security-Policy)가 chrome-extension:// 스크립트를 차단할 수 있습니다');
      return false;
    }
  }

  // ── 오디오 처리 파이프라인 생성 ──
  async function createAudioPipeline(stream) {
    if (!currentSettings.enabled) return stream;

    const audioCtx = new AudioContext({ sampleRate: 48000 });
    audioContexts.push(audioCtx);

    const source = audioCtx.createMediaStreamSource(stream);
    const destination = audioCtx.createMediaStreamDestination();

    // 1) HPF (저주파 잡음 제거)
    const highPass = audioCtx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = currentSettings.highPassFrequency;
    highPass.Q.value = 0.7;

    // 2) LPF (고주파 잡음 제거)
    const lowPass = audioCtx.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = currentSettings.lowPassFrequency;
    lowPass.Q.value = 0.7;

    // 3) RNNoise 딥러닝 노이즈 제거
    //    WASM이 워크릿 JS에 base64로 내장되어 있어 별도 전송 불필요
    let rnnoiseNode = null;
    console.log(`[DoorayAudio] RNNoise 조건 확인: enabled=${currentSettings.rnnoiseEnabled}, workletUrl=${!!extensionUrls.rnnoiseWorklet}`);
    if (currentSettings.rnnoiseEnabled && extensionUrls.rnnoiseWorklet) {
      try {
        console.log('[DoorayAudio] RNNoise addModule 시작:', extensionUrls.rnnoiseWorklet.substring(0, 80));
        await initRNNoiseWorklet(audioCtx);
        rnnoiseNode = new AudioWorkletNode(audioCtx, 'rnnoise-processor');
        console.log('[DoorayAudio] RNNoise AudioWorklet 노드 생성 완료');
      } catch (e) {
        console.warn('[DoorayAudio] RNNoise 초기화 실패:', e.message || e);
        rnnoiseNode = null;
      }
    } else {
      console.warn(`[DoorayAudio] RNNoise 건너뜀: rnnoiseEnabled=${currentSettings.rnnoiseEnabled}, workletUrl=${extensionUrls.rnnoiseWorklet}`);
    }

    // 4) 다이나믹 컴프레서
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = currentSettings.compressorThreshold;
    compressor.ratio.value = currentSettings.compressorRatio;
    compressor.knee.value = currentSettings.compressorKnee;
    compressor.attack.value = currentSettings.compressorAttack;
    compressor.release.value = currentSettings.compressorRelease;

    // 5) 게인 (볼륨 부스트)
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = currentSettings.gain;

    // 6) 하울링 감지용 분석기 (게인 앞 = pre-gain)
    //    게인 변경에 영향받지 않아 안정적으로 하울링 감지 가능
    const preGainAnalyser = audioCtx.createAnalyser();
    preGainAnalyser.fftSize = 4096; // 높은 주파수 해상도 (~11.7Hz/bin at 48kHz)
    preGainAnalyser.smoothingTimeConstant = 0.3; // 빠른 반응 (낮을수록 민감)

    // 7) 레벨 미터용 분석기 (게인 뒤 = post-gain)
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    // 노치 필터 프리-알로케이트 (allpass = 투명 통과, type 변경만으로 활성화)
    // → disconnect/reconnect 없이 오디오 글리치 제거
    const notchFilters = [];
    for (let i = 0; i < MAX_NOTCH_FILTERS; i++) {
      const notch = audioCtx.createBiquadFilter();
      notch.type = 'allpass'; // 비활성 시 투명 통과
      notch.frequency.value = 1000;
      notch.Q.value = NOTCH_Q;
      notchFilters.push(notch);
    }

    // 체인: source → HPF → LPF → [RNNoise] → compressor
    //        → preGainAnalyser (분석 분기, dead-end)
    //        → notch[0] → notch[1] → notch[2] → gain → analyser → destination
    source.connect(highPass);
    highPass.connect(lowPass);

    if (rnnoiseNode) {
      lowPass.connect(rnnoiseNode);
      rnnoiseNode.connect(compressor);
    } else {
      lowPass.connect(compressor);
    }

    // 분석 분기 (dead-end, 감지 전용)
    compressor.connect(preGainAnalyser);
    // 메인 체인: compressor → notch chain → gainNode
    compressor.connect(notchFilters[0]);
    for (let i = 0; i < notchFilters.length - 1; i++) {
      notchFilters[i].connect(notchFilters[i + 1]);
    }
    notchFilters[notchFilters.length - 1].connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(destination);

    const nodeInfo = {
      audioCtx, source, highPass, lowPass, rnnoiseNode,
      compressor, gainNode, analyser, preGainAnalyser,
      notchFilters, destination,
      howlingDetected: false,
      howlingIntervalId: null
    };
    processingNodes.push(nodeInfo);

    nodeInfo.howlingIntervalId = createHowlingDetector(audioCtx, preGainAnalyser, gainNode, notchFilters);

    // 배지 업데이트 요청
    window.postMessage({
      source: 'dooray-audio-main',
      type: 'UPDATE_BADGE',
      payload: { type: 'UPDATE_BADGE', active: true }
    }, '*');

    console.log('[DoorayAudio] 오디오 파이프라인 활성화');
    console.log(`  게인: ${currentSettings.gain}x | HPF: ${currentSettings.highPassFrequency}Hz | LPF: ${currentSettings.lowPassFrequency}Hz | RNNoise: ${rnnoiseNode ? 'ON' : 'OFF'}`);

    // 비디오 트랙 보존
    const processedStream = destination.stream;
    for (const vt of stream.getVideoTracks()) {
      processedStream.addTrack(vt);
    }

    return processedStream;
  }

  // ── 설정 실시간 적용 ──
  function applySettingsToAllNodes() {
    for (const node of processingNodes) {
      if (!node.audioCtx || node.audioCtx.state === 'closed') continue;
      const t = node.audioCtx.currentTime;

      node.gainNode.gain.setTargetAtTime(currentSettings.gain, t, 0.05);
      node.highPass.frequency.setTargetAtTime(currentSettings.highPassFrequency, t, 0.05);
      node.lowPass.frequency.setTargetAtTime(currentSettings.lowPassFrequency, t, 0.05);
      node.compressor.threshold.setTargetAtTime(currentSettings.compressorThreshold, t, 0.05);
      node.compressor.ratio.setTargetAtTime(currentSettings.compressorRatio, t, 0.05);
      node.compressor.knee.setTargetAtTime(currentSettings.compressorKnee, t, 0.05);
      node.compressor.attack.setTargetAtTime(currentSettings.compressorAttack, t, 0.05);
      node.compressor.release.setTargetAtTime(currentSettings.compressorRelease, t, 0.05);

      // RNNoise 런타임 토글: @timephy 워크릿은 항상 처리하므로
      // 비활성화 시 노드를 disconnect/reconnect로 바이패스
      // (향후 개선 사항: 동적 연결 변경)
    }
    console.log('[DoorayAudio] 설정 적용 완료');
  }

  // ── getUserMedia 인터셉트 ──
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    if (constraints && constraints.audio) {
      if (typeof constraints.audio === 'boolean') constraints.audio = {};

      constraints.audio = {
        ...constraints.audio,
        echoCancellation: { ideal: currentSettings.echoCancellation },
        noiseSuppression: { ideal: currentSettings.noiseSuppression },
        autoGainControl: { ideal: currentSettings.autoGainControl },
      };

      console.log('[DoorayAudio] getUserMedia 인터셉트, constraints 강화');
    }

    const stream = await originalGetUserMedia(constraints);

    if (stream.getAudioTracks().length > 0 && currentSettings.enabled) {
      try {
        return await createAudioPipeline(stream);
      } catch (e) {
        console.error('[DoorayAudio] 파이프라인 생성 실패, 원본 반환:', e);
        return stream;
      }
    }

    return stream;
  };

  // ── RTCPeerConnection 래핑 (수신 오디오 트랙 로깅) ──
  const OriginalRTCPeerConnection = window.RTCPeerConnection;

  window.RTCPeerConnection = function (...args) {
    const pc = new OriginalRTCPeerConnection(...args);

    const origAddEventListener = pc.addEventListener.bind(pc);
    pc.addEventListener = function (type, listener, options) {
      if (type === 'track') {
        const wrapped = function (event) {
          if (event.track.kind === 'audio' && currentSettings.enabled) {
            console.log('[DoorayAudio] 수신 오디오 트랙 감지');
          }
          listener.call(this, event);
        };
        return origAddEventListener(type, wrapped, options);
      }
      return origAddEventListener(type, listener, options);
    };

    let _ontrack = null;
    Object.defineProperty(pc, 'ontrack', {
      get: () => _ontrack,
      set: (handler) => {
        _ontrack = function (event) {
          if (event.track.kind === 'audio') {
            console.log('[DoorayAudio] 수신 오디오 트랙 (ontrack)');
          }
          handler.call(this, event);
        };
      }
    });

    return pc;
  };
  window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;

  // ── 초기화 ──
  loadSettings();
  console.log('[DoorayAudio] Dooray WebRTC Audio Controller 로드 완료');
  console.log(`  활성: ${currentSettings.enabled} | 게인: ${currentSettings.gain}x | RNNoise: ${currentSettings.rnnoiseEnabled}`);
})();
