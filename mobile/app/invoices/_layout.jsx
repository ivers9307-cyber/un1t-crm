// Stack layout for the invoices subtree (detail + new). The
// (tabs)/invoices.jsx is the list root and pushes into these
// child routes.

import { Stack } from 'expo-router'

export default function InvoicesLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="[id]" options={{ title: 'Invoice' }} />
      <Stack.Screen name="new" options={{ title: 'New invoice', presentation: 'modal' }} />
    </Stack>
  )
}
