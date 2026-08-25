// Stack layout for the cars subtree (list + detail). Reached from the
// More launcher (/cars). Light header; each screen supplies its own title
// + BackHeaderLeft (the list crosses the tab→stack navigator boundary, so
// iOS won't auto-render a chevron).
import { Stack } from 'expo-router'

export default function CarsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Cars' }} />
      <Stack.Screen name="[id]" options={{ title: 'Car' }} />
    </Stack>
  )
}
