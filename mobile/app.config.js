// Expo app config — read at build/run time. Env vars come from
// process.env (set in your shell or in mobile/.env when using `expo
// start`). The same Supabase URL + anon key the web app uses are read
// here as EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY (the
// EXPO_PUBLIC_ prefix is required by Expo to bundle them client-side).
//
// API base URL points at the Next.js deployment (e.g.
// https://crm.repset.ie). The mobile app calls a small subset of
// /api/* routes for orchestration (push registration, assistant chat,
// WhatsApp send, etc.); most CRUD goes direct to Supabase via RLS.

import { withInfoPlist } from 'expo/config-plugins'

// PHASE2 (one-app merge) — ported from champ-app/mobile/app.config.js.
// HealthKit background delivery uses the HealthKit background-delivery
// entitlement (added by the @kingstinct/react-native-healthkit plugin with
// `background: true`), not a UIBackgroundMode. expo-notifications needs
// UIBackgroundModes to include 'remote-notification' for push, and GEO-ATT
// needs 'location' for geofence wakes. This plugin is registered EARLY in
// the plugins array (before the HealthKit plugin) so Expo runs its
// Info.plist mod LAST, giving it the final say — it unions the modes so
// background sync + push + geofencing coexist. It only ever deletes
// 'fetch'/'processing' — 'location' (and anything else already present)
// survives the Set round-trip untouched.
const withUnionedBackgroundModes = (config) =>
  withInfoPlist(config, (cfg) => {
    const modes = new Set(cfg.modResults.UIBackgroundModes || [])
    // Push needs 'remote-notification'. The app registers NO BGTask/background-
    // fetch — HealthKit background delivery uses its ENTITLEMENT (added by the
    // HealthKit plugin), not a UIBackgroundMode. Strip 'fetch'/'processing':
    // 'processing' without BGTaskSchedulerPermittedIdentifiers fails App Store
    // validation at upload.
    modes.add('remote-notification')
    modes.delete('fetch')
    modes.delete('processing')
    cfg.modResults.UIBackgroundModes = Array.from(modes)
    return cfg
  })

export default ({ config }) => ({
  ...config,
  // REBRAND.2 (2026-07-27) — "CF Studio" → "Repset", the platform brand
  // (repset.ie). Same Bundle ID, same ASC record — only the user-facing
  // name + icon/splash change (name is edited on the ASC record, see
  // docs/repset-asc-metadata.md). Native-level change → ships in the
  // next store build, NOT over OTA; runtimeVersion is untouched because
  // no native module ABI changes (icons/name don't affect the JS lane).
  //
  // REBRAND.1 — display name flipped from "UN1T CRM" to "CF Studio" for
  // the new App Store Connect app record (Path 1 rebrand: same Bundle
  // ID, new ASC record after the previous Custom App record is removed).
  // The Expo `slug` stays at 'un1t-crm-mobile' so the existing EAS
  // project (and its projectId / build history / OTA update channel)
  // remains intact — only the user-facing name and home-screen icon
  // change. Version reset to 1.0.0 for the fresh ASC record (the
  // previous Custom App's 1.1 lives on a different ASC record so
  // Apple's per-record version tracking doesn't conflict).
  //
  // 1.1.0 (May 2026) — bundles the FTE expense reimbursement flow
  // (Expenses tab + claims + per-item receipt capture + Claude
  // Vision OCR auto-fill), the UniFi door allowlist tightening,
  // the audit-log expansion, the WhatsApp coexistence scaffolding,
  // and the reduced-motion accessibility wiring. Minor bump
  // because it adds new user-visible surfaces; buildNumber is
  // managed by EAS (autoIncrement: true on the production profile).
  //
  // 1.2.0 (STUDIO-IPAD.1) — universal binary. supportsTablet flips
  // to true so iPad gets the same App Store record; orientation
  // unlocks ('default') so iPad can rotate; the iPhone still
  // reads as portrait-only because the orientation lock is
  // applied per-screen by useScreenOptions, not at the app level.
  // This bundles the studio-device PIN auth foundation
  // (STUDIO-PIN.1/2/3) from a mobile perspective: a paired iPad
  // can now PIN-login from the web shell at /studio-login.
  name: 'Repset',
  slug: 'un1t-crm-mobile',
  // 1.3.2 — Android-manifest fix: blockedPermissions drops the unused
  // RECORD_AUDIO that expo-image-picker adds by default (2026-06-10 audit).
  // Manifest-level → needs this native build; no JS/native API change, so
  // runtimeVersion stays '1.3.0' (same OTA lane as 1.3.0/1.3.1 installs).
  // OTA code signing was intended for this build but is Enterprise-plan-
  // only — reverted, see the updates block below.
  //
  // 1.3.1 — bakes the W1/W2/W3 mobile-parity wave into the embedded bundle:
  // the full staff & access suite, tasks create/assign, issue inbox,
  // contacts, location-feature toggles, invoices inbox, orders, cars, and
  // trackside race-day control. JS-ONLY — every one already shipped as an OTA
  // to the 1.3.0 runtime lane, so runtimeVersion stays '1.3.0' (no native
  // change; the fresh binary + existing 1.3.0 installs share one OTA lane).
  //
  // 1.4.0 (EVENT-CHECKIN.D) — adds the in-app QR scanner for event check-in
  // (expo-camera, a NATIVE module). Ships only in a new EAS Build + store
  // release, NOT over OTA; runtimeVersion bumps to 1.4.0 to isolate its lane.
  //
  // 2.1.0 (REBRAND.2) — Repset rebrand binary (name + icons + splash).
  // Bumped past 2.0.0 in case the SDK-57 binary is already in review on
  // ASC (a higher version is always accepted; runtimeVersion stays
  // 2.0.0 so both binaries share one OTA lane — the JS is identical).
  //
  // 2.2.0 (GEO-ATT) — passive staff attendance via background geofencing.
  // Adds expo-location + expo-task-manager (NATIVE modules) → new EAS
  // Build + store release, NOT an OTA; runtimeVersion bumps to 2.2.0 in
  // lockstep (see the runtimeVersion comment log below).
  //
  // 2.3.0 (PHASE2 one-app merge) — the member app (Graft/champ-app) folds
  // into this binary. Adds @kingstinct/react-native-healthkit +
  // react-native-nitro-modules + react-native-svg (all NATIVE modules) →
  // new EAS Build + store release, NOT an OTA; runtimeVersion bumps to
  // 2.3.0 in lockstep (native lane bump — see the runtimeVersion log).
  version: '2.3.0',
  // We ship iOS + Android only. Without this, Expo defaults to
  // ['ios','android','web'] and `eas update` exports for web too —
  // which crashes the publish because react-native-web isn't installed.
  // That export failure is why no OTA ever reached the binary.
  platforms: ['ios', 'android'],
  // STUDIO-IPAD.1 — 'default' lets the OS decide based on the
  // device. iPhone is still pinned to portrait by per-screen
  // useScreenOptions calls (where they exist); iPad can rotate
  // freely so the larger screens that benefit from landscape
  // (Schedule week view, master-detail Contacts) actually use the
  // canvas.
  orientation: 'default',
  icon: './assets/icon.png',
  // Deep-link schemes — `repset://...` is the brand scheme going
  // forward; `cfstudio` stays registered so any link/QR minted while
  // the app was CF Studio keeps resolving (unlike the un1tcrm→cfstudio
  // rename, cfstudio:// has been live in the wild). Expo accepts an
  // array here and registers every entry in CFBundleURLTypes / the
  // Android intent filter.
  // PHASE2 — `un1tapp` joins the array: it is the member app's (Graft)
  // scheme, so Graft-era QR codes and deep links keep resolving into
  // the merged one-app binary.
  scheme: ['repset', 'cfstudio', 'un1tapp'],
  userInterfaceStyle: 'automatic',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#131316',
  },
  assetBundlePatterns: ['**/*'],
  ios: {
    // STUDIO-IPAD.1 — universal binary. Flipped to true so the same
    // App Store / TestFlight build serves both iPhone and iPad
    // (UIDeviceFamily 1, 2). Per-screen layouts adapt to the larger
    // canvas via the useIsTablet() hook in mobile/lib/use-is-tablet.js
    // — screens that benefit from a multi-column layout (Schedule
    // week view, Contacts list+detail, Approvals) check the hook and
    // render adaptively. Screens that don't (single-column forms,
    // simple lists) just look more spacious on iPad without code
    // changes.
    //
    // Apple-side: App Store Connect will now expect iPad screenshots
    // at 2048×2732 (12.9") and/or 2064×2752 (13" iPad Pro M4). Until
    // those are uploaded, new submissions can defer iPad-specific
    // metadata via the "use iPhone screenshots" toggle.
    supportsTablet: true,
    // requireFullScreen: false (the Expo default) lets the iPad run
    // the app in Split View / Stage Manager. Verified the existing
    // screens handle a non-fullscreen narrow viewport gracefully
    // (they're already laid out for iPhone widths down to 320pt) so
    // there's no fullscreen-only requirement to assert here.
    requireFullScreen: false,
    // BUNDLE-ID-RESET — the previous bundle ID
    // (com.un1tdublin.crmmobileios) was submitted for App Store review
    // and then deleted from App Store Connect. Apple permanently
    // reserves submitted bundle IDs to the team, so it could not be
    // reused. Switched to com.un1tdublin.crm — registered fresh in
    // Apple Developer → Identifiers and paired with a new App Store
    // Connect app record.
    bundleIdentifier: 'com.un1tdublin.crm',
    // buildNumber omitted — eas.json sets appVersionSource: 'remote',
    // so build numbers are managed by EAS, not the local config.
    infoPlist: {
      // Required for sending push tokens via APNs once an Apple
      // Developer account is wired up. Until then, Expo Go uses Expo's
      // own push channel for development.
      // GEO-ATT — 'location' lets the OS wake the app for geofence
      // region events with the app backgrounded or killed.
      UIBackgroundModes: ['remote-notification', 'location'],
      // US export-control declaration. Repset uses only HTTPS
      // (standard) and the iOS Keychain (standard) — no custom or
      // proprietary cryptography — so the app is EXEMPT from export
      // compliance review. Setting this to `false` here means we
      // never have to re-answer the "are you using encryption?"
      // question in App Store Connect for each version.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    // BUNDLE-ID-RESET — kept in lockstep with the iOS bundle ID for
    // consistency, even though Android doesn't have Apple's reuse
    // restriction. One namespace, one app, both stores.
    package: 'com.un1tdublin.crm',
    // FCM-SETUP.1 — Android push (mobile/docs/android-fcm-setup.md). On EAS
    // the GOOGLE_SERVICES_JSON file secret materialises as a path in this
    // env var; local prebuilds fall back to a git-ignored copy on disk (the
    // repo is public, so the file is never committed — Route A). Gradle
    // consumes it at BUILD time: a new binary is required, but the JS↔native
    // interface is unchanged, so runtimeVersion stays put (the 1.3.2 /
    // ANDROID-R8 precedent above).
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
    // MOBILE-AUDIT.2 — expo-image-picker adds RECORD_AUDIO by default
    // (for video capture); the app only picks/captures photos for
    // invoices and issue reports, never audio/video. Blocking it keeps
    // the Play data-safety declaration honest. Takes effect at the
    // next native build (manifest-level — not OTA-able).
    blockedPermissions: ['android.permission.RECORD_AUDIO'],
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      // Android adaptive icon background — Repset ink (#131316); the
      // foreground is the tally mark (bone bars + volt strike) so the
      // background must match the iOS icon's ink field visually.
      backgroundColor: '#131316',
    },
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    // Required peer of @expo/vector-icons used throughout the app
    // (every Ionicons component imports a font under the hood).
    // Expo Go bundles expo-font automatically so it works in dev,
    // but production builds — and EAS's expo-doctor pre-flight check
    // — require it to be declared explicitly.
    'expo-font',
    [
      'expo-notifications',
      {
        // Android notification tray icon — must be a white silhouette
        // on transparent (Android masks it). iOS uses the app icon.
        icon: './assets/notification-icon.png',
        color: '#131316',
      },
    ],
    // PHASE2 — registered BEFORE the HealthKit plugin so Expo composes
    // same-mod plugins such that this one's Info.plist mod runs LAST — it
    // has the final say on UIBackgroundModes (unions 'remote-notification'
    // back in for push; never touches 'location', which GEO-ATT needs).
    withUnionedBackgroundModes,
    // PHASE2 — direct HealthKit (Apple Health), ported from champ-app.
    // `background: true` adds the HealthKit entitlement + background-
    // delivery entitlement + the usage strings below. NATIVE module →
    // new EAS Build (runtimeVersion 2.3.0 lane), NOT an OTA.
    [
      '@kingstinct/react-native-healthkit',
      {
        background: true,
        NSHealthShareUsageDescription:
          'Repset reads your Apple Health workouts and heart rate to score your sessions, track your progress over time, and include you in gym challenges.',
        NSHealthUpdateUsageDescription:
          'Repset can save workout summaries back to Apple Health.',
      },
    ],
    // FACE-ID — biometric app-lock. faceIDPermission writes
    // NSFaceIDUsageDescription into Info.plist; without it iOS silently
    // falls back to device passcode on Face ID devices. NATIVE change →
    // requires a new EAS Build (not an OTA).
    [
      'expo-local-authentication',
      { faceIDPermission: 'Unlock Repset with Face ID.' },
    ],
    // EVENT-CHECKIN.D — in-app QR scanner for event check-in. cameraPermission
    // writes NSCameraUsageDescription (iOS); expo-camera adds the CAMERA
    // permission (Android). NATIVE module → new EAS Build, NOT an OTA. We only
    // decode QR codes — never record — and RECORD_AUDIO stays blocked above.
    [
      'expo-camera',
      { cameraPermission: 'Scan attendee check-in QR codes at events.', recordAudioAndroid: false },
    ],
    // GEO-ATT — background geofencing for passive staff attendance.
    // Writes the iOS location usage strings + Android foreground/
    // background location permissions. NATIVE module → new EAS Build
    // (runtimeVersion 2.2.0 lane), NOT an OTA.
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Repset detects when you arrive at the gym so your shift attendance is logged automatically.',
        locationAlwaysAndWhenInUsePermission:
          'Allow "Always" so arrival is detected even when the app is closed. Only gym arrival is detected — never your location elsewhere.',
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
      },
    ],
    // SDK 57 — these packages now ship config plugins that must be registered
    // explicitly. `expo install --fix` flagged them but can't auto-edit a
    // dynamic app.config.js, so they're declared here by hand.
    'expo-splash-screen',
    'expo-status-bar',
    'expo-web-browser',
    // ANDROID-R8 — Play Console flagged release 7 (2.1.0) as unoptimised:
    // React Native's Gradle template defaults minifyEnabled=false, so the
    // Java/Kotlin side ships unshrunk. Enabling R8 + resource shrinking cuts
    // AAB size and startup cost; the JS bundle (Hermes) is unaffected. Expo
    // modules carry their own ProGuard keep-rules, but reflection breakage
    // only surfaces in a MINIFIED build — smoke-test the internal-testing
    // .aab before promoting. NATIVE change → new EAS Build, not OTA-able;
    // runtimeVersion stays put (the JS↔native interface is unchanged, so
    // existing lanes still match).
    [
      'expo-build-properties',
      {
        android: {
          enableProguardInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  // Over-the-air updates via EAS Update. The project ID is the public
  // identifier of the EAS project at https://expo.dev/projects/<id> —
  // not a secret, safe to commit. The explicit runtimeVersion string
  // below defines the update lane — an update published for one lane is
  // never served to a binary on another, preventing native/JS skew.
  updates: {
    url: 'https://u.expo.dev/6256a4d8-03ff-4898-9d47-b4de6c9c20e1',
    enabled: true,
    // ON_LOAD only fires on a COLD start; staff rarely force-quit, so
    // lib/foreground-ota.jsx additionally checks on foreground (throttled).
    // Keep ON_LOAD — it's still what serves fresh installs and force-quits.
    checkAutomatically: 'ON_LOAD',
    fallbackToCacheTimeout: 0,
    // MOBILE-AUDIT.2 — OTA code signing was wired here (#446) and then
    // REVERTED: Expo rejects signed publishes on our Starter plan
    // ("EAS Update code signing requires a subscription to the EAS
    // Enterprise plan", live failure 2026-06-11). A cert-embedding
    // binary on a plan that can't sign would never receive OTAs again,
    // so the cert MUST stay out of the config until the account is on
    // Enterprise. The key material is ready for that day: cert at
    // certs/certificate.pem (committed), private key in mobile/keys/
    // (gitignored) + the EXPO_UPDATES_PRIVATE_KEY GitHub secret.
    // Runbook (incl. the plan gotcha): mobile/docs/eas-update-code-signing.md
  },
  // OTA runtime-version policy: an EXPLICIT string (history below — it
  // started as the 'sdkVersion' policy, then went explicit at 1.3.0).
  //
  // 'fingerprint' is the better long-term choice — it WITHHOLDS a native/ABI-
  // mismatched update instead of serving it into a boot-crash. We tried it
  // (PR #295) but it broke the iOS "Configure expo-updates" Xcode build phase:
  // that phase recomputes the fingerprint in a restricted build sandbox and
  // errors, so the production build failed (EAS build e02f3944). Reverted to
  // unblock the recovery build.
  //
  // The actual boot-crash fix does NOT depend on this — it's the OTA publish
  // pipeline now using `npm ci` + a pinned toolchain (.github/workflows/
  // eas-update.yml) so over-the-air Hermes bytecode matches the binary. Re-
  // attempt 'fingerprint' as a separate, debugged change. See
  // docs/OTA_BOOT_CRASH_FINDINGS.md.
  // MOBILE-FACEID — switched from the `sdkVersion` policy to an EXPLICIT
  // runtimeVersion because v1.3.0 adds a NATIVE module
  // (expo-local-authentication). An explicit runtime isolates this build's OTA
  // lane: old binaries (exposdk:54.0.0) no longer receive OTAs — frozen, NOT
  // crashed — until users install the 1.3.0 binary that contains the module.
  // Bump this string on every future native change.
  //
  // 1.4.0 — EVENT-CHECKIN.D adds expo-camera (native). New lane: existing
  // 1.3.x installs stop receiving OTAs (frozen, NOT crashed) until users
  // install the 1.4.0 binary from the stores. Merge this PR only as part of
  // that native release (see the Face ID release playbook).
  //
  // 2.0.0 — Expo SDK 54→57 upgrade (RN 0.81→0.86, React 19.1→19.2). A whole-SDK
  // native change, so a fresh OTA lane is mandatory. ⚠️ Align this string with
  // the actual store-release version you cut for the SDK 57 binary before
  // shipping; existing 1.4.x installs freeze (NOT crash) until users update.
  //
  // 2.2.0 — GEO-ATT adds expo-location + expo-task-manager (native:
  // background geofencing for staff attendance). New lane: 2.0.x
  // installs stop receiving OTAs (frozen, NOT crashed) until users
  // install the 2.2.0 binary. Merge only as part of the 2.2.0 store
  // release.
  //
  // 2.3.0 — PHASE2 one-app merge native lane. HealthKit
  // (@kingstinct/react-native-healthkit), react-native-nitro-modules and
  // react-native-svg are NEW NATIVE MODULES, so a fresh OTA lane is
  // mandatory: 2.2.x installs freeze (NOT crash) until users install the
  // 2.3.0 binary. This stays an EXPLICIT STRING — never switch to the
  // 'fingerprint' policy: PR #295 tried it and it broke the iOS
  // "Configure expo-updates" Xcode build phase (the phase recomputes the
  // fingerprint in a restricted build sandbox and errors, failing the
  // production build — EAS build e02f3944).
  runtimeVersion: '2.3.0',
  extra: {
    // Supabase URL + anon key are PUBLIC by design — the anon key is
    // protected by Row-Level Security on the database, not by secrecy
    // (it's the same key embedded in every browser session at
    // crm.repset.ie). Hardcoding here means EAS Update / EAS
    // Build don't need any env vars set — the bundle always has the
    // right values. Local dev can still override via mobile/.env if
    // someone needs to point at a staging Supabase project.
    supabaseUrl:
      process.env.EXPO_PUBLIC_SUPABASE_URL ||
      'https://iyvtbjjxdggiadzwwvdj.supabase.co',
    supabaseAnonKey:
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5dnRiamp4ZGdnaWFkend3dmRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNzYzOTQsImV4cCI6MjA5Mjk1MjM5NH0.GdUgg4Z3X9Djh57DKEP55yTgkcixualtn8LwEx3P9P8',
    // REPSET-P6.S2 — env override stays primary; the code defaults are the
    // canonical repset hosts. This is the OTA-able flip: publishing an
    // update rebases every installed app onto repset without a store build.
    apiBaseUrl:
      process.env.EXPO_PUBLIC_API_BASE_URL ||
      'https://crm.repset.ie',
    // PHASE2 — the member-app (champ) deployment. The merged app still
    // calls a few member-facing /api/* routes that live on the champ
    // Next.js deployment; the member's Supabase token is valid for both.
    champApiBaseUrl:
      process.env.EXPO_PUBLIC_CHAMP_API_BASE_URL ||
      'https://api.repset.ie',
    // EAS project ID — used by `eas update` to know where to publish,
    // and by Expo Notifications.getExpoPushTokenAsync() to scope push
    // tokens to this project once we're off Expo Go's shared channel.
    eas: {
      projectId: '6256a4d8-03ff-4898-9d47-b4de6c9c20e1',
    },
  },
})
