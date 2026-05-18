// Stack layout for the policies subtree. Same shape as
// contracts/_layout.jsx — /policies is the root list, /policies/[slug]
// pushes the viewer.

import { Stack } from 'expo-router'

export default function PoliciesLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Policies' }} />
      <Stack.Screen name="[slug]" options={{ title: 'Policy' }} />
    </Stack>
  )
}
