// Email conversation stack — push from the Messages tab. iOS-native
// back-swipe and breadcrumb header (same shell as whatsapp/_layout).

import { Stack } from 'expo-router'

export default function EmailLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Inbox',
      }}
    />
  )
}
