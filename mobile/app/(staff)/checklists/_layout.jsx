// CHECKLIST.2 — stack header for the coach's checklist drill-in.
// Single screen for now (today.jsx); PR 3 may add a history
// browser for owners to look back.

import { Stack } from 'expo-router'

export default function ChecklistsLayout() {
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: '#0B0F19' },
      headerTintColor: '#FFFFFF',
      headerTitleStyle: { fontWeight: 'bold' },
    }}>
      <Stack.Screen name="today" options={{ title: "Today's checklist" }} />
    </Stack>
  )
}
