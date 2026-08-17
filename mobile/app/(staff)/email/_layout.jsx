// Email ticket stack — pushed from the Email tab (INBOX-SPLIT.M1; it was the
// Messages tab while email was a channel there). iOS-native back-swipe and
// breadcrumb header (same shell as whatsapp/_layout).

import { Stack } from 'expo-router'

export default function EmailLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Email',
      }}
    />
  )
}
