// SPEND.P3 (mobile) — company-card receipts list.
//
// Role-aware (the /api/card-receipts route decides the set):
//   • approvers (owner/master) see the active-studio queue
//   • everyone else sees their own submissions
// Tap a row to drill into /card-receipts/[id] (detail + approve /
// decline / revoke actions). FAB → /card-receipts/new to capture a
// fresh receipt. Pull-to-refresh + useFocusEffect refetch so a freshly
// submitted receipt lands immediately on the back-bounce.
//
// Mirrors the list + status-badge styling of the expenses / invoices
// tabs; the differences are it's a folder route reached from the More
// launcher (so it crosses the tab→stack boundary and needs an explicit
// BackHeaderLeft chevron) and it's gated on the card_receipts mobile
// permission.

import { useState, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator,
} from 'react-native'
import { useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { listCardReceipts, formatPurchaseDate } from '../../lib/card-receipts-api'
import BackHeaderLeft from '../../components/BackHeaderLeft'
import TabletConstrained from '../../components/TabletConstrained'

const STATUS_STYLE = {
  submitted:                   { label: 'Awaiting review', color: '#D97706', bg: 'bg-amber-500/20', text: 'text-amber-700', icon: 'time-outline' },
  // Owner-approved → awaiting the bookkeeper's Xero sign-off (web). From
  // the submitter/owner view it reads as "Approved".
  awaiting_accountant_review:  { label: 'Approved',        color: '#059669', bg: 'bg-green-500/20', text: 'text-green-700', icon: 'checkmark-circle-outline' },
  declined:                    { label: 'Declined',        color: '#DC2626', bg: 'bg-red-500/20',   text: 'text-red-700',   icon: 'close-circle-outline' },
  revoked:                     { label: 'Revoked',         color: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700', icon: 'arrow-undo-outline' },
}

export default function CardReceiptsList() {
  const router = useRouter()
  const { profile, activeLocation } = useAuth()
  const canView = canMobile(profile, 'card_receipts', activeLocation)

  const [receipts, setReceipts] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const fetchList = useCallback(async () => {
    setError(null)
    const r = await listCardReceipts()
    if (r.success === false) {
      setError(r.error || 'Failed to load')
      setReceipts([])
    } else {
      setReceipts(r.data || [])
    }
  }, [])

  // Re-fetch on focus — covers the round-trip from /new and
  // /card-receipts/[id] back to the list (new receipt, approve, decline).
  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    setLoading(true)
    fetchList().finally(() => setLoading(false))
  }, [canView, fetchList]))

  async function onRefresh() {
    setRefreshing(true)
    await fetchList()
    setRefreshing(false)
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen
        options={{
          title: 'Card receipts',
          headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" />,
        }}
      />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Ionicons name="card-outline" size={32} color="#64748B" />
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">
            Company-card receipts aren’t enabled for you at {activeLocation?.name || 'this studio'}.
          </Text>
        </View>
      ) : (
        <>
          {/* STUDIO-IPAD.3 — constrain content on tablet; the floating +
              button stays anchored to the device edge. */}
          <TabletConstrained className="flex-1">
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 96 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
          >
            <Text className="text-2xl font-bold text-un1t-text mb-1">Card receipts</Text>
            <Text className="text-sm text-un1t-subtle mb-5">
              Snap a receipt the moment you pay on the company card. One per purchase;
              an owner approves it, then it’s forwarded to accounts.
            </Text>

            {loading ? (
              <View className="py-16 items-center">
                <ActivityIndicator color="#94A3B8" />
              </View>
            ) : error ? (
              <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
                <Text className="text-sm text-red-700">{error}</Text>
              </View>
            ) : receipts.length === 0 ? (
              <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-8 items-center">
                <Ionicons name="card-outline" size={32} color="#64748B" />
                <Text className="text-sm text-un1t-subtle mt-2 text-center">
                  No card receipts yet. Tap + to capture your first.
                </Text>
              </View>
            ) : (
              receipts.map((r) => (
                <Pressable
                  key={r.id}
                  onPress={() => router.push(`/card-receipts/${r.id}`)}
                  className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
                >
                  <View className="flex-row items-center justify-between mb-1.5">
                    <Text className="text-base font-semibold text-un1t-text" numberOfLines={1}>
                      {r.merchant || 'Card purchase'}
                    </Text>
                    <Text className="text-base font-semibold text-un1t-text">
                      €{Number(r.amount).toFixed(2)}
                    </Text>
                  </View>
                  <View className="flex-row items-center justify-between">
                    <View className={`px-2 py-0.5 rounded-full flex-row items-center ${STATUS_STYLE[r.status]?.bg || 'bg-slate-500/20'}`}>
                      <Ionicons
                        name={STATUS_STYLE[r.status]?.icon || 'help-circle-outline'}
                        size={11}
                        color={STATUS_STYLE[r.status]?.color || '#64748B'}
                      />
                      <Text className={`text-[11px] uppercase font-medium ml-1 ${STATUS_STYLE[r.status]?.text || 'text-un1t-subtle'}`}>
                        {STATUS_STYLE[r.status]?.label || r.status}
                      </Text>
                    </View>
                    <Text className="text-[11px] text-un1t-subtle">
                      {formatPurchaseDate(r.purchase_date)}
                      {r.card_last4 ? ` · ••${r.card_last4}` : ''}
                    </Text>
                  </View>
                  {/* For approvers the list mixes submitters; surface who. */}
                  {r.submitter?.full_name && (
                    <Text className="text-[11px] text-un1t-subtle mt-1.5">
                      {r.submitter.full_name}
                    </Text>
                  )}
                  {r.status === 'declined' && r.decline_reason && (
                    <Text className="text-xs text-un1t-subtle italic mt-2" numberOfLines={2}>
                      &ldquo;{r.decline_reason}&rdquo;
                    </Text>
                  )}
                </Pressable>
              ))
            )}
          </ScrollView>
          </TabletConstrained>

          {/* Floating "new receipt" button */}
          <Pressable
            onPress={() => router.push('/card-receipts/new')}
            className="absolute bottom-6 right-6 w-14 h-14 rounded-full bg-blue-600 items-center justify-center shadow-lg active:opacity-80"
            style={{ shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}
            accessibilityRole="button"
            accessibilityLabel="Capture a new card receipt"
          >
            <Ionicons name="add" size={28} color="#FFFFFF" />
          </Pressable>
        </>
      )}
    </View>
  )
}
