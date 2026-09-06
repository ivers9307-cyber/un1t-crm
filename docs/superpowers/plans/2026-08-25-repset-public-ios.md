# Repset public iOS app — phased plan

> Companion to `docs/superpowers/specs/2026-08-25-repset-public-ios-design.md`.
> This program is operator-heavy: phases interleave Richard's Apple-side clicks
> with code PRs. Code tasks follow the house TDD + review discipline; operator
> steps are exact click-paths.

## Telemetry amendment (supersedes the spec's `bundle_id` column)

The spec proposed reporting the bundle id. That cannot be read honestly from
JS: `Constants.expoConfig` reflects the OTA-delivered config (after the
config PR, OLD binaries would report the NEW bundle id), and
`expo-application` (the native source of truth) is not installed — adding it
is a native change, forbidden during the freeze window. The honest signal
that needs nothing new is **`Constants.nativeBuildVersion`** (expo-constants,
already a dependency): it reads the BINARY's Info.plist, untouched by OTAs.
`appVersionSource: 'remote'` means EAS owns a monotonically increasing build
counter, so: record the old app's FINAL iOS build number **N** (from EAS /
ASC at Phase-2 time); any iOS row reporting build > N is the new app. The
column is `native_build` (text), and the old-vs-new classification lives in
the report query, not the client.

## Phase 1 — parallel start (now)

**Task 1A (code, me): migration telemetry.**
- Forward-only migration: `device_tokens.native_build text` (nullable).
- `POST /api/mobile/device-tokens` accepts + stores it (zod optional; spread
  only when present, the geofence_permission idiom).
- `mobile/lib/push-register.js` reports `Constants.nativeBuildVersion` in
  both entry points.
- `/settings/notifications/health` shows it per device (small column), and
  the staff-devices lib gains a pure `classifyBinary(platform, nativeBuild,
  lastOldIosBuild)` for the migration report (threshold N configurable —
  wired in Phase 4 when N is known; until then the column just displays).
- Tests per house rules; migration applied via MCP before merge; OTA on
  merge (mobile/lib is a bundle path) — the OLD app starts reporting its
  build number too, which is exactly what makes the later report work.

**Step 1B (operator, Richard): create the Apple identity.**
1. developer.apple.com → Certificates, Identifiers & Profiles →
   Identifiers → + → App IDs → App. Description "Repset", bundle ID
   **explicit** `ie.repset.app`. Capabilities: tick **HealthKit** and
   **Push Notifications** now (eas credentials re-syncs later, but ticking
   here avoids the un-tick trap). Register.
2. appstoreconnect.apple.com → My Apps → + → New App. Platform iOS, name
   **Repset** (if taken → stop, we pick a fallback), primary language, the
   `ie.repset.app` bundle id, SKU e.g. `repset-ios-public`.
3. Open the new app record → App Information → note the **Apple ID**
   (numeric, ~10 digits) → give it to me. That is the new `ascAppId`.

## Phase 2 — identity switch (after 1B's ascAppId)

**Task 2A (code, me): the config PR.**
- `mobile/app.config.js`: `ios.bundleIdentifier: 'ie.repset.app'` with the
  BUNDLE-ID-RESET history comment extended (Apple's unlisted one-way rule;
  old record 6770890839 serves the installed base until sunset). Android
  package comment records the deliberate lockstep break.
- `mobile/eas.json`: `submit.production.ios.ascAppId` → the new id.
- `runtimeVersion` and `version` untouched. Merge publishes a
  content-neutral OTA (expected). After merge, old-app iOS binaries can no
  longer be built from main (by design).
- Record the old app's final iOS build number **N** in the PR body (read
  from EAS build list / ASC) — Phase 4 wires it into the report.

**Step 2B (operator): credentials + build + submit.**
From a fresh current-main tree (capability-sync rule):
```
cd ~/code/un1t-crm && git fetch origin main && git checkout -B repset-ios origin/main
cd mobile && npm ci
npx eas-cli credentials        # iOS → production → set up for ie.repset.app
npx eas-cli build --platform ios --profile production
export EXPO_APPLE_ID=<your Apple ID>   # eas.json carries no appleId (EAS-SECRET.1); unset → the CLI prompts
npx eas-cli submit --platform ios --latest
```
`eas credentials` mints the provisioning profile + distribution cert reuse
for the new App ID; verify HealthKit shows ticked. APNs is team-wide — no
push work.

## Phase 3 — App Review submission (operator + my drafts)

1. (Me) Draft `mobile/docs/asc-review-notes-repset.md`: what the app is,
   both surfaces (staff CRM + member fitness), the reviewer demo-login flow,
   permission rationale (location = staff attendance/on-site controls,
   HealthKit = member fitness), no-public-signup explanation.
2. (Richard) Fresh `REVIEW_LOGIN_CODE`: generate a new random code, set it
   in the Vercel project that serves the mobile review-login route — VERIFY
   first which deployment the merged app's review login calls (the July
   hardening lives in champ-app; the one-app merge may have moved it —
   Task 1A's implementer confirms and the notes doc states it). Never reuse
   a prior code (public repo history).
3. (Richard) ASC metadata: screenshots from `mobile/asc-screenshots/`
   (iPad: use the "use iPhone screenshots" toggle if 13" sets are missing),
   privacy questionnaire copied from the old record's answers, age rating,
   support URL. Attach the review notes + demo credentials. Submit.
4. Review cycle: rejections come back as notes — fix, resubmit; time cost
   only.

## Phase 4 — after approval (separate PRs, not started now)

- **Nudge PR**: operator-toggled banner in the OLD app only — gated on
  `Platform.OS === 'ios' && Number(nativeBuild) <= N` — linking the App
  Store page. Customer-facing copy operator-editable per the house rule.
- **Migration report**: wire N into `classifyBinary`; health page gains an
  old-app/new-app rollup so "who hasn't moved" is a number.
- **Kiosk re-pair**: runbook + checklist per studio iPad (pairing is
  per-app storage).
- **Sunset**: when the report says done — remove the old app from unlisted
  distribution in ASC; lift the native-change freeze (Expo SDK upgrade
  unblocks).

## Standing constraints while this runs

- 🔴 **No native changes / no `runtimeVersion` bump** until Phase-4 sunset.
- Android continues its own release life (2.3.1 in Play review) unaffected.
