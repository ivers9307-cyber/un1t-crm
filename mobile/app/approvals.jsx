// Manager Approvals inbox — sections per category (time-off, swaps, expenses,
// invoices), each an ApprovalCard. Approve dispatches to the right helper;
// Decline opens a reason sheet (required for finance items). Reached from the
// More tab. No client-side role logic — the aggregator role-scopes server-side.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Alert } from 'react-native'
import { Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../lib/auth-context'
import BackHeaderLeft from '../components/BackHeaderLeft'
import { getPendingApprovals } from '../lib/approvals-api'
import { mobileApprovalSections } from '../lib/approvals'
import { respondToTimeOff, respondToSwap } from '../lib/schedule-api'
import { approveExpenseClaim, declineExpenseClaim } from '../lib/expenses-api'
import { approveInvoice, declineInvoice } from '../lib/invoices-api'
import ApprovalCard from '../components/approvals/ApprovalCard'
import DeclineSheet from '../components/approvals/DeclineSheet'

const REASON_REQUIRED = new Set(['fte_expenses', 'contractor_invoices'])

export default function ApprovalsInbox() {
  const { activeLocation } = useAuth()
  const locationId = activeLocation?.id
  const [sections, setSections] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [declineFor, setDeclineFor] = useState(null) // { key, id }

  const load = useCallback(async () => {
    if (!locationId) return
    setError(null)
    const res = await getPendingApprovals({ locationId })
    if (!res.success) { setError(res.error || 'Failed to load approvals'); setSections([]); return }
    setSections(mobileApprovalSections(res.data?.providers || []))
  }, [locationId])

  useFocusEffect(useCallback(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load]))

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  function approveFn(key, id) {
    switch (key) {
      case 'time_off': return respondToTimeOff(id, 'approved', null, locationId)
      case 'shift_swaps': return respondToSwap(id, 'approved', null, locationId)
      case 'fte_expenses': return approveExpenseClaim(id)
      case 'contractor_invoices': return approveInvoice(id)
      default: return Promise.resolve({ success: false, error: 'Unknown category' })
    }
  }
  function declineFn(key, id, reason) {
    switch (key) {
      case 'time_off': return respondToTimeOff(id, 'rejected', reason, locationId)
      case 'shift_swaps': return respondToSwap(id, 'rejected', reason, locationId)
      case 'fte_expenses': return declineExpenseClaim(id, reason)
      case 'contractor_invoices': return declineInvoice(id, reason)
      default: return Promise.resolve({ success: false, error: 'Unknown category' })
    }
  }

  async function onApprove(key, item) {
    setBusyId(item.id)
    const res = await approveFn(key, item.id)
    setBusyId(null)
    if (!res.success) { Alert.alert('Could not approve', res.error || 'Unknown error'); return }
    const warn = res.warning || (Array.isArray(res.warnings) && res.warnings.length ? res.warnings.join('\n') : null)
    if (warn) Alert.alert('Approved — note', warn)
    load()
  }

  async function submitDecline(reason) {
    const target = declineFor
    setDeclineFor(null)
    if (!target) return
    setBusyId(target.id)
    const res = await declineFn(target.key, target.id, reason || null)
    setBusyId(null)
    if (!res.success) { Alert.alert('Could not decline', res.error || 'Unknown error'); return }
    load()
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Approvals', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />
      <ScrollView
        contentContainerClassName="p-4 pb-10"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
      >
        {error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-500 text-sm">{error}</Text>
          </View>
        ) : null}

        {loading ? (
          <View className="py-12 items-center"><ActivityIndicator /></View>
        ) : sections.length === 0 ? (
          <View className="py-16 items-center">
            <Ionicons name="checkmark-done-outline" size={30} color="#94A3B8" />
            <Text className="text-sm text-un1t-subtle mt-2">No pending approvals.</Text>
          </View>
        ) : sections.map((sec) => (
          <View key={sec.key} className="mb-5">
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-2 px-1">{sec.label} ({sec.count})</Text>
            {sec.items.map((item) => (
              <ApprovalCard
                key={item.id}
                item={item}
                busy={busyId === item.id}
                onApprove={() => onApprove(sec.key, item)}
                onDecline={() => setDeclineFor({ key: sec.key, id: item.id })}
              />
            ))}
          </View>
        ))}
      </ScrollView>

      <DeclineSheet
        visible={!!declineFor}
        requireReason={declineFor ? REASON_REQUIRED.has(declineFor.key) : false}
        onConfirm={submitDecline}
        onClose={() => setDeclineFor(null)}
      />
    </View>
  )
}
