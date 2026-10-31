# Honeycomb Trial — Build & Run Guide

Endless needle-tracing survival game. The core game is vanilla TypeScript and HTML5 Canvas. React is used only as a thin mount point that came with the template. The build is a single self-contained `dist/index.html` with no network requests, which Capacitor packages for Android.

## Project layout

```
src/game/
  GameEngine.ts            state machine, rAF loop, fixed-timestep simulation
  core/ShapeFactory.ts     28 design registry, arc-length resampling, validation
  core/ShapeLibrary.ts     20 additional hand-authored engraving outlines
  core/TraceController.ts  nearest-segment tracking, corridor, coverage, anti-shortcut
  core/CrackSimulator.ts   deterministic stress → integrity → branching cracks
  core/DifficultyManager.ts progression + shape unlocks
  core/ScoreManager.ts     scoring, streak multiplier, single-award guard
  core/RoundSimulation.ts  pure, deterministic round model (used by tests)
  input/PointerInput.ts    Pointer Events (touch / mouse / stylus), coalesced events
  render/CanvasRenderer.ts layered 2.5D rendering with cached textures
  render/ParticleSystem.ts pooled crumbs and sparks
  services/AudioManager.ts synthesized WebAudio SFX (no audio files)
  services/StorageManager.ts validated localStorage persistence
  services/Platform.ts     Capacitor haptics, status bar, back button, app state
  ui/UIController.ts       menus, HUD, overlays
  ui/game.css              interface styling
tests/simulation.test.ts   headless simulation tests (Node)
tests/e2e.browser.mjs      browser E2E test (Playwright, headless Chromium)
capacitor.config.json      appId com.honeycombtrial.game, webDir dist
android/                   generated Capacitor Android project (portrait, dark bars)
```

## Run in the browser

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # produces dist/index.html
npm run test:sim     # headless simulation tests
# Browser E2E test (needs Playwright + Chromium installed somewhere):
#   npm i -D playwright && npx playwright install chromium
npm run test:e2e
```

## Android prerequisites

- JDK 17 or 21 (`java -version`)
- Android Studio, or the command-line SDK with platform 35 and build-tools installed
- `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) pointing at the SDK

## Debug APK

```bash
npm run android:debug
# equivalent to:
#   npm run build && npx cap sync android && cd android && ./gradlew assembleDebug
# Output: android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Or open the project in Android Studio with `npm run android:open` and press Run.

## Signed release APK / AAB

1. Create a keystore once:
   ```bash
   keytool -genkeypair -v -keystore android/honeycomb-release.jks \
     -keyalg RSA -keysize 2048 -validity 10000 -alias honeycomb
   ```
2. Create `android/keystore.properties`. It is git-ignored.
   ```
   storeFile=honeycomb-release.jks
   storePassword=YOUR_STORE_PASSWORD
   keyAlias=honeycomb
   keyPassword=YOUR_KEY_PASSWORD
   ```
3. Build:
   ```bash
   npm run android:release
   # android/app/build/outputs/apk/release/app-release.apk
   # android/app/build/outputs/bundle/release/app-release.aab
   ```
4. Before each store upload, increase `versionCode` and `versionName` in `android/app/build.gradle`.

## Offline

All code, styles and sounds are inlined into `dist/index.html`. Sounds are synthesized at runtime. Capacitor copies this file into `android/app/src/main/assets/public` and serves it locally, so the game runs in airplane mode.
