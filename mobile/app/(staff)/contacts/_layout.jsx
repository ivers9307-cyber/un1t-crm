// W1 — contacts section stack (search/list + detail). Light header,
// matching the staff section. Reached from More, outside the tab bar.
import { Stack } from 'expo-router'

export default function ContactsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    />
  )
}
