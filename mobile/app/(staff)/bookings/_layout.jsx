// NOTIF.2 — booking detail stack. Sits outside (tabs) because we
// only want the bottom bar visible on the Bookings tab itself, not
// on detail pages.

import { Stack } from 'expo-router'

export default function BookingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      <Stack.Screen name="[id]" options={{ title: 'Booking' }} />
    </Stack>
  )
}
