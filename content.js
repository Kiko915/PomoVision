/**
 * PomoVision - content.js
 * Injected into every tab via manifest content_scripts.
 *
 * Responsibilities:
 *  - Listen for PV_REFOCUS_START → show a pulsing red border over the page
 *  - Listen for PV_REFOCUS_STOP  → remove the border
 *  - Listen for PV_PHONE_START   → show a pulsing orange border (phone alert)
 *  - Listen for PV_PHONE_STOP    → remove the border
 *
 * The overlay uses pointer-events:none so it never blocks page interaction.
 */

(function () {
  "use strict";

  const OVERLAY_ID = "pomovision-refocus-overlay";
  const STYLE_ID   = "pomovision-refocus-style";

  // ─────────────────────────────────────────────
  // Inject keyframe + base styles once
  // ─────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #pomovision-refocus-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647; /* Max z-index so it sits above everything */
        pointer-events: none;
        display: none;
        border-radius: 0;
        box-sizing: border-box;
      }

      /* Gaze-distraction: red beating border */
      #pomovision-refocus-overlay.pv-gaze {
        display: block;
        border: 5px solid #ff3b3b;
        animation: pv-beat-red 1s ease-in-out infinite;
        box-shadow:
          inset 0 0 40px rgba(255, 59, 59, 0.25),
                0 0 0 0 rgba(255, 59, 59, 0);
      }

      /* Phone alert: orange beating border */
      #pomovision-refocus-overlay.pv-phone {
        display: block;
        border: 5px solid #ff8c00;
        animation: pv-beat-orange 1s ease-in-out infinite;
        box-shadow:
          inset 0 0 40px rgba(255, 140, 0, 0.25),
                0 0 0 0 rgba(255, 140, 0, 0);
      }

      @keyframes pv-beat-red {
        0%   {
          border-color: rgba(255, 59, 59, 1);
          box-shadow: inset 0 0 60px rgba(255, 59, 59, 0.3),
                            0 0 0   0  rgba(255, 59, 59, 0.5);
        }
        40%  {
          border-color: rgba(255, 59, 59, 0.55);
          box-shadow: inset 0 0 80px rgba(255, 59, 59, 0.10),
                            0 0 0   0  rgba(255, 59, 59, 0);
        }
        60%  {
          border-color: rgba(255, 59, 59, 0.55);
          box-shadow: inset 0 0 80px rgba(255, 59, 59, 0.10),
                            0 0 0   0  rgba(255, 59, 59, 0);
        }
        100% {
          border-color: rgba(255, 59, 59, 1);
          box-shadow: inset 0 0 60px rgba(255, 59, 59, 0.3),
                            0 0 0   0  rgba(255, 59, 59, 0.5);
        }
      }

      @keyframes pv-beat-orange {
        0%   {
          border-color: rgba(255, 140, 0, 1);
          box-shadow: inset 0 0 60px rgba(255, 140, 0, 0.3),
                            0 0 0   0  rgba(255, 140, 0, 0.5);
        }
        40%  {
          border-color: rgba(255, 140, 0, 0.5);
          box-shadow: inset 0 0 80px rgba(255, 140, 0, 0.10),
                            0 0 0   0  rgba(255, 140, 0, 0);
        }
        60%  {
          border-color: rgba(255, 140, 0, 0.5);
          box-shadow: inset 0 0 80px rgba(255, 140, 0, 0.10),
                            0 0 0   0  rgba(255, 140, 0, 0);
        }
        100% {
          border-color: rgba(255, 140, 0, 1);
          box-shadow: inset 0 0 60px rgba(255, 140, 0, 0.3),
                            0 0 0   0  rgba(255, 140, 0, 0.5);
        }
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  // ─────────────────────────────────────────────
  // Overlay element (created lazily)
  // ─────────────────────────────────────────────
  function getOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      (document.body || document.documentElement).appendChild(overlay);
    }
    return overlay;
  }

  // ─────────────────────────────────────────────
  // Show / hide helpers
  // ─────────────────────────────────────────────
  function showGazeAlert() {
    injectStyles();
    const overlay = getOverlay();
    overlay.classList.remove("pv-phone");
    overlay.classList.add("pv-gaze");
  }

  function showPhoneAlert() {
    injectStyles();
    const overlay = getOverlay();
    overlay.classList.remove("pv-gaze");
    overlay.classList.add("pv-phone");
  }

  function hideAlert() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    overlay.classList.remove("pv-gaze", "pv-phone");
    overlay.style.display = "none"; // ensure hidden even if both classes removed
  }

  // ─────────────────────────────────────────────
  // Message listener
  // ─────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;

    switch (message.type) {
      case "PV_REFOCUS_START":
        showGazeAlert();
        sendResponse({ ok: true });
        break;

      case "PV_REFOCUS_STOP":
        hideAlert();
        sendResponse({ ok: true });
        break;

      case "PV_PHONE_START":
        showPhoneAlert();
        sendResponse({ ok: true });
        break;

      case "PV_PHONE_STOP":
        hideAlert();
        sendResponse({ ok: true });
        break;

      default:
        break;
    }
  });

  // ─────────────────────────────────────────────
  // Ensure styles are ready as early as possible
  // ─────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectStyles, { once: true });
  } else {
    injectStyles();
  }
})();
