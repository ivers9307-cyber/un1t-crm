// STUDIO-HUB.1 — TV displays stack. Lives outside (tabs) so the bottom
// tab bar hides; reached from the Studio hub's TV tile.

import { Stack } from 'expo-router'
import BackHeaderLeft from '../../components/BackHeaderLeft'

export default function TvLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      {/* Pushed from the Studio hub (a different navigator) → supply the
          back chevron explicitly (no auto chevron cross-navigator). */}
      <Stack.Screen
        name="index"
        options={{ title: 'TV displays', headerLeft: () => <BackHeaderLeft label="Studio" fallbackHref="/studio" /> }}
      />
    </Stack>
  )
}
