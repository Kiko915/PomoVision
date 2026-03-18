/**
 * AudioManager.js
 * Handles all audio feedback: beep patterns and audio context lifecycle.
 */

export class AudioManager {
  constructor() {
    this.audioContext = null;
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

  async playBeepPattern(type = "alert") {
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

  dispose() {
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }
}
