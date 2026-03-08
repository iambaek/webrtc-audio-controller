/**
 * Bridge Script (ISOLATED world)
 *
 * chrome.runtime API와 MAIN world content script 사이를 중개합니다.
 * - 팝업 → bridge (chrome.runtime.onMessage) → MAIN world (window.postMessage)
 * - MAIN world (window.postMessage) → bridge → 팝업 (sendResponse)
 */

(function () {
  'use strict';

  // Worklet URL을 MAIN world에 전달 (WASM은 JS에 내장되어 별도 파일 불필요)
  window.postMessage({
    source: 'dooray-audio-bridge',
    type: 'EXTENSION_URLS',
    urls: {
      rnnoiseWorklet: chrome.runtime.getURL('rnnoise-worklet.js'),
    }
  }, '*');

  // ── 팝업 → content script 중개 ──
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 고유 요청 ID 생성
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // 응답 리스너 등록
    function onResponse(event) {
      if (event.data?.source === 'dooray-audio-main' && event.data?.requestId === requestId) {
        window.removeEventListener('message', onResponse);
        sendResponse(event.data.payload);
      }
    }
    window.addEventListener('message', onResponse);

    // MAIN world로 전달
    window.postMessage({
      source: 'dooray-audio-bridge',
      type: message.type,
      requestId: requestId,
      payload: message
    }, '*');

    // 5초 타임아웃: 응답이 없으면 에러 응답 반환 (팝업이 무기한 대기하지 않도록)
    setTimeout(() => {
      window.removeEventListener('message', onResponse);
      try {
        sendResponse({ error: 'TIMEOUT', message: 'Content script 응답 타임아웃 (5초)' });
      } catch (e) {
        // sendResponse가 이미 호출된 경우 무시
      }
    }, 5000);

    return true; // 비동기 응답 유지
  });

  // ── MAIN world → 배경(background) 전달 ──
  window.addEventListener('message', (event) => {
    if (event.data?.source === 'dooray-audio-main' && event.data?.type === 'UPDATE_BADGE') {
      chrome.runtime.sendMessage(event.data.payload).catch(() => {});
    }
  });

  console.log('[DoorayAudio Bridge] 브리지 스크립트 로드 완료');
})();
