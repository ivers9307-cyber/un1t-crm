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
import { AuthProvider, useAuth } from '../lib/auth-context'
import { BiometricLockProvider } from '../lib/biometric-lock'
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
// `type` ('task_reminder' | 'booking_reminder' | …) and the entity
// id. We also handle the *cold-start* case via
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
      switch (data.type) {
        case 'task_reminder':
          if (data.task_id) router.push(`/tasks/${data.task_id}`)
          break
        case 'booking_reminder':
          if (data.booking_id) router.push(`/bookings/${data.booking_id}`)
          break
        default:
          // Other categories (time_off, swap, contract_issued, etc.)
          // already have screen-level handlers or no-op deep links.
          break
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

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <RootErrorBoundary>
      <SafeAreaProvider>
        <AuthProvider>
          <BiometricLockProvider>
            <StatusBar style="dark" />
            <SplashGate />
            <NotificationRouter />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="tasks" options={{ headerShown: false }} />
              <Stack.Screen name="bookings" options={{ headerShown: false }} />
              <Stack.Screen name="radar" options={{ headerShown: false }} />
              <Stack.Screen name="staff" options={{ headerShown: false }} />
              {/* Single-file routes have no folder _layout to host a header,
                  so enable the native header here (each screen still supplies
                  its own title + BackHeaderLeft). Without this they inherit
                  the headerless root stack and render under the status bar —
                  the same bug the folder sections fix via their _layout.jsx. */}
              <Stack.Screen name="approvals" options={{ headerShown: true, headerStyle: { backgroundColor: '#FFFFFF' }, headerTitleStyle: { fontWeight: '600' }, headerTintColor: '#111827' }} />
              <Stack.Screen name="customise-bar" options={{ headerShown: true, headerStyle: { backgroundColor: '#FFFFFF' }, headerTitleStyle: { fontWeight: '600' }, headerTintColor: '#111827' }} />
              <Stack.Screen name="location-features" options={{ headerShown: true, headerStyle: { backgroundColor: '#FFFFFF' }, headerTitleStyle: { fontWeight: '600' }, headerTintColor: '#111827' }} />
            </Stack>
          </BiometricLockProvider>
        </AuthProvider>
      </SafeAreaProvider>
      </RootErrorBoundary>
    </GestureHandlerRootView>
  )
}
