// W2 — invoices approver inbox (owner / master). The role-aware GET
// /api/invoices returns the active studio's review queue for owner/master
// (the contractor Invoices tab shows their own). Tabs by status; tap a
// row to review the PDF and approve / decline on the detail screen.
import { useState, useCallback, useMemo } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listInvoices, periodLabel } from '../../../lib/invoices-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

const TABS = [
  { key: 'submitted', label: 'Awaiting' },
  { key: 'approved', label: 'Approved' },
  { key: 'declined', label: 'Declined' },
]
// Owner-approval flips status to `awaiting_accountant_review` (the
// INVOICES-QUEUE.1 two-step: owner approves, then a bookkeeper signs off
// to Xero on web). From the owner's view that IS "approved", so the
// Approved tab covers both it and the final `approved` state.
const STATUS_FOR_TAB = {
  submitted: ['submitted'],
  approved: ['approved', 'awaiting_accountant_review'],
  declined: ['declined'],
}
const STATUS_STYLE = {
  submitted: { label: 'Awaiting review', color: '#D97706', bg: 'bg-amber-500/20', text: 'text-amber-700', icon: 'time-outline' },
  awaiting_accountant_review: { label: 'Approved', color: '#059669', bg: 'bg-green-500/20', text: 'text-green-700', icon: 'checkmark-circle-outline' },
  approved:  { label: 'Approved',        color: '#059669', bg: 'bg-green-500/20', text: 'text-green-700', icon: 'checkmark-circle-outline' },
  declined:  { label: 'Declined',        color: '#DC2626', bg: 'bg-red-500/20',   text: 'text-red-700',   icon: 'close-circle-outline' },
  revoked:   { label: 'Revoked',         color: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700', icon: 'arrow-undo-outline' },
}

export default function InvoicesInbox() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'invoices_inbox', activeLocation)

  const [all, setAll] = useState([])
  const [tab, setTab] = useState('submitted')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const r = await listInvoices()
    if (r.success === false) { setError(r.error || 'Failed to load'); setAll([]); return }
    setAll(Array.isArray(r.data) ? r.data : [])
  }, [])

  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    load().finally(() => setLoading(false))
  }, [canView, load]))

  const rows = useMemo(() => all.filter(i => (STATUS_FOR_TAB[tab] || [tab]).includes(i.status)), [all, tab])
  const awaiting = useMemo(() => all.filter(i => i.status === 'submitted').length, [all])

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Invoices inbox', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">The invoices inbox is owner/master only.</Text>
        </View>
      ) : (
        <>
          <View className="flex-row gap-2 px-4 pt-3 pb-2">
            {TABS.map(t => {
              const active = tab === t.key
              const badge = t.key === 'submitted' && awaiting > 0 ? ` · ${awaiting}` : ''
              return (
                <Pressable
                  key={t.key}
                  onPress={() => { setTab(t.key); setLoading(true) }}
                  className={`px-3 py-1.5 rounded-full border ${active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-surface border-un1t-border'}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text className={`text-xs font-medium ${active ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>{t.label}{badge}</Text>
                </Pressable>
              )
            })}
          </View>

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
            ) : rows.length === 0 ? (
              <View className="py-16 items-center px-6">
                <Ionicons name="receipt-outline" size={30} color="#94A3B8" />
                <Text className="text-base font-semibold text-un1t-text mt-3">{tab === 'submitted' ? 'Nothing to review' : 'None here'}</Text>
                <Text className="text-xs text-un1t-subtle text-center mt-1">Invoices at {activeLocation?.name || 'this studio'} show up here.</Text>
              </View>
            ) : (
              rows.map(inv => {
                const s = STATUS_STYLE[inv.status] || STATUS_STYLE.submitted
                return (
                  <Pressable
                    key={inv.id}
                    onPress={() => router.push(`/invoices/${inv.id}`)}
                    className="bg-white border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
                  >
                    <View className="flex-row items-center justify-between mb-1">
                      <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>
                        {inv.contractor?.full_name || 'Contractor'}
                      </Text>
                      <Text className="text-base font-semibold text-un1t-text ml-2">€{Number(inv.invoice_amount).toFixed(2)}</Text>
                    </View>
                    <View className="flex-row items-center justify-between">
                      <Text className="text-xs text-un1t-subtle">{periodLabel(inv.period_start)}</Text>
                      <View className={`px-2 py-0.5 rounded-full flex-row items-center ${s.bg}`}>
                        <Ionicons name={s.icon} size={11} color={s.color} />
                        <Text className={`text-[11px] uppercase font-medium ml-1 ${s.text}`}>{s.label}</Text>
                      </View>
                    </View>
                  </Pressable>
                )
              })
            )}
          </ScrollView>
        </>
      )}
    </View>
  )
}
