// Modal-style stack for schedule sub-screens (time-off request etc.).
// Presenting as iOS modal sheets matches the native feel — drag-down
// to dismiss, sheet animation, header with Cancel and Save.

import { Stack } from 'expo-router'

export default function ScheduleLayout() {
  return (
    <Stack
      screenOptions={{
        presentation: 'modal',
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
      }}
    />
  )
}
