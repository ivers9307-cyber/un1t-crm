// EQUIP-MAINT.2 — stack header for the equipment inspection
// walk-round on mobile.
//
// Two screens stack here:
//   index → due list (what needs inspecting + what's out of service)
//   [id]  → the run itself (tick items, attach photos, submit)
//
// Reachable only from the dashboard's DueInspectionsCard — there is
// no More-tab tile, same as checklists/today.jsx (a coach only sees
// this when there's something to do).

import { Stack } from 'expo-router'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function MaintenanceLayout() {
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: '#0B0F19' },
      headerTintColor: '#FFFFFF',
      headerTitleStyle: { fontWeight: 'bold' },
    }}>
      <Stack.Screen
        name="index"
        options={{
          title: 'Equipment due',
          headerLeft: () => <BackHeaderLeft label="Home" fallbackHref="/(tabs)" tint="#FFFFFF" />,
        }}
      />
      <Stack.Screen name="[id]" options={{ title: 'Inspection' }} />
    </Stack>
  )
}
