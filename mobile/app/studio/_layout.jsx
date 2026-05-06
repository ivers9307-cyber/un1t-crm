// Stack layout for /studio. Single screen today (door unlock + AC),
// but the stack lets future on-site actions (alarm, cameras, etc.)
// drill into sub-routes without restructuring.

import { Stack } from 'expo-router'

export default function StudioLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Studio management' }} />
    </Stack>
  )
}
