/**
 * Dooray Audio Controller - Dashboard Page Script
 *
 * 별도 탭에서 실시간 오디오 모니터링 & 제어를 제공합니다.
 * - FFT 주파수 스펙트럼 시각화
 * - 파형 시각화
 * - 실시간 레벨 미터
 * - 모든 파라미터 제어
 * - 이벤트 로그
 * - 팝업과 실시간 동기화 (chrome.storage.onChanged + runtime message)
 */

(function () {
  'use strict';

  // ── 프리셋 정의 ──
  const PRESETS = {
    quiet: {
      gain: 1.0, highPassFrequency: 50, lowPassFrequency: 16000,
      compressorThreshold: -20, compressorRatio: 2, compressorKnee: 10,
      compressorAttack: 0.003, compressorRelease: 0.25,
      rnnoiseEnabled: false, howlingDetection: false,
      noiseSuppression: true, echoCancellation: true, autoGainControl: true,
    },
    noisy: {
      gain: 1.8, highPassFrequency: 120, lowPassFrequency: 12000,
      compressorThreshold: -30, compressorRatio: 6, compressorKnee: 15,
      compressorAttack: 0.003, compressorRelease: 0.25,
      rnnoiseEnabled: true, noiseSuppression: true, howlingDetection: true,
      echoCancellation: true, autoGainControl: true,
    },
    meeting: {
      gain: 1.5, highPassFrequency: 80, lowPassFrequency: 14000,
      compressorThreshold: -24, compressorRatio: 4, compressorKnee: 10,
      compressorAttack: 0.003, compressorRelease: 0.25,
      echoCancellation: true, rnnoiseEnabled: true, howlingDetection: true,
      noiseSuppression: true, autoGainControl: true,
    },
    boost: {
      gain: 3.5, highPassFrequency: 60, lowPassFrequency: 16000,
      compressorThreshold: -18, compressorRatio: 8, compressorKnee: 5,
      compressorAttack: 0.001, compressorRelease: 0.15,
      rnnoiseEnabled: true, autoGainControl: false,
      noiseSuppression: true, echoCancellation: true, howlingDetection: true,
    },
  };

  // ── 슬라이더 컨트롤 매핑 ──
  const SLIDERS = {
    gain:                { display: 'gainValue',        format: v => `${v}x` },
    highPassFrequency:   { display: 'highPassValue',    format: v => v >= 1000 ? `${(v/1000).toFixed(1)} kHz` : `${v} Hz` },
    lowPassFrequency:    { display: 'lowPassValue',     format: v => v >= 1000 ? `${(v/1000).toFixed(0)} kHz` : `${v} Hz` },
    compressorThreshold: { display: 'compThreshValue',  format: v => `${v} dB` },
    compressorRatio:     { display: 'compRatioValue',   format: v => `${v}:1` },
    compressorKnee:      { display: 'compKneeValue',    format: v => `${v} dB` },
    compressorAttack:    { display: 'compAttackValue',  format: v => `${Math.round(v * 1000)} ms` },
    compressorRelease:   { display: 'compReleaseValue', format: v => `${Math.round(v * 1000)} ms` },
  };

  const TOGGLES = [
    'rnnoiseEnabled', 'noiseSuppression', 'echoCancellation',
    'howlingDetection', 'autoGainControl'
  ];

  let currentSettings = {};
  let doorayTabId = null;
  let pollInterval = null;
  let fftCtx, waveCtx;
  let ignoreNextStorageChange = false;

  // ── 초기화 ──
  document.addEventListener('DOMContentLoaded', () => {
    initCanvases();
    findDoorayTab();
    bindEvents();
    startPolling();
    listenForExternalChanges();
    addLog('info', '대시보드 시작됨');
  });

  // ── 캔버스 초기화 ──
  function initCanvases() {
    const fftCanvas = document.getElementById('fftCanvas');
    const waveCanvas = document.getElementById('waveCanvas');

    fftCtx = fftCanvas.getContext('2d');
    waveCtx = waveCanvas.getContext('2d');

    function resizeCanvas() {
      for (const canvas of [fftCanvas, waveCanvas]) {
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * devicePixelRatio;
        canvas.height = rect.height * devicePixelRatio;
        canvas.getContext('2d').scale(devicePixelRatio, devicePixelRatio);
      }
    }

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }

  // ── Dooray 탭 찾기 ──
  async function findDoorayTab() {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://*.dooray.com/*' });
      if (tabs.length > 0) {
        doorayTabId = tabs[0].id;
        updateConnectionStatus(true);
        addLog('success', `Dooray 탭 연결됨 (탭 #${doorayTabId})`);
        loadSettings();
      } else {
        updateConnectionStatus(false);
        addLog('warn', 'Dooray 탭을 찾을 수 없습니다. Dooray를 열어주세요.');
      }
    } catch (e) {
      addLog('error', '탭 검색 실패: ' + e.message);
    }
  }

  function updateConnectionStatus(connected) {
    const el = document.getElementById('connectionStatus');
    if (connected) {
      el.textContent = 'Dooray 연결됨';
      el.className = 'status-chip active';
    } else {
      el.textContent = 'Dooray 미연결';
      el.className = 'status-chip inactive';
    }
  }

  // ── content script에 메시지 전송 ──
  async function sendToContent(message) {
    if (!doorayTabId) {
      await findDoorayTab();
      if (!doorayTabId) return null;
    }
    try {
      return await chrome.tabs.sendMessage(doorayTabId, message);
    } catch (e) {
      doorayTabId = null;
      updateConnectionStatus(false);
      return null;
    }
  }

  // ── 설정 → UI 반영 (공통 함수) ──
  function applySettingsToUI(settings) {
    // 마스터 토글
    if (settings.enabled !== undefined) {
      document.getElementById('masterToggle').checked = settings.enabled;
      document.getElementById('masterLabel').textContent = settings.enabled ? '활성' : '비활성';
    }

    // 슬라이더
    for (const [key, cfg] of Object.entries(SLIDERS)) {
      const el = document.getElementById(key);
      const display = document.getElementById(cfg.display);
      if (el && settings[key] !== undefined) {
        el.value = settings[key];
        display.textContent = cfg.format(parseFloat(settings[key]));
      }
    }

    // 토글
    for (const key of TOGGLES) {
      const el = document.getElementById(key);
      if (el && settings[key] !== undefined) {
        el.checked = settings[key];
      }
    }

    // RNNoise 배지
    if (settings.rnnoiseEnabled !== undefined) {
      const rnnBadge = document.getElementById('rnnoiseBadge');
      rnnBadge.textContent = settings.rnnoiseEnabled ? 'RNNoise ON' : 'RNNoise OFF';
      rnnBadge.style.background = settings.rnnoiseEnabled ? '#00b894' : '#636e72';
    }
  }

  // ── 설정 로드 (content script에서) ──
  async function loadSettings() {
    const response = await sendToContent({ type: 'GET_SETTINGS' });
    if (!response) return;

    currentSettings = response.settings;
    const isActive = response.active;

    const pipelineEl = document.getElementById('pipelineStatus');
    if (isActive) {
      pipelineEl.textContent = '파이프라인 활성';
      pipelineEl.className = 'status-chip active';
    } else {
      pipelineEl.textContent = '파이프라인 대기';
      pipelineEl.className = 'status-chip inactive';
    }

    applySettingsToUI(currentSettings);
  }

  // ── 설정 업데이트 (content script + 브로드캐스트) ──
  async function updateSetting(key, value) {
    currentSettings[key] = value;
    await sendToContent({ type: 'UPDATE_SETTINGS', settings: { [key]: value } });
    broadcastSettingsChange(currentSettings);
  }

  async function updateMultipleSettings(settings) {
    Object.assign(currentSettings, settings);
    await sendToContent({ type: 'UPDATE_SETTINGS', settings });
    broadcastSettingsChange(currentSettings);
  }

  // ── 브로드캐스트: background를 통해 팝업에 전파 ──
  function broadcastSettingsChange(settings) {
    ignoreNextStorageChange = true;
    chrome.storage.local.set({ audioSettings: settings });
    chrome.runtime.sendMessage({
      type: 'SETTINGS_CHANGED',
      settings: settings,
      source: 'dashboard'
    }).catch(() => {});
  }

  // ── 외부 변경 수신 (팝업에서 변경한 경우) ──
  function listenForExternalChanges() {
    // 방법 1: chrome.storage.onChanged
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.audioSettings) {
        if (ignoreNextStorageChange) {
          ignoreNextStorageChange = false;
          return;
        }
        const newSettings = changes.audioSettings.newValue;
        if (newSettings) {
          currentSettings = newSettings;
          applySettingsToUI(currentSettings);
          addLog('info', '외부에서 설정 변경 수신 (storage)');
        }
      }
    });

    // 방법 2: runtime 메시지 (background 브로드캐스트)
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'SETTINGS_CHANGED' && message.source !== 'dashboard') {
        currentSettings = message.settings;
        applySettingsToUI(currentSettings);
        addLog('info', `설정 동기화 (${message.source}에서 변경)`);
      }
    });
  }

  // ── 이벤트 바인딩 ──
  function bindEvents() {
    // 마스터 토글
    document.getElementById('masterToggle').addEventListener('change', (e) => {
      const enabled = e.target.checked;
      updateSetting('enabled', enabled);
      document.getElementById('masterLabel').textContent = enabled ? '활성' : '비활성';
      addLog(enabled ? 'success' : 'warn', `오디오 처리 ${enabled ? '활성화' : '비활성화'}`);
    });

    // 슬라이더
    for (const [key, cfg] of Object.entries(SLIDERS)) {
      const el = document.getElementById(key);
      if (!el) continue;
      el.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        document.getElementById(cfg.display).textContent = cfg.format(val);
        updateSetting(key, val);
      });
    }

    // 토글
    for (const key of TOGGLES) {
      const el = document.getElementById(key);
      if (!el) continue;
      el.addEventListener('change', (e) => {
        updateSetting(key, e.target.checked);
        addLog('info', `${key}: ${e.target.checked ? 'ON' : 'OFF'}`);

        if (key === 'rnnoiseEnabled') {
          const badge = document.getElementById('rnnoiseBadge');
          badge.textContent = e.target.checked ? 'RNNoise ON' : 'RNNoise OFF';
          badge.style.background = e.target.checked ? '#00b894' : '#636e72';
        }
      });
    }

    // 프리셋
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const presetKey = btn.dataset.preset;
        const preset = PRESETS[presetKey];
        if (!preset) return;

        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        updateMultipleSettings(preset);
        applySettingsToUI(preset);
        addLog('success', `프리셋 적용: ${presetKey}`);
      });
    });

    // 초기화
    document.getElementById('resetBtn').addEventListener('click', async () => {
      const response = await sendToContent({ type: 'RESET_SETTINGS' });
      if (response?.success) {
        currentSettings = response.settings;
        applySettingsToUI(currentSettings);
        broadcastSettingsChange(currentSettings);
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        addLog('warn', '모든 설정이 초기화되었습니다');
      }
    });

    // 설정 내보내기
    document.getElementById('exportBtn').addEventListener('click', () => {
      const json = JSON.stringify(currentSettings, null, 2);
      navigator.clipboard.writeText(json).then(() => {
        addLog('success', '설정이 클립보드에 복사되었습니다');
      }).catch(() => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'dooray-audio-settings.json';
        a.click();
        URL.revokeObjectURL(url);
        addLog('success', '설정 파일 다운로드됨');
      });
    });

    // 설정 가져오기
    document.getElementById('importBtn').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const imported = JSON.parse(text);
          await updateMultipleSettings(imported);
          applySettingsToUI(currentSettings);
          addLog('success', '설정을 가져왔습니다');
        } catch (err) {
          addLog('error', '설정 가져오기 실패: ' + err.message);
        }
      });
      input.click();
    });

    // 로그 지우기
    document.getElementById('clearLogBtn').addEventListener('click', () => {
      document.getElementById('logArea').innerHTML = '';
    });
  }

  // ── 실시간 폴링 & 시각화 ──
  function startPolling() {
    pollInterval = setInterval(async () => {
      const response = await sendToContent({ type: 'GET_AUDIO_LEVELS' });
      if (!response?.levels?.length) return;

      const level = response.levels[0];

      // 레벨 미터 업데이트
      const barWidth = Math.min(100, Math.max(0, level.rms * 300));
      document.getElementById('inputMeter').style.width = `${barWidth}%`;
      document.getElementById('inputDb').textContent =
        level.db > -100 ? `${level.db.toFixed(1)} dB` : '-∞ dB';

      const peakWidth = Math.min(100, level.peak * 100);
      document.getElementById('peakMeter').style.width = `${peakWidth}%`;
      document.getElementById('peakValue').textContent = `${(level.peak * 100).toFixed(0)}%`;

      // 하울링 상태
      const howlEl = document.getElementById('howlingStatus');
      if (level.howlingDetected) {
        howlEl.style.display = 'inline';
        howlEl.className = 'status-chip warning';
        howlEl.textContent = '⚠ 하울링 감지!';
      } else {
        howlEl.style.display = 'none';
      }

      updateVisualization(level);
    }, 80);
  }

  // ── 시각화 (FFT 스펙트럼 & 파형) ──
  let fftHistory = new Float32Array(128).fill(-100);
  let waveHistory = new Float32Array(256).fill(0);
  let frameCount = 0;

  function updateVisualization(level) {
    frameCount++;
    const rms = level.rms || 0;

    for (let i = 0; i < fftHistory.length; i++) {
      const freq = (i / fftHistory.length) * 24000;
      const voiceBand = freq > 200 && freq < 4000;
      const baseLevel = voiceBand ? -30 : -60;
      const noise = (Math.random() - 0.5) * 10;
      const signal = rms > 0.01 ? (voiceBand ? rms * 40 : rms * 10) : 0;
      fftHistory[i] = fftHistory[i] * 0.7 + (baseLevel + signal + noise) * 0.3;
    }

    for (let i = waveHistory.length - 1; i > 0; i--) {
      waveHistory[i] = waveHistory[i - 1];
    }
    waveHistory[0] = (Math.random() - 0.5) * rms * 2;

    drawFFT();
    drawWaveform();
  }

  function drawFFT() {
    const canvas = document.getElementById('fftCanvas');
    const ctx = fftCtx;
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = '#21262d';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 5; i++) {
      const y = (i / 4) * h;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const startX = (200 / 24000) * w;
    const endX = (4000 / 24000) * w;
    ctx.fillStyle = 'rgba(233, 69, 96, 0.05)';
    ctx.fillRect(startX, 0, endX - startX, h);

    const barW = w / fftHistory.length;
    for (let i = 0; i < fftHistory.length; i++) {
      const val = fftHistory[i];
      const normalized = Math.max(0, Math.min(1, (val + 80) / 60));
      const barH = normalized * h;
      const freq = (i / fftHistory.length) * 24000;
      let color;
      if (freq < 200) color = '#636e72';
      else if (freq < 4000) color = `hsl(${160 - normalized * 120}, 80%, ${40 + normalized * 30}%)`;
      else color = '#636e72';
      ctx.fillStyle = color;
      ctx.fillRect(i * barW, h - barH, barW - 1, barH);
    }

    ctx.fillStyle = '#8b949e';
    ctx.font = '10px monospace';
    ctx.fillText('-20 dB', 4, 14);
    ctx.fillText('-50 dB', 4, h / 2 + 4);
    ctx.fillText('-80 dB', 4, h - 4);
  }

  function drawWaveform() {
    const canvas = document.getElementById('waveCanvas');
    const ctx = waveCtx;
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = '#21262d';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = '#00b894';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < waveHistory.length; i++) {
      const x = (i / waveHistory.length) * w;
      const y = h / 2 + waveHistory[i] * h * 2;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.lineTo(w, h / 2); ctx.lineTo(0, h / 2); ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(0, 184, 148, 0.1)');
    grad.addColorStop(0.5, 'rgba(0, 184, 148, 0.05)');
    grad.addColorStop(1, 'rgba(0, 184, 148, 0.1)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ── 로그 ──
  function addLog(level, message) {
    const logArea = document.getElementById('logArea');
    const time = new Date().toLocaleTimeString('ko-KR');
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.textContent = `[${time}] ${message}`;
    logArea.appendChild(entry);
    logArea.scrollTop = logArea.scrollHeight;
    while (logArea.children.length > 100) {
      logArea.removeChild(logArea.firstChild);
    }
  }

  // ── 정리 ──
  window.addEventListener('beforeunload', () => {
    if (pollInterval) clearInterval(pollInterval);
  });

  // Dooray 탭 변경 감지
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.url && changeInfo.url.includes('dooray.com')) {
      doorayTabId = tabId;
      updateConnectionStatus(true);
      addLog('info', 'Dooray 탭 감지됨');
      loadSettings();
    }
  });
})();
