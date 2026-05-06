// Stack layout for the impersonate picker. Single-screen subtree —
// the More-tab row pushes /impersonate which renders the search +
// reason form. We use a modal presentation so the tab bar fades and
// the picker feels distinct from the rest of the app, mirroring the
// web modal-style picker.

import { Stack } from 'expo-router'

export default function ImpersonateLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: 'View as user', presentation: 'modal' }}
      />
    </Stack>
  )
}
