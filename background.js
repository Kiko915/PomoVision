/**
 * PomoVision background service worker (Manifest V3)
 * --------------------------------------------------
 * Responsibilities:
 * 1) Initialize default synced stats on first install.
 * 2) Relay notification requests sent from popup/content scripts.
 * 3) Provide safe guards so runtime errors do not break the worker.
 */

const DEFAULT_STATS = {
  focusPercent: 0,
  sessionCount: 0,
  totalFocusSeconds: 0,
  totalDistractedSeconds: 0,
};

/**
 * Merge defaults with any existing data.
 * This ensures future installs/upgrades always have required keys.
 */
let creating = null; // A global promise to avoid concurrency issues

async function setupOffscreenDocument(path) {
  // Check all windows controlled by the service worker to see if one
  // of them is the offscreen document with the given path
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) {
    return;
  }

  // create offscreen document
  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: ["USER_MEDIA", "WEB_RTC"],
      justification: "Keep camera tracking running when popup is closed",
    });
    await creating;
    creating = null;
  }
}

async function ensureDefaultStats() {
  try {
    const existing = await chrome.storage.sync.get(DEFAULT_STATS);
    const merged = { ...DEFAULT_STATS, ...existing };
    await chrome.storage.sync.set(merged);
    console.log("[PomoVision] Stats initialized/verified.", merged);
  } catch (error) {
    console.error("[PomoVision] Failed to initialize default stats:", error);
  }
}

/**
 * Create a browser notification safely.
 */
function createNotification(payload = {}) {
  const title =
    typeof payload.title === "string" && payload.title.trim()
      ? payload.title.trim()
      : "PomoVision";

  const message =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : "Stay focused.";

  chrome.notifications.create(
    {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: 2,
    },
    (notificationId) => {
      if (chrome.runtime.lastError) {
        console.error(
          "[PomoVision] Notification error:",
          chrome.runtime.lastError.message,
        );
        return;
      }
      console.log("[PomoVision] Notification created:", notificationId);
    },
  );
}

/**
 * Fired when extension is installed/updated.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[PomoVision] onInstalled:", details.reason);

  // Ensure stats keys always exist on install/update.
  await ensureDefaultStats();

  if (details.reason === "install") {
    createNotification({
      title: "PomoVision Installed",
      message: "Ready to focus. Open the popup to start your first session.",
    });
  }
  // Launch the offscreen tracking page when installed
  await setupOffscreenDocument("tracking.html");
});

chrome.runtime.onStartup.addListener(async () => {
  // Launch the offscreen tracking page when browser starts
  await setupOffscreenDocument("tracking.html");
});

/**
 * Send a message to the currently active tab (top frame only).
 * Fails silently if the tab cannot receive content-script messages
 * (e.g. chrome://, new-tab page, PDF viewer).
 */
async function sendToActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) return;

    // chrome:// and other restricted URLs don't support content scripts
    const url = tab.url || "";
    if (
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("about:") ||
      url === ""
    )
      return;

    await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  } catch (err) {
    // Content script not yet injected or tab is restricted — ignore
    console.warn("[PomoVision] sendToActiveTab failed:", err.message);
  }
}

/**
 * Message relay endpoint.
 * Expected message shapes:
 * { type: "PV_NOTIFY",        payload: { title, message } }
 * { type: "PV_REFOCUS_START" }
 * { type: "PV_REFOCUS_STOP"  }
 * { type: "PV_PHONE_START"   }
 * { type: "PV_PHONE_STOP"    }
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    if (!message || typeof message !== "object") {
      sendResponse?.({ ok: false, error: "Invalid message." });
      return false;
    }

    if (message.type === "PV_NOTIFY") {
      createNotification(message.payload);
      sendResponse?.({ ok: true });
      return false;
    }

    // Tab border alerts — relay to the active tab's content script
    if (
      message.type === "PV_REFOCUS_START" ||
      message.type === "PV_REFOCUS_STOP" ||
      message.type === "PV_PHONE_START" ||
      message.type === "PV_PHONE_STOP"
    ) {
      sendToActiveTab({ type: message.type });
      sendResponse?.({ ok: true });
      return false;
    }

    if (message.type === "PV_HEALTHCHECK") {
      sendResponse?.({
        ok: true,
        serviceWorker: "active",
        timestamp: Date.now(),
      });
      return false;
    }

    // Unknown message type
    sendResponse?.({ ok: false, error: "Unsupported message type." });
    return false;
  } catch (error) {
    console.error("[PomoVision] onMessage handler failed:", error);
    sendResponse?.({ ok: false, error: "Internal error in service worker." });
    return false;
  }
});

/**
 * Optional cleanup / observability hooks.
 */
