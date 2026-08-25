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
import { useEffect, useRef } from 'react'
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
import { IdentityProvider, useIdentity } from '../lib/identity-context'
// GEO-ATT — importing from lib/geofence also runs its module top-level
// TaskManager.defineTask, so the background geofence task is registered
// on every launch (including headless OS relaunches for region events).
import { syncGeofences } from '../lib/geofence'
import { resolveNotificationTap, presentationForNotification } from '../lib/notification-side'
import { writeLastSide } from '../lib/last-side'
import { ForegroundOtaUpdater } from '../lib/foreground-ota'
import { BiometricLockProvider } from '../lib/biometric-lock'
import { StudioPinProvider } from '../lib/studio-pin'
import LocationGate from '../components/LocationGate'
import RootErrorBoundary from '../components/RootErrorBoundary'

// Keep the splash screen up until auth bootstrap finishes — avoids a
// flash of the login screen for already-logged-in users.
SplashScreen.preventAutoHideAsync()

// PHASE2 stage C — ONE foreground-presentation handler for both shells
// (was module scope in lib/push-register.js). Branches per payload type:
// staff types keep the sound+badge banner the staff app always had;
// member types keep champ's silent banner. Module scope (not a
// component) so it can't double-register on re-render.
Notifications.setNotificationHandler({
  handleNotification: async (notification) =>
    presentationForNotification(notification?.request?.content?.data),
})

// Reads auth + identity state and hides the splash. Renders nothing —
// its only job is to side-effect on the flags. Lives outside the
// navigation tree so its re-renders don't churn the Stack.
//
// Stage C: the splash now holds for (a) the font settle — the member
// tree's Archivo/Figtree faces; `fontsReady` is true once they load OR
// fail, so a font failure can never wedge boot — and (b) the identity
// resolution, so the entry redirect (app/index.jsx) lands in the right
// shell with no flash of the wrong one. Resolution is time-boxed inside
// IdentityProvider, so this cannot hang either.
function SplashGate({ fontsReady }) {
  const { session, loading } = useAuth()
  const { resolving } = useIdentity()
  useEffect(() => {
    if (loading || !fontsReady) return
    if (session && resolving) return
    SplashScreen.hideAsync()
  }, [loading, fontsReady, session, resolving])
  return null
}

// NOTIF.2 + PHASE2 stage C — ONE tap router for both shells. The payload's
// `data.type` is looked up in the STAFF map first (lib/notification-nav.js),
// then the member map (lib/member/notification-nav.js) — the merged
// decision is pure + unit-tested (lib/notification-side.js) and carries
// the OWNING SIDE. Before deep-linking we FLIP the persisted last-side to
// the owner, so the next boot lands in the shell the user was just pushed
// into. Staff taps keep today's router.push; a member tap replaces (the
// user lands in the other shell — back-navigating into the staff stack
// from a member push would be wrong). Kiosk/impersonation never receive
// member pushes (registration is guarded), and unknown types keep the
// log-only behaviour.
//
// Cold-start taps (killed state) are replayed once via
// getLastNotificationResponseAsync, guarded by a ref so hourly
// TOKEN_REFRESHED session churn can't re-yank the user (champ's fix).
function NotificationRouter() {
  const router = useRouter()
  const { session, loading } = useAuth()
  const coldStartHandled = useRef(false)

  useEffect(() => {
    if (loading || !session) return

    async function handle(response) {
      const data = response?.notification?.request?.content?.data
      if (!data) return
      const resolved = resolveNotificationTap(data)
      if (resolved === null) return // known type, deliberately no navigation
      if (resolved === undefined) {
        // A data.type this build doesn't know — log it so the gap
        // surfaces instead of a silent dead tap.
        console.error('[notif-router] unhandled push type', data.type)
        return
      }
      // Persist the owning side BEFORE navigating so a crash-after-nav
      // still boots into the right shell.
      await writeLastSide(resolved.side).catch(() => {})
      if (resolved.side === 'member') router.replace(resolved.path)
      else router.push(resolved.path)
    }

    // Cold-start: replay the last tap that opened the app — at most once
    // per launch.
    let cancelled = false
    if (!coldStartHandled.current) {
      coldStartHandled.current = true
      Notifications.getLastNotificationResponseAsync().then(r => {
        if (!cancelled && r) handle(r)
      }).catch(() => { /* best-effort */ })
    }

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
  // Settled = loaded OR errored — EITHER counts, so a font-load failure can
  // never wedge boot. Stage C: SplashGate consumes this (the member tree's
  // brand faces should be up before its shell paints; staff simply gets the
  // same settle-guarantee it already had).
  const fontsReady = fontsLoaded || !!fontError

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <RootErrorBoundary>
      <SafeAreaProvider>
        <AuthProvider>
          <IdentityProvider>
          <StudioPinProvider>
          <BiometricLockProvider>
            <StatusBar style="dark" />
            <SplashGate fontsReady={fontsReady} />
            <NotificationRouter />
            <GeofenceSync />
            <ForegroundOtaUpdater />
            {/* PHASE2 (one-app merge) — two route groups: (staff) carries the
                ENTIRE pre-merge staff app (its Stack — moved verbatim — lives
                in app/(staff)/_layout.jsx; group folders add no URL segment so
                every staff path and push deep link is byte-identical), and
                (member) carries the ported Graft member tree. Stage C: the
                resolver (app/index.jsx + IdentityProvider) owns entry. */}
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
          </IdentityProvider>
        </AuthProvider>
      </SafeAreaProvider>
      </RootErrorBoundary>
    </GestureHandlerRootView>
  )
}
