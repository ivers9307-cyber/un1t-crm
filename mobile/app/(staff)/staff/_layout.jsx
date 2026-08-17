// STAFF-C1 — staff section stack. Covers the directory (index), the
// member detail ([id]), and the editors (edit/[id], roles/[id]).
//
// Lives outside (tabs) so the bottom tab bar hides here — staff is
// reached from More, not a primary tab. Crucially this enables the
// native header (the root Stack is headerShown:false), which renders
// each screen's title + back button AND offsets content below the
// status bar / Dynamic Island. Without this layout the screens
// inherited the headerless root stack and rendered edge-to-edge under
// the notch. Mirrors app/radar/_layout.jsx.
import { Stack } from 'expo-router'

export default function StaffLayout() {
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
