// Modal-style stack for schedule sub-screens (time-off request etc.).
// Presenting as iOS modal sheets matches the native feel — drag-down
// to dismiss, sheet animation, header with Cancel and Save.
//
// MOBILE-A11Y-REDUCED-MOTION — when the user has iOS Reduce Motion
// enabled, the slide-up sheet is downgraded to a cross-fade via the
// motionAwareStackOptions helper. iOS handles this at OS level for
// system modals, but expo-router's native-stack wraps that with its
// own animation prop — gating it through the hook makes the
// behaviour explicit and survives expo-router upgrades that might
// change the default.

import { Stack } from 'expo-router'
import { useReducedMotion, motionAwareStackOptions } from '../../../lib/use-reduced-motion'

export default function ScheduleLayout() {
  const reduceMotion = useReducedMotion()
  return (
    <Stack
      screenOptions={motionAwareStackOptions({
        presentation: 'modal',
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
      }, reduceMotion)}
    />
  )
}
