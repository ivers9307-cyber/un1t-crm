# Mobile OTA boot-crash — findings & next steps (2026-06-03)

**Status:** OTA updates onto the current App Store binary (CF Studio v1.2.0,
build 4, bundle `com.un1tdublin.crm`) **crash on boot, 100% reproducible.**
The app only runs on its *embedded* (App-Store-bundled) JS. Recovery is
`eas update:roll-back-to-embedded --channel production`.

This doc is the handoff brief: what we proved, the root-cause conclusion, and
the concrete next steps. Pick it up in Claude Code (which can run a real
`eas build` / `next build`, unlike the sandbox this was diagnosed in).

---

## TL;DR conclusion

**The binary, not the JS, is broken for OTA.** Every OTA-delivered bundle —
regardless of its JS contents — aborts at launch inside `expo-updates`'
error-recovery controller. No JavaScript change can fix this. **The fix is a
new, correctly-configured native build + App Store submission.** Until that
ships, do **not** publish OTA updates to `production` — they brick the app.

Strong likelihood (to be confirmed on the next build): `expo-updates` is
**not fully wired into the native project** in build 4 — specifically the
`expo-updates` config plugin is **missing from `plugins[]`** in
`app.config.js`. The `updates` block exists, so OTAs *download*, but the
native runtime can't *launch* a downloaded bundle → abort.

---

## The evidence (three crash reports)

All three `.ips` reports — across two different JS bundles — are the **same
crash**:

| Field | Value (identical across all 3) |
|---|---|
| Triggered thread queue | `expo.controller.errorRecoveryQueue` |
| Signal / termination | `SIGABRT` · `Abort trap: 6` · `abort() called` |
| Top frames | `objc_exception_throw` → `-[NSException raise]` → app binary (image index 0, `imageOffset 429892`) |
| App version / build | 1.2.0 / build 4 |

Report timeline:
1. **Bundle A** — the "permissions structure" OTA. Crashed.
2. **Bundle B** — the OTA-safety bundle that imported `expo-updates` at module
   top. Crashed (same signature). → led to the (wrong) theory that the
   top-level import was the cause.
3. **Bundle C** — the hardened bundle with **no top-level `expo-updates`
   import** (lazy `require` inside try/catch). **Crashed identically.**

**The decisive fact:** removing all `expo-updates`-at-launch JS (B→C) did not
change the crash at all. The exception is thrown by the native
`expo-updates` error-recovery controller before/independent of our JS. So the
cause is the native OTA runtime in the binary, not any JavaScript.

`expo.controller.errorRecoveryQueue` firing = expo-updates tried to launch an
OTA bundle, the launch failed at the native layer, and its recovery path
itself aborts (rather than falling back to embedded). That is a
build-configuration failure, not application code.

---

## Current config (verified in repo at this commit)

`mobile/app.config.js`:
- ✅ `updates: { url: 'https://u.expo.dev/6256a4d8-...', enabled: true, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 }`
- ✅ `runtimeVersion: { policy: 'sdkVersion' }` (SDK 54; `expo: ^54.0.34`)
- ❌ **`plugins[]` does NOT include `'expo-updates'`** — only `expo-router`,
  `expo-secure-store`, `expo-font`, `expo-notifications`.
- ❌ no `updates.codeSigningCertificate` / `codeSigningMetadata` (code signing
  never wired — see `mobile/docs/eas-update-code-signing.md`, task #37).
- `expo-updates` IS in `package.json` (`~29.0.17`) and OTAs download — but a
  package being installed ≠ its config plugin being applied at build time.

`mobile/eas.json`: production profile `channel: production`, `autoIncrement:
true`, `appVersionSource: remote`.

`expo-updates` is imported by **no app code** today (after the hardening,
it's only lazy-required in `lib/build-info.js` + `components/
RootErrorBoundary.jsx`). That it was otherwise unused was the early red flag.

---

## Root-cause hypothesis to confirm on the next build

`fallbackToCacheTimeout: 0` means "launch instantly from cache, apply the new
bundle next time." Combined with a native runtime that can't successfully
launch the downloaded bundle, the error-recovery controller trips and aborts
instead of degrading to embedded. The most common reason the native side
can't launch an OTA while the binary's own embedded JS runs fine is an
**incomplete `expo-updates` native install** — classically the **missing
config plugin**, which is exactly what's absent from `plugins[]`.

This needs confirming by someone who can run a build (Claude Code), because
the sandbox these notes were written in cannot run `eas build`.

---

## Next steps (for Claude Code)

**Do NOT push another OTA to production to "test a fix" — it will crash the
device. Diagnose on a build/preview channel only.**

1. **Confirm binary-vs-JS once more, cheaply (optional, already strongly
   evidenced):** `eas update:republish` a pre-OTA-safety bundle to a
   *preview* channel + a preview build; if it also crashes, binary confirmed.

2. **Fix the native OTA config:**
   - Add the **`expo-updates` config plugin** to `plugins[]` in
     `app.config.js` (and review whether `expo-updates` needs any extra
     native config for SDK 54 — check `npx expo-doctor` + Expo's
     "Configure expo-updates" guide).
   - While here, **complete code signing** (task #37 /
     `eas-update-code-signing.md`) since a new native build is required
     anyway — do both in one build so devices start verifying signed updates.

3. **Build + verify on PREVIEW first:**
   - `eas build --profile preview` (internal distribution), install on the
     test device.
   - Publish an OTA to the **preview** channel and confirm it **boots** (and
     that the new More-screen footer shows `v1.2.0 · OTA <id> · preview`,
     proving the bundle is live). This is the gate that was skipped — an RN
     bundle must be proven to BOOT on a real device before production.

4. **Only then production:** `eas build --profile production` → submit to App
   Store → once approved + installed, OTA to `production` works. The
   build-info footer + RootErrorBoundary (already on main) become genuinely
   useful on a binary that can run updates.

5. **Add a staged rollout** to future `eas update` (rollout % so a bad bundle
   hits a fraction, not 100%).

---

## Hard-won process rules (carry these forward)

- **A mobile bundle must BOOT on a real device/preview build before it goes to
  production.** parse-clean + eslint-clean + mobile-parity-clean do NOT prove
  an RN bundle boots — they didn't here, twice.
- **When an OTA crashes on boot and the `.ips` is unsymbolicated, isolate
  binary-vs-JS FIRST** — republish a known-good *older* bundle (no recent
  code). If it also crashes → binary; stop editing JS. This one step would
  have avoided two production boot-crashes here.
- **expo-updates being installed ≠ configured.** Check `plugins[]` and run
  `expo-doctor`; "OTA downloads" is not evidence "OTA launches."
- **`roll-back-to-embedded` is the recovery** when an OTA bricks boot;
  `eas update:rollback` is interactive (no `--branch` flag in eas-cli v20).

## Already on main (usable once the binary can run OTA)
- `mobile/lib/build-info.js` — version/OTA-id footer (hardened: no top-level
  expo-updates import; lazy + guarded).
- `mobile/components/RootErrorBoundary.jsx` — render-crash screen with
  splash-hide on catch + a "Check for update" self-heal button.
- Note: an error boundary catches **render** errors only — a native
  OTA-launch abort like this one happens before render and **cannot** be
  caught by it. It helps future JS crashes, not this binary issue.
