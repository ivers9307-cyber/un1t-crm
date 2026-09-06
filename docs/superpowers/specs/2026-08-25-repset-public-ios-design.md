# Repset public iOS app — design

**Date:** 2026-08-25
**Status:** Decisions locked by Richard (conversation, 25 Aug) — pending review of this written spec
**Why:** Apple's unlisted-distribution rule is one-way: the current app record
(`com.un1tdublin.crm`, ascAppId 6770890839) can never become publicly listed.
Apple's required path is a NEW app record — and a bundle ID binds permanently
to its record, so the public app needs a new bundle ID.

## Decisions (locked)

1. **New iOS bundle ID: `ie.repset.app`.** Public App Store name:
   **Repset Fitness** ("Repset" was taken — fallback exercised 25 Aug). New
   record ascAppId **6805082306**; old-app final iOS build number **N = 24**.
2. **Same Apple developer account** (team 535XMCT5PY). No entity change.
3. **Android is untouched.** The iOS/Android bundle-lockstep convention
   (BUNDLE-ID-RESET comment) is DELIBERATELY broken here: changing the
   Android package would create a brand-new Play app — real cost, zero
   benefit. `com.un1tdublin.crm` stays on Play. The config comments must
   record the break and why.
4. **One OTA lane serves all three binaries.** The new iOS app is built from
   the same EAS project, build profile, channel and `runtimeVersion` (2.3.0)
   as the old iOS app and Android — one `eas update` publish reaches the old
   unlisted app, the new public app, and Android alike. No forked lanes.

## The transition model

- **The old unlisted app keeps working.** Its installed base keeps receiving
  OTAs on the shared lane. No user is broken on day one.
- **The old app stays rebuildable** (amended 25 Aug, Richard's question):
  unlisted status is one-way for LISTING only — the old record still takes
  binary updates through review. The `production-legacy` EAS profile
  (env-switched bundleIdentifier, old ascAppId) keeps that door open, so
  there is NO migration deadline. The cost: every future native change
  (runtimeVersion bump) must build + submit BOTH apps until sunset — two
  builds, two reviews, one shared lane. Sunset becomes an operational
  choice (stop paying the double-build tax), not a forcing function.
- **Migration is marketing, not engineering:** same backend, same accounts —
  a user moves by installing the new app and signing in. Per-app device
  state does NOT carry and each affected user redoes it:
  - Sign-in (session is per-app keychain) + Face ID re-enrol.
  - Location permission re-grant (the attendance gate / enable-location card
    fire again — both already handle first-run correctly).
  - Push token re-registers (a NEW `device_tokens` row per device+app is
    correct — the device_key is per-install).
  - 🔴 **Studio kiosk iPads must be RE-PAIRED** (pairing token is per-app
    SecureStore). The sunset checklist must include re-pairing every kiosk.
- **Nudge, then sunset:** after the new app is approved and stable, a small
  PR adds an operator-controlled nudge in the OLD app only (gated so the new
  app never shows it) linking to the App Store page. Once the fleet has
  moved (measured via `device_tokens.app_version` + bundle — see Telemetry),
  the old app is removed from unlisted distribution in ASC.

## Mechanics

### Config change (one PR)

- `mobile/app.config.js`: `ios.bundleIdentifier` → `'ie.repset.app'`, with a
  comment continuing the BUNDLE-ID-RESET history (why: Apple's unlisted
  one-way rule; old record 6770890839 remains for the installed base).
  Android `package` comment updated to record the deliberate lockstep break.
- `mobile/eas.json`: `submit.production.ios.ascAppId` → the NEW app record's
  id (known only after the record is created — the PR lands after the
  operator step, or with a placeholder swap).
- `runtimeVersion` **unchanged** (2.3.0). `version` unchanged (2.3.1 carries
  over; ASC accepts any starting version).
- ⚠️ `app.config.js` is an OTA publish path → the merge publishes a
  content-neutral update group. Expected.
- ⚠️ After this merges, a rebuild of the OLD iOS app is impossible from main
  (by design — see transition model). Android builds are unaffected (its
  identity is separate).

### Apple-side (operator, with exact steps in the plan)

1. Developer portal → Identifiers → register `ie.repset.app`.
2. ASC → New app → claim name "Repset", bundle `ie.repset.app`. Record the
   new ascAppId.
3. `eas credentials` (from a current-main tree — the HealthKit
   capability-sync rule) to mint provisioning for the new App ID and
   re-tick HealthKit. APNs .p8 is team-wide — push needs nothing new.
4. Metadata: screenshots reuse (`mobile/asc-screenshots/`), privacy
   questionnaire and age rating copy from the old record,
   `ITSAppUsesNonExemptEncryption` already declared in config.
5. Review notes + demo login: the hardened review-login flow exists
   (`REVIEW_LOGIN_CODE` env, per-IP throttled, member-only reviewer
   account) — set a FRESH code for this submission (never reuse a burned
   one) and reference it in the notes. Full app review will exercise the
   merged staff+member app; notes must explain both surfaces.
6. Build + submit: `eas build --platform ios --profile production` then
   `eas submit --platform ios --latest` (ascAppId updated first; export
   `EXPO_APPLE_ID=<your Apple ID>` first too — `eas.json` carries no
   `appleId` since EAS-SECRET.1, and without the env var the CLI prompts).

### Telemetry for the migration

`device_tokens` carries `app_version` but nothing distinguishing the two
iOS binaries — and the bundle id CANNOT be read honestly from JS
(`Constants.expoConfig` reflects the OTA-delivered config, so old binaries
would lie post-switch; `expo-application` is a native add, forbidden in the
freeze window). The honest, dependency-free signal is
`Constants.nativeBuildVersion` (binary Info.plist, OTA-immune): a new
`native_build` column + the known final old-app build number N classifies
every iOS row in the report query. (Amended during planning — see the
plan's telemetry note.)

## Out of scope

- Any Android change. Any backend/auth change. App name/branding work
  beyond claiming "Repset". The nudge/sunset PR ships AFTER approval as its
  own small change. Entity/account migration (explicitly decided against).

## Risks

- **App name "Repset" unavailable** on the App Store → fallback naming
  decision needed from Richard (e.g. "Repset Fitness").
- **Full App Review on the merged app** — the unlisted review was lighter.
  Mitigations: review-login demo flow, thorough notes, screenshots current.
  A rejection costs time, not architecture.
- **The double-build tax** (every native change = two builds + two review
  submissions until sunset) — accepted 25 Aug in exchange for removing the
  migration deadline entirely; native changes here are rare.
