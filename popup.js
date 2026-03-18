/**
 * TODO for tomorrow:
 * 1. Upgrade the MediaPipe face tracking
 * 2. Make sure stats are being tracked and saved
 * 3. Add a visual like Red border that is beating on the current webpage for refocus mode
 * 4. Add customizable settings for MVP
 * 5. Fix Logo/Icon size
 *
 * PomoVision - popup.js
 * Core logic:
 * - 25:00 Pomodoro timer (start/pause/reset)
 * - Webcam + MediaPipe Face Landmarker (CDN import via module)
 * - Basic gaze detection using iris x-position thresholds
 * - Distraction alert (overlay + notification + beep)
 * - Persistent stats in chrome.storage.sync
 *
 * NOTE:
 * popup.html should load this file as:
 *   <script type="module" src="popup.js"></script>
 */

// Import MediaPipe Face Landmarker + Object Detector
import {
  FilesetResolver,
  FaceLandmarker,
  ObjectDetector,
} from "./vendor/mediapipe/vision_bundle.mjs";

class PomoVision {
  constructor() {
    // ---- Pomodoro Config ----
    this.SESSION_DURATION_SECONDS = 25 * 60; // 25:00
    this.DISTRACTION_SECONDS_THRESHOLD = 5; // alert if distracted > 5s

    // ---- Runtime Timer State ----
    this.remainingSeconds = this.SESSION_DURATION_SECONDS;
    this.isRunning = false;
    this.sessionCompleted = false;
    this.timerIntervalId = null;
    this.isCameraReady = false;
    this.lastTickTime = null;

    // ---- Vision/Gaze State ----
    this.videoEl = null;
    this.canvasEl = null;
    this.ctx = null;
    this.alertOverlayEl = null;
    this.gazeStatusEl = null;
    this.trackingStatusEl = null;

    this.mediaStream = null;
    this.faceLandmarker = null;
    this.objectDetector = null;
    this.animationFrameId = null;
    this.lastInferenceTime = 0;
    this.INFERENCE_INTERVAL_MS = 33; // ~30fps

    // Phone detection runs less frequently to save performance
    this.lastPhoneCheckTime = 0;
    this.PHONE_CHECK_INTERVAL_MS = 800; // check every ~800ms
    this.phoneDetected = false;
    this.phoneAlertActive = false;

    this.currentDistractedStreak = 0;
    this.alertActive = false;
    this.wasFocusedLastFrame = false;

    // ---- Focus Stats (session + aggregate) ----
    this.sessionFocusSeconds = 0;
    this.sessionDistractedSeconds = 0;

    this.storageDefaults = {
      sessionCount: 0,
      totalFocusSeconds: 0,
      totalDistractedSeconds: 0,
      focusPercent: 0,
    };

    // ---- UI Elements ----
    this.timerDisplayEl = null;
    this.progressRingEl = null;
    this.startBtnEl = null;
    this.pauseBtnEl = null;
    this.resetBtnEl = null;
    this.focusPercentEl = null;
    this.sessionCountEl = null;
    this.sessionMessageEl = null;

    // ---- Audio ----
    this.audioContext = null;
  }

  async init() {
    this.cacheElements();
    this.bindEvents();

    // Load persisted state before rendering
    await this.loadState();

    this.renderTimer();
    this.updateProgressBar(true);
    await this.loadAndRenderStats();

    // Sync stats directly from tracking script via storage
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.pomoState) {
        const newVal = changes.pomoState.newValue;
        if (newVal && this.isRunning) {
          this.sessionFocusSeconds = newVal.sessionFocusSeconds;
          this.sessionDistractedSeconds = newVal.sessionDistractedSeconds;
        }
        // Reflect phone alert from background tracking into popup UI
        if (newVal && newVal.phoneAlert === true && !this.phoneAlertActive) {
          this.activatePhoneAlert();
        } else if (
          newVal &&
          newVal.phoneAlert === false &&
          this.phoneAlertActive
        ) {
          this.deactivatePhoneAlert();
        }
      }
    });

    try {
      await this.initializeVision();
      this.setSessionMessage("Camera active. Ready to start.");
      this.setTrackingStatus("Camera: ready", "ok");
    } catch (err) {
      console.error("[PomoVision] Vision init error:", err);
      this.setTrackingStatus("Camera unavailable", "danger");
      this.setGazeStatus("Gaze: unavailable", "danger");
      this.setSessionMessage(
        "Camera/model init failed. Check permissions and internet.",
      );
      if (this.cameraPlaceholderEl) {
        this.cameraPlaceholderEl.style.display = "flex";
        this.cameraPlaceholderEl.style.cursor = "pointer";
        this.cameraPlaceholderEl.title =
          "Click to open in a new tab and allow camera access";
        this.cameraPlaceholderEl.onclick = () => {
          // Chrome extensions sometimes block getUserMedia in popups.
          // The reliable fix is to open the extension in a full tab to request permission.
          chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
        };

        const textEl = document.getElementById("cameraPlaceholderText");
        if (textEl) {
          textEl.innerHTML = `Camera Unavailable<br><span style="font-size:0.65rem;font-weight:normal;color:var(--danger)">Error: ${err.message || err.name || "Permission denied"}</span><br><span style="font-size:0.75rem;font-weight:600;margin-top:6px;display:block;color:var(--accent)">Click to open in a new tab<br>to allow permissions</span>`;
          textEl.style.textAlign = "center";
        }
      }
    }
  }

  cacheElements() {
    this.timerDisplayEl = document.getElementById("timerDisplay");
    this.progressRingEl = document.getElementById("progressRing");
    this.startBtnEl = document.getElementById("startBtn");
    this.pauseBtnEl = document.getElementById("pauseBtn");
    this.resetBtnEl = document.getElementById("resetBtn");

    this.videoEl = document.getElementById("webcam");
    this.cameraPlaceholderEl = document.getElementById("cameraPlaceholder");
    this.canvasEl = document.getElementById("overlayCanvas");
    this.alertOverlayEl = document.getElementById("alertOverlay");

    this.gazeStatusEl = document.getElementById("gazeStatus");
    this.trackingStatusEl = document.getElementById("trackingStatus");

    this.focusPercentEl = document.getElementById("focusPercent");
    this.sessionCountEl = document.getElementById("sessionCount");
    this.sessionMessageEl = document.getElementById("sessionMessage");

    if (!this.canvasEl) {
      throw new Error("Canvas overlay element not found.");
    }
    this.ctx = this.canvasEl.getContext("2d");
  }

  bindEvents() {
    if (this.startBtnEl) {
      this.startBtnEl.addEventListener("click", () => this.startSession());
    }
    if (this.pauseBtnEl) {
      this.pauseBtnEl.addEventListener("click", () => this.pauseSession());
    }
    if (this.resetBtnEl) {
      this.resetBtnEl.addEventListener("click", () => this.resetSession());
    }

    // Clean up camera/raf when popup closes.
    window.addEventListener("beforeunload", () => {
      this.saveState();
      this.cleanup();
    });
  }

  // -------------------------------
  // State Persistence
  // -------------------------------

  async loadState() {
    const data = await chrome.storage.local.get(["pomoState"]);
    if (data.pomoState) {
      const state = data.pomoState;
      this.remainingSeconds = state.remainingSeconds;
      this.isRunning = state.isRunning;
      this.sessionCompleted = state.sessionCompleted;
      this.sessionFocusSeconds = state.sessionFocusSeconds;
      this.sessionDistractedSeconds = state.sessionDistractedSeconds;

      if (this.isRunning) {
        // Calculate elapsed time since popup closed
        if (state.lastTickTime) {
          const now = Date.now();
          const elapsed = Math.floor((now - state.lastTickTime) / 1000);
          this.remainingSeconds = Math.max(0, this.remainingSeconds - elapsed);

          if (this.remainingSeconds === 0 && !this.sessionCompleted) {
            this.completeSession();
            return;
          }
        }

        // Visually update buttons
        this.startBtnEl.disabled = true;
        this.pauseBtnEl.disabled = false;

        // Start the interval loop without resetting variables
        this.resumeInterval();
      }
    }
  }

  saveState() {
    const state = {
      remainingSeconds: this.remainingSeconds,
      isRunning: this.isRunning,
      sessionCompleted: this.sessionCompleted,
      sessionFocusSeconds: this.sessionFocusSeconds,
      sessionDistractedSeconds: this.sessionDistractedSeconds,
      lastTickTime: Date.now(),
    };
    chrome.storage.local.set({ pomoState: state });
  }

  // -------------------------------
  // Timer Logic
  // -------------------------------

  startSession() {
    if (this.sessionCompleted) return;
    if (this.isRunning) return;

    this.isRunning = true;
    this.startBtnEl.disabled = true;
    this.pauseBtnEl.disabled = false;
    this.setSessionMessage("Focus session running...");

    this.resumeInterval();
  }

  resumeInterval() {
    if (this.timerIntervalId) return;

    this.lastTickTime = Date.now();
    this.timerIntervalId = window.setInterval(() => {
      const now = Date.now();
      // Calculate delta to handle slight interval drifts
      const delta = Math.floor((now - this.lastTickTime) / 1000);

      if (delta >= 1) {
        this.remainingSeconds -= delta;
        this.lastTickTime = now;

        // Continually save state so we don't lose much if crash
        this.saveState();

        if (this.remainingSeconds <= 0) {
          this.remainingSeconds = 0;
          this.renderTimer();
          this.updateProgressBar();
          this.completeSession();
          return;
        }

        this.renderTimer();
        this.updateProgressBar();
      }
    }, 1000);
  }

  pauseSession() {
    if (!this.isRunning) return;

    this.isRunning = false;
    this.clearTimerInterval();

    this.startBtnEl.disabled = !this.isCameraReady;
    this.pauseBtnEl.disabled = true;
    this.setSessionMessage("Session paused.");
    this.saveState();
  }

  resetSession() {
    this.isRunning = false;
    this.sessionCompleted = false;
    this.clearTimerInterval();

    this.remainingSeconds = this.SESSION_DURATION_SECONDS;

    // Reset current session metrics only (do not clear aggregate stats)
    this.sessionFocusSeconds = 0;
    this.sessionDistractedSeconds = 0;

    this.renderTimer();
    this.updateProgressBar();

    this.startBtnEl.disabled = !this.isCameraReady;
    this.pauseBtnEl.disabled = true;
    this.setGazeStatus("Gaze: unknown");
    this.setSessionMessage("Session reset. Ready to focus.");
    this.saveState();
  }

  clearTimerInterval() {
    if (this.timerIntervalId !== null) {
      window.clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
  }

  async completeSession() {
    this.isRunning = false;
    this.sessionCompleted = true;
    this.clearTimerInterval();
    this.deactivateAlert();

    this.startBtnEl.disabled = true;
    this.pauseBtnEl.disabled = true;

    await this.persistSessionStats();

    this.setSessionMessage("25min complete. Diffuse break time.");
    this.sendNotification(
      "Session Complete",
      "Great work. Time for a diffuse break.",
    );
    this.playBeepPattern("complete");
    this.saveState();
  }

  renderTimer() {
    if (!this.timerDisplayEl) return;
    const mins = Math.floor(this.remainingSeconds / 60);
    const secs = this.remainingSeconds % 60;
    this.timerDisplayEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  updateProgressBar(instant = false) {
    if (!this.progressRingEl) return;
    const elapsed = this.SESSION_DURATION_SECONDS - this.remainingSeconds;
    const progress = Math.max(
      0,
      Math.min(1, elapsed / this.SESSION_DURATION_SECONDS),
    );
    // 2 * pi * r (where r=70)
    const circumference = 439.8;
    const offset = circumference - progress * circumference;

    if (instant) {
      // Snap to position without CSS transition so restored state doesn't re-animate
      this.progressRingEl.style.transition = "none";
      this.progressRingEl.style.strokeDashoffset = offset;
      // Force reflow so the browser registers the snap before re-enabling the transition
      void this.progressRingEl.getBoundingClientRect();
      this.progressRingEl.style.transition = "";
    } else {
      this.progressRingEl.style.strokeDashoffset = offset;
    }
  }

  // -------------------------------
  // Vision + MediaPipe
  // -------------------------------

  async initializeVision() {
    this.setTrackingStatus("Requesting camera...", "warn");
    this.setGazeStatus("Gaze: initializing", "warn");

    // Request webcam stream
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: "user",
      },
      audio: false,
    });

    this.videoEl.srcObject = this.mediaStream;
    await this.videoEl.play();

    // Sync canvas drawing buffer to the actual rendered video size
    // so landmark coordinates map pixel-perfectly to what is displayed
    await new Promise((resolve) => {
      if (this.videoEl.videoWidth > 0) {
        resolve();
        return;
      }
      this.videoEl.addEventListener("loadedmetadata", resolve, { once: true });
    });
    this.canvasEl.width = this.videoEl.videoWidth || 320;
    this.canvasEl.height = this.videoEl.videoHeight || 240;

    if (this.cameraPlaceholderEl) {
      this.cameraPlaceholderEl.style.display = "none";
    }

    // Load MediaPipe fileset + face landmarker
    const vision = await FilesetResolver.forVisionTasks("./vendor/mediapipe");

    this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "./vendor/mediapipe/face_landmarker.task",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });

    // Load object detector for phone detection
    this.objectDetector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "./vendor/mediapipe/efficientdet_lite0.tflite",
      },
      runningMode: "VIDEO",
      scoreThreshold: 0.5,
      categoryAllowlist: ["cell phone"],
    });

    this.setTrackingStatus("Camera: ready", "ok");
    this.setGazeStatus("Gaze: waiting for face", "warn");

    this.isCameraReady = true;
    this.startBtnEl.disabled = false;
    this.resetBtnEl.disabled = false;

    this.startVisionLoop();
  }

  startVisionLoop() {
    const tick = (ts) => {
      // Face detection — isolated so errors never stop the loop
      try {
        if (ts - this.lastInferenceTime >= this.INFERENCE_INTERVAL_MS) {
          this.lastInferenceTime = ts;
          this.processFrame();
        }
      } catch (err) {
        console.error("[PomoVision] processFrame error:", err);
      }

      // Phone detection — completely isolated from face detection
      try {
        if (ts - this.lastPhoneCheckTime >= this.PHONE_CHECK_INTERVAL_MS) {
          this.lastPhoneCheckTime = ts;
          this.processPhoneDetection(performance.now());
        }
      } catch (err) {
        console.error("[PomoVision] processPhoneDetection error:", err);
      }

      this.animationFrameId = window.requestAnimationFrame(tick);
    };

    this.animationFrameId = window.requestAnimationFrame(tick);
  }

  processFrame() {
    if (!this.faceLandmarker || !this.videoEl || this.videoEl.readyState < 2) {
      return;
    }

    const width = this.canvasEl.width;
    const height = this.canvasEl.height;

    this.ctx.clearRect(0, 0, width, height);

    const result = this.faceLandmarker.detectForVideo(
      this.videoEl,
      performance.now(),
    );

    if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) {
      this.setGazeStatus("Gaze: no face", "danger");
      this.drawStatusHint("No face", "#ffb703");

      if (this.isRunning) {
        // treat no-face as distracted while running
        this.updateSessionFocusCounters(false);
      }
      return;
    }

    const landmarks = result.faceLandmarks[0];

    // Iris landmark references:
    // left iris center approx index = 468
    // right iris center approx index = 473
    const leftIris = landmarks[468];
    const rightIris = landmarks[473];

    if (!leftIris || !rightIris) {
      this.setGazeStatus("Gaze: tracking...");
      if (this.isRunning) {
        this.updateSessionFocusCounters(false);
      }
      return;
    }

    // Mirror avgX to match flipped video — gaze logic stays the same
    const rawAvgX = (leftIris.x + rightIris.x) / 2;
    const avgX = 1 - rawAvgX;
    const lookingAway = avgX < 0.25 || avgX > 0.75;

    // Draw iris points — mirror x to match the CSS scaleX(-1) flipped video
    this.drawPoint((1 - leftIris.x) * width, leftIris.y * height, "#00d4ff");
    this.drawPoint((1 - rightIris.x) * width, rightIris.y * height, "#00d4ff");

    // Draw safe-zone guide lines
    this.drawGuideLines(width, height);

    this.setGazeStatus(
      `Gaze: ${lookingAway ? "away" : "focused"} (x=${avgX.toFixed(2)})`,
      lookingAway ? "danger" : "ok",
    );

    if (this.isRunning) {
      this.updateSessionFocusCounters(!lookingAway);
    }
  }

  updateSessionFocusCounters(isFocusedFrame) {
    // Approximate frame duration at 30fps
    const dt = 1 / 30;

    if (isFocusedFrame) {
      this.sessionFocusSeconds += dt;
      this.currentDistractedStreak = 0;
      this.wasFocusedLastFrame = true;
      this.deactivateAlert();
    } else {
      this.sessionDistractedSeconds += dt;
      this.currentDistractedStreak += dt;
      this.wasFocusedLastFrame = false;

      if (this.currentDistractedStreak >= this.DISTRACTION_SECONDS_THRESHOLD) {
        this.activateAlert();
      }
    }
  }

  drawPoint(x, y, color = "#00d4ff") {
    this.ctx.beginPath();
    this.ctx.arc(x, y, 3, 0, Math.PI * 2);
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  drawGuideLines(width, height) {
    const left = width * 0.25;
    const right = width * 0.75;

    this.ctx.strokeStyle = "rgba(255,255,255,0.18)";
    this.ctx.lineWidth = 1;

    this.ctx.beginPath();
    this.ctx.moveTo(left, 0);
    this.ctx.lineTo(left, height);
    this.ctx.stroke();

    this.ctx.beginPath();
    this.ctx.moveTo(right, 0);
    this.ctx.lineTo(right, height);
    this.ctx.stroke();
  }

  processPhoneDetection(ts) {
    if (
      !this.objectDetector ||
      !this.videoEl ||
      this.videoEl.readyState < 4 // HAVE_ENOUGH_DATA — ensures frames are actually available
    )
      return;

    const result = this.objectDetector.detectForVideo(this.videoEl, ts);
    if (!result || !result.detections) return;

    const phoneFound = result.detections.some((d) =>
      d.categories.some(
        (c) => c.categoryName === "cell phone" && c.score >= 0.5,
      ),
    );

    if (phoneFound && !this.phoneAlertActive) {
      this.phoneAlertActive = true;
      this.activatePhoneAlert(result.detections);
    } else if (!phoneFound && this.phoneAlertActive) {
      this.phoneAlertActive = false;
      this.deactivatePhoneAlert();
    }

    // Draw bounding boxes for detected phones
    if (phoneFound && result.detections.length > 0) {
      for (const det of result.detections) {
        const box = det.boundingBox;
        const w = this.canvasEl.width;
        const h = this.canvasEl.height;
        // Mirror x to match flipped video
        const mirroredX = w - (box.originX + box.width);
        this.ctx.strokeStyle = "#ff473e";
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(mirroredX, box.originY, box.width, box.height);
        this.ctx.fillStyle = "rgba(255,71,62,0.15)";
        this.ctx.fillRect(mirroredX, box.originY, box.width, box.height);
        this.ctx.font = "bold 11px sans-serif";
        this.ctx.fillStyle = "#ff473e";
        this.ctx.fillText("📵 Phone", mirroredX + 4, box.originY + 14);
      }
    }
  }

  activatePhoneAlert() {
    if (this.alertOverlayEl) {
      this.alertOverlayEl.hidden = false;
      // Override default text to phone-specific message
      const title = this.alertOverlayEl.querySelector(".alert-title");
      const subtitle = this.alertOverlayEl.querySelector(".alert-subtitle");
      if (title) title.textContent = "PUT PHONE DOWN";
      if (subtitle) subtitle.textContent = "Phone detected — stay focused!";
    }
    this.sendNotification(
      "📵 Phone Detected!",
      "Put your phone down and refocus on your work.",
    );
    this.playBeepPattern("alert");
    this.setSessionMessage("📵 Phone detected — put it down!");
  }

  deactivatePhoneAlert() {
    // Only close the overlay if the gaze alert is also not active
    if (!this.alertActive && this.alertOverlayEl) {
      this.alertOverlayEl.hidden = true;
    }
    this.setSessionMessage("Focus session running...");
  }

  drawStatusHint(text, color = "#ffffff") {
    this.ctx.font = "12px sans-serif";
    this.ctx.fillStyle = color;
    this.ctx.fillText(text, 8, 16);
  }

  // -------------------------------
  // Alerts + Audio + Notifications
  // -------------------------------

  activateAlert() {
    if (this.alertActive) return;
    this.alertActive = true;

    if (this.alertOverlayEl) {
      this.alertOverlayEl.hidden = false;
    }

    this.setSessionMessage("Distraction detected: refocus now.");
    this.sendNotification("REFOCUS!", "Eyes off-screen for over 5 seconds.");
    this.playBeepPattern("alert");
  }

  deactivateAlert() {
    if (!this.alertActive) return;
    this.alertActive = false;

    if (this.alertOverlayEl) {
      this.alertOverlayEl.hidden = true;
    }
  }

  async ensureAudioContext() {
    if (!this.audioContext) {
      const ACtx = window.AudioContext || window.webkitAudioContext;
      if (!ACtx) return null;
      this.audioContext = new ACtx();
    }

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  async playBeepPattern(type) {
    const ctx = await this.ensureAudioContext();
    if (!ctx) return;

    if (type === "alert") {
      this.beep(ctx, 520, 0.12, 0);
      this.beep(ctx, 390, 0.16, 0.14);
    } else if (type === "complete") {
      this.beep(ctx, 660, 0.12, 0);
      this.beep(ctx, 880, 0.12, 0.16);
      this.beep(ctx, 1040, 0.12, 0.32);
    }
  }

  beep(ctx, frequency = 440, durationSec = 0.12, delaySec = 0) {
    const now = ctx.currentTime + delaySec;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(frequency, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }

  sendNotification(title, message) {
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

  // -------------------------------
  // Storage + Stats
  // -------------------------------

  async loadAndRenderStats() {
    try {
      const data = await chrome.storage.sync.get(this.storageDefaults);
      this.renderStats(data);
    } catch (err) {
      console.error("[PomoVision] Failed to load stats:", err);
      this.renderStats(this.storageDefaults);
    }
  }

  renderStats(data) {
    const focusPercent = Number(data.focusPercent || 0);
    const sessionCount = Number(data.sessionCount || 0);

    if (this.focusPercentEl)
      this.focusPercentEl.textContent = `${Math.round(focusPercent)}%`;
    if (this.sessionCountEl)
      this.sessionCountEl.textContent = String(sessionCount);
  }

  async persistSessionStats() {
    try {
      const prev = await chrome.storage.sync.get(this.storageDefaults);

      const totalFocusSeconds =
        Number(prev.totalFocusSeconds || 0) + this.sessionFocusSeconds;
      const totalDistractedSeconds =
        Number(prev.totalDistractedSeconds || 0) +
        this.sessionDistractedSeconds;

      const totalTracked = totalFocusSeconds + totalDistractedSeconds;
      const aggregatedFocusPercent =
        totalTracked > 0 ? (totalFocusSeconds / totalTracked) * 100 : 0;

      const next = {
        sessionCount: Number(prev.sessionCount || 0) + 1,
        totalFocusSeconds: Number(totalFocusSeconds.toFixed(2)),
        totalDistractedSeconds: Number(totalDistractedSeconds.toFixed(2)),
        focusPercent: Number(aggregatedFocusPercent.toFixed(1)),
      };

      await chrome.storage.sync.set(next);
      this.renderStats(next);
    } catch (err) {
      console.error("[PomoVision] Failed to persist stats:", err);
      this.setSessionMessage("Session finished, but stats save failed.");
    }
  }

  // -------------------------------
  // UI Helpers
  // -------------------------------

  setTrackingStatus(text, statusType = "ok") {
    if (this.trackingStatusEl) {
      this.trackingStatusEl.textContent = text;
      this.trackingStatusEl.className = `status-pill ${statusType}`;
    }
  }

  setGazeStatus(text, statusType = "") {
    if (this.gazeStatusEl) {
      this.gazeStatusEl.textContent = text;
      this.gazeStatusEl.className = `status-pill ${statusType}`;
    }
  }

  setSessionMessage(text) {
    if (this.sessionMessageEl) this.sessionMessageEl.textContent = text;
  }

  // -------------------------------
  // Cleanup
  // -------------------------------

  cleanup() {
    this.clearTimerInterval();

    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
    }
  }
}

// Bootstrap
document.addEventListener("DOMContentLoaded", async () => {
  const app = new PomoVision();
  window.pomoVisionApp = app; // optional debug handle in popup devtools

  try {
    await app.init();
  } catch (err) {
    console.error("[PomoVision] Fatal init error:", err);
    const sessionMessage = document.getElementById("sessionMessage");
    if (sessionMessage) {
      sessionMessage.textContent = "Initialization failed. Reload extension.";
    }
  }
});
