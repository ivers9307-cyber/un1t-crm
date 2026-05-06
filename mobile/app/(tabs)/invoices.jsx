// Invoices tab — contractor's own submissions list + a "New invoice"
// FAB. Submit form lives at /invoices/new; detail at /invoices/[id].
//
// Visible only when user.employment_type === 'contractor' (gated in
// (tabs)/_layout.jsx via Tabs.Screen href: null).

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { listInvoices, periodLabel } from '../../lib/invoices-api'

const STATUS_STYLE = {
  submitted: { label: 'Awaiting review', color: '#D97706', bg: 'bg-amber-500/20', text: 'text-amber-700', icon: 'time-outline' },
  approved:  { label: 'Approved',        color: '#059669', bg: 'bg-green-500/20', text: 'text-green-700', icon: 'checkmark-circle-outline' },
  declined:  { label: 'Declined',        color: '#DC2626', bg: 'bg-red-500/20',   text: 'text-red-700',   icon: 'close-circle-outline' },
  revoked:   { label: 'Revoked',         color: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700', icon: 'arrow-undo-outline' },
}

export default function InvoicesScreen() {
  const router = useRouter()
  const { profile } = useAuth()
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const fetchList = useCallback(async () => {
    setError(null)
    const r = await listInvoices()
    if (r.success === false) {
      setError(r.error || 'Failed to load')
      setInvoices([])
    } else {
      setInvoices(r.data || [])
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchList().finally(() => setLoading(false))
  }, [fetchList])

  // Re-fetch on tab refocus so a freshly submitted invoice from
  // /invoices/new lands in the list immediately.
  useFocusEffect(useCallback(() => { fetchList() }, [fetchList]))

  async function onRefresh() {
    setRefreshing(true)
    await fetchList()
    setRefreshing(false)
  }

  return (
    <View className="flex-1 bg-un1t-black">
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 96 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
      >
        <Text className="text-2xl font-bold text-un1t-white mb-1">Invoices</Text>
        <Text className="text-sm text-un1t-light mb-5">
          Submit your monthly invoice as a PDF. Approved invoices are forwarded to accounts;
          declined ones come back with notes for adjustment.
        </Text>

        {loading ? (
          <View className="py-16 items-center">
            <ActivityIndicator color="#94A3B8" />
          </View>
        ) : error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
            <Text className="text-sm text-red-700">{error}</Text>
          </View>
        ) : invoices.length === 0 ? (
          <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-8 items-center">
            <Ionicons name="document-text-outline" size={32} color="#64748B" />
            <Text className="text-sm text-un1t-light mt-2 text-center">
              No invoices yet. Tap the + button to submit your first.
            </Text>
          </View>
        ) : (
          invoices.map((inv) => (
            <Pressable
              key={inv.id}
              onPress={() => router.push(`/invoices/${inv.id}`)}
              className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 mb-2 active:opacity-70"
            >
              <View className="flex-row items-center justify-between mb-1.5">
                <Text className="text-base font-semibold text-un1t-white">
                  {periodLabel(inv.period_start)}
                </Text>
                <Text className="text-base font-semibold text-un1t-white">
                  €{Number(inv.invoice_amount).toFixed(2)}
                </Text>
              </View>
              <View className="flex-row items-center justify-between">
                <View className={`px-2 py-0.5 rounded-full flex-row items-center ${STATUS_STYLE[inv.status]?.bg || 'bg-slate-500/20'}`}>
                  <Ionicons
                    name={STATUS_STYLE[inv.status]?.icon || 'help-circle-outline'}
                    size={11}
                    color={STATUS_STYLE[inv.status]?.color || '#64748B'}
                  />
                  <Text className={`text-[11px] uppercase font-medium ml-1 ${STATUS_STYLE[inv.status]?.text || 'text-un1t-light'}`}>
                    {STATUS_STYLE[inv.status]?.label || inv.status}
                  </Text>
                </View>
                {inv.xero_synced_at && (
                  <Text className="text-[10px] text-un1t-light">Forwarded to accounts</Text>
                )}
              </View>
              {inv.status === 'declined' && inv.decline_reason && (
                <Text className="text-xs text-un1t-light italic mt-2" numberOfLines={2}>
                  &ldquo;{inv.decline_reason}&rdquo;
                </Text>
              )}
            </Pressable>
          ))
        )}
      </ScrollView>

      {/* Floating "new invoice" button */}
      <Pressable
        onPress={() => router.push('/invoices/new')}
        className="absolute bottom-6 right-6 w-14 h-14 rounded-full bg-blue-600 items-center justify-center shadow-lg active:opacity-80"
        style={{ shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}
      >
        <Ionicons name="add" size={28} color="#FFFFFF" />
      </Pressable>
    </View>
  )
}
