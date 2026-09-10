// WIDGET.1 (Phase 2, Task 5) — Settings stack. Lives outside (tabs) so the
// bottom tab bar hides; same shape as doors/ and sonos/ (reached by a push
// from the More tab, a different navigator, so no auto back chevron).
//
// One screen today (widgets); a folder rather than a single-file route
// because "Settings" reads as a section that will grow, not a one-off.

import { Stack } from 'expo-router'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      <Stack.Screen
        name="widgets"
        options={{ title: 'Home screen widgets', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }}
      />
    </Stack>
  )
}
