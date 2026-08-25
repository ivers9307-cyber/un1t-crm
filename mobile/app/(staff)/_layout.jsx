// PHASE2 (one-app merge, stage B) — the staff navigation stack, moved
// verbatim from the former root app/_layout.jsx <Stack> block. The (staff)
// route group adds NO URL segment, so every staff path (and therefore every
// push deep link) is byte-identical to before the move. Screen names below
// are this navigator's DIRECT children again — exactly as they were when
// this Stack lived at the root — so all the per-screen options keep applying.
//
// Providers (Auth, StudioPin, BiometricLock, gates, LocationGate overlay)
// stay in the root app/_layout.jsx, unchanged.

import { Stack } from 'expo-router'

export default function StaffLayout() {
  return (
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
  )
}
