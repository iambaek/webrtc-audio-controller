/**
 * Dooray Audio Controller - Popup Script
 *
 * 팝업 UI ↔ content script 통신 + 대시보드와 실시간 동기화
 *
 * 동기화 구조:
 *   설정 변경 시 → content script 전송 + background SETTINGS_CHANGED 브로드캐스트
 *   외부 변경 수신 → chrome.storage.onChanged + chrome.runtime.onMessage
 */

(function () {
  'use strict';

  // ── 설정 매핑 ──
  const SLIDER_CONTROLS = {
    gain: { el: null, display: null, format: v => `${v}x` },
    highPassFrequency: { el: null, display: null, format: v => v >= 1000 ? `${(v/1000).toFixed(1)}kHz` : `${v}Hz` },
    lowPassFrequency: { el: null, display: null, format: v => v >= 1000 ? `${(v/1000).toFixed(0)}kHz` : `${v}Hz` },
    compressorThreshold: { el: null, display: null, format: v => `${v}dB` },
    compressorRatio: { el: null, display: null, format: v => `${v}:1` },
  };

  const TOGGLE_CONTROLS = [
    'echoCancellation', 'noiseSuppression', 'autoGainControl',
    'howlingDetection', 'rnnoiseEnabled'
  ];

  // ── 프리셋 정의 ──
  const PRESETS = {
    quiet: {
      name: '조용한 환경',
      gain: 1.0,
      highPassFrequency: 50,
      lowPassFrequency: 16000,
      compressorThreshold: -20,
      compressorRatio: 2,
      rnnoiseEnabled: false,
      howlingDetection: false,
    },
    noisy: {
      name: '소음 환경',
      gain: 1.8,
      highPassFrequency: 120,
      lowPassFrequency: 12000,
      compressorThreshold: -30,
      compressorRatio: 6,
      rnnoiseEnabled: true,
      noiseSuppression: true,
      howlingDetection: true,
    },
    meeting: {
      name: '회의실',
      gain: 1.5,
      highPassFrequency: 80,
      lowPassFrequency: 14000,
      compressorThreshold: -24,
      compressorRatio: 4,
      echoCancellation: true,
      rnnoiseEnabled: true,
      howlingDetection: true,
    },
    boost: {
      name: '볼륨 최대',
      gain: 3.5,
      highPassFrequency: 60,
      lowPassFrequency: 16000,
      compressorThreshold: -18,
      compressorRatio: 8,
      rnnoiseEnabled: true,
      autoGainControl: false,
    },
  };

  let currentSettings = {};
  let levelPollInterval = null;
  let ignoreNextStorageChange = false; // 자신이 발생시킨 변경 무시용

  // ── 초기화 ──
  document.addEventListener('DOMContentLoaded', () => {
    initElements();
    loadCurrentSettings();
    startLevelPolling();
    bindEvents();
    listenForExternalChanges();
  });

  function initElements() {
    for (const [key, ctrl] of Object.entries(SLIDER_CONTROLS)) {
      ctrl.el = document.getElementById(key);
      const displayId = {
        gain: 'gainValue',
        highPassFrequency: 'highPassValue',
        lowPassFrequency: 'lowPassValue',
        compressorThreshold: 'compThreshValue',
        compressorRatio: 'compRatioValue',
      }[key];
      ctrl.display = document.getElementById(displayId);
    }
  }

  // ── 현재 탭에 메시지 전송 ──
  async function sendToContent(message) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('dooray.com')) {
        return await chrome.tabs.sendMessage(tab.id, message);
      }
    } catch (e) {
      console.warn('메시지 전송 실패:', e);
    }
    return null;
  }

  // ── 설정 로드 ──
  async function loadCurrentSettings() {
    const response = await sendToContent({ type: 'GET_SETTINGS' });

    if (response) {
      currentSettings = response.settings;
      const isActive = response.active;

      const badge = document.getElementById('statusBadge');
      if (isActive) {
        badge.textContent = '활성';
        badge.className = 'status active';
      } else {
        badge.textContent = '대기 중';
        badge.className = 'status inactive';
      }

      applySettingsToUI(currentSettings);
    } else {
      const badge = document.getElementById('statusBadge');
      badge.textContent = 'Dooray 아님';
      badge.className = 'status inactive';
    }
  }

  // ── 설정 → UI 반영 (공통 함수) ──
  function applySettingsToUI(settings) {
    // 마스터 토글
    if (settings.enabled !== undefined) {
      document.getElementById('masterToggle').checked = settings.enabled;
    }

    // 슬라이더
    for (const [key, ctrl] of Object.entries(SLIDER_CONTROLS)) {
      if (ctrl.el && settings[key] !== undefined) {
        ctrl.el.value = settings[key];
        ctrl.display.textContent = ctrl.format(parseFloat(settings[key]));
      }
    }

    // 토글
    for (const key of TOGGLE_CONTROLS) {
      const el = document.getElementById(key);
      if (el && settings[key] !== undefined) {
        el.checked = settings[key];
      }
    }
  }

  // ── 설정 업데이트 (content script 전송 + 브로드캐스트) ──
  async function updateSetting(key, value) {
    currentSettings[key] = value;
    // content script에 전송
    await sendToContent({ type: 'UPDATE_SETTINGS', settings: { [key]: value } });
    // 다른 Extension 뷰에 브로드캐스트
    broadcastSettingsChange(currentSettings);
  }

  async function updateMultipleSettings(settings) {
    Object.assign(currentSettings, settings);
    await sendToContent({ type: 'UPDATE_SETTINGS', settings });
    broadcastSettingsChange(currentSettings);
  }

  // ── 브로드캐스트: background를 통해 대시보드에 전파 ──
  function broadcastSettingsChange(settings) {
    ignoreNextStorageChange = true;
    // chrome.storage.local에 저장 (SSOT)
    chrome.storage.local.set({ audioSettings: settings });
    // background에 브로드캐스트 요청
    chrome.runtime.sendMessage({
      type: 'SETTINGS_CHANGED',
      settings: settings,
      source: 'popup'
    }).catch(() => {});
  }

  // ── 외부 변경 수신 (대시보드에서 변경한 경우) ──
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
        }
      }
    });

    // 방법 2: runtime 메시지 (background 브로드캐스트)
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'SETTINGS_CHANGED' && message.source !== 'popup') {
        currentSettings = message.settings;
        applySettingsToUI(currentSettings);
      }
    });
  }

  // ── 이벤트 바인딩 ──
  function bindEvents() {
    // 마스터 토글
    document.getElementById('masterToggle').addEventListener('change', (e) => {
      updateSetting('enabled', e.target.checked);
    });

    // 슬라이더
    for (const [key, ctrl] of Object.entries(SLIDER_CONTROLS)) {
      if (ctrl.el) {
        ctrl.el.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          ctrl.display.textContent = ctrl.format(val);
          updateSetting(key, val);
        });
      }
    }

    // 토글
    for (const key of TOGGLE_CONTROLS) {
      const el = document.getElementById(key);
      if (el) {
        el.addEventListener('change', (e) => {
          updateSetting(key, e.target.checked);
        });
      }
    }

    // 프리셋 버튼
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const presetKey = btn.dataset.preset;
        const preset = PRESETS[presetKey];
        if (!preset) return;

        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        updateMultipleSettings(preset);
        applySettingsToUI(preset);
      });
    });

    // 초기화 버튼
    document.getElementById('resetBtn').addEventListener('click', async () => {
      const response = await sendToContent({ type: 'RESET_SETTINGS' });
      if (response && response.success) {
        currentSettings = response.settings;
        applySettingsToUI(currentSettings);
        broadcastSettingsChange(currentSettings);
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      }
    });

    // 대시보드 열기
    document.getElementById('dashboardBtn').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      window.close();
    });
  }

  // ── 레벨 미터 폴링 ──
  function startLevelPolling() {
    levelPollInterval = setInterval(async () => {
      const response = await sendToContent({ type: 'GET_AUDIO_LEVELS' });
      if (response && response.levels && response.levels.length > 0) {
        const level = response.levels[0];

        const barWidth = Math.min(100, Math.max(0, (level.rms * 100 * 3)));
        document.getElementById('levelBar').style.width = `${barWidth}%`;

        const dbText = level.db > -100 ? `${level.db.toFixed(1)} dB` : '-∞ dB';
        document.getElementById('levelDb').textContent = dbText;

        document.getElementById('levelPeak').textContent =
          `Peak: ${(level.peak * 100).toFixed(0)}%`;

        const howlingBadge = document.getElementById('howlingBadge');
        if (level.howlingDetected) {
          howlingBadge.classList.add('show');
        } else {
          howlingBadge.classList.remove('show');
        }
      }
    }, 100);
  }

  window.addEventListener('unload', () => {
    if (levelPollInterval) clearInterval(levelPollInterval);
  });
})();
