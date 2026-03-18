/**
 * VisionManager.js
 * Handles all camera and MediaPipe logic:
 * - Camera initialization
 * - Face landmark detection + gaze tracking
 * - Phone detection via ObjectDetector
 * - Canvas overlay drawing
 */

import {
  FilesetResolver,
  FaceLandmarker,
  ObjectDetector,
} from "../vendor/mediapipe/vision_bundle.mjs";

export class VisionManager {
  /**
   * @param {object} elements
   * @param {HTMLVideoElement} elements.videoEl
   * @param {HTMLCanvasElement} elements.canvasEl
   * @param {HTMLElement} elements.cameraPlaceholderEl
   * @param {object} callbacks
   * @param {Function} callbacks.onCameraReady         - () => void
   * @param {Function} callbacks.onCameraError         - (err) => void
   * @param {Function} callbacks.onFocused             - () => void
   * @param {Function} callbacks.onDistracted          - () => void
   * @param {Function} callbacks.onPhoneDetected       - () => void
   * @param {Function} callbacks.onPhoneGone           - () => void
   * @param {Function} callbacks.setTrackingStatus     - (text, type) => void
   * @param {Function} callbacks.setGazeStatus         - (text, type) => void
   */
  constructor(elements = {}, callbacks = {}) {
    // Elements
    this.videoEl = elements.videoEl || null;
    this.canvasEl = elements.canvasEl || null;
    this.cameraPlaceholderEl = elements.cameraPlaceholderEl || null;
    this.ctx = this.canvasEl ? this.canvasEl.getContext("2d") : null;

    // Callbacks
    this.onCameraReady = callbacks.onCameraReady || (() => {});
    this.onCameraError = callbacks.onCameraError || (() => {});
    this.onFocused = callbacks.onFocused || (() => {});
    this.onDistracted = callbacks.onDistracted || (() => {});
    this.onPhoneDetected = callbacks.onPhoneDetected || (() => {});
    this.onPhoneGone = callbacks.onPhoneGone || (() => {});
    this.setTrackingStatus = callbacks.setTrackingStatus || (() => {});
    this.setGazeStatus = callbacks.setGazeStatus || (() => {});

    // MediaPipe
    this.mediaStream = null;
    this.faceLandmarker = null;
    this.objectDetector = null;

    // Loop state
    this.animationFrameId = null;
    this.lastInferenceTime = 0;
    this.lastPhoneCheckTime = 0;
    this.INFERENCE_INTERVAL_MS = 33;    // ~30fps
    this.PHONE_CHECK_INTERVAL_MS = 800; // ~1fps

    // Gaze / distraction config
    this.DISTRACTION_SECONDS_THRESHOLD = 5;
    this.currentDistractedStreak = 0;
    this.alertActive = false;
    this.phoneAlertActive = false;
    this.isRunning = false; // kept in sync by the orchestrator
  }

  // -------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------

  async initialize() {
    this.setTrackingStatus("Requesting camera...", "warn");
    this.setGazeStatus("Gaze: initializing", "warn");

    // Camera stream
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

    // Sync canvas buffer to real video dimensions
    await new Promise((resolve) => {
      if (this.videoEl.videoWidth > 0) { resolve(); return; }
      this.videoEl.addEventListener("loadedmetadata", resolve, { once: true });
    });
    this.canvasEl.width = this.videoEl.videoWidth || 320;
    this.canvasEl.height = this.videoEl.videoHeight || 240;

    // Hide placeholder
    if (this.cameraPlaceholderEl) {
      this.cameraPlaceholderEl.style.display = "none";
    }

    // Load MediaPipe models
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

    this.setTrackingStatus("Camera: ready", "ok");
    this.setGazeStatus("Gaze: waiting for face", "warn");

    this.onCameraReady();
    this._startLoop();
  }

  // -------------------------------------------------------
  // Vision Loop
  // -------------------------------------------------------

  _startLoop() {
    const tick = (ts) => {
      // Face detection — isolated so its errors never kill the phone check
      try {
        if (ts - this.lastInferenceTime >= this.INFERENCE_INTERVAL_MS) {
          this.lastInferenceTime = ts;
          this._processFrame();
        }
      } catch (err) {
        console.error("[VisionManager] processFrame error:", err);
      }

      // Phone detection — isolated from face detection
      try {
        if (ts - this.lastPhoneCheckTime >= this.PHONE_CHECK_INTERVAL_MS) {
          this.lastPhoneCheckTime = ts;
          this._processPhoneDetection(performance.now());
        }
      } catch (err) {
        console.error("[VisionManager] processPhoneDetection error:", err);
      }

      this.animationFrameId = window.requestAnimationFrame(tick);
    };

    this.animationFrameId = window.requestAnimationFrame(tick);
  }

  // -------------------------------------------------------
  // Face / Gaze Processing
  // -------------------------------------------------------

  _processFrame() {
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
      this._drawStatusHint("No face", "#ffb703");

      if (this.isRunning) {
        this._updateFocusCounters(false);
      }
      return;
    }

    const landmarks = result.faceLandmarks[0];

    // Iris landmarks: 468 = left iris, 473 = right iris
    const leftIris = landmarks[468];
    const rightIris = landmarks[473];

    if (!leftIris || !rightIris) {
      this.setGazeStatus("Gaze: tracking...", "warn");
      if (this.isRunning) this._updateFocusCounters(false);
      return;
    }

    // Mirror avgX to match CSS scaleX(-1) flipped video
    const rawAvgX = (leftIris.x + rightIris.x) / 2;
    const avgX = 1 - rawAvgX;
    const lookingAway = avgX < 0.25 || avgX > 0.75;

    // Draw mirrored iris points
    this._drawPoint((1 - leftIris.x) * width, leftIris.y * height, "#00d4ff");
    this._drawPoint((1 - rightIris.x) * width, rightIris.y * height, "#00d4ff");

    // Draw safe-zone guide lines
    this._drawGuideLines(width, height);

    this.setGazeStatus(
      `Gaze: ${lookingAway ? "away" : "focused"} (x=${avgX.toFixed(2)})`,
      lookingAway ? "danger" : "ok",
    );

    if (this.isRunning) {
      this._updateFocusCounters(!lookingAway);
    }
  }

  _updateFocusCounters(isFocused) {
    const dt = 1 / 30; // approx frame time at 30fps

    if (isFocused) {
      this.currentDistractedStreak = 0;
      this.alertActive = false;
      this.onFocused(dt);
    } else {
      this.currentDistractedStreak += dt;

      if (this.currentDistractedStreak >= this.DISTRACTION_SECONDS_THRESHOLD) {
        this.alertActive = true;
        this.onDistracted(dt, true /* threshold exceeded */);
      } else {
        this.onDistracted(dt, false);
      }
    }
  }

  // -------------------------------------------------------
  // Phone Detection
  // -------------------------------------------------------

  _processPhoneDetection(ts) {
    if (
      !this.objectDetector ||
      !this.videoEl ||
      this.videoEl.readyState < 4 // HAVE_ENOUGH_DATA
    ) return;

    const result = this.objectDetector.detectForVideo(this.videoEl, ts);
    if (!result || !result.detections) return;

    const phoneFound = result.detections.some((d) =>
      d.categories.some(
        (c) => c.categoryName === "cell phone" && c.score >= 0.5,
      ),
    );

    if (phoneFound && !this.phoneAlertActive) {
      this.phoneAlertActive = true;
      this.onPhoneDetected();
    } else if (!phoneFound && this.phoneAlertActive) {
      this.phoneAlertActive = false;
      this.onPhoneGone();
    }

    // Draw bounding boxes for any detected phones
    if (phoneFound) {
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
    }
  }

  // -------------------------------------------------------
  // Canvas Drawing Helpers
  // -------------------------------------------------------

  _drawPoint(x, y, color = "#00d4ff") {
    this.ctx.beginPath();
    this.ctx.arc(x, y, 3, 0, Math.PI * 2);
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  _drawGuideLines(width, height) {
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

  _drawStatusHint(text, color = "#ffffff") {
    this.ctx.font = "12px sans-serif";
    this.ctx.fillStyle = color;
    this.ctx.fillText(text, 8, 16);
  }

  // -------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------

  dispose() {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }
}
