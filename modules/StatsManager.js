/**
 * StatsManager.js
 * Handles loading, persisting, and rendering of aggregate session statistics.
 */

export class StatsManager {
  constructor({ focusPercentEl, sessionCountEl }) {
    this.focusPercentEl = focusPercentEl;
    this.sessionCountEl = sessionCountEl;

    this.defaults = {
      sessionCount: 0,
      totalFocusSeconds: 0,
      totalDistractedSeconds: 0,
      focusPercent: 0,
    };
  }

  async loadAndRender() {
    try {
      const data = await chrome.storage.sync.get(this.defaults);
      this.render(data);
    } catch (err) {
      console.error("[StatsManager] Failed to load stats:", err);
      this.render(this.defaults);
    }
  }

  render(data) {
    const focusPercent = Number(data.focusPercent || 0);
    const sessionCount = Number(data.sessionCount || 0);

    if (this.focusPercentEl) {
      this.focusPercentEl.textContent = `${Math.round(focusPercent)}%`;
    }
    if (this.sessionCountEl) {
      this.sessionCountEl.textContent = String(sessionCount);
    }
  }

  async persist(sessionFocusSeconds, sessionDistractedSeconds) {
    try {
      const prev = await chrome.storage.sync.get(this.defaults);

      const totalFocusSeconds =
        Number(prev.totalFocusSeconds || 0) + sessionFocusSeconds;
      const totalDistractedSeconds =
        Number(prev.totalDistractedSeconds || 0) + sessionDistractedSeconds;

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
      this.render(next);

      return next;
    } catch (err) {
      console.error("[StatsManager] Failed to persist stats:", err);
      throw err;
    }
  }
}
