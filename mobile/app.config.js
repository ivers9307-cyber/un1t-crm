// Expo app config — read at build/run time. Env vars come from
// process.env (set in your shell or in mobile/.env when using `expo
// start`). The same Supabase URL + anon key the web app uses are read
// here as EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY (the
// EXPO_PUBLIC_ prefix is required by Expo to bundle them client-side).
//
// API base URL points at the Next.js deployment (e.g.
// https://crm.un1tdublin.com). The mobile app calls a small subset of
// /api/* routes for orchestration (push registration, assistant chat,
// WhatsApp send, etc.); most CRUD goes direct to Supabase via RLS.

export default ({ config }) => ({
  ...config,
  name: 'UN1T CRM',
  slug: 'un1t-crm-mobile',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'un1tcrm',
  userInterfaceStyle: 'automatic',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#000000',
  },
  assetBundlePatterns: ['**/*'],
  ios: {
    // iPhone-only. Setting this to false keeps the binary's UIDeviceFamily
    // restricted to iPhone (1) — App Store Connect then doesn't require
    // iPad screenshots, and the Custom App in ABM only offers itself to
    // iPhones. The CRM's mobile UI is laid out for narrow viewports;
    // iPad would show stretched single-column layouts which isn't a
    // good user experience anyway.
    supportsTablet: false,
    // NOTE: Apple bundle IDs use reverse-DNS. The literal string
    // "crmmobileios.un1tdublin.com" the user wrote isn't valid; this is
    // the equivalent in Apple-acceptable form. Change before App Store
    // submission if a different ID is preferred.
    bundleIdentifier: 'com.un1tdublin.crmmobileios',
    // buildNumber omitted — eas.json sets appVersionSource: 'remote',
    // so build numbers are managed by EAS, not the local config.
    infoPlist: {
      // Required for sending push tokens via APNs once an Apple
      // Developer account is wired up. Until then, Expo Go uses Expo's
      // own push channel for development.
      UIBackgroundModes: ['remote-notification'],
      // US export-control declaration. UN1T CRM uses only HTTPS
      // (standard) and the iOS Keychain (standard) — no custom or
      // proprietary cryptography — so the app is EXEMPT from export
      // compliance review. Setting this to `false` here means we
      // never have to re-answer the "are you using encryption?"
      // question in App Store Connect for each version.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: 'com.un1tdublin.crmmobileios',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      // Android adaptive icon background — UN1T identity is black/white
      // and the foreground is a white wordmark, so the background must
      // be black to match the iOS icon visually.
      backgroundColor: '#000000',
    },
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-notifications',
      {
        // Android notification tray icon — must be a white silhouette
        // on transparent (Android masks it). iOS uses the app icon.
        icon: './assets/notification-icon.png',
        color: '#111827',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  // Over-the-air updates via EAS Update. The project ID is the public
  // identifier of the EAS project at https://expo.dev/projects/<id> —
  // not a secret, safe to commit. The runtimeVersion policy
  // 'sdkVersion' means each Expo SDK gets its own update lane — an
  // update built for SDK 54 won't be served to a phone running an
  // SDK 53 build, preventing native/JS skew.
  updates: {
    url: 'https://u.expo.dev/6256a4d8-03ff-4898-9d47-b4de6c9c20e1',
    enabled: true,
    checkAutomatically: 'ON_LOAD',
    fallbackToCacheTimeout: 0,
  },
  runtimeVersion: { policy: 'sdkVersion' },
  extra: {
    // Supabase URL + anon key are PUBLIC by design — the anon key is
    // protected by Row-Level Security on the database, not by secrecy
    // (it's the same key embedded in every browser session at
    // crm.un1tdublin.com). Hardcoding here means EAS Update / EAS
    // Build don't need any env vars set — the bundle always has the
    // right values. Local dev can still override via mobile/.env if
    // someone needs to point at a staging Supabase project.
    supabaseUrl:
      process.env.EXPO_PUBLIC_SUPABASE_URL ||
      'https://iyvtbjjxdggiadzwwvdj.supabase.co',
    supabaseAnonKey:
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5dnRiamp4ZGdnaWFkend3dmRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNzYzOTQsImV4cCI6MjA5Mjk1MjM5NH0.GdUgg4Z3X9Djh57DKEP55yTgkcixualtn8LwEx3P9P8',
    apiBaseUrl:
      process.env.EXPO_PUBLIC_API_BASE_URL ||
      'https://crm.un1tdublin.com',
    // EAS project ID — used by `eas update` to know where to publish,
    // and by Expo Notifications.getExpoPushTokenAsync() to scope push
    // tokens to this project once we're off Expo Go's shared channel.
    eas: {
      projectId: '6256a4d8-03ff-4898-9d47-b4de6c9c20e1',
    },
  },
})
