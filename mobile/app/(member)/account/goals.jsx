// Goals screen — mirrors src/app/account/goals/{page,GoalsManager}.jsx.
//
// Queries (same as web):
//   contact_goals  — active rows (is_active, archived_at IS NULL), asc by created_at
//   heart_rate_sessions  — last 35 days, ended sessions only
//
// Mutations mirror GoalsManager.jsx exactly:
//   INSERT  contact_goals { contact_id, kind, target_value }
//   UPDATE  contact_goals SET target_value WHERE id        (edit)
//   UPDATE  contact_goals SET archived_at, is_active=false WHERE id  (archive)
//
// RLS (mig 117) grants the customer full CRUD on their own contact_goals rows.

import { useState, useCallback } from 'react'
import {
  View, Text, Pressable, ScrollView, TextInput, ActivityIndicator, Alert, RefreshControl,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../../lib/member/supabase'
import { useAuth } from '../../../lib/member/contact-context'
import Card from '../../../components/member/ui/Card'
import { GOAL_DEFS, GOAL_KINDS, computeProgress } from 'shared/goals'

// ── Main screen ──────────────────────────────────────────────────────────────

export default function Goals() {
  const router = useRouter()
  const { contact } = useAuth()

  const [goals, setGoals] = useState([])
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [mutError, setMutError] = useState(null)

  // ── Loader ─────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!contact?.id) return
    setLoading(true)
    setError(null)
    try {
      const sinceIso = new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString()
      const [{ data: goalRows, error: gErr }, { data: sessionRows, error: sErr }] =
        await Promise.all([
          supabase
            .from('contact_goals')
            .select('id, kind, target_value, is_active, created_at')
            .eq('contact_id', contact.id)
            .is('archived_at', null)
            .order('created_at', { ascending: true }),
          supabase
            .from('heart_rate_sessions')
            .select('started_at, effort_points, zones_seconds')
            .not('ended_at', 'is', null)
            .gte('started_at', sinceIso),
        ])
      if (gErr) throw gErr
      if (sErr) throw sErr
      setGoals(goalRows || [])
      setSessions(sessionRows || [])
    } catch (e) {
      setError(e?.message || 'Failed to load goals')
    } finally {
      setLoading(false)
    }
  }, [contact?.id])

  const refresh = useCallback(async () => {
    if (!contact?.id) return
    const { data } = await supabase
      .from('contact_goals')
      .select('id, kind, target_value, is_active, created_at')
      .eq('contact_id', contact.id)
      .is('archived_at', null)
      .order('created_at', { ascending: true })
    setGoals(data || [])
  }, [contact?.id])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  useFocusEffect(
    useCallback(() => { load() }, [load])
  )

  // ── Mutations (mirror GoalsManager.jsx) ────────────────────────────────────

  async function addGoal({ kind, target_value }) {
    setMutError(null)
    const { error: e } = await supabase
      .from('contact_goals')
      .insert({ contact_id: contact.id, kind, target_value })
    if (e) {
      setMutError(/duplicate key/i.test(e.message)
        ? 'You already have an active goal of this kind. Edit or archive it first.'
        : e.message)
      return
    }
    setAdding(false)
    await refresh()
  }

  async function updateGoal(id, target_value) {
    setMutError(null)
    const { error: e } = await supabase
      .from('contact_goals')
      .update({ target_value })
      .eq('id', id)
    if (e) setMutError(e.message)
    else await refresh()
  }

  async function archiveGoal(id) {
    Alert.alert(
      'Archive goal',
      'Archive this goal? You can set a new target after.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: async () => {
            const { error: e } = await supabase
              .from('contact_goals')
              .update({ archived_at: new Date().toISOString(), is_active: false })
              .eq('id', id)
            if (e) setMutError(e.message)
            else await refresh()
          },
        },
      ]
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const activeKinds = new Set(goals.map((g) => g.kind))
  const availableKinds = GOAL_KINDS.filter((k) => !activeKinds.has(k))

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView
        contentContainerClassName="p-5 pb-24"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#F1EEE7" />
        }
      >

        {/* Back */}
        <Pressable
          onPress={() => router.back()}
          className="flex-row items-center gap-1 mb-4 self-start active:opacity-60"
        >
          <Ionicons name="chevron-back-outline" size={18} color="#B3B2AC" />
          <Text className="text-sm font-body text-chalk-2">Back</Text>
        </Pressable>

        {/* Header */}
        <Text className="text-2xl font-display-bold text-chalk">Goals</Text>
        <Text className="mt-1 text-sm font-body text-chalk-2">
          Pick a target, watch it tick up every class.
        </Text>

        {/* Mutation error banner */}
        {mutError ? (
          <View className="mt-4 rounded-xl border border-iron-hairline bg-iron-surface p-3">
            <Text className="text-sm font-body" style={{ color: '#FF4E42' }}>{mutError}</Text>
          </View>
        ) : null}

        {loading ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#F1EEE7" size="large" />
          </View>
        ) : error ? (
          <Card className="mt-6">
            <Text className="text-sm font-body text-chalk-2">
              Couldn't load goals. Pull to retry.
            </Text>
          </Card>
        ) : (
          <View className="mt-6 gap-3">
            {/* Empty state with CTA */}
            {goals.length === 0 && !adding && (
              <View className="rounded-[20px] border border-dashed border-iron-hairline p-6 items-center">
                <Ionicons name="flag-outline" size={20} color="#727170" />
                <Text className="mt-2 text-sm font-body text-chalk-2 text-center">
                  No goals yet. Set one to track week-over-week progress.
                </Text>
                <Pressable
                  onPress={() => setAdding(true)}
                  className="mt-4 flex-row items-center gap-1 rounded-xl bg-chalk px-4 py-2.5 active:opacity-80"
                >
                  <Ionicons name="add-outline" size={14} color="#131316" />
                  <Text className="text-sm font-body-semibold text-iron-bg">Set a goal</Text>
                </Pressable>
              </View>
            )}

            {/* Goal cards */}
            {goals.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                sessions={sessions}
                onUpdate={updateGoal}
                onArchive={archiveGoal}
              />
            ))}

            {/* Add another button */}
            {goals.length > 0 && availableKinds.length > 0 && !adding && (
              <Pressable
                onPress={() => setAdding(true)}
                className="flex-row items-center gap-1 self-start rounded-xl border border-iron-hairline px-3 py-2 active:bg-iron-raised"
              >
                <Ionicons name="add-outline" size={14} color="#F1EEE7" />
                <Text className="text-sm font-body-semibold text-chalk">Add another</Text>
              </Pressable>
            )}

            {/* Add form */}
            {adding && (
              <AddGoalForm
                availableKinds={availableKinds}
                onCancel={() => setAdding(false)}
                onSubmit={addGoal}
              />
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

// ── Goal card ────────────────────────────────────────────────────────────────

function GoalCard({ goal, sessions, onUpdate, onArchive }) {
  const [editing, setEditing] = useState(false)
  const [target, setTarget] = useState(String(goal.target_value))

  const def = GOAL_DEFS[goal.kind]
  const progress = computeProgress(goal, sessions)

  const fillPct = Math.min(100, progress.pct * 100)
  const isComplete = progress.pct >= 1

  return (
    <View className="rounded-[20px] border border-iron-hairline bg-iron-surface p-5">
      {/* Top row: label + action buttons */}
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-body-semibold text-chalk">
            {def?.label || goal.kind}
          </Text>
          <Text className="mt-1 text-xs font-body text-chalk-2">
            {isComplete ? 'Goal hit. Nice.' : `${Math.round((1 - progress.pct) * 100)}% to go.`}
          </Text>
        </View>
        {!editing && (
          <View className="flex-row shrink-0 gap-1">
            <Pressable
              onPress={() => { setTarget(String(goal.target_value)); setEditing(true) }}
              className="rounded p-1.5 active:bg-iron-raised"
            >
              <Text className="text-xs font-body-medium text-chalk-2">Edit</Text>
            </Pressable>
            <Pressable
              onPress={() => onArchive(goal.id)}
              className="rounded p-1.5 active:bg-iron-raised"
            >
              <Ionicons name="trash-outline" size={14} color="#FF4E42" />
            </Pressable>
          </View>
        )}
      </View>

      {!editing ? (
        <>
          {/* Progress numbers — EARNED count in the display face, mono unit tag */}
          <View className="mt-3 flex-row items-baseline justify-between">
            <View className="flex-row items-baseline gap-1">
              <Text className="text-3xl font-display-bold text-chalk">
                {progress.current}
              </Text>
              <Text className="text-sm font-body-medium text-chalk-2">
                / {progress.target}
              </Text>
            </View>
            {def?.unit ? (
              <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>{def.unit}</Text>
            ) : null}
          </View>

          {/* Progress bar */}
          <View className="mt-2 h-2 rounded-full bg-iron-raised overflow-hidden">
            <View
              className={`h-full rounded-full ${isComplete ? 'bg-chalk' : 'bg-chalk-3'}`}
              style={{ width: `${fillPct}%` }}
            />
          </View>
        </>
      ) : (
        /* Edit form */
        <View className="mt-3 flex-row items-center gap-2">
          <TextInput
            value={target}
            onChangeText={setTarget}
            keyboardType="number-pad"
            className="w-24 rounded-xl border border-iron-hairline bg-iron-raised px-2 py-1.5 text-sm font-body text-chalk"
            placeholderTextColor="#727170"
          />
          {def?.unit ? (
            <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>{def.unit}</Text>
          ) : null}
          <View className="ml-auto flex-row items-center gap-2">
            <Pressable
              onPress={() => {
                const v = parseInt(target, 10)
                if (!v || v < 1) return
                onUpdate(goal.id, v)
                setEditing(false)
              }}
              className="flex-row items-center gap-1 rounded-xl bg-chalk px-3 py-1.5 active:opacity-80"
            >
              <Ionicons name="checkmark-outline" size={12} color="#131316" />
              <Text className="text-xs font-body-semibold text-iron-bg">Save</Text>
            </Pressable>
            <Pressable onPress={() => setEditing(false)}>
              <Ionicons name="close-outline" size={16} color="#B3B2AC" />
            </Pressable>
          </View>
        </View>
      )}
    </View>
  )
}

// ── Add goal form ─────────────────────────────────────────────────────────────

function AddGoalForm({ availableKinds, onCancel, onSubmit }) {
  const fallbackKind = availableKinds[0] || GOAL_KINDS[0]
  const [kind, setKind] = useState(fallbackKind)
  const [target, setTarget] = useState(String(GOAL_DEFS[fallbackKind]?.suggested?.[0] || 100))

  const def = GOAL_DEFS[kind]

  function changeKind(k) {
    setKind(k)
    setTarget(String(GOAL_DEFS[k]?.suggested?.[0] || 100))
  }

  function handleSubmit() {
    const v = parseInt(target, 10)
    if (!v || v < 1) return
    onSubmit({ kind, target_value: v })
  }

  return (
    <View className="rounded-[20px] border border-iron-hairline bg-iron-raised p-5">
      <Text className="text-sm font-body-semibold text-chalk">Set a new goal</Text>

      {/* Kind picker */}
      <View className="mt-3">
        <Text className="mb-1 text-xs font-body-medium text-chalk-2">Goal</Text>
        {availableKinds.map((k) => (
          <Pressable
            key={k}
            onPress={() => changeKind(k)}
            className={`flex-row items-center gap-3 rounded-xl border px-3 py-3 mb-2 ${
              kind === k
                ? 'border-chalk bg-iron-surface'
                : 'border-iron-hairline'
            }`}
          >
            <View className={`h-4 w-4 rounded-full border-2 items-center justify-center ${
              kind === k ? 'border-chalk' : 'border-chalk-3'
            }`}>
              {kind === k && (
                <View className="h-2 w-2 rounded-full bg-chalk" />
              )}
            </View>
            <Text className="text-sm font-body text-chalk">{GOAL_DEFS[k].label}</Text>
          </Pressable>
        ))}
      </View>

      {/* Target input */}
      <View className="mt-2">
        <Text className="mb-1 text-xs font-body-medium text-chalk-2">Target</Text>
        <View className="flex-row items-center gap-2">
          <TextInput
            value={target}
            onChangeText={setTarget}
            keyboardType="number-pad"
            className="w-24 rounded-xl border border-iron-hairline bg-iron-surface px-3 py-2 text-sm font-body text-chalk"
            placeholderTextColor="#727170"
          />
          {def?.unit ? (
            <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>{def.unit}</Text>
          ) : null}
        </View>
      </View>

      {/* Suggested quick-picks (mirrors web) */}
      {def?.suggested && def.suggested.length > 0 && (
        <View className="mt-3 flex-row flex-wrap gap-2">
          {def.suggested.map((n) => {
            const isSelected = Number(target) === n
            return (
              <Pressable
                key={n}
                onPress={() => setTarget(String(n))}
                className={`rounded-full px-3 py-1 ${
                  isSelected
                    ? 'bg-chalk'
                    : 'border border-iron-hairline'
                }`}
              >
                <Text className={`text-xs font-body-medium ${
                  isSelected ? 'text-iron-bg' : 'text-chalk-2'
                }`}>
                  {n}
                </Text>
              </Pressable>
            )
          })}
        </View>
      )}

      {/* Actions */}
      <View className="mt-4 flex-row items-center gap-3">
        <Pressable
          onPress={handleSubmit}
          className="flex-row items-center gap-1 rounded-xl bg-chalk px-4 py-2.5 active:opacity-80"
        >
          <Ionicons name="checkmark-outline" size={14} color="#131316" />
          <Text className="text-sm font-body-semibold text-iron-bg">Set goal</Text>
        </Pressable>
        <Pressable onPress={onCancel}>
          <Text className="text-sm font-body-medium text-chalk-2">Cancel</Text>
        </Pressable>
      </View>
    </View>
  )
}
