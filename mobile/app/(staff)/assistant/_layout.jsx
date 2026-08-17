// MOBILE-ASSISTANT.1 — AI assistant chat stack. Single screen.
//
// Lives outside (tabs) so the bottom tab bar hides here — the assistant
// is reached from More, not a primary tab.

import { Stack } from 'expo-router'

export default function AssistantLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'AI Assistant' }} />
    </Stack>
  )
}
