/**
 * TimerManager.js
 * Handles all Pomodoro timer logic: start, pause, reset, complete,
 * rendering the timer display, updating the progress ring, and
 * persisting / restoring timer state via chrome.storage.local.
 */

export class TimerManager {
  /**
   * @param {object} config
   * @param {number} config.sessionDurationSeconds   - Total session length (default 25*60)
   * @param {object} elements
   * @param {HTMLElement} elements.timerDisplayEl
   * @param {SVGElement}  elements.progressRingEl
   * @param {HTMLElement} elements.startBtnEl
   * @param {HTMLElement} elements.pauseBtnEl
   * @param {HTMLElement} elements.resetBtnEl
   * @param {object} callbacks
   * @param {Function} callbacks.onComplete          - Called when the session finishes
   * @param {Function} callbacks.onSetMessage        - (text) => void
   * @param {Function} callbacks.onSetGazeStatus     - (text, type) => void
   * @param {boolean}  callbacks.isCameraReady       - Getter, returns current camera state
   */
  constructor(
    { sessionDurationSeconds = 25 * 60 } = {},
    elements = {},
    callbacks = {},
  ) {
    // Config
    this.SESSION_DURATION_SECONDS = sessionDurationSeconds;

    // Elements
    this.timerDisplayEl = elements.timerDisplayEl || null;
    this.progressRingEl = elements.progressRingEl || null;
    this.startBtnEl = elements.startBtnEl || null;
    this.pauseBtnEl = elements.pauseBtnEl || null;
    this.resetBtnEl = elements.resetBtnEl || null;

    // Callbacks
    this.onComplete = callbacks.onComplete || (() => {});
    this.onSetMessage = callbacks.onSetMessage || (() => {});
    this.onSetGazeStatus = callbacks.onSetGazeStatus || (() => {});
    this.isCameraReady = callbacks.isCameraReady || (() => false);

    // State
    this.remainingSeconds = this.SESSION_DURATION_SECONDS;
    this.isRunning = false;
    this.sessionCompleted = false;
    this.timerIntervalId = null;
    this.lastTickTime = null;

    // Session focus counters (synced from VisionManager / tracking)
    this.sessionFocusSeconds = 0;
    this.sessionDistractedSeconds = 0;

    // Ring circumference for r=70: 2 * π * 70
    this.CIRCUMFERENCE = 439.8;
  }

  // -------------------------------------------------------
  // Public API
  // -------------------------------------------------------

  start() {
    if (this.sessionCompleted || this.isRunning) return;

    this.isRunning = true;
    if (this.startBtnEl) this.startBtnEl.disabled = true;
    if (this.pauseBtnEl) this.pauseBtnEl.disabled = false;
    this.onSetMessage("Focus session running...");

    this._resumeInterval();
  }

  pause() {
    if (!this.isRunning) return;

    this.isRunning = false;
    this._clearInterval();

    if (this.startBtnEl) this.startBtnEl.disabled = !this.isCameraReady();
    if (this.pauseBtnEl) this.pauseBtnEl.disabled = true;
    this.onSetMessage("Session paused.");
    this.saveState();
  }

  reset() {
    this.isRunning = false;
    this.sessionCompleted = false;
    this._clearInterval();

    this.remainingSeconds = this.SESSION_DURATION_SECONDS;
    this.sessionFocusSeconds = 0;
    this.sessionDistractedSeconds = 0;

    this.renderTimer();
    this.updateProgressBar();

    if (this.startBtnEl) this.startBtnEl.disabled = !this.isCameraReady();
    if (this.pauseBtnEl) this.pauseBtnEl.disabled = true;

    this.onSetGazeStatus("Gaze: unknown", "");
    this.onSetMessage("Session reset. Ready to focus.");
    this.saveState();
  }

  async complete() {
    this.isRunning = false;
    this.sessionCompleted = true;
    this._clearInterval();

    if (this.startBtnEl) this.startBtnEl.disabled = true;
    if (this.pauseBtnEl) this.pauseBtnEl.disabled = true;

    await this.onComplete();
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
    const offset = this.CIRCUMFERENCE - progress * this.CIRCUMFERENCE;

    if (instant) {
      // Snap directly to the restored position without animating
      this.progressRingEl.style.transition = "none";
      this.progressRingEl.style.strokeDashoffset = offset;
      // Force a reflow so the browser commits the snap before re-enabling transition
      void this.progressRingEl.getBoundingClientRect();
      this.progressRingEl.style.transition = "";
    } else {
      this.progressRingEl.style.strokeDashoffset = offset;
    }
  }

  // -------------------------------------------------------
  // State Persistence
  // -------------------------------------------------------

  async loadState() {
    const data = await chrome.storage.local.get(["pomoState"]);
    if (!data.pomoState) return;

    const state = data.pomoState;
    this.remainingSeconds = state.remainingSeconds ?? this.SESSION_DURATION_SECONDS;
    this.isRunning = state.isRunning ?? false;
    this.sessionCompleted = state.sessionCompleted ?? false;
    this.sessionFocusSeconds = state.sessionFocusSeconds ?? 0;
    this.sessionDistractedSeconds = state.sessionDistractedSeconds ?? 0;

    if (this.isRunning && state.lastTickTime) {
      const elapsed = Math.floor((Date.now() - state.lastTickTime) / 1000);
      this.remainingSeconds = Math.max(0, this.remainingSeconds - elapsed);

      if (this.remainingSeconds === 0 && !this.sessionCompleted) {
        await this.complete();
        return;
      }

      // Restore running UI state
      if (this.startBtnEl) this.startBtnEl.disabled = true;
      if (this.pauseBtnEl) this.pauseBtnEl.disabled = false;

      this._resumeInterval();
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

  // -------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------

  _resumeInterval() {
    if (this.timerIntervalId) return;

    this.lastTickTime = Date.now();
    this.timerIntervalId = window.setInterval(() => {
      const now = Date.now();
      const delta = Math.floor((now - this.lastTickTime) / 1000);

      if (delta >= 1) {
        this.remainingSeconds -= delta;
        this.lastTickTime = now;

        // Persist on every tick to minimise state loss on crash
        this.saveState();

        if (this.remainingSeconds <= 0) {
          this.remainingSeconds = 0;
          this.renderTimer();
          this.updateProgressBar();
          this.complete();
          return;
        }

        this.renderTimer();
        this.updateProgressBar();
      }
    }, 1000);
  }

  _clearInterval() {
    if (this.timerIntervalId !== null) {
      window.clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
  }
}
