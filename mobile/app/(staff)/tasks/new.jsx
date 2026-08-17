// W1 Tasks — create & assign a task from mobile. Any user with the Tasks
// surface can create one (matches the web, where Tasks isn't manager-
// gated). Assign to yourself (default) or a colleague at the active
// studio. Writes via tasks-api.createTask (direct Supabase, the same RLS
// path the web TasksPage uses). On save it lands on the assignee's "Your
// tasks" list; a self-assigned task shows up on yours immediately.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, TextInput } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { sdk } from '../../../lib/sdk'
import { createTask } from '../../../lib/tasks-api'
import { isoDate, addDays } from '../../../lib/dates'
import { Button } from '../../../components/ui'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

const PRIORITIES = [
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
  { key: 'urgent', label: 'Urgent' },
]

function Pills({ options, value, onChange }) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {options.map(opt => {
        const active = value === opt.key
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            className={`rounded-xl px-3 py-2 ${active ? 'bg-un1t-accent' : 'bg-un1t-surface border border-un1t-border'}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text className={`text-sm font-medium ${active ? 'text-white' : 'text-un1t-subtle'}`}>{opt.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export default function TaskNew() {
  const { activeLocation, profile } = useAuth()
  const router = useRouter()

  const [subject, setSubject] = useState('')
  const [assigneeId, setAssigneeId] = useState(profile?.id || null)
  const [priority, setPriority] = useState('medium')
  const [hasDue, setHasDue] = useState(false)
  const [dueDate, setDueDate] = useState(isoDate(new Date()))
  const [colleagues, setColleagues] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Colleagues at the active studio for the assignee picker. Any role can
  // list the slim roster (GET /api/staff returns names to everyone), so
  // this works for a regular staff member, not just admins. Best-effort —
  // a failure just leaves "Me" as the only option.
  const loadColleagues = useCallback(async () => {
    const res = await sdk.staff.list()
    if (!res.success) return
    const here = (res.data || []).filter(s =>
      s.id !== profile?.id &&
      (s.profile_locations || []).some(pl => pl.location_id === activeLocation?.id)
    )
    setColleagues(here)
  }, [profile?.id, activeLocation?.id])

  useEffect(() => { loadColleagues() }, [loadColleagues])

  const assigneeOptions = [
    { key: profile?.id, label: `${profile?.full_name || 'Me'} · me` },
    ...colleagues.map(s => ({ key: s.id, label: s.full_name || s.email || 'Staff' })),
  ]

  const prettyDue = new Date(dueDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const today = isoDate(new Date())
  const stepDue = (n) => setDueDate(isoDate(addDays(new Date(dueDate + 'T00:00:00'), n)))

  const canSave = !!subject.trim() && !!activeLocation?.id && !saving

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    const res = await createTask({
      locationId: activeLocation.id,
      subject,
      assigneeId,
      priority,
      dueDate: hasDue ? dueDate : null,
    })
    setSaving(false)
    if (!res.success) { setError(res.error || 'Could not create task'); return }
    router.back()
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'New task', headerLeft: () => <BackHeaderLeft label="Tasks" fallbackHref="/tasks" /> }} />

      <ScrollView contentContainerClassName="px-4 pt-4 pb-10" keyboardShouldPersistTaps="handled">
        {error && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-500 text-sm">{error}</Text>
          </View>
        )}

        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">Task</Text>
        <TextInput
          value={subject}
          onChangeText={setSubject}
          placeholder="What needs doing?"
          placeholderTextColor="#94A3B8"
          multiline
          className="rounded-xl border border-un1t-border bg-white px-3 py-2 text-un1t-text mb-5"
        />

        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">Assign to</Text>
        <View className="mb-5">
          <Pills options={assigneeOptions} value={assigneeId} onChange={setAssigneeId} />
        </View>

        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">Priority</Text>
        <View className="mb-5">
          <Pills options={PRIORITIES} value={priority} onChange={setPriority} />
        </View>

        <View className="flex-row items-center justify-between px-1 mb-2">
          <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Due date</Text>
          <Pressable onPress={() => setHasDue(v => !v)} accessibilityRole="button">
            <Text className="text-xs font-semibold text-un1t-accent">{hasDue ? 'Clear' : 'Add'}</Text>
          </Pressable>
        </View>
        {hasDue && (
          <View className="flex-row items-center justify-between rounded-xl border border-un1t-border bg-white px-3 py-2 mb-5">
            <Pressable onPress={() => stepDue(-1)} disabled={dueDate <= today} hitSlop={8} className="px-3">
              <Text className={`text-xl ${dueDate <= today ? 'text-un1t-muted' : 'text-un1t-accent'}`}>−</Text>
            </Pressable>
            <Text className="text-sm font-medium text-un1t-text">{prettyDue}</Text>
            <Pressable onPress={() => stepDue(1)} hitSlop={8} className="px-3">
              <Text className="text-xl text-un1t-accent">+</Text>
            </Pressable>
          </View>
        )}

        <View className="mt-3">
          <Button
            label={saving ? 'Creating…' : 'Create task'}
            onPress={save}
            disabled={!canSave}
            loading={saving}
          />
        </View>
      </ScrollView>
    </View>
  )
}
