// Pipeline tab — Funnel | Off funnel views (FUNNEL-M.1, web parity).
//
// Web equivalent is the tabbed kanban (src/app/pipeline/page.js +
// PipelineViewSwitcher). On mobile the two views map to a segmented
// Tabs switcher; within a view we render a horizontal stage strip with
// open-deal counts as badges, and the list of open deals for the
// selected stage below it.
//
//   Funnel      — the 5 journey stages in order (new_lead → first_class
//                 → second_class → trial_done → converted).
//   Off funnel  — the parked piles, grouped exactly like web columns:
//                 Member / Class Pack (a first-class group, FUNNEL.3) /
//                 ClassPass / Cold / Dormant.
//
// The split comes from shared/pipeline-classifier's splitStagesByFunnel
// (is_dormant on the non-archived stage rows) — same source of truth as
// the web board. Stage placement stays read-only on mobile (classifier-
// derived); the only pipeline action is the Cold toggle on deal detail.
//
// Tapping a deal opens its detail screen. Pull-to-refresh re-fetches.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { listStages, listDealsByStage, countOpenDealsForStage } from '../../../lib/pipeline-api'
import { splitStagesByFunnel } from 'shared/pipeline-classifier'
import { Tabs } from '../../../components/ui'
import TabletConstrained from '../../../components/TabletConstrained'

function StagePill({ stage, count, selected, onPress }) {
  const tint = stage.color || '#94A3B8'
  return (
    <Pressable
      onPress={onPress}
      className={`mr-2 px-4 py-2 rounded-full flex-row items-center ${
        selected ? 'bg-un1t-text' : 'bg-un1t-surface border border-un1t-border'
      }`}
    >
      <View
        className="w-2 h-2 rounded-full mr-2"
        style={{ backgroundColor: tint }}
      />
      <Text className={`text-sm font-medium ${selected ? 'text-un1t-bg' : 'text-un1t-text'}`}>
        {stage.name}
      </Text>
      <View className={`ml-2 px-1.5 py-0.5 rounded-full ${selected ? 'bg-un1t-bg/10' : 'bg-un1t-border/40'}`}>
        <Text className={`text-[11px] font-semibold ${selected ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
          {count}
        </Text>
      </View>
    </Pressable>
  )
}

function DealRow({ deal, onPress }) {
  const c = deal.contacts
  const name = c?.name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'Unknown'
  const sub = c?.pipeline_stage_slug ? c.pipeline_stage_slug.replace(/_/g, ' ') : (c?.email || c?.phone || '')
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 flex-row items-center active:opacity-70"
    >
      <View className="w-10 h-10 rounded-full bg-un1t-border/40 items-center justify-center mr-3">
        <Text className="text-base font-semibold text-un1t-text">
          {(name[0] || '?').toUpperCase()}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-un1t-text">{deal.title}</Text>
        <Text className="text-sm text-un1t-subtle capitalize">{name} · {sub}</Text>
      </View>
      {deal.value > 0 && (
        <Text className="text-sm font-semibold text-un1t-text ml-2">€{deal.value}</Text>
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
  const [view, setView] = useState('funnel')          // 'funnel' | 'off_funnel'
  const [selectedId, setSelectedId] = useState(null)
  const [deals, setDeals] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  // Same split the web board renders as its two tabs.
  const { funnel, offFunnel } = useMemo(() => splitStagesByFunnel(stages), [stages])
  const viewStages = view === 'off_funnel' ? offFunnel : funnel

  // Keep the selected stage inside the active view — on first load and
  // whenever the view flips, fall back to the view's first stage.
  useEffect(() => {
    if (viewStages.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!viewStages.some((s) => s.id === selectedId)) {
      setSelectedId(viewStages[0].id)
    }
  }, [viewStages, selectedId])

  // Load stages + per-stage open-deal counts. Counts are HEAD count
  // queries (no rows) — the off-funnel piles hold thousands of deals
  // and a full select is silently capped at 1,000, so fetching lists
  // just to .length them was both heavy and wrong.
  const fetchStages = useCallback(async () => {
    if (!activeLocation) return
    setError(null)
    const res = await listStages(activeLocation.id)
    if (!res.success) {
      setError(res.error || 'Failed to load stages')
      return
    }
    const all = res.data || []
    setStages(all)

    const countResults = await Promise.all(
      all.map((s) => countOpenDealsForStage(s.id, activeLocation.id))
    )
    const cMap = {}
    countResults.forEach((r, i) => {
      cMap[all[i].id] = r.success ? r.count : 0
    })
    setCounts(cMap)
  }, [activeLocation])

  const fetchDealsForStage = useCallback(async () => {
    if (!selectedId || !activeLocation) {
      setDeals([])
      return
    }
    const res = await listDealsByStage(selectedId, activeLocation.id)
    setDeals(res.success ? res.data || [] : [])
  }, [selectedId, activeLocation])

  useEffect(() => {
    setLoading(true)
    fetchStages().finally(() => setLoading(false))
  }, [fetchStages])

  useEffect(() => {
    fetchDealsForStage()
  }, [fetchDealsForStage])

  // Re-fetch on tab focus so stage counts + the open-deal list reflect
  // changes made elsewhere (web kanban, or a "View as user" switch) without
  // a manual pull-to-refresh.
  useFocusEffect(useCallback(() => {
    fetchStages()
    fetchDealsForStage()
  }, [fetchStages, fetchDealsForStage]))

  async function onRefresh() {
    setRefreshing(true)
    await Promise.all([fetchStages(), fetchDealsForStage()])
    setRefreshing(false)
  }

  // View badges mirror the web tab counts: total open deals per pile.
  const sumCounts = (list) => list.reduce((n, s) => n + (counts[s.id] || 0), 0)
  const viewTabs = [
    { key: 'funnel', label: `Funnel (${sumCounts(funnel).toLocaleString()})` },
    { key: 'off_funnel', label: `Off funnel (${sumCounts(offFunnel).toLocaleString()})` },
  ]

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <TabletConstrained className="flex-1 bg-un1t-bg">
      <ScrollView
        contentContainerClassName="px-4 pt-3 pb-32"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
      >
        {error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-500 text-sm">{error}</Text>
          </View>
        ) : null}

        {/* Funnel | Off funnel switcher (web PipelineViewSwitcher parity) */}
        <View className="mb-3">
          <Tabs tabs={viewTabs} value={view} onChange={setView} />
        </View>

        {/* Stage strip — only the active view's stages */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="pb-3 pr-4"
        >
          {viewStages.map(s => (
            <StagePill
              key={s.id}
              stage={s}
              count={counts[s.id] || 0}
              selected={selectedId === s.id}
              onPress={() => setSelectedId(s.id)}
            />
          ))}
        </ScrollView>

        {viewStages.length === 0 ? (
          <View className="py-12 items-center">
            <Ionicons name="folder-open-outline" size={28} color="#94A3B8" />
            <Text className="text-sm text-un1t-subtle mt-2">
              No {view === 'off_funnel' ? 'off-funnel' : 'funnel'} stages for this location.
            </Text>
          </View>
        ) : deals.length === 0 ? (
          <View className="py-12 items-center">
            <Ionicons name="folder-open-outline" size={28} color="#94A3B8" />
            <Text className="text-sm text-un1t-subtle mt-2">
              No open deals in this {view === 'off_funnel' ? 'group' : 'stage'}.
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
    </TabletConstrained>
  )
}
