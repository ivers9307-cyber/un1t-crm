// Explicit back chevron for stack screens that are the ONLY screen
// in their sub-stack.
//
// iOS auto-renders a back chevron only when the *current* navigator
// has a previous screen. For our app, screens like /bookings/[id],
// /tasks/[id], /pipeline/[dealId], /whatsapp/[conversationId] etc.
// are pushed from the (tabs) navigator into their own single-screen
// sub-stack — so the "current navigator" has no previous screen and
// no chevron renders. Swipe-back still works (the gesture targets
// the parent stack) but discoverability suffers.
//
// Drop this into the screen's <Stack.Screen options={{ headerLeft }}>
// to render a chevron + label that calls router.back(). If we're
// the root of the stack (eg. cold-start deep-link from a push
// notification), router.canGoBack() is false — fall back to the
// `fallbackHref` so the user lands somewhere sensible instead of
// nowhere.
//
// History: extracted from inline copies in pipeline/[dealId].jsx +
// whatsapp/[conversationId].jsx (d442a36, Apr 30) — same problem
// re-occurred on Tasks + Bookings (NOTIF.2). Centralising so the
// next single-screen sub-stack inherits the convention.

import { Pressable, Text } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'

export default function BackHeaderLeft({ label = 'Back', fallbackHref = '/' }) {
  const router = useRouter()
  return (
    <Pressable
      onPress={() => {
        if (router.canGoBack && router.canGoBack()) router.back()
        else router.replace(fallbackHref)
      }}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="flex-row items-center -ml-1"
    >
      <Ionicons name="chevron-back" size={26} color="#111827" />
      <Text className="text-base text-un1t-text">{label}</Text>
    </Pressable>
  )
}
