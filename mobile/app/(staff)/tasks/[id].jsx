// NOTIF.2 — Task detail screen.
//
// Read-only metadata + a primary action button that cycles status
// (todo → in_progress → done). 'Cancel task' lives in a secondary
// destructive action for the rare case the task is no longer needed.
//
// This is the screen push-notification taps land on (via the
// task_id in the notification's data payload — wired in
// _layout.jsx's notification-response listener).

import { useEffect, useState, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, Alert,
  RefreshControl, Linking,
} from 'react-native'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { getTask, setTaskStatus, statusLabel, nextStatus } from '../../../lib/tasks-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

function StatusPill({ status }) {
  const tone =
    status === 'done'        ? { bg: 'bg-emerald-500/20', fg: 'text-emerald-700' } :
    status === 'in_progress' ? { bg: 'bg-blue-500/20',    fg: 'text-blue-700' } :
    status === 'cancelled'   ? { bg: 'bg-un1t-border/40',    fg: 'text-un1t-muted' } :
                               { bg: 'bg-amber-500/20',   fg: 'text-amber-700' }
  return (
    <View className={`px-2.5 py-1 rounded-full ${tone.bg} self-start`}>
      <Text className={`text-xs uppercase font-semibold ${tone.fg}`}>
        {statusLabel(status)}
      </Text>
    </View>
  )
}

export default function TaskDetail() {
  const { id } = useLocalSearchParams()
  const router = useRouter()
  const [task, setTask] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    const res = await getTask(String(id))
    if (!res.success) setError(res.error || 'Failed to load task')
    setTask(res.success ? res.data : null)
  }, [id])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  async function cycleStatus() {
    if (!task) return
    setBusy(true)
    const next = nextStatus(task.status)
    const res = await setTaskStatus(task.id, next)
    setBusy(false)
    if (res.success) setTask(res.data)
    else Alert.alert('Update failed', res.error || 'Unknown error')
  }

  async function cancelTask() {
    if (!task) return
    Alert.alert(
      'Cancel this task?',
      'It will move to "cancelled" and drop off the open list.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel task',
          style: 'destructive',
          onPress: async () => {
            setBusy(true)
            const res = await setTaskStatus(task.id, 'cancelled')
            setBusy(false)
            if (res.success) setTask(res.data)
            else Alert.alert('Update failed', res.error || 'Unknown error')
          },
        },
      ]
    )
  }

  // iOS auto-renders back when /tasks (index) is below us in the
  // stack — but a cold-start push notification tap lands here with
  // an empty stack and no chevron. The BackHeaderLeft fallback
  // replaces to /tasks in that case.
  const headerOptions = {
    headerLeft: () => <BackHeaderLeft label="Tasks" fallbackHref="/tasks" />,
  }

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <Stack.Screen options={{ ...headerOptions, title: 'Task' }} />
        <ActivityIndicator />
      </View>
    )
  }

  if (error || !task) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center px-6">
        <Stack.Screen options={{ ...headerOptions, title: 'Task' }} />
        <Ionicons name="alert-circle-outline" size={28} color="#DC2626" />
        <Text className="text-base text-un1t-text mt-2">{error || 'Task not found'}</Text>
        <Pressable
          onPress={() => router.back()}
          className="mt-4 px-4 py-2 rounded-full bg-un1t-surface border border-un1t-border"
        >
          <Text className="text-sm text-un1t-text">Go back</Text>
        </Pressable>
      </View>
    )
  }

  const ctaLabel = task.status === 'todo'        ? 'Start task'
                 : task.status === 'in_progress' ? 'Mark done'
                 : task.status === 'done'        ? 'Re-open'
                 :                                  'Restart'

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ ...headerOptions, title: task.subject || 'Task' }} />
      <ScrollView
        contentContainerClassName="px-4 pt-4 pb-32"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />
        }
      >
        <StatusPill status={task.status} />

        <Text className="text-2xl font-bold text-un1t-text mt-3">{task.subject}</Text>

        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mt-4">
          {task.due_date && (
            <View className="flex-row items-center mb-2">
              <Ionicons name="calendar-outline" size={16} color="#94A3B8" />
              <Text className="text-sm text-un1t-text ml-2">
                Due {task.due_date}{task.due_time ? ` · ${String(task.due_time).slice(0,5)}` : ''}
              </Text>
            </View>
          )}
          {task.priority && (
            <View className="flex-row items-center mb-2">
              <Ionicons name="flag-outline" size={16} color="#94A3B8" />
              <Text className="text-sm text-un1t-text ml-2 capitalize">
                {task.priority} priority
              </Text>
            </View>
          )}
          {task.project && (
            <View className="flex-row items-center mb-2">
              <Ionicons name="pricetag-outline" size={16} color="#94A3B8" />
              <Text className="text-sm text-un1t-text ml-2">#{task.project}</Text>
            </View>
          )}
          {/* Assignee row removed: mobile tasks are always the signed-in
              user's own (listMyTasks filters assignee_id = self), and the
              `authenticated` role has no SELECT grant on profiles — so the
              old `assignee:profiles` embed 500'd with "permission denied for
              table profiles". The name added nothing here. */}
        </View>

        {task.note && (
          <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mt-3">
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-1.5">Notes</Text>
            <Text className="text-sm text-un1t-text leading-5">{task.note}</Text>
          </View>
        )}

        {task.contact && (
          <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mt-3">
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-1.5">Contact</Text>
            <Text className="text-base text-un1t-text">
              {task.contact.first_name} {task.contact.last_name}
            </Text>
            <View className="flex-row gap-3 mt-2">
              {task.contact.phone && (
                <Pressable onPress={() => Linking.openURL(`tel:${task.contact.phone}`)}>
                  <Text className="text-sm text-blue-400">{task.contact.phone}</Text>
                </Pressable>
              )}
              {task.contact.email && (
                <Pressable onPress={() => Linking.openURL(`mailto:${task.contact.email}`)}>
                  <Text className="text-sm text-blue-400">{task.contact.email}</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}

        {task.completed_at && (
          <Text className="text-[11px] text-un1t-muted text-center mt-4">
            Completed {new Date(task.completed_at).toLocaleString()}
          </Text>
        )}
      </ScrollView>

      <View className="absolute bottom-0 inset-x-0 px-4 pb-8 pt-3 bg-un1t-bg border-t border-un1t-border">
        <Pressable
          onPress={cycleStatus}
          disabled={busy}
          className="bg-un1t-text active:opacity-80 disabled:opacity-50 px-4 py-3.5 rounded-xl items-center flex-row justify-center"
        >
          {busy
            ? <ActivityIndicator color="#111827" />
            : <Ionicons name={task.status === 'done' ? 'refresh' : 'checkmark'} size={18} color="#111827" />}
          <Text className="text-base font-semibold text-un1t-bg ml-2">
            {busy ? 'Saving…' : ctaLabel}
          </Text>
        </Pressable>
        {task.status !== 'cancelled' && task.status !== 'done' && (
          <Pressable
            onPress={cancelTask}
            disabled={busy}
            className="mt-2 active:opacity-70 px-4 py-2.5 rounded-xl items-center"
          >
            <Text className="text-sm text-red-500">Cancel task</Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}
