# Mobile OTA boot-crash — findings & next steps (2026-06-03)

**Status:** OTA updates onto the App Store binary (CF Studio v1.2.0, build 4,
bundle `com.un1tdublin.crm`) **crash on boot, 100% reproducible.** The app only
runs on its *embedded* (App-Store-bundled) JS. Recovery is
`eas update:roll-back-to-embedded --channel production` — production is sitting
on embedded now, so it's **stable but frozen** (no OTAs can land).

> **⚠️ CORRECTION (2026-06-03, in Claude Code).** The original version of this
> doc concluded the root cause was a **missing `expo-updates` config plugin in
> `plugins[]`**. That is **wrong** — see "Why the original diagnosis was wrong"
> below. After symbolicating against build 4's binary and re-reading the three
> `.ips` reports, the real cause is a **drift in the OTA publish pipeline** that
> ships Hermes bytecode incompatible with the binary's engine. The fix is
> **PR #295** (`mobile-ota-pipeline-hardening`) + a fresh build. This doc has
> been rewritten accordingly.

> **UPDATE 2 (2026-06-03).** The `runtimeVersion: 'fingerprint'` switch from
> PR #295 **broke the iOS build** — it fails the native "Configure expo-updates"
> Xcode phase (the phase recomputes the fingerprint in a restricted build
> sandbox and errors; EAS build `e02f3944`). Reverted to `sdkVersion` (build 4's
> proven config) to unblock the recovery build. **This does not reopen the boot
> crash:** the real fix is the publish pipeline using `npm ci` + a pinned
> toolchain so OTA bytecode matches the binary. `fingerprint` was only the
> belt-and-suspenders safety net and is now a tracked follow-up (re-attempt as a
> separate change; it needs the EAS-precomputed fingerprint wired into the build
> phase rather than recomputed in-sandbox).

---

## TL;DR conclusion (corrected)

The **OTA publish pipeline drifted from the binary's toolchain**, so the
over-the-air JS bundle was Hermes-compiled against a different React Native /
Hermes ABI than the engine baked into build 4. The mismatched bytecode loads,
then either corrupts memory during execution or trips a fatal that
`expo-updates`' error recovery can't recover from → boot-crash.

Two config facts let it ship:
- **`.github/workflows/eas-update.yml` installed deps with
  `npm install --legacy-peer-deps`** (ignores `package-lock.json`) on an
  unpinned **`eas-version: latest`**, whereas `eas build` (which made the
  binary) uses `npm ci`. → the two toolchains could resolve different trees.
- **`runtimeVersion: { policy: 'sdkVersion' }`** resolves to `exposdk:54.0.0`
  on *both* the binary and the update, so EAS considered them compatible and
  **served the mismatched bundle into the crash** instead of withholding it.

**No `app.config.js` `plugins[]` change is needed, and the binary is not
fundamentally broken** — it just got fed an incompatible bundle. The fix is to
make the publish pipeline match the build pipeline, then ship a fresh build.

---

## The evidence (three crash reports — NOT all identical)

The original doc claimed all three `.ips` were the same crash. They are not —
and the odd one out is the most informative.

| Report | Uptime to crash | Signal | Faulting thread | Site |
|---|---|---|---|---|
| `…235556` | ~0.3s | `SIGABRT` | `expo.controller.errorRecoveryQueue` | uncaught `NSException`, app-binary `+429892` |
| `…002008` | ~0.4s | `SIGABRT` | `expo.controller.errorRecoveryQueue` | uncaught `NSException`, app-binary `+429892` (identical) |
| `…235824` | **~71s** | **`SIGSEGV`** (EXC_BAD_ACCESS @ `0xb`) | `com.facebook.react.runtime.JavaScript` | **inside Hermes** — `JSObject::addOwnPropertyImpl` ← `arrayFrom` |

Two of the three are the launch-time `expo-updates` error-recovery abort. The
third is a **memory-corruption segfault deep inside the Hermes object model**,
on the bridgeless RuntimeScheduler — the classic fingerprint of a **Hermes /
JSI ABI mismatch** between the bundle and the engine. (In the two boot crashes,
the JS thread and Hermes GC threads are alive and idle — Hermes *did* come up
and start running the bundle, so this is not a "bundle failed to parse" crash.)

**Symbolication confirmed the binary identity.** The crash binary's UUID
(`34357e60-b70d-38a3-bbb1-342cc056a023`) is an exact match to **build 4** (EAS
build `f78c6f25…`, commit `ec82bcc`). EAS only exposes the stripped release
`.ipa`, so the four `+429892` frames can't be *named* without build 4's dSYM
(App Store Connect → Xcode Organizer → Download Debug Symbols) — but the
faulting queue `expo.controller.errorRecoveryQueue` already identifies them as
`expo-updates`' error-recovery code raising the uncaught exception. Naming them
is confirmatory only; it doesn't change the fix.

**No native-dependency change between build 4 and the crashing OTAs.** Build 4
was cut from `ec82bcc` (2026-05-29); between it and `main` only `.jsx` changed —
`mobile/package.json` was last touched 2026-05-19. So the binary and every OTA
bundle share the same declared native deps and lockfile; the **only** variable
is the toolchain that produced the over-the-air bytecode.

---

## Why the original diagnosis was wrong

The original doc theorised `expo-updates` was "not fully wired into the native
project" because its **config plugin is missing from `plugins[]`**. Two reasons
that's not it:

1. **This is a managed / CNG project** (no committed `ios/`), and
   `expo-updates` is configured from the top-level **`updates`** +
   **`runtimeVersion`** keys — its plugin is auto-applied at prebuild. The
   "Configure expo-updates" guide never has you add it to `plugins[]`.
2. **The crash reports show `expo-updates` actively running its error-recovery
   controller.** A module that wasn't wired into the binary couldn't do that.
   It downloads updates *and* runs recovery — it's fully present; it's the
   *bundle it's handed* that's incompatible.

The "B→C bundles still crashed after removing the top-level `expo-updates`
import" observation is consistent with the corrected diagnosis: the crash is
independent of bundle *content* because it's an ABI/toolchain problem, not a JS
problem.

---

## Current config (verified in repo)

`mobile/app.config.js`:
- ✅ `updates: { url: 'https://u.expo.dev/6256a4d8-...', enabled: true, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 }`
- `runtimeVersion: { policy: 'sdkVersion' }` — PR #295 changed this to `fingerprint`, but it broke the iOS "Configure expo-updates" build phase and was **reverted** (see UPDATE 2). `fingerprint` is the safety net, not the core fix; re-attempt it separately.
- `plugins[]`: `expo-router`, `expo-secure-store`, `expo-font`, `expo-notifications` — **`expo-updates` is correctly absent** (auto-applied; nothing to fix here).
- no `updates.codeSigningCertificate` (code signing never wired — see `mobile/docs/eas-update-code-signing.md`, task #37; worth doing in the next build while a rebuild is required anyway, but unrelated to this crash).

`.github/workflows/eas-update.yml` (the culprit, **fixed in PR #295**):
- ⚠️ installed with `npm install --legacy-peer-deps` → **`npm ci --legacy-peer-deps`**
  → **plain `npm ci`** (OTATREE.1, 2026-08-20). PR #295's fix was `npm install`
  → `npm ci`, which was the load-bearing half; the `--legacy-peer-deps` rider
  came along for the ride and was never the point. It then sat here for two
  months contradicting `store-release-one-app.md` §7, which forbids the flag
  against this lockfile. EAS Build installs the BINARY's tree with a plain
  `npm ci` (there is no `.npmrc` in the repo), so keeping the flag on the OTA
  side could only re-open the very tree divergence this document is about.
  Measured: the flag prunes 13 peer entries under npm 11.12.1 and 0 under
  npm 10.9.4.
- ⚠️ `eas-version: latest` → **pinned `18.9.1`**.
- ⚠️ auto-published on every push to `main` touching `mobile/**` or `shared/**` → **changed to manual `workflow_dispatch`** (a web-only `shared/**` change could re-brick the app, and nothing was boot-tested before prod).

`mobile/eas.json`: production profile `channel: production`; `cli.version` `">= 5.0.0"` → **pinned `18.9.1`** (build + update share one CLI).

---

## Next steps — the runbook to get OTA working again

**Do NOT publish another OTA to `production` until a fresh build ships and an
OTA is proven to boot on `preview`.**

1. **Merge PR #295** (`mobile-ota-pipeline-hardening`). This stops the
   auto-publish landmine and lands `npm ci` + pinned toolchain + `fingerprint`.

2. **Build a fresh production binary** from `main`:
   `eas build --platform ios --profile production`.
   - Built with the pinned `npm ci` toolchain so future OTAs are ABI-matched.
     (`runtimeVersion` is `sdkVersion` for now — `fingerprint` is a deferred
     follow-up; see UPDATE 2. Wire code signing / task #37 in a *later* build,
     not this one — one variable at a time.)

3. **Prove an OTA boots on `preview` first** — the gate that was skipped:
   - `eas build --platform ios --profile preview` (internal distribution),
     install on the test device.
   - `eas update --branch preview …`, open the app, confirm it **boots** and the
     More-screen footer shows the live OTA id. An RN bundle must be proven to
     boot on a real device before production.

4. **Submit the production build** to App Store Connect (Custom App / ABM) and
   distribute. Once it's installed, its fingerprint runtime version is what
   production OTAs must match.

5. **Publish the production OTA with a staged rollout %** (e.g. `--rollout 10`)
   so a bad bundle ever only reaches a fraction. Re-enable the (now
   manual-dispatch) workflow only once the above is proven, or keep publishing
   manually with `eas update --branch main --rollout …`.

`runtimeVersion` stays `sdkVersion` (= `exposdk:54.0.0`), so OTA targeting is
not binary-specific. That's acceptable now because the publish pipeline is
`npm ci`-pinned (bytecode matches the binary) and the workflow is manual, so a
human gates every publish — but it's why `fingerprint` is worth coming back to
(it would make targeting airtight). Once all staff are on the new build, the
old build-4 installs are gone and the ambiguity is moot.

---

## Hard-won process rules (carry these forward)

- **A mobile bundle must BOOT on a real device / preview build before it goes to
  production.** parse-clean + eslint-clean + mobile-parity-clean do NOT prove an
  RN bundle boots.
- **The OTA toolchain must match the binary's.** Publish updates with `npm ci`
  (lockfile-exact, same as `eas build`) and a **pinned** `eas-version` /
  `cli.version`. `npm install` + `eas-version: latest` can ship bytecode whose
  Hermes/JSI ABI doesn't match the engine in the binary — which is exactly what
  bricked boot here.
- **`runtimeVersion: 'fingerprint'`, not `'sdkVersion'`.** `sdkVersion` resolves
  identically across native changes within one SDK, so EAS serves incompatible
  updates into a crash. `fingerprint` withholds them.
- **When an OTA crashes on boot, read the `.ips` faulting queue first, then
  symbolicate.** `expo.controller.errorRecoveryQueue` = expo-updates couldn't
  launch the update; a `SIGSEGV` inside `hermes::vm::*` = ABI mismatch. Both
  point at the binary↔bundle relationship, not your JS.
- **`roll-back-to-embedded` is the recovery** when an OTA bricks boot.

## Already on main (usable once OTA works again)
- `mobile/lib/build-info.js` — version/OTA-id footer (lazy + guarded
  `expo-updates` use).
- `mobile/components/RootErrorBoundary.jsx` — render-crash screen with a "Check
  for update" self-heal button.
- Note: an error boundary catches **render** errors only — a native
  OTA-launch abort happens before render and can't be caught by it.
