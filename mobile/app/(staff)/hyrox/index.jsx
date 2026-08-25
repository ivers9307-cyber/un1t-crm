// Hyrox planner — the active block's sessions, grouped by week. Tap a session to
// review, approve, regenerate, or push it to the studio TV. Mirrors the web
// /admin/hyrox grid; reads direct from Supabase (RLS-scoped) via loadHyrox.
import { useState, useCallback } from 'react'
import { View, Text, FlatList, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect, Stack } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { loadHyrox } from '../../../lib/hyrox-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

const STATUS = {
  draft: { text: 'Draft', bg: 'bg-amber-500/15', fg: 'text-amber-700' },
  approved: { text: 'Approved', bg: 'bg-emerald-500/15', fg: 'text-emerald-700' },
  published: { text: 'Published', bg: 'bg-blue-500/15', fg: 'text-blue-700' },
}

export default function HyroxList() {
  const router = useRouter()
  const { profile, activeLocation } = useAuth()
  const allowed = canMobile(profile, 'hyrox', activeLocation)
  const [state, setState] = useState({ block: null, sessions: null })
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!allowed || !activeLocation?.id) { setState({ block: null, sessions: [] }); return }
    setError(null)
    const res = await loadHyrox(activeLocation.id)
    if (res.success) setState(res.data)
    else { setError(res.error || 'Failed to load'); setState({ block: null, sessions: [] }) }
  }, [allowed, activeLocation?.id])

  useFocusEffect(useCallback(() => { load() }, [load]))

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  const headerOptions = { headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }

  if (!allowed) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center px-8">
        <Stack.Screen options={{ ...headerOptions, title: 'Hyrox' }} />
        <Ionicons name="lock-closed-outline" size={30} color="#94A3B8" />
        <Text className="text-sm text-un1t-subtle mt-3 text-center">You don't have access to Hyrox planning.</Text>
      </View>
    )
  }

  if (state.sessions == null) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <Stack.Screen options={{ ...headerOptions, title: 'Hyrox' }} />
        <ActivityIndicator />
      </View>
    )
  }

  if (error) {
    return (
      <View className="flex-1 bg-un1t-bg p-6">
        <Stack.Screen options={{ ...headerOptions, title: 'Hyrox' }} />
        <View className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
          <Text className="text-sm font-semibold text-red-700">Couldn't load Hyrox</Text>
          <Text className="text-xs text-red-700 mt-1">{error}</Text>
          <Pressable onPress={load} className="mt-3 bg-red-600 active:opacity-80 px-3 py-2 rounded-md self-start">
            <Text className="text-xs font-semibold text-white">Try again</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  if (!state.block) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center px-8">
        <Stack.Screen options={{ ...headerOptions, title: 'Hyrox' }} />
        <Ionicons name="barbell-outline" size={32} color="#94A3B8" />
        <Text className="text-sm text-un1t-subtle mt-3 text-center">No active Hyrox block for this studio.</Text>
        <Text className="text-xs text-un1t-muted mt-1 text-center">Generate one from the web planner to start.</Text>
      </View>
    )
  }

  const { block, sessions } = state
  // Flatten to week-headered rows.
  const items = []
  const weeks = Array.from({ length: block.weeks || 0 }, (_, i) => i + 1)
  for (const w of weeks) {
    const wkSessions = sessions.filter((s) => s.week_no === w)
    if (!wkSessions.length) continue
    items.push({ kind: 'header', key: `h-${w}`, label: `Week ${w}` })
    wkSessions.forEach((s) => items.push({ kind: 'row', key: s.id, row: s }))
  }

  return (
    <>
      <Stack.Screen options={{ ...headerOptions, title: 'Hyrox Training Club' }} />
      <FlatList
        className="flex-1 bg-un1t-bg"
        contentContainerClassName="p-4"
        data={items}
        keyExtractor={(i) => i.key}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
        ListHeaderComponent={
          <View className="mb-3">
            <Text className="text-base font-semibold text-un1t-text">{block.title || 'Active block'}</Text>
            <Text className="text-xs text-un1t-subtle mt-0.5">{block.weeks} weeks · {block.sessions_per_week}/week · starts {block.starts_on}</Text>
          </View>
        }
        renderItem={({ item }) => {
          if (item.kind === 'header') {
            return <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mt-3 mb-1.5">{item.label}</Text>
          }
          const s = item.row
          const badge = STATUS[s.status] || { text: s.status, bg: 'bg-un1t-border', fg: 'text-un1t-subtle' }
          return (
            <Pressable
              onPress={() => router.push(`/hyrox/${s.id}`)}
              className="bg-un1t-surface border border-un1t-border rounded-xl p-3.5 mb-2 active:bg-un1t-border/40"
            >
              <View className="flex-row items-center justify-between gap-2">
                <View className="flex-1 min-w-0">
                  <Text className="text-[11px] text-un1t-muted">Session {s.slot}{s.is_benchmark ? ' · benchmark' : ''}</Text>
                  <Text className="text-base font-medium text-un1t-text mt-0.5" numberOfLines={1}>{s.focus || '—'}</Text>
                </View>
                <View className="flex-row items-center gap-2">
                  <View className={`px-2 py-0.5 rounded-full ${badge.bg}`}>
                    <Text className={`text-[10px] uppercase tracking-wider font-semibold ${badge.fg}`}>{badge.text}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
                </View>
              </View>
            </Pressable>
          )
        }}
      />
    </>
  )
}
