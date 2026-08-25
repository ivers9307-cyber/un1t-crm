// SHELLY-MOB.1 — Smart plugs stack.
//
// Lives outside (tabs) so the bottom tab bar hides on this screen — it is
// reached from the Studio hub, not as a primary tab (same shape as sonos/, ac/).

import { Stack } from 'expo-router'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function ShellyLayout() {
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
        options={{ title: 'Smart plugs', headerLeft: () => <BackHeaderLeft label="Studio" fallbackHref="/studio" /> }}
      />
    </Stack>
  )
}
