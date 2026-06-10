// Stack layout for race-day control (picker + control board). Reached from
// the More launcher (/races). Light header; each screen supplies its own
// title + BackHeaderLeft (the picker crosses the tab→stack boundary).
import { Stack } from 'expo-router'

export default function RacesLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Races' }} />
      <Stack.Screen name="[id]" options={{ title: 'Race control' }} />
    </Stack>
  )
}
