# Repset loader — branded loading animation (LOADER)

**Date:** 2026-07-31 · **Status:** APPROVED (Richard picked option B, 2026-07-31)
**Origin:** "Loading screen is a bit boring can we have an animation" — the white screen with a stock `ActivityIndicator` seen on every app open.

## 1. What it replaces

The screen in question is **`mobile/components/LockScreen.jsx` in its `checking` state** (biometric-lock overlay, rendered while the stored lock preference is read). Today: `bg-un1t-bg` (**white** — the mobile palette uses inverted token names) + bold "Repset" + a default `ActivityIndicator`.

Two other stock spinners share the same moment and get the same treatment: the auth-bootstrap wait and the OTA-update wait.

## 2. Chosen design — "rep counter" (option B)

The brand mark animated: three tally bars light **one at a time** like counting reps, then the diagonal volt strike lands across them to finish the set. Loop ≈2.1 s with a brief hold before repeating.

- Bars: `#F2F0EB` (bone), dimmed to ~16% opacity when "unlit".
- Volt strike: `#D6F84C`, fades + scales in at ~50% of the cycle.
- Surface: **ink `#131316`** — the same background as `splash.png`, so the native splash and this screen become one continuous moment instead of splash → white flash → app.

## 3. Hard constraints

- **`react-native-svg` is NOT installed** and must not be added — it is a native module, so it would require a new store binary. The mark is built from plain `View`s: three rounded bars + one rotated rounded bar for the strike. Verified 2026-07-31.
- **Reanimated 4.5.0 + react-native-worklets 0.10.0 are already installed**, so the animation is JS-only and **ships over OTA** on the 2.2.0 lane. No EAS build, no store release.
- **Respect `AccessibilityInfo.isReduceMotionEnabled()`** — when reduce-motion is on, render the mark fully lit and static (no loop). Apple expects this, and this screen is seen many times a day.
- No new dependencies of any kind.

## 4. Component

`mobile/components/RepsetLoader.jsx`

```
<RepsetLoader size={96} label?="Checking…" />
```

- Self-contained: owns its own Reanimated shared values and loop; no props required beyond optional `size` and `label`.
- Cancels its animation on unmount (no orphaned loops).
- Renders the wordmark text below the mark only when `label` is passed.
- Accessible: `accessibilityRole="progressbar"`, `accessibilityLabel` defaulting to "Loading".

## 5. Call sites

1. **`LockScreen.jsx`** — `checking` state: ink background, `<RepsetLoader />` replacing the `ActivityIndicator`. The unlocked state keeps its existing layout but moves to the ink surface for consistency.
2. **Auth bootstrap** — wherever the app waits on the session before the tab tree renders.
3. **OTA update wait** — the same, if it renders a visible spinner.

Call sites 2 and 3 are "use it if there is a visible spinner in that moment"; if a call site turns out not to render one, leave it alone and say so.

## 6. Out of scope

Lottie or any animation library; animating the native splash screen itself (that is a static asset by platform design); rebranding any other screen; changing the light theme anywhere else in the app.

## 7. Verification

No unit-test infrastructure exists for RN components in this repo, so: `check:mobile-imports`, `check:mobile-parity`, `lint`, and a **device/simulator visual check** before merge (the animation is the deliverable — it must be seen, not just compiled). Reduce-motion path checked by toggling the OS setting.
