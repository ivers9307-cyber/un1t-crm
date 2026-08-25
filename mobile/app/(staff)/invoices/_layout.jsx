// Stack layout for the invoices subtree (detail + new). The
// (tabs)/invoices.jsx is the list root and pushes into these
// child routes.
//
// MOBILE-A11Y-REDUCED-MOTION — only the 'new' screen is modal, so
// only it carries the motion-aware animation override. The detail
// screen uses the default push-from-right, which iOS already
// honours Reduce Motion for at the OS level.

import { Stack } from 'expo-router'
import { useReducedMotion, motionAwareStackOptions } from '../../../lib/use-reduced-motion'

export default function InvoicesLayout() {
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
      <Stack.Screen name="[id]" options={{ title: 'Invoice' }} />
      <Stack.Screen
        name="new"
        options={motionAwareStackOptions({ title: 'New invoice', presentation: 'modal' }, reduceMotion)}
      />
    </Stack>
  )
}
