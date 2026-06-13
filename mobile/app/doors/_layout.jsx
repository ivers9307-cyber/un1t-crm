// STUDIO-HUB.1 — Door unlock stack. Lives outside (tabs) so the bottom
// tab bar hides; reached from the Studio hub's Door tile.

import { Stack } from 'expo-router'

export default function DoorsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Door unlock' }} />
    </Stack>
  )
}
