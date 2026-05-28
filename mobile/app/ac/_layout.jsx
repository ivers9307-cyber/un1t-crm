// MOBILE-AC.1 — AC control stack.
//
// Lives outside (tabs) so the bottom tab bar hides on this screen
// — AC lives under More, not as a primary tab.

import { Stack } from 'expo-router'

export default function AcLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Air conditioning' }} />
    </Stack>
  )
}
