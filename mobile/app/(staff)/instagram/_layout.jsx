// Instagram conversation stack — push from the inbox tab. iOS-native
// back-swipe and breadcrumb header, mirroring the WhatsApp stack.
//
// IG-NAV.1 — this file did not exist, so the route inherited the root
// layout's `screenOptions={{ headerShown: false }}` and `instagram` had no
// entry there to override it. The thread screen sets a title, a back button
// and a resolve action via <Stack.Screen options>, and none of them rendered:
// the thread drew from pixel zero, so its "You're handling this" banner sat
// under the status bar and the Dynamic Island. useHeaderHeight() also
// returned 0, which put the keyboard offset out by a header's height.

import { Stack } from 'expo-router'

export default function InstagramLayout() {
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
