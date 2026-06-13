// STUDIO-HUB.1 — TV displays stack. Lives outside (tabs) so the bottom
// tab bar hides; reached from the Studio hub's TV tile.

import { Stack } from 'expo-router'

export default function TvLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'TV displays' }} />
    </Stack>
  )
}
