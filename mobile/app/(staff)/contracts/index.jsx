// Contracts list — the recipient's own. Same shape as the web
// /account/contracts page: pending (issued/viewed) at the top
// under "Action required", everything else under "Archive".
//
// Pulls via the existing /api/contracts route which is RLS-
// filtered to recipient-self for this caller.

import { useState, useEffect, useCallback } from 'react'
import { View, Text, FlatList, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect, Stack } from 'expo-router'
import { listContracts } from '../../../lib/contracts-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

const STATUS_LABEL = {
  issued:   { text: 'Awaiting signature', bg: 'bg-blue-500/15',    fg: 'text-blue-700' },
  viewed:   { text: 'Awaiting signature', bg: 'bg-amber-500/15',   fg: 'text-amber-700' },
  signed:   { text: 'Signed',             bg: 'bg-emerald-500/15', fg: 'text-emerald-700' },
  declined: { text: 'Declined',           bg: 'bg-red-500/15',     fg: 'text-red-700' },
  revoked:  { text: 'Withdrawn',          bg: 'bg-gray-500/15',    fg: 'text-gray-600' },
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

export default function ContractsList() {
  const router = useRouter()
  const [rows, setRows] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const res = await listContracts()
    if (res.success) {
      setRows(res.data || [])
    } else {
      setError(res.error || 'Failed to load')
      setRows([])
    }
  }, [])

  // Refresh on focus so signing on detail then bouncing back here
  // shows the updated status.
  useFocusEffect(useCallback(() => {
    load()
  }, [load]))

  // Initial load (focus effect fires too but this avoids the
  // momentary blank screen).
  useEffect(() => {
    load()
  }, [load])

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  // contracts/index is reached from the More tab, so iOS won't
  // auto-render a back chevron — opt in explicitly (cross-navigator
  // push convention, see CLAUDE.md "iOS auto-back-button").
  const headerOptions = {
    headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" />,
  }

  if (rows == null) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <Stack.Screen options={{ ...headerOptions, title: 'Your contracts' }} />
        <ActivityIndicator />
      </View>
    )
  }

  if (error) {
    return (
      <View className="flex-1 bg-un1t-bg p-6">
        <Stack.Screen options={{ ...headerOptions, title: 'Your contracts' }} />
        <View className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
          <Text className="text-sm font-semibold text-red-700">Couldn't load contracts</Text>
          <Text className="text-xs text-red-700 mt-1">{error}</Text>
          <Pressable
            onPress={load}
            className="mt-3 bg-red-600 active:opacity-80 px-3 py-2 rounded-md self-start"
          >
            <Text className="text-xs font-semibold text-white">Try again</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  if (rows.length === 0) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center px-8">
        <Stack.Screen options={{ ...headerOptions, title: 'Your contracts' }} />
        <Ionicons name="document-text-outline" size={32} color="#94A3B8" />
        <Text className="text-sm text-un1t-subtle mt-3 text-center">
          No contracts on file yet.
        </Text>
        <Text className="text-xs text-un1t-muted mt-1 text-center">
          When UN1T issues you a contract, you'll see it here.
        </Text>
      </View>
    )
  }

  const pending = rows.filter(r => r.status === 'issued' || r.status === 'viewed')
  const archive = rows.filter(r => r.status !== 'issued' && r.status !== 'viewed')

  // Build a flat list with section headers — easier than SectionList
  // here because each section has its own count.
  const items = []
  if (pending.length > 0) {
    items.push({ kind: 'header', label: `Action required (${pending.length})`, key: 'h-pending' })
    pending.forEach(c => items.push({ kind: 'row', row: c, key: c.id }))
  }
  if (archive.length > 0) {
    items.push({ kind: 'header', label: 'Archive', key: 'h-archive' })
    archive.forEach(c => items.push({ kind: 'row', row: c, key: c.id }))
  }

  return (
    <>
      <Stack.Screen options={{ ...headerOptions, title: 'Your contracts' }} />
      <FlatList
      className="flex-1 bg-un1t-bg"
      contentContainerClassName="p-4"
      data={items}
      keyExtractor={i => i.key}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />
      }
      renderItem={({ item }) => {
        if (item.kind === 'header') {
          return (
            <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mt-2 mb-1.5">
              {item.label}
            </Text>
          )
        }
        const c = item.row
        const badge = STATUS_LABEL[c.status] || { text: c.status, bg: 'bg-un1t-border', fg: 'text-un1t-subtle' }
        return (
          <Pressable
            onPress={() => router.push(`/contracts/${c.id}`)}
            className="bg-un1t-surface border border-un1t-border rounded-xl p-3.5 mb-2 active:bg-un1t-border/40"
          >
            <View className="flex-row items-start justify-between gap-2">
              <View className="flex-1 min-w-0">
                <Text className="text-base font-medium text-un1t-text" numberOfLines={1}>
                  {c.template?.name || 'Contract'}
                </Text>
                <Text className="text-[11px] text-un1t-subtle mt-0.5">
                  Issued {fmtDate(c.issued_at)}
                  {c.signed_at && ` · Signed ${fmtDate(c.signed_at)}`}
                </Text>
              </View>
              <View className={`px-2 py-0.5 rounded-full ${badge.bg}`}>
                <Text className={`text-[10px] uppercase tracking-wider font-semibold ${badge.fg}`}>
                  {badge.text}
                </Text>
              </View>
            </View>
          </Pressable>
        )
      }}
    />
    </>
  )
}
