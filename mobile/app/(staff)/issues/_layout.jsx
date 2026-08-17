// REPORT-ISSUE.1 — stack header for the issues flow on mobile.
//
// Three screens stack here:
//   index.jsx     → list of own submissions (newest first)
//   new.jsx       → submit form (modal-presented from More)
//   [id].jsx      → drill-in (read-only, shows photos + resolution)

import { Stack } from 'expo-router'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function IssuesLayout() {
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: '#0B0F19' },
      headerTintColor: '#FFFFFF',
      headerTitleStyle: { fontWeight: 'bold' },
    }}>
      <Stack.Screen
        name="hub"
        options={{
          title: 'Reports',
          headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" tint="#FFFFFF" />,
        }}
      />
      <Stack.Screen
        name="index"
        options={{
          title: 'My reports',
          headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" tint="#FFFFFF" />,
        }}
      />
      <Stack.Screen
        name="new"
        options={{
          title: 'Report a problem',
          presentation: 'modal',
          headerLeft: () => <BackHeaderLeft label="Close" fallbackHref="/(tabs)/more" tint="#FFFFFF" />,
        }}
      />
      <Stack.Screen name="[id]" options={{ title: 'Report details' }} />
    </Stack>
  )
}
