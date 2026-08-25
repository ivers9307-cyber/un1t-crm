// Policies list — every active policy with Opened / Not-opened
// status (POLICIES-VIEWS.1 — passive view tracking). Open to all
// authenticated staff (RLS). Reached from the More tab. Refresh on
// focus so an open from the viewer reflects on bounce-back.

import { useState, useEffect, useCallback } from 'react'
import { View, Text, FlatList, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect, Stack } from 'expo-router'
import { listPolicies } from '../../../lib/policies-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'
import TabletConstrained from '../../../components/TabletConstrained'

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

export default function PoliciesList() {
  const router = useRouter()
  const [rows, setRows] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const res = await listPolicies()
    if (res.success) {
      setRows(res.data || [])
    } else {
      setError(res.error || 'Failed to load')
      setRows([])
    }
  }, [])

  useFocusEffect(useCallback(() => { load() }, [load]))
  useEffect(() => { load() }, [load])

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const headerOptions = {
    headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" />,
  }

  if (rows == null) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <Stack.Screen options={{ ...headerOptions, title: 'Policies' }} />
        <ActivityIndicator />
      </View>
    )
  }

  if (error) {
    return (
      <View className="flex-1 bg-un1t-bg p-6">
        <Stack.Screen options={{ ...headerOptions, title: 'Policies' }} />
        <View className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
          <Text className="text-sm font-semibold text-red-700">Couldn't load policies</Text>
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
        <Stack.Screen options={{ ...headerOptions, title: 'Policies' }} />
        <Ionicons name="book-outline" size={32} color="#94A3B8" />
        <Text className="text-sm text-un1t-subtle mt-3 text-center">
          No policies published yet.
        </Text>
      </View>
    )
  }

  const outstanding = rows.filter((p) => p.current_version && !p.viewed_at).length

  return (
    <>
      <Stack.Screen options={{ ...headerOptions, title: 'Policies' }} />
      <TabletConstrained className="flex-1 bg-un1t-bg">
      <FlatList
        className="flex-1"
        contentContainerClassName="p-4"
        data={rows}
        keyExtractor={(p) => p.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />
        }
        ListHeaderComponent={
          outstanding > 0 ? (
            <View className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 mb-3 flex-row items-center gap-2">
              <Ionicons name="alert-circle-outline" size={14} color="#1D4ED8" />
              <Text className="text-xs text-blue-700 flex-1">
                You have {outstanding} {outstanding === 1 ? 'policy' : 'policies'} you haven't opened yet.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item: p }) => {
          const opened = !!p.viewed_at
          const ver = p.current_version
          return (
            <Pressable
              onPress={() => router.push(`/policies/${p.slug}`)}
              className="bg-un1t-surface border border-un1t-border rounded-xl p-3.5 mb-2 active:bg-un1t-border/40"
            >
              <View className="flex-row items-start justify-between gap-2">
                <View className="flex-1 min-w-0">
                  <View className="flex-row items-center gap-2">
                    <Text className="text-base font-medium text-un1t-text flex-shrink" numberOfLines={1}>
                      {p.title}
                    </Text>
                    {ver && (
                      <Text className="text-[10px] uppercase tracking-wider text-un1t-muted">
                        v{ver.version_number}
                      </Text>
                    )}
                  </View>
                  {p.description && (
                    <Text className="text-[11px] text-un1t-subtle mt-0.5" numberOfLines={2}>
                      {p.description}
                    </Text>
                  )}
                  {ver && (
                    <Text className="text-[10px] text-un1t-muted mt-1">
                      Effective {fmtDate(ver.effective_date)}
                    </Text>
                  )}
                </View>
                <View
                  className={`px-2 py-0.5 rounded-full ${
                    opened ? 'bg-emerald-500/15' : 'bg-amber-500/15'
                  }`}
                >
                  <Text
                    className={`text-[10px] uppercase tracking-wider font-semibold ${
                      opened ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {opened ? 'Opened' : 'New'}
                  </Text>
                </View>
              </View>
            </Pressable>
          )
        }}
      />
      </TabletConstrained>
    </>
  )
}
