// WhatsApp conversation stack — push from the inbox tab. iOS-native
// back-swipe and breadcrumb header.

import { Stack } from 'expo-router'

export default function WhatsAppLayout() {
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
