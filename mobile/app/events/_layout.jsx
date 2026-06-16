// Stack layout for the mobile events browse surface (EVENT-CHECKIN.E).
// Reached from the More launcher (/events). Each screen sets its own
// title + BackHeaderLeft. Mirrors mobile/app/races/_layout.jsx.
import { Stack } from 'expo-router'

export default function EventsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Events' }} />
      <Stack.Screen name="[id]" options={{ title: 'Event' }} />
    </Stack>
  )
}
