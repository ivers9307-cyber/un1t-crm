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

import { Stack, SplashScreen } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useEffect } from 'react'
import { AuthProvider, useAuth } from '../lib/auth-context'

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

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="dark" />
          <SplashGate />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          </Stack>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
