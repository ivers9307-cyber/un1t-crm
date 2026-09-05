# un1t-crm — mobile app (Expo / React Native)

> Mobile reference extracted from the root `CLAUDE.md` (2026-06-25). The app lives in `mobile/`. Linked from the CLAUDE.md "Deep reference" index.

## Mobile app (`mobile/`)

The iOS app is an Expo (React Native) project living in `mobile/` as a sibling to `src/`. Single repo, separate `package.json` (Expo can't share Next's deps). Cross-platform constants/helpers come from the repo-root `shared/` folder, consumed as the `shared` file: package (`"shared": "file:../shared"` in `mobile/package.json`, imported as `'shared/<module>'`) — mobile never imports `src/`. NativeWind re-exports the same `un1t-*` Tailwind tokens used on web.

### First-time setup

```bash
cd mobile
cp .env.example .env       # then fill in EXPO_PUBLIC_SUPABASE_URL,
                           #   EXPO_PUBLIC_SUPABASE_ANON_KEY,
                           #   EXPO_PUBLIC_API_BASE_URL
npm install
npx expo start             # → press i for iOS simulator, scan the QR with
                           #   Expo Go on a real device, or w for web
```

The Supabase URL + anon key are the same values used by the web app (in `un1t-crm/.env.local`). The mobile app authenticates via Supabase JS with `expo-secure-store` for session persistence; the access token is sent as `Authorization: Bearer <jwt>` to any `/api/*` route the app calls. The `src/proxy.js` at the web layer recognises three Bearer-token shapes — `CRM_API_KEY` (n8n), Supabase JWT (mobile), or no Bearer + cookies (web) — see the "Mobile app" architectural pattern note above.

### Routing model

`expo-router` uses file-based routing under `mobile/app/`:

| Path | Purpose |
|------|---------|
| `app/_layout.jsx` | Root — wraps in SafeAreaProvider + AuthProvider; keeps splash screen up while auth loads. |
| `app/index.jsx` | Decides session → redirect to `(tabs)` or `(auth)/login`. |
| `app/(auth)/login.jsx` | Email/password sign-in via `signInWithPassword`. |
| `app/(tabs)/_layout.jsx` | Bottom tabs. Tabs are conditionally enabled by `permissions.mobile.<key>` — `href: null` removes a tab. Registers Expo push token if `permissions.mobile.push_notifications` is on. |
| `app/(tabs)/index.jsx` | Home — greeting, active-location header, navigation cards based on enabled mobile features. |
| `app/(tabs)/schedule.jsx` | Week strip + day picker + shifts list, time-off banner, long-press to post for swap, floating Request Time Off button. |
| `app/(tabs)/pipeline.jsx` | Stage strip with deal counts + open-deal list. Tap a deal to open `app/pipeline/[dealId].jsx` — contact card, stage move, log activity, mark won/lost, timeline. |
| `app/(tabs)/whatsapp.jsx` | Messages inbox — unified WhatsApp + Instagram + Email queue (client-side merge, channel glyphs, queue chips mirroring the web unified inbox incl. the Approval pill; route + permission key stay `whatsapp`). Tap to open the per-channel thread: `app/whatsapp/[conversationId].jsx` (iMessage-style bubbles, text composer, template picker for closed-window sends), `app/instagram/[conversationId].jsx`, or `app/email/[conversationId].jsx` (subject strip, text-only bubbles, Postmark reply composer — rides `/api/email/*`, same posture as IG). The tab badge polls `/api/whatsapp/unread-count` (SIDEBAR-BADGES.2 needs-action semantics). |
| `app/schedule/time-off-new.jsx` | Modal — type segmented control, date stepper, reason field. |
| `app/(tabs)/more.jsx` | iOS-style settings list — account, location switcher, sign out. |

### Per-user mobile feature flags

Stored under `profile_locations.permissions.mobile.<key>` per assignment (mig 058 — was profile-wide on `profiles.permissions.mobile` until mig 058 moved it). JSONB allows arbitrary keys, so adding a new feature is just an entry in `MOBILE_PERMISSIONS` and `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE` inside **`shared/permissions.js`** — the single source of truth imported by both `src/components/StaffForm.jsx` (web admin) and `mobile/lib/permissions.js` (iOS app). Adding the entry there auto-flows everywhere; `npm run check:mobile-parity` enforces that web and mobile permission sets stay aligned. Read on mobile via `lib/permissions.js → canMobile(profile, key, activeLocation)`. The `activeLocation` arg now carries `permissions` (the active assignment's blob, surfaced by `/api/mobile/me`); `canMobile` reads it at tier 2, falls through to `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[profile.role]` at tier 3. Switching active location flips both the gate and the per-location override since the mobile app re-fetches `/api/mobile/me`.

### Push notifications

Tokens are registered server-side in the `device_tokens` table (migration 023) via `POST /api/mobile/device-tokens`. `src/lib/push.js` fans out via Expo Push Service, honouring both the master `permissions.mobile.push_notifications` switch and per-category `notify_<category>` flags (`time_off`, `schedule`, `swap`, `lead`, `whatsapp`). `DeviceNotRegistered` responses from Expo automatically prune stale tokens — no cron needed.

For production push (TestFlight / App Store), an Apple Developer account ($99/yr) is required: `eas credentials` configures APNs, then `eas build --platform ios` produces a `.ipa`. During Expo Go development, Expo proxies to its own push channel — no Apple credentials needed.

### Deployment (mobile)

Two distinct pipelines — **EAS Update** for JS-only changes (over-the-air, no review) and **EAS Build** for native binaries (required for App Store / TestFlight / Custom App via ABM).

**EAS Update (JS only).** Auto-publishes via `.github/workflows/eas-update.yml` on every push to `main` that touches a path genuinely entering the Metro bundle, or `shared/**`. The trigger is an **allowlist** (`mobile/app|components|lib|assets/**`, `index.js`, the `app.config`/`babel`/`metro`/`tailwind` configs, `global.css`, `package.json`+lock) — **not** `mobile/**`: non-bundle paths (`docs/`, `asc-screenshots/`, `certs/`, `scripts/`, `eas.json`, `.eas/`, `.audit-allowlist.json`) are inert, after `mobile/**`-with-negations twice published a no-op update group on top of a live ramp. Adding a directory under `mobile/` means registering it in the trigger or in `NON_BUNDLE` (`scripts/check-ota-trigger-paths.mjs`); `check:ota-paths` gates it, and every publish starts at **10%** with a manual ramp (`mobile/docs/ota-rollout.md`). Also manually triggerable (`workflow_dispatch` / `gh workflow run eas-update.yml`). Publishes to **branch `main`**; the **`production` channel is mapped to branch `main`** (`eas channel:edit production --branch main`) so the App Store build receives it — if a build ever stops seeing updates, check that mapping first (`eas channel:view production`). Ships only the JS bundle; existing installs pick it up on next launch. Use for any change that doesn't add/remove a native module or change permissions, plugins, icons, or bundle identifier. ~30 sec to publish, no Apple review.

**Two OTA-publish gotchas baked into the pipeline (2026-06, both bit hard):** (1) `app.config.js` must keep `platforms: ['ios', 'android']` — `eas update` runs `expo export --platform=all`, and without that array Expo defaults to include `web`, tries to bundle it, and **the publish crashes** because `react-native-web` isn't installed (the silent reason no OTA reached devices for weeks). (2) `runtimeVersion` is an **explicit string** (currently `2.0.0`; it began as the `sdkVersion` policy) — an update only reaches binaries on the **same** lane, and the string must be bumped on every native change. The `fingerprint` policy is the better long-term choice but broke the iOS "Configure expo-updates" build phase (reverted, PR #296) — re-attempt separately. Publish toolchain is pinned (`npm ci` + eas-cli `18.9.1`) so OTA Hermes bytecode matches the binary.

**EAS Build (native binary).** Required when `app.config.js` plugins / `package.json` native deps / icons / bundle id / version change. Three ways to trigger:

1. **EAS Workflow (recommended)** — `mobile/.eas/workflows/release.yml` defines a manually-triggered "Release" workflow that builds AND submits BOTH platforms in parallel: iOS to App Store Connect (Custom App / ABM) and Android to Google Play Internal Testing track. Trigger from expo.dev → Workflows → Run. Single click, no laptop needed, total wall-clock ~25 min (slower of the two builds). Each platform's submit job depends only on its own build so a failure on one doesn't block the other. This is the steady-state path for shipping new native releases.
2. **CLI** — from `mobile/`:
   ```bash
   export EXPO_APPLE_ID=<your Apple ID>   # not in eas.json (public repo, EAS-SECRET.1); without it `eas submit` prompts
   eas build --platform ios --profile production
   eas submit --platform ios --profile production --latest
   eas build --platform android --profile production
   eas submit --platform android --profile production --latest
   ```
   Used for the very first build per platform (because credentials need interactive setup — Distribution Cert for iOS, upload keystore for Android) and as a fallback if EAS Workflows is unavailable.
3. **expo.dev web UI ad-hoc** — Project → Builds → "Build". Equivalent to the CLI route but no laptop needed. First time, link GitHub at Project settings → GitHub with **Base directory = `mobile`** (this is a monorepo; without the base dir EAS tries to build the Next.js app and fails).

The Vercel-deployed `crm.un1tdublin.com` is the API base URL the mobile app calls — no separate backend deploy.

#### Distribution: closed-track only, no public stores

UN1T CRM is an internal staff tool, not a consumer product, so neither store version is publicly listed:

- **iOS**: ships as a **Custom App for Business or Education** via Apple Business Manager. Distribution is gated by ABM organisation membership.
- **Android**: ships to the **Internal Testing track** on Google Play Console. Up to 100 testers managed by email lists; testers click a "Become a tester" link, app appears in their Play Store. App is not searchable publicly.

The two platforms have parallel-but-not-identical setup paths. iOS specifics first, then Android.

##### iOS — Custom App via Apple Business Manager

**One-time prerequisites (already done as of 2026-05):**
- Apple Developer Program membership (annual fee).
- Apple Business Manager account for Champ Fitness Ltd, trading as UN1T Dublin (requires D-U-N-S; free) — the settled legal entity (SAAS4-W0.2). LEGALENT.1 corrected the entity named here; confirm the ABM record itself matches before the next enrolment step.
- Bundle ID `com.un1tdublin.crm` registered at developer.apple.com → Identifiers, with **Push Notifications** capability ticked. (`BUNDLE-ID-RESET`: the original `com.un1tdublin.crmmobileios` was submitted for review then deleted; Apple permanently reserves submitted bundle IDs to the team, so it can't be reused — hence the switch to `com.un1tdublin.crm`.)
- App Store Connect record created (ID `6770890839`, app name **Repset** (renamed from "CF Studio" with REBRAND.2, 2026-07-27) — the `REBRAND.1` record; the previous UN1T-CRM record `6766947870` was removed), distribution method set to **Custom App for Business or Education**, ABM org listed as recipient.
- Privacy policy live at `crm.un1tdublin.com/privacy` (page lives at `src/app/privacy/page.js`).
- App icons at `mobile/assets/icon.png` (iOS, 1024×1024 RGB no alpha), `adaptive-icon.png` (Android), `notification-icon.png`, `splash.png` — generated as a black/white wordmark using **Poppins Bold** as a SIL-licensed stand-in for NEXA.
- `mobile/eas.json` `submit.production.ios` populated: `appleTeamId` (`535XMCT5PY`), `ascAppId` (`6770890839`). **No `appleId`** — the repo is public, so the Apple ID travels as the `EXPO_APPLE_ID` env var at submit time (eas.json schema: "Your Apple ID username (you can also set the `EXPO_APPLE_ID` env variable)"). Export it in the shell (or your shell profile / an EAS environment variable) before `eas submit`; without it the CLI prompts for it interactively, and `--non-interactive` errors. Only the local app-specific-password path reads it — the EAS Workflow submit job authenticates with the ASC API key held by the EAS credentials service and needs neither. `tests/fixture-pii.test.js` fails if the address comes back.

**Per-version submission flow:**
1. Bump `version` in `mobile/app.config.js` (semver). Use the helper:
   ```bash
   cd mobile
   npm run version:patch    # 0.1.0 -> 0.1.1   (bug fix)
   npm run version:minor    # 0.1.0 -> 0.2.0   (new feature)
   npm run version:major    # 0.1.0 -> 1.0.0   (breaking / milestone)
   ```
   The script (`mobile/scripts/bump-version.mjs`) edits `app.config.js`, commits with a descriptive message, and tags the commit `mobile-vX.Y.Z`. **It does not push** — pass `--push` when you mean to, or run `git push --follow-tags` yourself. Add `--no-commit` to stage manually. EAS Build auto-increments `buildNumber` on every native build, so we only manage the marketing version here.

   > ⚠️ **Pushing this commit to `main` publishes an OTA.** `mobile/app.config.js` is in `eas-update.yml`'s publish allowlist (it carries `runtimeVersion`), so the bump commit mints an update group at **10%** — and `version` and `runtimeVersion` are **two separate literals** (`app.config.js:110` and `:375`). Bumping `version` to 2.3.1 leaves the runtime lane at `2.3.0`, so the group lands on the **currently live lane**, demoting the other ~90% of same-lane devices to the previous group and starting a fresh 48h ramp-or-rollback clock (`mobile/docs/ota-rollout.md`). That is why the push is opt-in. Do it on a branch, or push deliberately and ramp. **Never during a launch window** — see `mobile/docs/store-release-one-app.md` §8.
2. Verify lock file is in sync (see "Before pushing" above) — `npm ci` is what EAS runs and the lock-drift failure is silent in local dev.
3. Trigger build via the **Release iOS** EAS Workflow at expo.dev → Workflows → Run. ~15–25 min build, automatically followed by submit (~3–5 min upload + 10–20 min Apple processing). For first-time builds or when EAS Workflows is unavailable, fall back to the CLI route.
4. The build appears under App Store Connect → My Apps → Repset → TestFlight tab once Apple finishes processing.
5. In App Store Connect, attach the build to the version, fill metadata (screenshots, App Privacy nutrition label, age rating, content rights, review notes), submit for review. Custom App reviews are typically 24–48h.
6. Once approved, distribute via ABM → Apps & Books — assign to staff Apple IDs by email or Managed Apple ID. App appears in their App Store app library, not searchable publicly.

**App Privacy declarations** (the "nutrition label") for Repset iOS: Name, Email Address, Phone Number, User ID, Device ID, Photos/Videos (invoice PDFs), Customer Support (WhatsApp/email/SMS history), Crash Data, Performance Data — all linked, none used for tracking, all purposes are App Functionality (+ Customer Support for phone/messages, + Analytics for diagnostics). Do NOT declare: Location, Contacts (the iOS Contacts app — CRM "contacts" is a different concept), Payment Info (Revolut handles cards, app never sees them), Health/Fitness (no HealthKit access), IDFA. Age rating: all "None"/"No" → 4+. Content rights: No (no licensed third-party media).

**Common iOS build/submit failures and their fixes:**
- `npm error Missing: <pkg> from lock file` → run `npm install --package-lock-only` in `mobile/` and recommit (see "Before pushing").
- `Bundle ID dropdown empty in App Store Connect` → bundle ID has to be registered at **developer.apple.com → Identifiers** first; App Store Connect only lists pre-registered IDs.
- Apple credentials prompt during build → first-time only; let EAS generate the cert + provisioning profile.
- iPad screenshots required — set `supportsTablet: false` in `app.config.js` if iPad isn't a target, otherwise Apple rejects for missing 13" iPad screenshots.

##### Android — Internal Testing track on Google Play (build-only automation)

**Important: Android submit is NOT automated.** UN1T's Google Workspace organisation policy `iam.disableServiceAccountKeyCreation` blocks creating the service-account JSON that `eas submit --platform android` needs. Disabling that constraint requires Cloud Org Administrator role at the Workspace level which isn't worth the bureaucratic adventure for what's a roughly quarterly native release. Instead:

- The EAS Workflow **builds** the Android `.aab` automatically.
- You **download and upload manually** to Play Console (~2 min per release).

If we ever want to re-enable automated submit, the path is either: (1) become Cloud Org Admin → disable the org policy → create a service-account JSON → upload to expo.dev → restore the `submit.production.android` block in `eas.json` → restore the `submit_android` job in `release.yml`. Or (2) set up Workload Identity Federation in EAS, which doesn't need a JSON key but is more involved.

**One-time prerequisites:**
- Google Play Console developer account ($25 one-time).
- App record created in Play Console with the matching package name (`com.un1tdublin.crm`). **`BUNDLE-ID-RESET` gotcha:** the original Play record used `com.un1tdublin.crmmobileios`; Android package names are permanent per record, so the rebrand to `com.un1tdublin.crm` required a **brand-new** Play app record (the old one can't be reused). The first `.aab` upload to the new record enrols Play App Signing with the EAS upload keystore.
- App content forms completed: Privacy Policy URL (`https://crm.un1tdublin.com/privacy`), Account Deletion URL (`https://crm.un1tdublin.com/account-deletion`), Data Safety form (Android's privacy nutrition label), Content Rating questionnaire, Target Audience (18+), App Category, Ads disclosure (no ads).
- Main Store Listing filled in (icon 512×512, feature graphic 1024×500, 3+ phone screenshots at 1080×2160, full description). Ready-made Repset icon + feature graphic live at `store-assets/play-android/` (generated from `mobile/assets/icon.png` via `sips`); screenshots still need capturing from a device/emulator.
- Android upload keystore: auto-generated on first interactive `eas build --platform android --profile production`. Stored on EAS, reused indefinitely. **Never delete it** — Play App Signing pins your app to its fingerprint, deleting locks you out of the Play listing forever.
- Internal Testing track configured in Play Console with the staff tester email list.

**Per-version submission flow:**
1. Bump version (shared with iOS): `npm run version:patch` from `mobile/`. Same warning as the iOS flow above — the commit touches `mobile/app.config.js`, so **pushing it to `main` publishes a 10% OTA on the current runtime lane**. The script no longer pushes by default.
2. Trigger the `Release` EAS Workflow at expo.dev → Workflows → Run. iOS auto-submits; Android only builds.
3. Once the Android build is green: open it on expo.dev, click **Download** to get the `.aab`.
4. Play Console → Testing → Internal testing → **Create new release** → drag the `.aab` in → fill release notes → **Save → Review release → Start rollout to Internal testing**.

The first build to a fresh app record always has to be uploaded manually like this anyway — even with a service account configured, Play Console requires the first AAB through the web UI to "create" the listing.

**Common Android build failures and their fixes:**
- Upload keystore prompts during build → first-time only; let EAS generate it. After this, never delete the keystore on EAS.
- `Version code already exists` (when manually uploading) → `appVersionSource: 'remote'` in eas.json should auto-increment, but if a build was rejected and resubmitted under the same code, force a new build to get a fresh code.
- Manual upload rejected for "metadata not complete" → Play Console requires every form in App Content to be green-ticked before any upload is accepted. Check the "App content" sidebar for amber dots.

