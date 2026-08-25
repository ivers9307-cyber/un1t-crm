// FTE-EXPENSES.2 (mobile) — expenses tab list.
//
// FTE staff's own monthly expense claims with status badges. Tap a
// row to drill into /expenses/[id] (line items + add-item flow +
// submit/revoke actions). FAB → /expenses/new to start a fresh
// month.
//
// Mirrors the contractor invoices tab (mobile/app/(tabs)/invoices.jsx)
// in structure; the differences are:
//   - Per-claim shows item_count + total + VAT instead of a single
//     amount + invoice number
//   - The status set adds 'draft' (claim is in-flight, not yet
//     submitted), which doesn't exist for contractor invoices

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { listExpenseClaims, periodLabel } from '../../../lib/expenses-api'
import TabletConstrained from '../../../components/TabletConstrained'

const STATUS_STYLE = {
  draft:     { label: 'Draft',           color: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700', icon: 'create-outline' },
  submitted: { label: 'Awaiting review', color: '#D97706', bg: 'bg-amber-500/20', text: 'text-amber-700', icon: 'time-outline' },
  approved:  { label: 'Approved',        color: '#059669', bg: 'bg-green-500/20', text: 'text-green-700', icon: 'checkmark-circle-outline' },
  declined:  { label: 'Declined',        color: '#DC2626', bg: 'bg-red-500/20',   text: 'text-red-700',   icon: 'close-circle-outline' },
  revoked:   { label: 'Revoked',         color: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700', icon: 'arrow-undo-outline' },
}

export default function ExpensesScreen() {
  const router = useRouter()
  const [claims, setClaims] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const fetchList = useCallback(async () => {
    setError(null)
    const r = await listExpenseClaims()
    if (r.success === false) {
      setError(r.error || 'Failed to load')
      setClaims([])
    } else {
      setClaims(r.data || [])
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchList().finally(() => setLoading(false))
  }, [fetchList])

  // Re-fetch on tab refocus — covers the round-trip from /new and
  // /expenses/[id] back to the list (new draft, added item, submitted).
  useFocusEffect(useCallback(() => { fetchList() }, [fetchList]))

  async function onRefresh() {
    setRefreshing(true)
    await fetchList()
    setRefreshing(false)
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      {/* STUDIO-IPAD.3 — constrain content on tablet; floating + button
          stays anchored to the device edge. */}
      <TabletConstrained className="flex-1">
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 96 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
      >
        <Text className="text-2xl font-bold text-un1t-text mb-1">Expenses</Text>
        <Text className="text-sm text-un1t-subtle mb-5">
          Capture receipts as you collect them. Submit at month-end for approval;
          reimbursement runs through the next payroll.
        </Text>

        {loading ? (
          <View className="py-16 items-center">
            <ActivityIndicator color="#94A3B8" />
          </View>
        ) : error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
            <Text className="text-sm text-red-700">{error}</Text>
          </View>
        ) : claims.length === 0 ? (
          <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-8 items-center">
            <Ionicons name="wallet-outline" size={32} color="#64748B" />
            <Text className="text-sm text-un1t-subtle mt-2 text-center">
              No expense claims yet. Tap + to start a claim for the current month.
            </Text>
          </View>
        ) : (
          claims.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => router.push(`/expenses/${c.id}`)}
              className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
            >
              <View className="flex-row items-center justify-between mb-1.5">
                <Text className="text-base font-semibold text-un1t-text">{periodLabel(c.period_start)}</Text>
                <Text className="text-base font-semibold text-un1t-text">
                  €{Number(c.total_amount).toFixed(2)}
                </Text>
              </View>
              <View className="flex-row items-center justify-between">
                <View className={`px-2 py-0.5 rounded-full flex-row items-center ${STATUS_STYLE[c.status]?.bg || 'bg-slate-500/20'}`}>
                  <Ionicons
                    name={STATUS_STYLE[c.status]?.icon || 'help-circle-outline'}
                    size={11}
                    color={STATUS_STYLE[c.status]?.color || '#64748B'}
                  />
                  <Text className={`text-[11px] uppercase font-medium ml-1 ${STATUS_STYLE[c.status]?.text || 'text-un1t-subtle'}`}>
                    {STATUS_STYLE[c.status]?.label || c.status}
                  </Text>
                </View>
                <Text className="text-[11px] text-un1t-subtle">
                  {c.item_count} item{c.item_count === 1 ? '' : 's'} · €{Number(c.total_vat_amount || 0).toFixed(2)} VAT
                </Text>
              </View>
              {c.status === 'declined' && c.decline_reason && (
                <Text className="text-xs text-un1t-subtle italic mt-2" numberOfLines={2}>
                  &ldquo;{c.decline_reason}&rdquo;
                </Text>
              )}
            </Pressable>
          ))
        )}
      </ScrollView>
      </TabletConstrained>

      <Pressable
        onPress={() => router.push('/expenses/new')}
        className="absolute bottom-6 right-6 w-14 h-14 rounded-full bg-blue-600 items-center justify-center shadow-lg active:opacity-80"
        style={{ shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}
      >
        <Ionicons name="add" size={28} color="#FFFFFF" />
      </Pressable>
    </View>
  )
}
