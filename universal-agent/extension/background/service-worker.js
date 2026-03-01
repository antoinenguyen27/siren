let activeTabUrl = null;
let pendingMicPermission = null;
const demoDomCaptureSessions = new Map();

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

async function getActiveTabInfo() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  if (!tab || typeof tab.id !== 'number') return null;
  if (!isTrackableUrl(tab.url)) return { id: tab.id, url: null };
  return { id: tab.id, url: tab.url };
}

async function ensureDomCaptureScriptInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/demo-dom-capture.js'],
  });
}

async function startDemoDomCapture(tabId, sessionStartMs) {
  await ensureDomCaptureScriptInjected(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (startMs) => {
      const api = window.__UA_DEMO_DOM_CAPTURE__;
      if (!api || typeof api.start !== 'function') return { ok: false, error: 'capture api missing' };
      return api.start(startMs);
    },
    args: [sessionStartMs],
  });

  demoDomCaptureSessions.set(tabId, { sessionStartMs: Number(sessionStartMs) || Date.now() });
  return results || [];
}

async function stopDemoDomCapture(tabId) {
  const session = demoDomCaptureSessions.get(tabId);
  demoDomCaptureSessions.delete(tabId);
  await ensureDomCaptureScriptInjected(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const api = window.__UA_DEMO_DOM_CAPTURE__;
      if (!api || typeof api.stop !== 'function') {
        return { ok: false, events: [], error: 'capture api missing' };
      }
      return api.stop();
    },
  });

  const frameEvents = [];
  for (const item of results || []) {
    const result = item?.result;
    if (!result || !Array.isArray(result.events)) continue;
    frameEvents.push({
      frameId: item.frameId,
      frameUrl: result.frameUrl || '',
      dropped: Number(result.dropped || 0),
      events: result.events,
    });
  }

  return {
    sessionStartMs: session?.sessionStartMs || null,
    frameEvents,
  };
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

  if (message?.type === 'GET_ACTIVE_TAB_INFO') {
    getActiveTabInfo()
      .then((info) => sendResponse(info || { id: null, url: null }))
      .catch(() => sendResponse({ id: null, url: null }));
    return true;
  }

  if (message?.type === 'START_DEMO_DOM_CAPTURE') {
    const tabId = Number(message?.tabId);
    const sessionStartMs = Number(message?.sessionStartMs) || Date.now();
    if (!Number.isFinite(tabId)) {
      sendResponse({ ok: false, error: 'Invalid tabId for START_DEMO_DOM_CAPTURE.' });
      return true;
    }
    startDemoDomCapture(tabId, sessionStartMs)
      .then((results) => {
        sendResponse({
          ok: true,
          sessionStartMs,
          frames: Array.isArray(results) ? results.length : 0,
        });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (message?.type === 'STOP_DEMO_DOM_CAPTURE') {
    const tabId = Number(message?.tabId);
    if (!Number.isFinite(tabId)) {
      sendResponse({ ok: false, error: 'Invalid tabId for STOP_DEMO_DOM_CAPTURE.' });
      return true;
    }
    stopDemoDomCapture(tabId)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
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
  demoDomCaptureSessions.delete(tabId);
  if (!pendingMicPermission) return;
  if (tabId !== pendingMicPermission.tabId) return;

  clearTimeout(pendingMicPermission.timeoutId);
  pendingMicPermission.sendResponse({
    ok: false,
    error: 'Microphone permission tab was closed before completion.',
  });
  pendingMicPermission = null;
});
