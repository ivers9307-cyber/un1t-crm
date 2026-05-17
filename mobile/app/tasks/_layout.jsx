// NOTIF.2 — task stack. List + detail.
//
// Lives outside (tabs) so the bottom tab bar hides on these screens
// — Tasks lives under More, not as a primary tab.

import { Stack } from 'expo-router'

export default function TasksLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Your tasks' }} />
      <Stack.Screen name="[id]" options={{ title: 'Task' }} />
    </Stack>
  )
}
