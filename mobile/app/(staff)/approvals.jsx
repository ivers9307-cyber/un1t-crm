// Manager Approvals inbox — APPROVALS-STUDIO.1: two tabs.
//   Customers        agent requests (Mia bookings, funnel reviews, pauses,
//                    cancellations, memberships, events) — urgency-sorted,
//                    default tab; approving executes via the same atomic
//                    PATCH as web (Glofox booking + in-thread confirmation),
//                    declining messages the customer (never silence).
//   Everything else  time-off / swaps / expenses / invoices decide cards,
//                    plus nav tiles into the categories with their own
//                    screens (receipts, issues, hyrox, rosters).
// Reached from the More tab. No client-side role logic — the aggregator
// role-scopes server-side.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Alert, Pressable } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import BackHeaderLeft from '../../components/BackHeaderLeft'
import { getPendingApprovals, reviewHostEvent } from '../../lib/approvals-api'
import {
  mobileApprovalSections, customerQueue, failedQueue, teamNavTiles,
  customerBadgeCount, teamBadgeCount,
} from '../../lib/approvals'
import { respondToTimeOff, respondToSwap } from '../../lib/schedule-api'
import { approveExpenseClaim, declineExpenseClaim } from '../../lib/expenses-api'
import { approveInvoice, declineInvoice } from '../../lib/invoices-api'
import { decideApproval } from '../../lib/inbox-approvals-api'
import ApprovalCard from '../../components/approvals/ApprovalCard'
import CustomerApprovalCard from '../../components/approvals/CustomerApprovalCard'
import DeclineSheet from '../../components/approvals/DeclineSheet'

const REASON_REQUIRED = new Set(['fte_expenses', 'contractor_invoices', 'host_events'])

function TabPill({ label, count, active, onPress }) {
  return (
    <Pressable onPress={onPress}
      className={`flex-1 flex-row items-center justify-center py-2 rounded-xl ${active ? 'bg-un1t-text' : 'border border-un1t-border'}`}>
      <Text className={`text-sm font-semibold ${active ? 'text-white' : 'text-un1t-subtle'}`}>{label}</Text>
      {count > 0 ? (
        <View className={`ml-1.5 rounded-full px-1.5 ${active ? 'bg-white/20' : 'bg-un1t-bg'}`}>
          <Text className={`text-[11px] font-semibold ${active ? 'text-white' : 'text-un1t-subtle'}`}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

export default function ApprovalsInbox() {
  const { activeLocation } = useAuth()
  const locationId = activeLocation?.id
  // NOTIF.4 — optional `?focus=<id>` deep-link param; `?tab=customers|team`
  // picks the landing tab (agent_request pushes send tab=customers).
  const { focus, tab: tabParam } = useLocalSearchParams()
  const [tab, setTab] = useState(tabParam === 'team' ? 'team' : 'customers')
  const [providers, setProviders] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [declineFor, setDeclineFor] = useState(null) // { key, id } — key 'agent_requests' = customer decline

  const load = useCallback(async () => {
    if (!locationId) return
    setError(null)
    const res = await getPendingApprovals({ locationId })
    if (!res.success) { setError(res.error || 'Failed to load approvals'); setProviders([]); return }
    setProviders(res.data?.providers || [])
  }, [locationId])

  useFocusEffect(useCallback(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load]))

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  const customers = customerQueue(providers)
  // AGENT-RETRY.2 — failed executions the server offers for retry.
  const failed = failedQueue(providers)
  const teamSections = mobileApprovalSections(providers)
  const navTiles = teamNavTiles(providers)

  function approveFn(key, id) {
    switch (key) {
      case 'time_off': return respondToTimeOff(id, 'approved', null, locationId)
      case 'shift_swaps': return respondToSwap(id, 'approved', null, locationId)
      case 'fte_expenses': return approveExpenseClaim(id)
      case 'contractor_invoices': return approveInvoice(id)
      case 'host_events': return reviewHostEvent(id, 'approve')
      default: return Promise.resolve({ success: false, error: 'Unknown category' })
    }
  }
  function declineFn(key, id, reason) {
    switch (key) {
      case 'time_off': return respondToTimeOff(id, 'rejected', reason, locationId)
      case 'shift_swaps': return respondToSwap(id, 'rejected', reason, locationId)
      case 'fte_expenses': return declineExpenseClaim(id, reason)
      case 'contractor_invoices': return declineInvoice(id, reason)
      case 'host_events': return reviewHostEvent(id, 'reject', reason)
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

  // Customer approvals execute server-side (Glofox booking etc.) — surface an
  // execution failure honestly instead of a silent green tick.
  async function onApproveCustomer(item) {
    setBusyId(item.id)
    const res = await decideApproval(item.id, 'approved')
    setBusyId(null)
    if (!res.success) { Alert.alert('Could not approve', res.error || 'Unknown error'); return }
    if (res.executed && res.executed.ok === false) {
      Alert.alert('Approved, but the action failed', res.executed.message_code || 'The booking system rejected it. Check the account and retry.')
    }
    load()
  }

  async function submitDecline(reason) {
    const target = declineFor
    setDeclineFor(null)
    if (!target) return
    setBusyId(target.id)
    const res = target.key === 'agent_requests'
      ? await decideApproval(target.id, 'declined', reason || null)
      : await declineFn(target.key, target.id, reason || null)
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
        <View className="flex-row gap-2 mb-4">
          <TabPill label="Customers" count={customerBadgeCount(providers)} active={tab === 'customers'} onPress={() => setTab('customers')} />
          <TabPill label="Everything else" count={teamBadgeCount(providers)} active={tab === 'team'} onPress={() => setTab('team')} />
        </View>

        {error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-700 text-sm">{error}</Text>
          </View>
        ) : null}

        {loading ? (
          <View className="py-12 items-center"><ActivityIndicator /></View>
        ) : tab === 'customers' ? (
          customers.length === 0 && failed.length === 0 ? (
            <View className="py-16 items-center">
              <Ionicons name="checkmark-done-outline" size={30} color="#94A3B8" />
              <Text className="text-sm text-un1t-subtle mt-2">No customers waiting.</Text>
            </View>
          ) : (
            <>
              {/* AGENT-RETRY.2 — failed executions first: that customer has
                  been waiting longest and was told nothing. The card offers
                  only retry (fix in Glofox first); onApproveCustomer already
                  surfaces a repeat failure honestly via its Alert. */}
              {failed.length > 0 ? (
                <Text className="text-xs uppercase tracking-wider text-red-700 mb-2 px-1">Failed — fix &amp; retry</Text>
              ) : null}
              {failed.map((item) => (
                <CustomerApprovalCard
                  key={item.id}
                  item={item}
                  highlight={typeof focus === 'string' && focus === item.id}
                  busy={busyId === item.id}
                  onApprove={() => onApproveCustomer(item)}
                />
              ))}
              {failed.length > 0 && customers.length > 0 ? (
                <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-2 mt-2 px-1">Waiting for review</Text>
              ) : null}
              {customers.map((item) => (
                <CustomerApprovalCard
                  key={item.id}
                  item={item}
                  highlight={typeof focus === 'string' && focus === item.id}
                  busy={busyId === item.id}
                  onApprove={() => onApproveCustomer(item)}
                  onDecline={() => setDeclineFor({ key: 'agent_requests', id: item.id })}
                />
              ))}
            </>
          )
        ) : (
          teamSections.length === 0 && navTiles.length === 0 ? (
            <View className="py-16 items-center">
              <Ionicons name="checkmark-done-outline" size={30} color="#94A3B8" />
              <Text className="text-sm text-un1t-subtle mt-2">No pending approvals.</Text>
            </View>
          ) : (
            <>
              {teamSections.map((sec) => (
                <View key={sec.key} className="mb-5">
                  <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-2 px-1">{sec.label} ({sec.count})</Text>
                  {sec.items.map((item) => (
                    <ApprovalCard
                      key={item.id}
                      item={item}
                      highlight={typeof focus === 'string' && focus === item.id}
                      busy={busyId === item.id}
                      onApprove={() => onApprove(sec.key, item)}
                      onDecline={() => setDeclineFor({ key: sec.key, id: item.id })}
                    />
                  ))}
                </View>
              ))}
              {navTiles.map((tile) => (
                <Pressable key={tile.key} onPress={() => router.push(tile.route)}
                  className="bg-un1t-surface border border-un1t-border rounded-2xl p-3.5 mb-2 flex-row items-center justify-between active:opacity-70">
                  <View className="flex-row items-center">
                    <Text className="text-sm font-semibold text-un1t-text">{tile.label}</Text>
                    <View className="bg-amber-500/10 rounded-full px-2 py-0.5 ml-2">
                      <Text className="text-[11px] font-semibold text-amber-700">{tile.count}</Text>
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
                </Pressable>
              ))}
            </>
          )
        )}
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
