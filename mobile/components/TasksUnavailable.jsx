// C146 TASKSNEEDCONTACTS.1 — what a Tasks screen shows at a studio where
// canUseTasksHere (lib/tasks-access.js) says no. The More tile is already
// gone there; this covers the ways in that skip it (a task-reminder push,
// a deep link, a screen left open across a studio switch). Nothing is
// loaded and nothing can be written.
import { View, Text } from 'react-native'
import { Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import BackHeaderLeft from './BackHeaderLeft'

export default function TasksUnavailable({ title = 'Tasks', backLabel = 'Back', fallbackHref = '/(tabs)/more' }) {
  return (
    <View className="flex-1 bg-un1t-bg items-center justify-center px-8">
      <Stack.Screen
        options={{
          title,
          headerLeft: () => <BackHeaderLeft label={backLabel} fallbackHref={fallbackHref} />,
          headerRight: () => null,
        }}
      />
      <Ionicons name="lock-closed-outline" size={28} color="#94A3B8" />
      <Text className="text-base font-semibold text-un1t-text mt-3 text-center">
        Tasks are off at this studio
      </Text>
      <Text className="text-xs text-un1t-subtle text-center mt-1">
        Tasks need Contacts access here. Ask an admin, or switch studio.
      </Text>
    </View>
  )
}
