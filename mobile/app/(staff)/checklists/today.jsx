// CHECKLIST.2 — full drill-in for today's checklist. Lists every
// item with a tap-to-tick row + a deadline countdown header. The
// list updates optimistically on tap; the server response confirms
// the new state (and auto-completes if the last item was ticked).

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from 'expo-router'
import {
  getTodayChecklists, tickChecklistItem,
  progressFor, deadlineMinutesLeft,
} from '../../../lib/checklists-api'

function fmtDeadline(mins) {
  if (mins == null) return null
  if (mins <= 0) return 'Past deadline'
  if (mins < 60) return `${mins} min until shift ends`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m until shift ends` : `${h}h until shift ends`
}

function ItemRow({ item, checked, busy, onToggle, isLast }) {
  return (
    <Pressable
      onPress={() => onToggle(item.id, !checked)}
      disabled={busy}
      className={`flex-row items-center px-4 py-4 active:bg-un1t-border/30 ${
        !isLast ? 'border-b border-un1t-border' : ''
      }`}
    >
      <View
        className={`w-7 h-7 rounded-md mr-3 items-center justify-center border-2 ${
          checked ? 'bg-blue-600 border-blue-600' : 'border-un1t-border bg-un1t-bg/60'
        }`}
      >
        {busy ? (
          <ActivityIndicator size="small" color={checked ? '#FFFFFF' : '#94A3B8'} />
        ) : checked ? (
          <Ionicons name="checkmark" size={18} color="#FFFFFF" />
        ) : null}
      </View>
      <Text
        className={`flex-1 text-base ${
          checked ? 'text-un1t-subtle line-through' : 'text-un1t-text'
        }`}
      >
        {item.label}
      </Text>
    </Pressable>
  )
}

export default function TodayChecklistScreen() {
  const [instance, setInstance] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [busyItemId, setBusyItemId] = useState(null)

  const load = useCallback(async () => {
    const r = await getTodayChecklists()
    if (r.success === false) {
      setError(r.error || 'Could not load checklist')
      setInstance(null)
    } else {
      setError(null)
      setInstance(r.data?.instances?.[0] || null)
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useFocusEffect(useCallback(() => { load() }, [load]))

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  async function toggleItem(itemId, checked) {
    if (!instance) return
    // Optimistic update.
    const prev = instance
    const next = {
      ...prev,
      items_checked: { ...prev.items_checked },
    }
    if (checked) {
      next.items_checked[itemId] = { checked_at: new Date().toISOString(), checked_by: 'me' }
    } else {
      delete next.items_checked[itemId]
    }
    setInstance(next)
    setBusyItemId(itemId)

    const r = await tickChecklistItem({ instanceId: instance.id, itemId, checked })
    setBusyItemId(null)
    if (r.success === false) {
      // Roll back on failure.
      setInstance(prev)
      setError(r.error || 'Could not save')
      return
    }
    // Take the server's full row — includes the recomputed status +
    // completed_at.
    setInstance(r.data)
  }

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }

  if (!instance) {
    return (
      <ScrollView
        className="flex-1 bg-un1t-bg"
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
      >
        <View className="items-center py-16 px-6">
          <Ionicons name="checkmark-circle-outline" size={42} color="#475569" />
          <Text className="text-lg font-bold text-un1t-text mt-3 mb-1">Nothing for today</Text>
          <Text className="text-sm text-un1t-subtle text-center">
            You don&apos;t have a checklist today — either you&apos;re not on shift or your role doesn&apos;t have one configured for today.
          </Text>
        </View>
      </ScrollView>
    )
  }

  const { done, total } = progressFor(instance)
  const minsLeft = deadlineMinutesLeft(instance)
  const isComplete = instance.status === 'complete'
  const isOverdue = !isComplete && minsLeft != null && minsLeft <= 0
  const items = [...(instance.items || [])].sort((a, b) => (a.order || 0) - (b.order || 0))
  const checkedIds = new Set(Object.keys(instance.items_checked || {}))

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
    >
      {/* Header */}
      <View className="mb-4">
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-1">
          Progress
        </Text>
        <View className="flex-row items-end justify-between">
          <Text className="text-3xl font-bold text-un1t-text">
            {done} <Text className="text-un1t-subtle text-xl">/ {total}</Text>
          </Text>
          {minsLeft != null && !isComplete && (
            <Text className={`text-[12px] font-semibold ${isOverdue ? 'text-amber-300' : 'text-blue-200'}`}>
              {fmtDeadline(minsLeft)}
            </Text>
          )}
          {isComplete && (
            <Text className="text-[12px] font-semibold text-green-300">
              Done — nice work
            </Text>
          )}
        </View>
        <View className="mt-3 h-2 bg-un1t-border/40 rounded-full overflow-hidden">
          <View
            className={`h-2 rounded-full ${isComplete ? 'bg-green-400' : isOverdue ? 'bg-amber-400' : 'bg-blue-400'}`}
            style={{ width: total > 0 ? `${Math.round((done / total) * 100)}%` : '0%' }}
          />
        </View>
      </View>

      {error && (
        <View className="bg-red-500/10 border border-red-500/30 rounded-md p-3 mb-3 flex-row items-start">
          <Ionicons name="alert-circle-outline" size={14} color="#EF4444" style={{ marginTop: 2 }} />
          <Text className="text-[12px] text-red-300 ml-2 flex-1">{error}</Text>
        </View>
      )}

      {/* Items */}
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden">
        {items.length === 0 ? (
          <View className="p-6 items-center">
            <Text className="text-sm text-un1t-subtle text-center">
              No items on this template yet.
            </Text>
          </View>
        ) : (
          items.map((it, idx) => (
            <ItemRow
              key={it.id}
              item={it}
              checked={checkedIds.has(it.id)}
              busy={busyItemId === it.id}
              onToggle={toggleItem}
              isLast={idx === items.length - 1}
            />
          ))
        )}
      </View>

      {/* Footer hint */}
      {!isComplete && total > 0 && (
        <Text className="text-[11px] text-un1t-muted text-center mt-4">
          {done < total
            ? `Tap each item as you finish it. ${total - done} left.`
            : 'Almost there.'}
        </Text>
      )}
    </ScrollView>
  )
}
