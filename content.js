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
        for (let i = 0; i < data.length; i++) {
          const val = (data[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / data.length);
        const db = 20 * Math.log10(Math.max(rms, 1e-10));
        levels.push({
          rms,
          db,
          peak: Math.max(...Array.from(data).map(v => Math.abs(v - 128) / 128)),
          howlingDetected: node.howlingDetected || false
        });
      }
    }
    return levels;
  }

  // ── 하울링 감지 (FFT 주파수 분석) ──
  function createHowlingDetector(audioCtx, analyser, gainNode) {
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    let consecutiveDetections = 0;
    const DETECTION_THRESHOLD = 5;
    let isHowling = false;

    function detect() {
      if (!currentSettings.howlingDetection || !currentSettings.enabled) {
        if (isHowling) {
          gainNode.gain.setTargetAtTime(currentSettings.gain, audioCtx.currentTime, 0.1);
          isHowling = false;
        }
        requestAnimationFrame(detect);
        return;
      }

      analyser.getFloatFrequencyData(dataArray);

      let totalEnergy = 0, maxEnergy = -Infinity, maxFreqIndex = 0, count = 0;
      for (let i = 0; i < bufferLength; i++) {
        const energy = dataArray[i];
        if (isFinite(energy) && energy > -Infinity) {
          totalEnergy += energy;
          count++;
          if (energy > maxEnergy) { maxEnergy = energy; maxFreqIndex = i; }
        }
      }

      const avgEnergy = count > 0 ? totalEnergy / count : -100;
      const energyDiff = maxEnergy - avgEnergy;
      const freq = maxFreqIndex * (audioCtx.sampleRate / (analyser.fftSize || 2048));
      const isNarrowPeak = energyDiff > 30;
      const isHowlingRange = freq > 200 && freq < 4000;

      if (isNarrowPeak && isHowlingRange && maxEnergy > -30) {
        consecutiveDetections++;
      } else {
        consecutiveDetections = Math.max(0, consecutiveDetections - 1);
      }

      if (consecutiveDetections >= DETECTION_THRESHOLD && !isHowling) {
        isHowling = true;
        gainNode.gain.setTargetAtTime(currentSettings.howlingSuppressionGain, audioCtx.currentTime, 0.01);
        console.warn(`[DoorayAudio] 하울링 감지! (${Math.round(freq)}Hz, ${Math.round(energyDiff)}dB 돌출)`);
      } else if (consecutiveDetections < 2 && isHowling) {
        isHowling = false;
        gainNode.gain.setTargetAtTime(currentSettings.gain, audioCtx.currentTime, 0.3);
        console.log('[DoorayAudio] 하울링 해소, 게인 복원');
      }

      for (const node of processingNodes) {
        if (node.gainNode === gainNode) node.howlingDetected = isHowling;
      }

      requestAnimationFrame(detect);
    }

    detect();
  }

  // ── RNNoise AudioWorklet 초기화 ──
  let rnnoiseWasmBytes = null;

  async function loadRNNoiseWasm() {
    if (!extensionUrls.rnnoiseWasm) return false;
    try {
      const response = await fetch(extensionUrls.rnnoiseWasm);
      if (response.ok) {
        rnnoiseWasmBytes = await response.arrayBuffer();
        console.log('[DoorayAudio] RNNoise WASM 로드 완료');
        return true;
      }
    } catch (e) {
      console.warn('[DoorayAudio] RNNoise WASM 로드 실패:', e);
    }
    return false;
  }

  async function initRNNoiseWorklet(audioCtx) {
    if (!extensionUrls.rnnoiseWorklet) return false;
    try {
      await audioCtx.audioWorklet.addModule(extensionUrls.rnnoiseWorklet);
      console.log('[DoorayAudio] RNNoise AudioWorklet 등록 완료');
      return true;
    } catch (e) {
      console.warn('[DoorayAudio] AudioWorklet 등록 실패:', e);
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
    let rnnoiseNode = null;
    if (currentSettings.rnnoiseEnabled && extensionUrls.rnnoiseWorklet) {
      try {
        await initRNNoiseWorklet(audioCtx);
        rnnoiseNode = new AudioWorkletNode(audioCtx, 'rnnoise-processor', {
          processorOptions: { wasmPath: extensionUrls.rnnoiseWasm }
        });

        if (!rnnoiseWasmBytes) await loadRNNoiseWasm();
        if (rnnoiseWasmBytes) {
          rnnoiseNode.port.postMessage({ type: 'WASM_MODULE', wasmBytes: rnnoiseWasmBytes });
        }

        rnnoiseNode.port.onmessage = (event) => {
          if (event.data.type === 'WASM_READY') {
            console.log('[DoorayAudio] RNNoise WASM 처리 준비 완료');
          }
        };
      } catch (e) {
        console.warn('[DoorayAudio] RNNoise 초기화 실패:', e);
        rnnoiseNode = null;
      }
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

    // 6) 분석기 (레벨 & 하울링)
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    // 체인: source → HPF → LPF → [RNNoise] → compressor → gain → analyser → destination
    source.connect(highPass);
    highPass.connect(lowPass);

    if (rnnoiseNode) {
      lowPass.connect(rnnoiseNode);
      rnnoiseNode.connect(compressor);
    } else {
      lowPass.connect(compressor);
    }

    compressor.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(destination);

    const nodeInfo = {
      audioCtx, source, highPass, lowPass, rnnoiseNode,
      compressor, gainNode, analyser, destination,
      howlingDetected: false
    };
    processingNodes.push(nodeInfo);

    createHowlingDetector(audioCtx, analyser, gainNode);

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

      if (node.rnnoiseNode) {
        node.rnnoiseNode.port.postMessage({
          type: 'SET_ENABLED',
          enabled: currentSettings.rnnoiseEnabled
        });
      }
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
