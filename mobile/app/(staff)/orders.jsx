// W2 — Orders (revenue) read view. Mirrors the web Orders page: revenue
// across race signups + car deposits at the active studio. Read-only on
// mobile (refund + retry-chain drill-in stay on web). Gated by
// canMobile(orders); the GET /api/orders route re-checks MANAGER_ROLES +
// hasPermission('orders') server-side regardless.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { listOrders, formatMoney, orderSourceLabel, orderDateLabel } from '../../lib/orders-api'
import BackHeaderLeft from '../../components/BackHeaderLeft'

const STATUS_TABS = [
  { key: null, label: 'All' },
  { key: 'completed', label: 'Completed' },
  { key: 'pending', label: 'Pending' },
  { key: 'failed', label: 'Failed' },
  { key: 'refunded', label: 'Refunded' },
  { key: 'recovered', label: 'Recovered' },
  { key: 'abandoned', label: 'Abandoned' },
]
const STATUS_STYLE = {
  completed: { bg: 'bg-green-500/20',  text: 'text-green-700' },
  pending:   { bg: 'bg-amber-500/20',  text: 'text-amber-700' },
  failed:    { bg: 'bg-red-500/20',    text: 'text-red-700' },
  abandoned: { bg: 'bg-slate-500/20',  text: 'text-slate-700' },
  recovered: { bg: 'bg-blue-500/20',   text: 'text-blue-700' },
  refunded:  { bg: 'bg-violet-500/20', text: 'text-violet-700' },
}
const PAGE = 50

export default function OrdersScreen() {
  const { profile, activeLocation } = useAuth()
  const canView = canMobile(profile, 'orders', activeLocation)

  const [orders, setOrders] = useState([])
  const [counts, setCounts] = useState({})
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)

  const fetchPage = useCallback(async (nextPage, replace) => {
    const res = await listOrders({ locationId: activeLocation?.id, status, page: nextPage, limit: PAGE })
    if (res.success === false) { setError(res.error || 'Failed to load'); if (replace) { setOrders([]); setTotal(0); setCounts({}) } return }
    setError(null)
    setCounts(res.counts || {})
    setTotal(res.total || 0)
    setOrders(prev => (replace ? (res.data || []) : [...prev, ...(res.data || [])]))
    setPage(nextPage)
  }, [activeLocation?.id, status])

  // Reload on focus + whenever the status filter changes (fetchPage closes
  // over `status`, so changing it re-runs this effect).
  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    setLoading(true)
    fetchPage(1, true).finally(() => setLoading(false))
  }, [canView, fetchPage]))

  async function onRefresh() { setRefreshing(true); await fetchPage(1, true); setRefreshing(false) }
  async function loadMore() {
    if (loadingMore || orders.length >= total) return
    setLoadingMore(true)
    await fetchPage(page + 1, false)
    setLoadingMore(false)
  }

  const allCount = Object.values(counts).reduce((a, b) => a + (b || 0), 0)

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Orders', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Orders is manager, owner and master only.</Text>
        </View>
      ) : (
        <>
          {/* Status filter strip */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="px-4 py-3 gap-2" style={{ flexGrow: 0 }}>
            {STATUS_TABS.map(t => {
              const active = status === t.key
              const n = t.key ? (counts[t.key] || 0) : allCount
              return (
                <Pressable
                  key={t.key || 'all'}
                  onPress={() => { if (status !== t.key) { setStatus(t.key); setLoading(true) } }}
                  className={`px-3 py-1.5 rounded-full border ${active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-surface border-un1t-border'}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text className={`text-xs font-medium ${active ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>{t.label}{n ? ` · ${n}` : ''}</Text>
                </Pressable>
              )
            })}
          </ScrollView>

          <ScrollView
            contentContainerClassName="px-4 pb-10"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
          >
            {error && (
              <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
                <Text className="text-red-500 text-sm">{error}</Text>
              </View>
            )}

            {loading ? (
              <View className="py-12 items-center"><ActivityIndicator /></View>
            ) : orders.length === 0 ? (
              <View className="py-16 items-center px-6">
                <Ionicons name="cash-outline" size={30} color="#94A3B8" />
                <Text className="text-base font-semibold text-un1t-text mt-3">No orders</Text>
                <Text className="text-xs text-un1t-subtle text-center mt-1">Revenue at {activeLocation?.name || 'this studio'} shows up here.</Text>
              </View>
            ) : (
              <>
                {orders.map(o => {
                  const st = STATUS_STYLE[o.status] || STATUS_STYLE.pending
                  return (
                    <View key={o.id} className="bg-white border border-un1t-border rounded-2xl p-4 mb-2">
                      <View className="flex-row items-center justify-between mb-1">
                        <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>
                          {o.contact_name || o.contact_email || 'Customer'}
                        </Text>
                        <Text className="text-base font-semibold text-un1t-text ml-2">{formatMoney(o.amount_cents, o.currency)}</Text>
                      </View>
                      <View className="flex-row items-center justify-between">
                        <Text className="text-xs text-un1t-subtle flex-1" numberOfLines={1}>
                          {orderSourceLabel(o.source_type)} · {orderDateLabel(o.created_at)}
                        </Text>
                        <View className={`px-2 py-0.5 rounded-full ml-2 ${st.bg}`}>
                          <Text className={`text-[11px] uppercase font-medium ${st.text}`}>{o.status}</Text>
                        </View>
                      </View>
                    </View>
                  )
                })}

                {orders.length < total ? (
                  <Pressable
                    onPress={loadMore}
                    disabled={loadingMore}
                    className="mt-1 py-3 rounded-xl border border-un1t-border items-center active:opacity-70 flex-row justify-center"
                  >
                    {loadingMore
                      ? <ActivityIndicator />
                      : <Text className="text-sm font-medium text-un1t-text">Load more · {orders.length} of {total}</Text>}
                  </Pressable>
                ) : (
                  <Text className="text-center text-xs text-un1t-muted mt-2">{total} order{total === 1 ? '' : 's'}</Text>
                )}
              </>
            )}
          </ScrollView>
        </>
      )}
    </View>
  )
}
