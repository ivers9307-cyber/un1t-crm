// Pipeline tab — stage selector + deals list per stage.
//
// Web equivalent is the kanban (KanbanBoard.jsx). On mobile we render
// a horizontal scrollable stage strip ("New" → "Trial" → "Member" etc.)
// with deal counts as badges, and the list of open deals for the
// selected stage below it.
//
// Tapping a deal opens its detail screen. Pull-to-refresh re-fetches.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { listStages, listDealsByStage } from '../../lib/pipeline-api'

function StagePill({ stage, count, selected, onPress }) {
  const tint = stage.color || '#94A3B8'
  return (
    <Pressable
      onPress={onPress}
      className={`mr-2 px-4 py-2 rounded-full flex-row items-center ${
        selected ? 'bg-un1t-white' : 'bg-un1t-dark border border-un1t-gray'
      }`}
    >
      <View
        className="w-2 h-2 rounded-full mr-2"
        style={{ backgroundColor: tint }}
      />
      <Text className={`text-sm font-medium ${selected ? 'text-un1t-black' : 'text-un1t-white'}`}>
        {stage.name}
      </Text>
      <View className={`ml-2 px-1.5 py-0.5 rounded-full ${selected ? 'bg-un1t-black/10' : 'bg-un1t-gray/40'}`}>
        <Text className={`text-[11px] font-semibold ${selected ? 'text-un1t-black' : 'text-un1t-light'}`}>
          {count}
        </Text>
      </View>
    </Pressable>
  )
}

function DealRow({ deal, onPress }) {
  const c = deal.contacts
  const name = c?.name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'Unknown'
  const sub = c?.lead_status ? c.lead_status.replace(/_/g, ' ') : (c?.email || c?.phone || '')
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 mb-2 flex-row items-center active:opacity-70"
    >
      <View className="w-10 h-10 rounded-full bg-un1t-gray/40 items-center justify-center mr-3">
        <Text className="text-base font-semibold text-un1t-white">
          {(name[0] || '?').toUpperCase()}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-un1t-white">{deal.title}</Text>
        <Text className="text-sm text-un1t-light capitalize">{name} · {sub}</Text>
      </View>
      {deal.value > 0 && (
        <Text className="text-sm font-semibold text-un1t-white ml-2">€{deal.value}</Text>
      )}
      <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
    </Pressable>
  )
}

export default function Pipeline() {
  const { activeLocation } = useAuth()
  const router = useRouter()
  const [stages, setStages] = useState([])
  const [counts, setCounts] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [deals, setDeals] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  // Load stages + counts (one round-trip per stage's count is fine for
  // a typical 5–7 stage pipeline; we batch with Promise.all).
  const fetchStages = useCallback(async () => {
    if (!activeLocation) return
    setError(null)
    const res = await listStages(activeLocation.id)
    if (!res.success) {
      setError(res.error || 'Failed to load stages')
      return
    }
    setStages(res.data || [])
    if (!selectedId && res.data?.length) setSelectedId(res.data[0].id)

    const countResults = await Promise.all(
      (res.data || []).map(s => listDealsByStage(s.id, activeLocation.id))
    )
    const cMap = {}
    countResults.forEach((r, i) => {
      cMap[res.data[i].id] = r.success ? (r.data?.length || 0) : 0
    })
    setCounts(cMap)
  }, [activeLocation, selectedId])

  const fetchDealsForStage = useCallback(async () => {
    if (!selectedId || !activeLocation) return
    const res = await listDealsByStage(selectedId, activeLocation.id)
    setDeals(res.success ? res.data || [] : [])
  }, [selectedId, activeLocation])

  useEffect(() => {
    setLoading(true)
    fetchStages().finally(() => setLoading(false))
  }, [fetchStages])

  useEffect(() => {
    if (selectedId) fetchDealsForStage()
  }, [selectedId, fetchDealsForStage])

  async function onRefresh() {
    setRefreshing(true)
    await Promise.all([fetchStages(), fetchDealsForStage()])
    setRefreshing(false)
  }

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-black items-center justify-center">
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <View className="flex-1 bg-un1t-black">
      <ScrollView
        contentContainerClassName="px-4 pt-3 pb-32"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
      >
        {error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-500 text-sm">{error}</Text>
          </View>
        ) : null}

        {/* Stage strip */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="pb-3 pr-4"
        >
          {stages.map(s => (
            <StagePill
              key={s.id}
              stage={s}
              count={counts[s.id] || 0}
              selected={selectedId === s.id}
              onPress={() => setSelectedId(s.id)}
            />
          ))}
        </ScrollView>

        {deals.length === 0 ? (
          <View className="py-12 items-center">
            <Ionicons name="folder-open-outline" size={28} color="#94A3B8" />
            <Text className="text-sm text-un1t-light mt-2">
              No open deals in this stage.
            </Text>
          </View>
        ) : (
          deals.map(d => (
            <DealRow
              key={d.id}
              deal={d}
              onPress={() => router.push(`/pipeline/${d.id}`)}
            />
          ))
        )}
      </ScrollView>
    </View>
  )
}
