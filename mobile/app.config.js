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
  // icon: './assets/icon.png',          // TODO: add UN1T branding to assets/
  scheme: 'un1tcrm',
  userInterfaceStyle: 'automatic',
  // splash: {                           // TODO: add splash to assets/
  //   image: './assets/splash.png',
  //   resizeMode: 'contain',
  //   backgroundColor: '#FFFFFF',
  // },
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: true,
    // NOTE: Apple bundle IDs use reverse-DNS. The literal string
    // "crmmobileios.un1tdublin.com" the user wrote isn't valid; this is
    // the equivalent in Apple-acceptable form. Change before App Store
    // submission if a different ID is preferred.
    bundleIdentifier: 'com.un1tdublin.crmmobileios',
    buildNumber: '1',
    infoPlist: {
      // Required for sending push tokens via APNs once an Apple
      // Developer account is wired up. Until then, Expo Go uses Expo's
      // own push channel for development.
      UIBackgroundModes: ['remote-notification'],
    },
  },
  android: {
    package: 'com.un1tdublin.crmmobileios',
    // adaptiveIcon: {                  // TODO: add UN1T branding to assets/
    //   foregroundImage: './assets/adaptive-icon.png',
    //   backgroundColor: '#FFFFFF',
    // },
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-notifications',
      {
        // TODO: add a transparent white silhouette of the UN1T logo for
        // the notification tray icon. Defaults work fine for development.
        // icon: './assets/notification-icon.png',
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
    supabaseUrl:
      process.env.EXPO_PUBLIC_SUPABASE_URL ||
      'https://YOUR-PROJECT.supabase.co',
    supabaseAnonKey:
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
      'YOUR-ANON-KEY',
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
