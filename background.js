/**
 * Dooray Audio Controller - Background Service Worker
 *
 * - Extension 아이콘 상태 관리
 * - 설정 변경 브로드캐스트 (팝업 ↔ 대시보드 동기화)
 * - chrome.storage.local을 단일 진실 소스(SSOT)로 사용
 */

// Dooray 페이지에서만 Extension 아이콘 활성화
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.disable();

  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostSuffix: 'dooray.com' },
          })
        ],
        actions: [new chrome.declarativeContent.ShowAction()]
      }
    ]);
  });

  console.log('[DoorayAudio BG] Extension 설치 완료');
});

// ── 메시지 중개 ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 배지 업데이트 (content script → background)
  if (message.type === 'UPDATE_BADGE') {
    const tabId = sender.tab?.id;
    if (tabId) {
      if (message.active) {
        chrome.action.setBadgeText({ text: 'ON', tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#00b894', tabId });
      } else {
        chrome.action.setBadgeText({ text: '', tabId });
      }
    }
    sendResponse({ success: true });
    return true;
  }

  // 설정 변경 브로드캐스트 (팝업 또는 대시보드 → 다른 모든 Extension 페이지)
  if (message.type === 'SETTINGS_CHANGED') {
    // chrome.storage.local에 저장 (SSOT)
    chrome.storage.local.set({ audioSettings: message.settings });

    // 발신자 제외 모든 Extension 뷰에 브로드캐스트
    const senderViewId = sender.tab?.id || sender.id;
    broadcastToViews(message, senderViewId);

    sendResponse({ success: true });
    return true;
  }

  // 오디오 레벨 브로드캐스트 (content script → 팝업/대시보드)
  if (message.type === 'AUDIO_LEVELS_BROADCAST') {
    broadcastToViews(message, null);
    sendResponse({ success: true });
    return true;
  }

  return true;
});

/**
 * 모든 Extension 뷰(팝업, 대시보드 탭)에 메시지 전파
 */
async function broadcastToViews(message, excludeTabId) {
  try {
    // Extension 페이지 탭 (대시보드 등)
    const extensionTabs = await chrome.tabs.query({
      url: chrome.runtime.getURL('*')
    });
    for (const tab of extensionTabs) {
      if (tab.id !== excludeTabId) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }

    // 팝업은 chrome.runtime.sendMessage로 수신
    // (팝업은 tab이 아니므로 runtime 메시지 사용)
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (e) {
    // 수신자가 없으면 무시
  }
}
