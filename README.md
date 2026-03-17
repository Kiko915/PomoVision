# PomoVision

An AI-assisted Pomodoro focus tracker Chrome extension built with **vanilla HTML, CSS, and JavaScript** (no frameworks, no build step).  
PomoVision uses **MediaPipe Face Landmarker** in the popup to detect when your gaze drifts away for too long, then triggers an instant refocus alert.

> Inspired by **Learning How to Learn**

---

## Features

### Core MVP
- **25:00 Pomodoro timer** with Start / Pause / Reset controls
- **Live webcam preview** (320x240) inside extension popup
- **MediaPipe Face Landmarker** integration via CDN
- **Gaze-away detection**:
  - Tracks iris x-position
  - Flags distraction when gaze remains near left/right edge for > 5 seconds
- **Distraction alerts**:
  - Red flashing **REFOCUS!** overlay
  - Browser notification
  - Audio beep (Web Audio API)
- **Persistent stats** with `chrome.storage.sync`:
  - Focus percentage
  - Session count
- **Session completion feedback**:
  - Diffuse-break message after 25 minutes

### Quality Goals
- Clean MV3 structure
- Minimal, modern dark UI
- Mobile-friendly popup layout constraints
- Smooth tracking loop targeting ~30 FPS
- Defensive error handling for camera/model/permissions failures

---

## Project Structure

```text
PomoVision/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── background.js
├── README.md
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Architecture Overview

### 1) `manifest.json` (MV3)
- Defines popup entry (`popup.html`)
- Registers background service worker (`background.js`)
- Declares permissions:
  - `storage`
  - `notifications`
  - camera access (handled via browser media permission flow)
- Defines extension icons (16/48/128)

### 2) `popup.html`
- Main UI shell for:
  - Timer display
  - Progress bar
  - Session controls
  - Video + canvas overlay
  - Alert layer
  - Stats section
  - Branding text

### 3) `popup.css`
- Dark theme palette:
  - Background: `#0f0f23`
  - Accent: `#00d4ff`
- Compact, modern card layout for popup dimensions
- Alert flash animation for distraction state

### 4) `popup.js`
Contains the core app logic in a `PomoVision` class:
- `init()` bootstraps UI, stats, camera, and MediaPipe
- `startSession()` launches Pomodoro countdown
- Real-time frame loop for landmark inference
- Gaze heuristic:
  - distraction if iris x-position `< 0.25` or `> 0.75`
  - sustained > 5 seconds triggers alert
- Notification + audio + overlay alert channels
- Persists and updates focus stats

### 5) `background.js`
- MV3 service worker scaffold
- Handles install-time initialization defaults
- Supports notification helper flow / future extension logic

---

## 3-Step Setup (Load Unpacked)

1. **Prepare files**
   - Ensure all required files exist in the `PomoVision/` root.
   - Add icon image files at:
     - `icons/icon16.png`
     - `icons/icon48.png`
     - `icons/icon128.png`

2. **Load extension**
   - Open `chrome://extensions`
   - Turn on **Developer mode**
   - Click **Load unpacked**
   - Select the `PomoVision/` directory

3. **Run and verify**
   - Click extension icon to open popup
   - Grant webcam permission when prompted
   - Click **Start Focus Session**
   - Look away > 5 seconds to validate:
     - red overlay
     - browser notification
     - beep alert
   - Let timer complete to verify diffuse-break message + stats persistence

---

## Usage Flow

1. Open popup and confirm camera readiness.
2. Start focus session.
3. Keep your gaze on screen during deep work.
4. If distracted too long, refocus immediately when alerted.
5. After 25 minutes, take a short diffuse break and start next cycle.

---

## Success Criteria Checklist

- [ ] Extension loads unpacked without manifest errors  
- [ ] Popup launches and shows `25:00` timer  
- [ ] Camera stream appears after permission grant  
- [ ] Face tracking runs without crashing popup  
- [ ] Looking away >5s triggers REFOCUS overlay + notification + beep  
- [ ] 25-minute completion updates session count and focus %  

---

## Permissions & Privacy Notes

### Permissions Used
- `storage`: Save focus stats across sessions/devices (sync storage)
- `notifications`: Send immediate refocus and completion notifications
- `camera`: Access webcam stream for local landmark inference

### Privacy
- Webcam frames are processed locally in the extension runtime.
- No face embeddings or raw video uploads are required for MVP.
- Recommended for release:
  - add a public privacy policy page
  - explicitly state local processing and no biometric identity storage
  - disclose third-party model/CDN dependency (MediaPipe)

---

## Icon Guidance (Design Spec Only)

Create simple flat icons at 16/48/128 px with:
- **Background**: dark navy circle (`#0f0f23`)
- **Primary symbol**: cyan eye outline (`#00d4ff`)
- **Secondary symbol**: minimal clock hand inside pupil
- Strong contrast and readability at 16px
- Avoid thin detail that blurs at small sizes

---

## Troubleshooting

### Camera unavailable
- Confirm webcam is not locked by another app
- Reopen popup after granting permissions
- Check browser/site-level camera settings

### No notifications
- Ensure OS notification permissions are enabled for Chrome
- Verify extension notification permission remains allowed

### Model load failures
- Confirm internet access for CDN/WASM/model file fetches
- Keep popup open for initial model initialization

### Low accuracy
- Improve lighting and keep face centered in frame
- Reduce extreme head angles
- Consider future calibration step for personalized thresholds

---

## Roadmap (Post-MVP)

- Baseline gaze calibration per session
- Better attention scoring with smoothing filters
- Break timer / long-break cycles
- Historical charts and streak analytics
- Optional ambient focus soundscapes

---

## License

Suggested: **MIT** for portfolio and educational use.