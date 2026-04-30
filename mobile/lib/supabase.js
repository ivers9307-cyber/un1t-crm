// Supabase client for the mobile app.
//
// We can't use cookies on a mobile device, so the session lives in
// expo-secure-store (iOS Keychain / Android Keystore). Supabase JS
// supports a custom storage adapter — we plug SecureStore in.
//
// The same project URL and anon key the web app uses are read from
// expo-constants.extra (set via app.config.js → process.env). Server-
// side code never runs in the app, so we only need the anon key.

import 'react-native-url-polyfill/auto'
import { createClient } from '@supabase/supabase-js'
import * as SecureStore from 'expo-secure-store'
import Constants from 'expo-constants'
import { Platform } from 'react-native'

const SUPABASE_URL = Constants.expoConfig?.extra?.supabaseUrl
const SUPABASE_ANON_KEY = Constants.expoConfig?.extra?.supabaseAnonKey

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Fail loud — same philosophy as src/lib/app-url.js (no silent fallbacks).
  // The user will see this in the Expo dev tools immediately.
  // eslint-disable-next-line no-console
  console.error(
    '[supabase] Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
    'Copy mobile/.env.example to mobile/.env and fill in the values.'
  )
}

// SecureStore has a 2KB per-value limit on iOS. Supabase sessions are
// usually well under that (~1.5KB) but if you ever see a "Value too
// long" error, fall back to AsyncStorage for the session and keep
// SecureStore for the refresh token only. We keep it simple here.
const SecureStoreAdapter = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: Platform.OS === 'web' ? undefined : SecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    // PKCE is the recommended flow for native apps — uses a code
    // challenge instead of relying on cookies.
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
})
