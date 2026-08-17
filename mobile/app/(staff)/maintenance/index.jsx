// EQUIP-MAINT.2 — the due list: what needs inspecting right now at
// the active studio, plus what's currently out of service. Tapping a
// due row opens the run (pushes /maintenance/[id], carrying the
// asset's name + type along as params since the create-or-resume
// response is just the draft row — no embedded equipment/type name).
//
// Gated on equipment_inspect (the mobile permission — universal
// default, same key the server routes enforce).

import { useState, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { getDueEquipment } from '../../../lib/maintenance-api'

function DueRow({ item, today, onPress }) {
  const overdue = item.next_due_on < today
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-80"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 min-w-0">
          <Text className="text-base font-semibold text-un1t-text" numberOfLines={1}>
            {item.name}
          </Text>
          <Text className="text-[12px] text-un1t-subtle mt-0.5" numberOfLines={1}>
            {item.equipment_types?.name || 'Unknown type'}
            {item.zone ? ` · ${item.zone}` : ''}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
      </View>
      <View
        className={`self-start mt-2 rounded-full px-2.5 py-0.5 ${
          overdue ? 'bg-amber-500/15 border border-amber-500/30' : 'bg-blue-500/15 border border-blue-500/30'
        }`}
      >
        <Text className={`text-[11px] font-semibold ${overdue ? 'text-amber-200' : 'text-blue-200'}`}>
          {overdue ? `Overdue since ${item.next_due_on}` : `Due ${item.next_due_on}`}
        </Text>
      </View>
    </Pressable>
  )
}

function OutOfServiceRow({ item }) {
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2">
      <Text className="text-base font-semibold text-un1t-text" numberOfLines={1}>
        {item.name}
      </Text>
      <Text className="text-[12px] text-un1t-subtle mt-0.5" numberOfLines={1}>
        {item.equipment_types?.name || 'Unknown type'}
      </Text>
      <View className="self-start mt-2 rounded-full px-2.5 py-0.5 bg-red-500/15 border border-red-500/30">
        <Text className="text-[11px] font-semibold text-red-300">Out of service</Text>
      </View>
    </View>
  )
}

export default function MaintenanceDueScreen() {
  const router = useRouter()
  const { profile, activeLocation } = useAuth()
  const canView = canMobile(profile, 'equipment_inspect', activeLocation)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!canView) { setLoading(false); return }
    try {
      const r = await getDueEquipment()
      if (r.success === false) {
        setError(r.error || 'Could not load the due list')
        setData(null)
      } else {
        setError(null)
        setData(r.data)
      }
    } catch (err) {
      // Without this catch a network failure never reaches
      // setLoading(false) and the screen spins forever.
      setError(err.message || 'Could not load the due list')
      setData(null)
    }
    setLoading(false)
  }, [canView])

  useFocusEffect(useCallback(() => {
    let alive = true
    setLoading(true)
    load().catch(() => {})
    return () => { alive = false; void alive }
  }, [load]))

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  if (!canView) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center px-6">
        <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
        <Text className="text-xs text-un1t-subtle text-center mt-1">
          Equipment inspections aren&apos;t enabled for your account.
        </Text>
      </View>
    )
  }

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }

  const due = data?.due || []
  const outOfService = data?.outOfService || []

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
    >
      {error && (
        <View className="bg-red-500/10 border border-red-500/30 rounded-md p-3 mb-3 flex-row items-start">
          <Ionicons name="alert-circle-outline" size={14} color="#EF4444" style={{ marginTop: 2 }} />
          <Text className="text-[12px] text-red-300 ml-2 flex-1">{error}</Text>
        </View>
      )}

      {!data?.enabled ? (
        <View className="items-center py-16 px-6">
          <Ionicons name="settings-outline" size={42} color="#475569" />
          <Text className="text-lg font-bold text-un1t-text mt-3 mb-1">Not set up yet</Text>
          <Text className="text-sm text-un1t-subtle text-center">
            An admin needs to add equipment types and register assets on the web before inspections show up here.
          </Text>
        </View>
      ) : (
        <>
          <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">
            Due for inspection
          </Text>
          {due.length === 0 ? (
            <View className="items-center py-10 px-6 mb-2">
              <Ionicons name="checkmark-circle-outline" size={36} color="#475569" />
              <Text className="text-base font-bold text-un1t-text mt-3 mb-1">Nothing due</Text>
              <Text className="text-sm text-un1t-subtle text-center">
                Every in-service asset here is inspected and up to date.
              </Text>
            </View>
          ) : (
            due.map((item) => (
              <DueRow
                key={item.id}
                item={item}
                today={data.today}
                onPress={() => router.push({
                  pathname: '/maintenance/[id]',
                  params: { id: item.id, name: item.name, type: item.equipment_types?.name || '' },
                })}
              />
            ))
          )}

          {outOfService.length > 0 && (
            <>
              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mt-6 mb-2">
                Out of service
              </Text>
              {outOfService.map((item) => (
                <OutOfServiceRow key={item.id} item={item} />
              ))}
            </>
          )}
        </>
      )}
    </ScrollView>
  )
}
