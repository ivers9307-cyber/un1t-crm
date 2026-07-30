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
import { AuthProvider, useAuth } from '../lib/auth-context'
// GEO-ATT — importing from lib/geofence also runs its module top-level
// TaskManager.defineTask, so the background geofence task is registered
// on every launch (including headless OS relaunches for region events).
import { syncGeofences } from '../lib/geofence'
import { routeForNotification } from '../lib/notification-nav'
import { ForegroundOtaUpdater } from '../lib/foreground-ota'
import { BiometricLockProvider } from '../lib/biometric-lock'
import { StudioPinProvider } from '../lib/studio-pin'
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
  useFonts({
    Poppins_400Regular,
    Poppins_600SemiBold,
    Poppins_700Bold,
    Poppins_800ExtraBold,
  })

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
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="tasks" options={{ headerShown: false }} />
              <Stack.Screen name="bookings" options={{ headerShown: false }} />
              <Stack.Screen name="radar" options={{ headerShown: false }} />
              <Stack.Screen name="assistant" options={{ headerShown: false }} />
              <Stack.Screen name="staff" options={{ headerShown: false }} />
              <Stack.Screen name="cars" options={{ headerShown: false }} />
              <Stack.Screen name="races" options={{ headerShown: false }} />
              {/* Single-file routes have no folder _layout to host a header,
                  so enable the native header here (each screen still supplies
                  its own title + BackHeaderLeft). Without this they inherit
                  the headerless root stack and render under the status bar —
                  the same bug the folder sections fix via their _layout.jsx. */}
              <Stack.Screen name="approvals" options={{ headerShown: true, headerStyle: { backgroundColor: '#FFFFFF' }, headerTitleStyle: { fontWeight: '600' }, headerTintColor: '#111827' }} />
              <Stack.Screen name="customise-bar" options={{ headerShown: true, headerStyle: { backgroundColor: '#FFFFFF' }, headerTitleStyle: { fontWeight: '600' }, headerTintColor: '#111827' }} />
              <Stack.Screen name="location-features" options={{ headerShown: true, headerStyle: { backgroundColor: '#FFFFFF' }, headerTitleStyle: { fontWeight: '600' }, headerTintColor: '#111827' }} />
              <Stack.Screen name="orders" options={{ headerShown: true, headerStyle: { backgroundColor: '#FFFFFF' }, headerTitleStyle: { fontWeight: '600' }, headerTintColor: '#111827' }} />
              <Stack.Screen name="accounting" options={{ headerShown: true, headerStyle: { backgroundColor: '#FFFFFF' }, headerTitleStyle: { fontWeight: '600' }, headerTintColor: '#111827' }} />
              <Stack.Screen name="events" options={{ headerShown: false }} />
            </Stack>
          </BiometricLockProvider>
          </StudioPinProvider>
        </AuthProvider>
      </SafeAreaProvider>
      </RootErrorBoundary>
    </GestureHandlerRootView>
  )
}
