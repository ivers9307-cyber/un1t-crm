// SPEND.P3 (mobile) — stack layout for the company-card-receipts
// subtree. new.jsx is presented modally (sheet-style on iOS) so the
// capture flow feels distinct from the list; [id].jsx pushes from the
// right in the usual stack style.
//
// MOBILE-A11Y-REDUCED-MOTION — only the 'new' screen is modal, so only
// it carries the motion-aware animation override. The detail screen
// uses the default push-from-right, which iOS already honours Reduce
// Motion for at the OS level.

import { Stack } from 'expo-router'
import { useReducedMotion, motionAwareStackOptions } from '../../../lib/use-reduced-motion'

export default function CardReceiptsLayout() {
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
      <Stack.Screen name="index" options={{ title: 'Card receipts' }} />
      <Stack.Screen name="[id]" options={{ title: 'Receipt' }} />
      <Stack.Screen
        name="new"
        options={motionAwareStackOptions({ title: 'New receipt', presentation: 'modal' }, reduceMotion)}
      />
    </Stack>
  )
}
