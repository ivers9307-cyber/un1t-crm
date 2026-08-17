// Root layout. Wraps the entire app in:
//   - GestureHandlerRootView (required by react-navigation gestures)
//   - SafeAreaProvider (so screens respect the iPhone notch / Dynamic Island)
//   - AuthProvider (Supabase session + bootstrapped profile)
//
// expo-router auto-resolves the route tree: anything under app/(auth)/
// renders without auth, anything under app/(tabs)/ requires auth. The
// guard logic lives in app/(tabs)/_layout.jsx.
//
// IMPORTANT: in expo-router v6 + react-navigation v7 the splash-screen
// hide effect MUST live in a separate component from the one that
// renders <Stack>. If you read useAuth() in the same component that
// returns <Stack>, the re-render on auth state change can race against
// the navigation context bootstrap and trip the "Couldn't find the
// prevent remove context" error. Splitting them — one component that
// reads auth and triggers the hide, another that returns the Stack —
// keeps the navigation tree stable across re-renders.

import '../global.css'

import { Stack, SplashScreen, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useEffect } from 'react'
import * as Notifications from 'expo-notifications'
import {
  useFonts,
  Poppins_400Regular,
  Poppins_600SemiBold,
  Poppins_700Bold,
  Poppins_800ExtraBold,
} from '@expo-google-fonts/poppins'
// PHASE2 — Graft (member-tree) faces; see the useFonts call below.
import { Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold } from '@expo-google-fonts/figtree'
import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono'
import { AuthProvider, useAuth } from '../lib/auth-context'
// GEO-ATT — importing from lib/geofence also runs its module top-level
// TaskManager.defineTask, so the background geofence task is registered
// on every launch (including headless OS relaunches for region events).
import { syncGeofences } from '../lib/geofence'
import { routeForNotification } from '../lib/notification-nav'
import { ForegroundOtaUpdater } from '../lib/foreground-ota'
import { BiometricLockProvider } from '../lib/biometric-lock'
import { StudioPinProvider } from '../lib/studio-pin'
import LocationGate from '../components/LocationGate'
import RootErrorBoundary from '../components/RootErrorBoundary'

// Keep the splash screen up until auth bootstrap finishes — avoids a
// flash of the login screen for already-logged-in users.
SplashScreen.preventAutoHideAsync()

// Reads auth state and hides the splash. Renders nothing — its only job
// is to side-effect on the loading flag. Lives outside the navigation
// tree so its re-renders don't churn the Stack.
function SplashGate() {
  const { loading } = useAuth()
  useEffect(() => {
    if (!loading) SplashScreen.hideAsync()
  }, [loading])
  return null
}

// NOTIF.2 — deep-link the user into the relevant detail screen when
// they tap a push notification. The payload's `data` object carries
// `type` ('task_reminder' | 'swap_inbound' | …) and the entity id;
// the type → route mapping lives in lib/notification-nav.js (pure,
// unit-tested). We also handle the *cold-start* case via
// getLastNotificationResponseAsync() — taps that opened the app
// from killed state fire the listener before the navigation tree is
// ready, so we replay them once on mount.
function NotificationRouter() {
  const router = useRouter()
  const { session, loading } = useAuth()

  useEffect(() => {
    if (loading || !session) return

    function handle(response) {
      const data = response?.notification?.request?.content?.data
      if (!data) return
      const route = routeForNotification(data)
      if (route) {
        router.push(route)
      } else if (route === undefined) {
        // A data.type this build doesn't know — log it so the gap
        // surfaces instead of a silent dead tap.
        console.error('[notif-router] unhandled push type', data.type)
      }
    }

    // Cold-start: replay the last tap that opened the app.
    let cancelled = false
    Notifications.getLastNotificationResponseAsync().then(r => {
      if (!cancelled && r) handle(r)
    }).catch(() => { /* best-effort */ })

    const sub = Notifications.addNotificationResponseReceivedListener(handle)
    return () => { cancelled = true; sub.remove() }
  }, [router, session, loading])

  return null
}

// GEO-ATT — registers/refreshes geofence regions once auth is ready.
// Side-effect only; must NOT live in the component that renders <Stack>
// (see the header comment — reading useAuth() there races the
// navigation bootstrap).
function GeofenceSync() {
  const { session, loading } = useAuth()
  useEffect(() => {
    if (!loading && session) syncGeofences()
  }, [loading, session])
  return null
}

export default function RootLayout() {
  // TV-STYLE.2 — load Poppins (the TV-template face) app-wide.
  // Deliberately NON-blocking: we don't gate rendering or hold the
  // splash on the load — the TV canvas simply falls back to the
  // system font until the family is ready (expo-font resolves the
  // fontFamily on later renders). expo-font's native module is
  // already in the build (Ionicons dep), so this is OTA-safe.
  //
  // PHASE2 (one-app merge, stage B) — the Graft brand faces (Afterglow
  // system) load here too: Archivo Expanded for EARNED numbers +
  // headings, Figtree for body, IBM Plex Mono for body-sourced
  // telemetry. Champ's settle-on-error pattern is kept below
  // (`fontsLoaded || !!fontError`): EITHER state counts as settled so a
  // font-load failure can never wedge rendering — screens fall back to
  // the system font. Staff splash still gates on auth only (SplashGate),
  // exactly as before this merge.
  const [fontsLoaded, fontError] = useFonts({
    Poppins_400Regular,
    Poppins_600SemiBold,
    Poppins_700Bold,
    Poppins_800ExtraBold,
    'ArchivoExpanded-SemiBold': require('../assets/fonts/ArchivoExpanded-600.ttf'),
    'ArchivoExpanded-Bold': require('../assets/fonts/ArchivoExpanded-700.ttf'),
    'ArchivoExpanded-Black': require('../assets/fonts/ArchivoExpanded-800.ttf'),
    Figtree_400Regular,
    Figtree_500Medium,
    Figtree_600SemiBold,
    IBMPlexMono_500Medium,
  })
  // Settled = loaded OR errored. Not consumed by any gate yet — TODO(stage C):
  // the member-tree splash/entry gating consumes this when the resolver lands.
  const fontsReady = fontsLoaded || !!fontError
  void fontsReady

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <RootErrorBoundary>
      <SafeAreaProvider>
        <AuthProvider>
          <StudioPinProvider>
          <BiometricLockProvider>
            <StatusBar style="dark" />
            <SplashGate />
            <NotificationRouter />
            <GeofenceSync />
            <ForegroundOtaUpdater />
            {/* PHASE2 (one-app merge, stage B) — the route tree now has two
                groups: (staff) carries the ENTIRE pre-merge staff app (its
                Stack — moved verbatim — lives in app/(staff)/_layout.jsx;
                group folders add no URL segment so every staff path and push
                deep link is byte-identical), and (member) carries the ported
                Graft member tree (unreachable until the stage-C resolver —
                see app/index.jsx). */}
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(staff)" options={{ headerShown: false }} />
              <Stack.Screen name="(member)" options={{ headerShown: false }} />
            </Stack>
            {/* GEO-ATT.12 — full-screen permission-gate OVERLAY. Sibling
                of <Stack> (SplashGate pattern: reads useAuth in its own
                component, never wraps the navigator) and rendered AFTER
                it so the absolute-fill block sits above every screen —
                including deep-linked sibling groups that a (tabs)-only
                wrap missed. Renders null unless gating applies. */}
            <LocationGate />
          </BiometricLockProvider>
          </StudioPinProvider>
        </AuthProvider>
      </SafeAreaProvider>
      </RootErrorBoundary>
    </GestureHandlerRootView>
  )
}
