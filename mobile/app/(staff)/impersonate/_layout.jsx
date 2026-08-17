// Stack layout for the impersonate picker. Single-screen subtree —
// the More-tab row pushes /impersonate which renders the search +
// reason form. We use a modal presentation so the tab bar fades and
// the picker feels distinct from the rest of the app, mirroring the
// web modal-style picker.
//
// MOBILE-A11Y-REDUCED-MOTION — the modal slide is downgraded to a
// cross-fade when iOS Reduce Motion is enabled.

import { Stack } from 'expo-router'
import { useReducedMotion, motionAwareStackOptions } from '../../../lib/use-reduced-motion'

export default function ImpersonateLayout() {
  const reduceMotion = useReducedMotion()
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen
        name="index"
        options={motionAwareStackOptions({ title: 'View as user', presentation: 'modal' }, reduceMotion)}
      />
    </Stack>
  )
}
