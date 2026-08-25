// FTE-EXPENSES.2 (mobile) — stack layout for the expenses subtree.
// new.jsx is presented modally (sheet-style on iOS) so the create-
// claim flow feels distinct from the tab; [id].jsx pushes from the
// right in the usual stack style.

import { Stack } from 'expo-router'
import { useReducedMotion, motionAwareStackOptions } from '../../../lib/use-reduced-motion'

export default function ExpensesLayout() {
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
      <Stack.Screen name="[id]" options={{ title: 'Claim' }} />
      <Stack.Screen
        name="new"
        options={motionAwareStackOptions({ title: 'New claim', presentation: 'modal' }, reduceMotion)}
      />
    </Stack>
  )
}
