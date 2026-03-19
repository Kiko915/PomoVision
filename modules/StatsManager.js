/**
 * StatsManager.js
 * Handles loading, persisting, and rendering of aggregate session statistics.
 * - Focus ratio is stored and rendered as a percentage.
 * - Completed Pomodoros are rendered as mini dot indicators (8 per cycle).
 */

export class StatsManager {
  /**
   * @param {object} elements
   * @param {HTMLElement} elements.focusPercentEl  - Span for focus percentage
   * @param {HTMLElement} elements.pomodoroDotsEl  - Container div for pomo dots
   * @param {number}      [elements.maxDots=8]     - Total dots per cycle
   */
  constructor({ focusPercentEl, pomodoroDotsEl, maxDots = 8 }) {
    this.focusPercentEl = focusPercentEl;
    this.pomodoroDotsEl = pomodoroDotsEl;
    this.maxDots = maxDots;

    this.defaults = {
      sessionCount: 0,
      totalFocusSeconds: 0,
      totalDistractedSeconds: 0,
      focusPercent: 0,
    };
  }

  // ─────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────

  /** Load stats from chrome.storage.sync and render them. */
  async loadAndRender() {
    try {
      const data = await chrome.storage.sync.get(this.defaults);
      this.render(data);
    } catch (err) {
      console.error("[StatsManager] Failed to load stats:", err);
      this.render(this.defaults);
    }
  }

  /**
   * Persist a completed session's focus/distraction data,
   * accumulate into aggregate totals, then re-render.
   *
   * @param {number} sessionFocusSeconds
   * @param {number} sessionDistractedSeconds
   * @returns {Promise<object>} The updated stats object that was saved.
   */
  async persist(sessionFocusSeconds, sessionDistractedSeconds) {
    // Guard: ignore sessions where nothing was tracked at all
    const sessionTotal = sessionFocusSeconds + sessionDistractedSeconds;

    try {
      const prev = await chrome.storage.sync.get(this.defaults);

      const totalFocusSeconds =
        Number(prev.totalFocusSeconds || 0) + Math.max(0, sessionFocusSeconds);
      const totalDistractedSeconds =
        Number(prev.totalDistractedSeconds || 0) +
        Math.max(0, sessionDistractedSeconds);

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
      console.log("[StatsManager] Stats persisted:", next);
      this.render(next);

      return next;
    } catch (err) {
      console.error("[StatsManager] Failed to persist stats:", err);
      throw err;
    }
  }

  /**
   * Render stats into the DOM.
   * @param {object} data - Stats object with focusPercent and sessionCount.
   */
  render(data) {
    const focusPercent = Number(data.focusPercent || 0);
    const sessionCount = Number(data.sessionCount || 0);

    // ── Focus ratio ──────────────────────────────
    if (this.focusPercentEl) {
      this.focusPercentEl.textContent = `${Math.round(focusPercent)}%`;
    }

    // ── Pomodoro dots ────────────────────────────
    this._renderDots(sessionCount);
  }

  // ─────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────

  /**
   * Fill in completed-pomodoro stars.
   * The display wraps every `maxDots` sessions so the stars always show
   * progress within the current 8-pomodoro cycle.
   *
   * @param {number} totalSessions - All-time completed session count.
   */
  _renderDots(totalSessions) {
    if (!this.pomodoroDotsEl) return;

    const stars = this.pomodoroDotsEl.querySelectorAll(".pomo-star");
    if (!stars.length) return;

    // How many sessions into the current cycle (0–maxDots)
    const completedInCycle = totalSessions % this.maxDots;

    stars.forEach((star, index) => {
      const isCompleted = index < completedInCycle;
      star.classList.toggle("completed", isCompleted);
      star.title = isCompleted
        ? `Pomodoro ${index + 1} complete`
        : `Pomodoro ${index + 1}`;
    });
  }
}
