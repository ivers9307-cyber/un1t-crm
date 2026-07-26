// Stack layout for the Hyrox subtree — list at /hyrox is the root; a session
// pushes /hyrox/[id]. Same pattern as contracts/_layout.jsx.
import { Stack } from 'expo-router'

export default function HyroxLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Hyrox Training Club' }} />
      <Stack.Screen name="[id]" options={{ title: 'Session' }} />
    </Stack>
  )
}
