let activeTabUrl = null;

function isTrackableUrl(url) {
  return Boolean(url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://'));
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
  refreshActiveTabUrl();
});

chrome.runtime.onStartup.addListener(() => {
  refreshActiveTabUrl();
});

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

  return false;
});
