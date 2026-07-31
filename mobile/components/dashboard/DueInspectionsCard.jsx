// EQUIP-MAINT.2 — dashboard card surfacing what's due for equipment
// inspection today, alongside TodayChecklistCard. Self-contained:
// fetches /api/equipment/due on mount, renders nothing when the
// viewer lacks equipment_inspect, the location hasn't got
// inspections switched on (dormant), or nothing is currently due —
// most days for most people/studios.

import { useEffect, useState, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { getDueEquipment } from '../../lib/maintenance-api'

export default function DueInspectionsCard() {
  const router = useRouter()
  const { profile, activeLocation } = useAuth()
  const canView = canMobile(profile, 'equipment_inspect', activeLocation)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!canView) { setLoading(false); return }
    try {
      const r = await getDueEquipment()
      setData(r.success === false ? null : r.data)
    } catch {
      // Best-effort card — keep whatever is on screen; never block Today.
    }
    setLoading(false)
  }, [canView])

  useEffect(() => { load() }, [load])

  // Re-load on tab focus — a walk-round finished in the run screen
  // should drop the count when the user comes back.
  useFocusEffect(useCallback(() => { load() }, [load]))

  if (!canView || loading) return null

  // Dormant location (never set up, or switched off) or nothing due —
  // both render nothing, matching TodayChecklistCard's "invisible
  // unless there's something to do" posture.
  const dueCount = data?.due?.length || 0
  if (!data?.enabled || dueCount === 0) return null

  const overdueCount = data.due.filter((r) => r.next_due_on < data.today).length

  return (
    <Pressable
      onPress={() => router.push('/maintenance')}
      className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 mb-3 active:opacity-80"
    >
      <View className="flex-row items-center justify-between mb-2">
        <View className="flex-row items-center gap-2 flex-1 min-w-0">
          <Ionicons name="build-outline" size={16} color="#FCD34D" />
          <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
            Equipment
          </Text>
        </View>
        {loading && <ActivityIndicator size="small" color="#94A3B8" />}
      </View>

      <View className="flex-row items-center justify-between">
        <View className="min-w-0 flex-1">
          <Text className="text-base font-bold text-un1t-text" numberOfLines={1}>
            {dueCount} due for inspection
          </Text>
          <Text className="text-[11px] text-un1t-subtle mt-0.5" numberOfLines={1}>
            {overdueCount > 0 ? `${overdueCount} overdue — tap to start the walk-round.` : 'Tap to start the walk-round.'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
      </View>
    </Pressable>
  )
}
