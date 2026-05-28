// CHECKLIST.2 — top-of-Today checklist card.
//
// Self-contained: fetches /api/mobile/checklists/today on mount,
// renders nothing if the coach isn't on shift today or has no
// matching template (most days for most people). When an
// instance exists, shows progress (3 / 7), the deadline countdown,
// and a tap-through to the drill-in.

import { useEffect, useState, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect } from 'expo-router'
import {
  getTodayChecklists, progressFor, deadlineMinutesLeft,
} from '../../lib/checklists-api'

function fmtDeadline(mins) {
  if (mins == null) return null
  if (mins <= 0) return 'overdue'
  if (mins < 60) return `${mins} min left`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m left` : `${h}h left`
}

export default function TodayChecklistCard() {
  const router = useRouter()
  const [instance, setInstance] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const r = await getTodayChecklists()
    if (r.success === false) {
      setInstance(null)
    } else {
      setInstance(r.data?.instances?.[0] || null)
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Re-load when the user navigates back to the tab — they may
  // have ticked items in the drill-in.
  useFocusEffect(useCallback(() => {
    load()
  }, [load]))

  if (loading) {
    // Render nothing during the first load — most users won't have
    // a checklist and a flicker would be noise.
    return null
  }
  if (!instance) return null

  const { done, total } = progressFor(instance)
  const minsLeft = deadlineMinutesLeft(instance)
  const deadlineLabel = fmtDeadline(minsLeft)
  const isComplete = instance.status === 'complete'
  const isOverdue = !isComplete && minsLeft != null && minsLeft <= 0

  // Colour the card by state — calm blue while in progress, green
  // once complete, amber when overdue but not yet auto-closed.
  let tone
  if (isComplete) {
    tone = { bg: 'bg-green-500/10', border: 'border-green-500/30', accent: 'text-green-200', icon: 'checkmark-done' }
  } else if (isOverdue) {
    tone = { bg: 'bg-amber-500/10',  border: 'border-amber-500/30', accent: 'text-amber-200', icon: 'time-outline' }
  } else {
    tone = { bg: 'bg-blue-500/10',   border: 'border-blue-500/30',  accent: 'text-blue-200',  icon: 'list-outline' }
  }

  return (
    <Pressable
      onPress={() => router.push('/checklists/today')}
      className={`${tone.bg} ${tone.border} border rounded-2xl p-4 mb-3 active:opacity-80`}
    >
      <View className="flex-row items-center justify-between mb-2">
        <View className="flex-row items-center gap-2 flex-1 min-w-0">
          <Ionicons name={tone.icon} size={16} color="#93C5FD" />
          <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
            Today&apos;s checklist
          </Text>
        </View>
        {deadlineLabel && !isComplete && (
          <Text className={`text-[11px] ${tone.accent} font-semibold`}>{deadlineLabel}</Text>
        )}
      </View>

      <View className="flex-row items-center justify-between">
        <View className="min-w-0 flex-1">
          <Text className="text-base font-bold text-un1t-text" numberOfLines={1}>
            {done} / {total} done
          </Text>
          <Text className="text-[11px] text-un1t-subtle mt-0.5" numberOfLines={1}>
            {isComplete ? 'All done — nice work.' : 'Tap to tick items as you finish them.'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
      </View>

      {/* Progress bar */}
      <View className="mt-3 h-1.5 bg-un1t-border/40 rounded-full overflow-hidden">
        <View
          className={`h-1.5 rounded-full ${isComplete ? 'bg-green-400' : isOverdue ? 'bg-amber-400' : 'bg-blue-400'}`}
          style={{ width: total > 0 ? `${Math.round((done / total) * 100)}%` : '0%' }}
        />
      </View>
    </Pressable>
  )
}
