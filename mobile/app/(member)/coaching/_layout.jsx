// Coaching stack — pushed from the Account tab.
//
// Three screens: the hub (index), the InBody body-composition detail, and the
// coach-feedback history. Headers are drawn in-screen (back chevron + title),
// so the native header stays hidden — matching the account/goals + challenges
// idiom.

import { Stack } from 'expo-router'

export default function CoachingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="inbody" />
      <Stack.Screen name="feedback" />
      <Stack.Screen name="photos" />
    </Stack>
  )
}
