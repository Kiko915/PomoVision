import {
  FilesetResolver,
  FaceLandmarker,
  ObjectDetector,
} from "./vendor/mediapipe/vision_bundle.mjs";

class PomoTracking {
  constructor() {
    this.videoEl = document.getElementById("webcam");
    this.canvasEl = document.getElementById("overlayCanvas");
    this.ctx = this.canvasEl.getContext("2d");

    this.faceLandmarker = null;
    this.objectDetector = null;
    this.mediaStream = null;
    this.lastVideoTime = -1;
    this.lastFrameTime = performance.now();

    // State
    this.DISTRACTION_SECONDS_THRESHOLD = 5;
    this.currentDistractedStreak = 0;
    this.pomoState = {
      isRunning: false,
      sessionFocusSeconds: 0,
      sessionDistractedSeconds: 0,
    };

    // Phone detection state
    this.lastPhoneCheckTime = 0;
    this.PHONE_CHECK_INTERVAL_MS = 800;
    this.phoneAlertActive = false;

    this.audioCtx = null;
    this.alertActive = false;

    this.init();
  }

  async init() {
    // Initial state load
    const data = await chrome.storage.local.get(["pomoState"]);
    if (data.pomoState) {
      this.pomoState = { ...this.pomoState, ...data.pomoState };
    }

    // Listen to state changes from the popup
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.pomoState) {
        const newVal = changes.pomoState.newValue;
        if (newVal) {
          this.pomoState.isRunning = newVal.isRunning;
          // Only take timer resets/updates from popup, preserve local streak
          if (!newVal.isRunning) {
            this.currentDistractedStreak = 0;
            this.deactivateAlert();
          }
        }
      }
    });

    await this.initializeCamera();
    await this.initializeVision();
    this.startVisionLoop();
  }

  async initializeCamera() {
    try {
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
      console.log("[Tracking] Camera active.");
    } catch (err) {
      console.error("[Tracking] Camera access failed:", err);
    }
  }

  async initializeVision() {
    try {
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

      this.objectDetector = await ObjectDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "./vendor/mediapipe/efficientdet_lite0.tflite",
        },
        runningMode: "VIDEO",
        scoreThreshold: 0.5,
        categoryAllowlist: ["cell phone"],
      });

      console.log("[Tracking] Vision models loaded (face + object detector).");
    } catch (err) {
      console.error("[Tracking] Model load failed:", err);
    }
  }

  startVisionLoop() {
    const tick = (ts) => {
      if (!this.videoEl.paused && this.faceLandmarker) {
        this.processFrame();
      }
      // Phone detection at lower frequency
      if (
        this.objectDetector &&
        !this.videoEl.paused &&
        ts - this.lastPhoneCheckTime >= this.PHONE_CHECK_INTERVAL_MS
      ) {
        this.lastPhoneCheckTime = ts;
        this.processPhoneDetection(ts);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  processFrame() {
    const startTimeMs = performance.now();
    const dt = (startTimeMs - this.lastFrameTime) / 1000;
    this.lastFrameTime = startTimeMs;

    if (this.videoEl.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.videoEl.currentTime;

      const result = this.faceLandmarker.detectForVideo(
        this.videoEl,
        startTimeMs,
      );

      this.ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);

      let isDistracted = true;

      if (result && result.faceLandmarks && result.faceLandmarks.length > 0) {
        const landmarks = result.faceLandmarks[0];

        // Draw basic mesh dots for visualization
        this.ctx.fillStyle = "#0066cc";
        for (const pt of landmarks) {
          this.ctx.beginPath();
          this.ctx.arc(
            pt.x * this.canvasEl.width,
            pt.y * this.canvasEl.height,
            1,
            0,
            2 * Math.PI,
          );
          this.ctx.fill();
        }

        // Extremely simplified gaze logic - if face is present and somewhat centered
        // (In a real scenario, use Iris coordinates 468 and 473 to calculate gaze ratio)
        const nose = landmarks[1];
        if (nose.x > 0.2 && nose.x < 0.8 && nose.y > 0.1 && nose.y < 0.9) {
          isDistracted = false;
        }
      }

      if (this.pomoState.isRunning) {
        this.updateState(isDistracted, dt);
      }
    }
  }

  processPhoneDetection(ts) {
    if (!this.objectDetector || !this.videoEl || this.videoEl.readyState < 2)
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
      console.log("[Tracking] Phone detected! Alerting user.");

      // Draw bounding box on canvas
      for (const det of result.detections) {
        const box = det.boundingBox;
        const w = this.canvasEl.width;
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

      // Notify via background service worker
      chrome.runtime.sendMessage({
        type: "PV_NOTIFY",
        payload: {
          title: "📵 Phone Detected!",
          message: "Put your phone down and refocus on your work.",
        },
      });

      // Pulse the active tab's border orange
      chrome.runtime.sendMessage({ type: "PV_PHONE_START" });

      this.playAlertBeep();

      // Persist phone alert state so popup can reflect it
      chrome.storage.local.get(["pomoState"], (data) => {
        if (data.pomoState) {
          chrome.storage.local.set({
            pomoState: { ...data.pomoState, phoneAlert: true },
          });
        }
      });
    } else if (!phoneFound && this.phoneAlertActive) {
      this.phoneAlertActive = false;
      document.body.style.backgroundColor = "#1a1a1a";

      // Remove the tab border
      chrome.runtime.sendMessage({ type: "PV_PHONE_STOP" });

      // Clear phone alert state
      chrome.storage.local.get(["pomoState"], (data) => {
        if (data.pomoState) {
          chrome.storage.local.set({
            pomoState: { ...data.pomoState, phoneAlert: false },
          });
        }
      });
    }
  }

  updateState(isDistracted, dt) {
    if (isDistracted) {
      this.pomoState.sessionDistractedSeconds += dt;
      this.currentDistractedStreak += dt;

      if (this.currentDistractedStreak >= this.DISTRACTION_SECONDS_THRESHOLD) {
        this.activateAlert();
      }
    } else {
      this.pomoState.sessionFocusSeconds += dt;
      this.currentDistractedStreak = 0;
      this.deactivateAlert();
    }

    // Throttle storage updates so we don't spam the API
    if (!this.lastSaveTime || performance.now() - this.lastSaveTime > 1000) {
      this.lastSaveTime = performance.now();
      this.syncStateToStorage();
    }
  }

  async syncStateToStorage() {
    const data = await chrome.storage.local.get(["pomoState"]);
    if (data.pomoState) {
      const merged = {
        ...data.pomoState,
        sessionFocusSeconds: this.pomoState.sessionFocusSeconds,
        sessionDistractedSeconds: this.pomoState.sessionDistractedSeconds,
      };
      await chrome.storage.local.set({ pomoState: merged });
    }
  }

  async ensureAudioContext() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }
  }

  activateAlert() {
    if (this.alertActive) return;
    this.alertActive = true;
    document.body.style.backgroundColor = "#4a0000";

    // Send Notification
    chrome.runtime.sendMessage({
      type: "PV_NOTIFY",
      payload: {
        title: "REFOCUS!",
        message: "You've been distracted for over 5 seconds.",
      },
    });

    // Pulse the active tab's border red
    chrome.runtime.sendMessage({ type: "PV_REFOCUS_START" });

    this.playAlertBeep();
  }

  deactivateAlert() {
    if (!this.alertActive) return;
    this.alertActive = false;
    document.body.style.backgroundColor = "#1a1a1a";

    // Remove the tab border
    chrome.runtime.sendMessage({ type: "PV_REFOCUS_STOP" });
  }

  async playAlertBeep() {
    await this.ensureAudioContext();
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();

    osc.type = "square";
    osc.frequency.setValueAtTime(440, this.audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      880,
      this.audioCtx.currentTime + 0.1,
    );

    gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.1, this.audioCtx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      this.audioCtx.currentTime + 0.3,
    );

    osc.connect(gain);
    gain.connect(this.audioCtx.destination);

    osc.start();
    osc.stop(this.audioCtx.currentTime + 0.3);
  }
}

// Initialize
window.addEventListener("DOMContentLoaded", () => {
  new PomoTracking();
});
