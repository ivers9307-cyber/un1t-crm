// Pipeline detail stack — pushed from the Pipeline tab. Standard iOS
// push-style navigation (not modal) so back-swipe and the breadcrumb
// header work naturally.

import { Stack } from 'expo-router'

export default function PipelineLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Pipeline',
      }}
    />
  )
}
