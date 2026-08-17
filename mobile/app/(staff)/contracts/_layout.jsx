// Stack layout for the contracts subtree. Same pattern as
// invoices/_layout.jsx — list at /contracts is the root, detail
// pushes /contracts/[id] which opens with the sign sheet for
// pending contracts.

import { Stack } from 'expo-router'

export default function ContractsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Your contracts' }} />
      <Stack.Screen name="[id]" options={{ title: 'Contract' }} />
    </Stack>
  )
}
