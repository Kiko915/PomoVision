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
  totalDistractedSeconds: 0
};

/**
 * Merge defaults with any existing data.
 * This ensures future installs/upgrades always have required keys.
 */
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
  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.trim()
    : "PomoVision";

  const message = typeof payload.message === "string" && payload.message.trim()
    ? payload.message.trim()
    : "Stay focused.";

  chrome.notifications.create(
    {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: 2
    },
    (notificationId) => {
      if (chrome.runtime.lastError) {
        console.error("[PomoVision] Notification error:", chrome.runtime.lastError.message);
        return;
      }
      console.log("[PomoVision] Notification created:", notificationId);
    }
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
      message: "Ready to focus. Open the popup to start your first session."
    });
  }
});

/**
 * Message relay endpoint.
 * Expected message shape:
 * {
 *   type: "PV_NOTIFY",
 *   payload: { title: string, message: string }
 * }
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

    if (message.type === "PV_HEALTHCHECK") {
      sendResponse?.({
        ok: true,
        serviceWorker: "active",
        timestamp: Date.now()
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
chrome.runtime.onStartup?.addListener(() => {
  console.log("[PomoVision] Browser startup detected, worker available.");
});
