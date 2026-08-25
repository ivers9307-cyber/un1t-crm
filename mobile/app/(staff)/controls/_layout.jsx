// HOME-LOC.9 — Studio controls launcher stack (manual/remote entry from Home).
import { Stack } from 'expo-router'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function ControlsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: 'Studio controls', headerLeft: () => <BackHeaderLeft label="Home" fallbackHref="/" /> }}
      />
    </Stack>
  )
}
