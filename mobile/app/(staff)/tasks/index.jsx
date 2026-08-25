// NOTIF.2 — Tasks list screen.
//
// Tasks assigned to the signed-in user at the active location.
// Filter toggle: Open (todo + in_progress) | All (incl. done). Tap
// a row to drill into detail; from detail you can mark done.
//
// Sort: due date asc (overdue floats to the top because today
// > yesterday by string-compare on ISO dates), then priority asc.

import { useState, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator,
} from 'react-native'
import { useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { listMyTasks, statusLabel } from '../../../lib/tasks-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'
import TabletConstrained from '../../../components/TabletConstrained'

const PRIORITY_COLOR = {
  urgent: '#DC2626',
  high:   '#F97316',
  medium: '#EAB308',
  low:    '#94A3B8',
}

function isOverdue(due_date) {
  if (!due_date) return false
  return due_date < new Date().toISOString().slice(0, 10)
}

function TaskRow({ task, onPress }) {
  const overdue = isOverdue(task.due_date) && task.status !== 'done'
  const priorityDot = PRIORITY_COLOR[task.priority]
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
    >
      <View className="flex-row items-start">
        <View
          className="w-2 h-2 rounded-full mt-1.5 mr-2.5"
          style={{ backgroundColor: priorityDot || '#475569' }}
        />
        <View className="flex-1">
          <Text className="text-base font-semibold text-un1t-text" numberOfLines={2}>
            {task.subject}
          </Text>
          <View className="flex-row items-center mt-1 flex-wrap">
            <View className={`px-2 py-0.5 rounded-full ${
              task.status === 'in_progress' ? 'bg-blue-500/20' :
              task.status === 'done'        ? 'bg-emerald-500/20' :
                                              'bg-un1t-border/40'
            }`}>
              <Text className={`text-[10px] uppercase font-medium ${
                task.status === 'in_progress' ? 'text-blue-700' :
                task.status === 'done'        ? 'text-emerald-700' :
                                                'text-un1t-subtle'
              }`}>{statusLabel(task.status)}</Text>
            </View>
            {task.due_date && (
              <View className="flex-row items-center ml-2">
                <Ionicons
                  name="calendar-outline"
                  size={12}
                  color={overdue ? '#DC2626' : '#94A3B8'}
                />
                <Text className={`text-[11px] ml-1 ${overdue ? 'text-red-500 font-semibold' : 'text-un1t-subtle'}`}>
                  {task.due_date}{task.due_time ? ` · ${String(task.due_time).slice(0,5)}` : ''}
                  {overdue ? ' · overdue' : ''}
                </Text>
              </View>
            )}
            {task.project && (
              <Text className="text-[11px] text-un1t-muted ml-2">#{task.project}</Text>
            )}
          </View>
          {task.contact && (
            <Text className="text-xs text-un1t-subtle mt-1">
              {task.contact.first_name} {task.contact.last_name}
            </Text>
          )}
        </View>
        <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
      </View>
    </Pressable>
  )
}

export default function TasksIndex() {
  const { activeLocation, profile } = useAuth()
  const router = useRouter()
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('open') // 'open' | 'all'

  const load = useCallback(async () => {
    if (!activeLocation || !profile) return
    setError(null)
    const res = await listMyTasks({
      locationId: activeLocation.id,
      profileId: profile.id,
      includeDone: filter === 'all',
    })
    if (!res.success) setError(res.error || 'Failed to load tasks')
    setTasks(res.success ? res.data : [])
  }, [activeLocation, profile, filter])

  // Refetch on focus so a task just created (and self-assigned) shows up
  // on return. Silent on re-focus — the spinner only shows on first load
  // while `loading` is still true.
  useFocusEffect(
    useCallback(() => {
      load().finally(() => setLoading(false))
    }, [load])
  )

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const openCount = useMemo(() =>
    tasks.filter(t => t.status === 'todo' || t.status === 'in_progress').length,
    [tasks]
  )

  return (
    <TabletConstrained className="flex-1 bg-un1t-bg">
      {/* tasks/ is a single-screen sub-stack pushed from /more,
          so iOS won't auto-render a back chevron — opt in. */}
      <Stack.Screen
        options={{
          title: 'Your tasks',
          headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" />,
          headerRight: () => (
            <Pressable onPress={() => router.push('/tasks/new')} hitSlop={8} accessibilityRole="button" accessibilityLabel="New task">
              <Ionicons name="add" size={26} color="#1E293B" />
            </Pressable>
          ),
        }}
      />
      <View className="flex-row gap-2 px-4 pt-3 pb-2">
        <Pressable
          onPress={() => setFilter('open')}
          className={`px-3 py-1.5 rounded-full border ${
            filter === 'open'
              ? 'bg-un1t-text border-un1t-text'
              : 'bg-un1t-surface border-un1t-border'
          }`}
        >
          <Text className={`text-xs font-medium ${
            filter === 'open' ? 'text-un1t-bg' : 'text-un1t-subtle'
          }`}>Open{filter === 'open' ? ` · ${openCount}` : ''}</Text>
        </Pressable>
        <Pressable
          onPress={() => setFilter('all')}
          className={`px-3 py-1.5 rounded-full border ${
            filter === 'all'
              ? 'bg-un1t-text border-un1t-text'
              : 'bg-un1t-surface border-un1t-border'
          }`}
        >
          <Text className={`text-xs font-medium ${
            filter === 'all' ? 'text-un1t-bg' : 'text-un1t-subtle'
          }`}>All</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerClassName="px-4 pb-10"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />
        }
      >
        {error && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-500 text-sm">{error}</Text>
          </View>
        )}

        {loading ? (
          <View className="py-12 items-center">
            <ActivityIndicator />
          </View>
        ) : tasks.length === 0 ? (
          <View className="py-16 items-center px-6">
            <Ionicons name="checkmark-done-circle-outline" size={32} color="#10B981" />
            <Text className="text-base font-semibold text-un1t-text mt-3">
              {filter === 'open' ? 'No open tasks' : 'No tasks'}
            </Text>
            <Text className="text-xs text-un1t-subtle text-center mt-1">
              Tap + to create a task, or pull down to refresh.
            </Text>
          </View>
        ) : (
          tasks.map(t => (
            <TaskRow
              key={t.id}
              task={t}
              onPress={() => router.push(`/tasks/${t.id}`)}
            />
          ))
        )}
      </ScrollView>
    </TabletConstrained>
  )
}
