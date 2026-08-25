// MOBILE-AC.1 — AC control stack.
//
// Lives outside (tabs) so the bottom tab bar hides on this screen
// — AC lives under More, not as a primary tab.

import { Stack } from 'expo-router'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function AcLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      {/* Pushed from the Studio hub (a different navigator) → iOS shows
          no auto back chevron, so supply one explicitly. */}
      <Stack.Screen
        name="index"
        options={{ title: 'Air conditioning', headerLeft: () => <BackHeaderLeft label="Studio" fallbackHref="/studio" /> }}
      />
    </Stack>
  )
}
