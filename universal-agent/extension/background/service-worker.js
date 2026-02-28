let activeTabUrl = null;
let pendingMicPermission = null;

function isTrackableUrl(url) {
  return Boolean(url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://'));
}

async function configureSidePanelBehavior() {
  if (!chrome.sidePanel?.setPanelBehavior) return;

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('[extension] Failed to enable openPanelOnActionClick:', error);
  }
}

async function refreshActiveTabUrl() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (tab?.url && isTrackableUrl(tab.url)) {
      activeTabUrl = tab.url;
    }
  } catch {
    // Ignore transient tab errors.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanelBehavior();
  refreshActiveTabUrl();
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanelBehavior();
  refreshActiveTabUrl();
});

// Ensure behavior is configured even if the worker wakes without install/startup.
configureSidePanelBehavior();

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isTrackableUrl(tab?.url)) {
      activeTabUrl = tab.url;
    }
  } catch {
    // Ignore transient tab errors.
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isTrackableUrl(tab?.url)) {
    activeTabUrl = tab.url;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_ACTIVE_TAB_URL') {
    if (activeTabUrl) {
      sendResponse({ url: activeTabUrl });
      return true;
    }

    refreshActiveTabUrl()
      .then(() => sendResponse({ url: activeTabUrl }))
      .catch(() => sendResponse({ url: null }));
    return true;
  }

  if (message?.type === 'OPEN_MIC_PERMISSION_TAB') {
    if (pendingMicPermission) {
      sendResponse({ ok: false, error: 'Microphone permission flow already in progress.' });
      return true;
    }

    const permissionUrl = chrome.runtime.getURL('permission/mic-permission.html');

    chrome.tabs
      .create({ url: permissionUrl, active: true })
      .then((tab) => {
        const tabId = tab?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, error: 'Failed to open microphone permission tab.' });
          return;
        }

        const timeoutId = setTimeout(() => {
          if (!pendingMicPermission) return;
          chrome.tabs.remove(tabId).catch(() => {});
          pendingMicPermission.sendResponse({
            ok: false,
            error: 'Timed out waiting for microphone permission response.',
          });
          pendingMicPermission = null;
        }, 120000);

        pendingMicPermission = { tabId, sendResponse, timeoutId };
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || 'Unable to open permission tab.' });
      });

    return true;
  }

  if (message?.type === 'MIC_PERMISSION_RESULT') {
    if (!pendingMicPermission) {
      sendResponse({ ok: false });
      return true;
    }

    const fromTabId = sender?.tab?.id;
    if (fromTabId !== pendingMicPermission.tabId) {
      sendResponse({ ok: false });
      return true;
    }

    clearTimeout(pendingMicPermission.timeoutId);
    const resolver = pendingMicPermission.sendResponse;
    const tabId = pendingMicPermission.tabId;
    pendingMicPermission = null;

    chrome.tabs.remove(tabId).catch(() => {});
    resolver({
      ok: Boolean(message?.granted),
      error: message?.error || null,
      errorName: message?.errorName || null,
    });
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!pendingMicPermission) return;
  if (tabId !== pendingMicPermission.tabId) return;

  clearTimeout(pendingMicPermission.timeoutId);
  pendingMicPermission.sendResponse({
    ok: false,
    error: 'Microphone permission tab was closed before completion.',
  });
  pendingMicPermission = null;
});
