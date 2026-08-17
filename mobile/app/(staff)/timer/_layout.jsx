// CLASS-TIMER PR3 — class-timer control stack.
//
// Lives outside (tabs) so the bottom tab bar hides on this screen — the timer
// lives under Studio, not as a primary tab (same shape as /ac and /doors).

import { Stack } from 'expo-router'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function TimerLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      {/* Pushed from the Studio hub (a different navigator) → iOS shows no
          auto back chevron, so supply one explicitly. */}
      <Stack.Screen
        name="index"
        options={{ title: 'Class timer', headerLeft: () => <BackHeaderLeft label="Studio" fallbackHref="/studio" /> }}
      />
    </Stack>
  )
}
