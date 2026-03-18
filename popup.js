/**
 * TODO for tomorrow:
 * 1. Upgrade the MediaPipe face tracking
 * 2. Make sure stats are being tracked and saved
 * 3. Add a visual like Red border that is beating on the current webpage for refocus mode
 * 4. Add customizable settings for MVP
 * 5. Fix Logo/Icon size
 *
 * PomoVision - popup.js (Orchestrator)
 * Thin entry-point that wires together the four feature modules:
 *   TimerManager  — countdown, state persistence, progress ring
 *   VisionManager — camera, face/gaze tracking, phone detection
 *   StatsManager  — aggregate stats storage & rendering
 *   AudioManager  — beep feedback
 *
 * No business logic lives here. This file only:
 *   1. Caches DOM elements
 *   2. Instantiates the managers with the right config / callbacks
 *   3. Registers button listeners and storage change listeners
 *   4. Bootstraps on DOMContentLoaded
 */

import { TimerManager } from "./modules/TimerManager.js";
import { VisionManager } from "./modules/VisionManager.js";
import { StatsManager } from "./modules/StatsManager.js";
import { AudioManager } from "./modules/AudioManager.js";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Shorthand getElementById */
const el = (id) => document.getElementById(id);

/** Update a status-pill element's text and colour class */
function setStatus(element, text, type = "") {
  if (!element) return;
  element.textContent = text;
  element.className = `status-pill${type ? ` ${type}` : ""}`;
}

/** Fire a Chrome notification (fails silently if unavailable) */
function sendNotification(title, message) {
  try {
    if (!chrome?.notifications?.create) return;
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  } catch (err) {
    console.warn("[PomoVision] Notification failed:", err);
  }
}

// ─────────────────────────────────────────────
// Tab Alert Helper
// ─────────────────────────────────────────────

/**
 * Send an alert message to the currently active tab via the background
 * service worker, which relays it to the content script.
 * @param {"PV_REFOCUS_START"|"PV_REFOCUS_STOP"|"PV_PHONE_START"|"PV_PHONE_STOP"} type
 */
function sendTabAlert(type) {
  chrome.runtime.sendMessage({ type }).catch(() => {
    // Background SW may be sleeping — fire-and-forget is fine here
  });
}

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  // ── DOM references ──────────────────────────
  const timerDisplayEl = el("timerDisplay");
  const progressRingEl = el("progressRing");
  const startBtnEl = el("startBtn");
  const pauseBtnEl = el("pauseBtn");
  const resetBtnEl = el("resetBtn");
  const videoEl = el("webcam");
  const canvasEl = el("overlayCanvas");
  const cameraPlaceholderEl = el("cameraPlaceholder");
  const alertOverlayEl = el("alertOverlay");
  const trackingStatusEl = el("trackingStatus");
  const gazeStatusEl = el("gazeStatus");
  const focusPercentEl = el("focusPercent");
  const pomodoroDotsEl = el("pomodoroDots");
  const sessionMessageEl = el("sessionMessage");

  // ── Shared alert flags ───────────────────────
  // Tracked here so the overlay is only hidden when BOTH alert types clear.
  let gazeAlertActive = false;
  let phoneAlertActive = false;

  // ── Shared camera-ready flag ─────────────────
  // Declared before managers so closures can reference it.
  let cameraReady = false;

  // ── UI helpers ───────────────────────────────
  const setTrackingStatus = (text, type = "") =>
    setStatus(trackingStatusEl, text, type);

  const setGazeStatus = (text, type = "") =>
    setStatus(gazeStatusEl, text, type);

  const setSessionMessage = (text) => {
    if (sessionMessageEl) sessionMessageEl.textContent = text;
  };

  function showAlertOverlay(title, subtitle) {
    if (!alertOverlayEl) return;
    const titleEl = alertOverlayEl.querySelector(".alert-title");
    const subtitleEl = alertOverlayEl.querySelector(".alert-subtitle");
    if (titleEl) titleEl.textContent = title;
    if (subtitleEl) subtitleEl.textContent = subtitle;
    alertOverlayEl.hidden = false;
  }

  function hideAlertOverlay() {
    if (!gazeAlertActive && !phoneAlertActive && alertOverlayEl) {
      alertOverlayEl.hidden = true;
    }
  }

  // ── Managers ─────────────────────────────────
  const audio = new AudioManager();

  const stats = new StatsManager({
    focusPercentEl,
    pomodoroDotsEl,
    maxDots: 8,
  });

  const timer = new TimerManager(
    { sessionDurationSeconds: 25 * 60 },
    { timerDisplayEl, progressRingEl, startBtnEl, pauseBtnEl, resetBtnEl },
    {
      isCameraReady: () => cameraReady,

      onSetMessage: setSessionMessage,

      onSetGazeStatus: setGazeStatus,

      onComplete: async () => {
        // Sync vision so it stops counting focus frames
        vision.isRunning = false;
        gazeAlertActive = false;
        phoneAlertActive = false;
        hideAlertOverlay();
        sendTabAlert("PV_REFOCUS_STOP");
        sendTabAlert("PV_PHONE_STOP");

        try {
          await stats.persist(
            timer.sessionFocusSeconds,
            timer.sessionDistractedSeconds,
          );
        } catch (_) {
          setSessionMessage("Session finished, but stats save failed.");
          return;
        }

        setSessionMessage("25 min complete — diffuse break time!");
        sendNotification(
          "Session Complete",
          "Great work. Time for a diffuse break.",
        );
        audio.playBeepPattern("complete");
      },
    },
  );

  // vision is declared with let so TimerManager's isCameraReady closure
  // can reference it after assignment below.
  let vision;

  vision = new VisionManager(
    { videoEl, canvasEl, cameraPlaceholderEl },
    {
      setTrackingStatus,
      setGazeStatus,

      onCameraReady: () => {
        cameraReady = true;
        if (startBtnEl) startBtnEl.disabled = false;
        if (resetBtnEl) resetBtnEl.disabled = false;
        setSessionMessage("Camera active. Ready to start.");
        setTrackingStatus("Camera: ready", "ok");
      },

      onFocused: (dt) => {
        timer.sessionFocusSeconds += dt;
        // Clear the gaze distraction alert when focus is restored
        if (gazeAlertActive) {
          gazeAlertActive = false;
          hideAlertOverlay();
          sendTabAlert("PV_REFOCUS_STOP");
        }
      },

      onDistracted: (dt, thresholdExceeded) => {
        timer.sessionDistractedSeconds += dt;
        // Only fire the alert once per distraction event
        if (thresholdExceeded && !gazeAlertActive) {
          gazeAlertActive = true;
          showAlertOverlay("REFOCUS", "Eyes off-screen for over 5 seconds.");
          sendNotification("REFOCUS!", "Eyes off-screen for over 5 seconds.");
          audio.playBeepPattern("alert");
          setSessionMessage("Distraction detected — refocus now.");
          sendTabAlert("PV_REFOCUS_START");
        }
      },

      onPhoneDetected: () => {
        phoneAlertActive = true;
        showAlertOverlay("PUT PHONE DOWN", "Phone detected — stay focused!");
        sendNotification(
          "📵 Phone Detected!",
          "Put your phone down and refocus on your work.",
        );
        audio.playBeepPattern("alert");
        setSessionMessage("📵 Phone detected — put it down!");
        sendTabAlert("PV_PHONE_START");
      },

      onPhoneGone: () => {
        phoneAlertActive = false;
        hideAlertOverlay();
        sendTabAlert("PV_PHONE_STOP");
        setSessionMessage(
          timer.isRunning ? "Focus session running..." : "Ready to start.",
        );
      },
    },
  );

  // Keep VisionManager's isRunning in sync with the timer so it only
  // counts focus / distraction frames while a session is active.
  function syncVisionRunning() {
    vision.isRunning = timer.isRunning;
  }

  // ── Button events ────────────────────────────
  startBtnEl?.addEventListener("click", () => {
    timer.start();
    syncVisionRunning();
  });

  pauseBtnEl?.addEventListener("click", () => {
    timer.pause();
    syncVisionRunning();
  });

  resetBtnEl?.addEventListener("click", () => {
    gazeAlertActive = false;
    phoneAlertActive = false;
    hideAlertOverlay();
    sendTabAlert("PV_REFOCUS_STOP");
    sendTabAlert("PV_PHONE_STOP");
    timer.reset();
    syncVisionRunning();
  });

  // ── Background tracking sync ─────────────────
  // The offscreen tracking document (tracking.js) writes focus/distraction
  // seconds and phone alerts to chrome.storage.local; we mirror them here.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.pomoState) return;
    const newVal = changes.pomoState.newValue;
    if (!newVal) return;

    if (timer.isRunning) {
      timer.sessionFocusSeconds =
        newVal.sessionFocusSeconds ?? timer.sessionFocusSeconds;
      timer.sessionDistractedSeconds =
        newVal.sessionDistractedSeconds ?? timer.sessionDistractedSeconds;
    }

    if (newVal.phoneAlert === true && !phoneAlertActive) {
      phoneAlertActive = true;
      showAlertOverlay("PUT PHONE DOWN", "Phone detected — stay focused!");
    } else if (newVal.phoneAlert === false && phoneAlertActive) {
      phoneAlertActive = false;
      hideAlertOverlay();
    }
  });

  // ── Restore persisted state ───────────────────
  await timer.loadState();
  timer.renderTimer();
  timer.updateProgressBar(true /* instant, no transition */);
  syncVisionRunning();
  await stats.loadAndRender();

  // ── Initialize vision ────────────────────────
  try {
    await vision.initialize();
  } catch (err) {
    console.error("[PomoVision] Vision init error:", err);
    setTrackingStatus("Camera unavailable", "danger");
    setGazeStatus("Gaze: unavailable", "danger");
    setSessionMessage("Camera/model init failed. Check permissions.");

    if (cameraPlaceholderEl) {
      cameraPlaceholderEl.style.display = "flex";
      cameraPlaceholderEl.style.cursor = "pointer";
      cameraPlaceholderEl.title =
        "Click to open in a new tab and allow camera access";
      cameraPlaceholderEl.onclick = () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
      };

      const textEl = document.getElementById("cameraPlaceholderText");
      if (textEl) {
        textEl.innerHTML =
          `Camera Unavailable<br>` +
          `<span style="font-size:0.65rem;font-weight:normal;color:var(--danger)">` +
          `Error: ${err.message || err.name || "Permission denied"}` +
          `</span><br>` +
          `<span style="font-size:0.75rem;font-weight:600;margin-top:6px;display:block;color:var(--accent)">` +
          `Click to open in a new tab<br>to allow permissions` +
          `</span>`;
        textEl.style.textAlign = "center";
      }
    }
  }

  // ── Cleanup on popup close ───────────────────
  window.addEventListener("beforeunload", () => {
    timer.saveState();
    vision.dispose();
    audio.dispose();
  });
});
