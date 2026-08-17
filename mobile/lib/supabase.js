// Supabase client for the mobile app.
//
// We can't use cookies on a mobile device, so the session lives in
// expo-secure-store (iOS Keychain / Android Keystore). Supabase JS
// supports a custom storage adapter — we plug a CHUNKED SecureStore
// adapter in.
//
// Why chunked (MOBILE-AUDIT.4): SecureStore has a ~2 KB per-value limit
// on iOS. A Supabase session is usually ~1.5 KB but can exceed 2 KB
// (longer JWTs, extra claims, longer email) — at which point a plain
// setItemAsync throws and the session silently fails to persist, logging
// the user out on every cold start. The adapter below splits large
// values across `<key>.0`, `<key>.1`, … under a small marker so the
// whole session always fits, while keeping everything in the Keychain
// (no AsyncStorage fallback, so nothing sensitive lands in plaintext).
//
// The same project URL and anon key the web app uses are read from
// expo-constants.extra (set via app.config.js). Server-side code never
// runs in the app, so we only need the anon key.

import 'react-native-url-polyfill/auto'
import { createClient } from '@supabase/supabase-js'
import * as SecureStore from 'expo-secure-store'
import Constants from 'expo-constants'
import { AppState, Platform } from 'react-native'

const SUPABASE_URL = Constants.expoConfig?.extra?.supabaseUrl
const SUPABASE_ANON_KEY = Constants.expoConfig?.extra?.supabaseAnonKey

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Fail loud — same philosophy as src/lib/app-url.js (no silent fallbacks).
  // eslint-disable-next-line no-console
  console.error(
    '[supabase] Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
    'Copy mobile/.env.example to mobile/.env and fill in the values.'
  )
}

// Stay comfortably under the iOS 2 KB SecureStore limit (UTF-8 bytes can
// exceed JS string length, so leave headroom).
const CHUNK_SIZE = 1500
const CHUNK_MARKER = '__chunks__:'
// Cleanup is bounded — we never expect a session to exceed a handful of
// chunks, but cap the scan so a corrupt marker can't loop unbounded.
const MAX_CHUNKS = 16

const SecureStoreAdapter = {
  async getItem(key) {
    const head = await SecureStore.getItemAsync(key)
    if (head == null) return null
    // Legacy single-value sessions (written before chunking) and small
    // values are stored plain — return as-is so existing users aren't
    // logged out on upgrade.
    if (!head.startsWith(CHUNK_MARKER)) return head
    const count = parseInt(head.slice(CHUNK_MARKER.length), 10)
    if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) return null
    let out = ''
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`)
      if (part == null) return null // corrupt/partial — treat as no session
      out += part
    }
    return out
  },

  async setItem(key, value) {
    if (value.length <= CHUNK_SIZE) {
      // Small enough to store plain. Drop any stale chunks from a
      // previous large write so they can't be misread later.
      await SecureStore.setItemAsync(key, value)
      await clearChunks(key)
      return
    }
    const count = Math.ceil(value.length / CHUNK_SIZE)
    for (let i = 0; i < count; i++) {
      await SecureStore.setItemAsync(`${key}.${i}`, value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))
    }
    await SecureStore.setItemAsync(key, `${CHUNK_MARKER}${count}`)
  },

  async removeItem(key) {
    await clearChunks(key)
    await SecureStore.deleteItemAsync(key)
  },
}

// Best-effort removal of `<key>.0..N` chunk entries.
async function clearChunks(key) {
  for (let i = 0; i < MAX_CHUNKS; i++) {
    try {
      const existing = await SecureStore.getItemAsync(`${key}.${i}`)
      if (existing == null) break
      await SecureStore.deleteItemAsync(`${key}.${i}`)
    } catch {
      break
    }
  }
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

// ── AppState-wired token refresh (PHASE2 stage C — champ's pattern, moved
// onto the ONE shared client) ──
//
// Supabase's auto-refresh timer only ticks while the JS runtime is running.
// When the app is backgrounded the OS suspends the timer, so a user
// returning after >1h holds a stale access token. The api() helpers recover
// on a 401, but DIRECT `supabase.from(...)` reads (member dashboard,
// sessions; staff schedule reads) have no 401-retry path — they just
// surface "Failed to load" until a manual refetch.
//
// The standard Supabase RN fix: drive the auto-refresh loop off AppState,
// and proactively refresh the moment we come back to the foreground so the
// very next direct read carries a fresh token. Wired once here at import
// (the client is a module singleton) with an explicit guard so no future
// re-export/refactor can double-register the listener.
let autoRefreshWired = false
if (Platform.OS !== 'web' && !autoRefreshWired) {
  autoRefreshWired = true
  let refreshingOnForeground = false

  const handleAppStateChange = (state) => {
    if (state === 'active') {
      // Resume the periodic auto-refresh loop.
      supabase.auth.startAutoRefresh()
      // Proactively refresh NOW so a direct supabase.from() read that fires
      // on this same foreground doesn't race a still-expired token. Guarded
      // so overlapping 'active' events don't stack refresh calls.
      // Best-effort: a truly-dead refresh token is handled by the normal
      // onAuthStateChange sign-out path, not here.
      if (!refreshingOnForeground) {
        refreshingOnForeground = true
        supabase.auth
          .refreshSession()
          .catch(() => { /* best-effort; auth listener handles a dead session */ })
          .finally(() => { refreshingOnForeground = false })
      }
    } else {
      // Backgrounded/inactive — stop the loop so we don't burn cycles or
      // hit the network from a suspended state.
      supabase.auth.stopAutoRefresh()
    }
  }

  AppState.addEventListener('change', handleAppStateChange)
  // Kick the loop for the initial foreground launch (AppState starts
  // 'active' but the 'change' event won't have fired yet).
  if (AppState.currentState === 'active') supabase.auth.startAutoRefresh()
}
