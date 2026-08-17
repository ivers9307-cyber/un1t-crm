// ACCOUNTING-HUB.1 — the Accounting landing screen on mobile.
//
// One "Accounting" tile in More opens this. It nests the money surfaces
// (Expenses, Invoices own-submissions, Company-card receipts, Invoices
// approver inbox, and the Orders revenue ledger) and routes by access
// level — the same flow as the Reports hub:
//   • exactly one surface → that screen directly. The More tile routes
//     single-surface users straight to their one surface, so the hub is
//     normally only reached with 2+; it self-redirects defensively if
//     deep-linked with a single surface.
//   • two or more surfaces → a chooser of cards.
// Submitting folds in — Expenses and Invoices keep their own + FABs.
// EVENTS-HUB.2: Orders lives here (it's revenue → money), not under Events.

import { useState, useCallback } from 'react'
import { View, Text, Pressable, ScrollView } from 'react-native'
import { useRouter, Redirect, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { resolveLayoutForUser } from '../../lib/mobile-layout'
import { canMobile } from '../../lib/permissions'
import { accountingLanding, ACCOUNTING_ROUTES } from '../../lib/accounting'
import { listInvoices } from '../../lib/invoices-api'
import BackHeaderLeft from '../../components/BackHeaderLeft'

function ChoiceCard({ icon, title, subtitle, badge, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 flex-row items-center active:opacity-70"
    >
      <View className="w-12 h-12 rounded-full bg-un1t-border/40 items-center justify-center mr-4">
        <Ionicons name={icon} size={24} color="#111827" />
      </View>
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-base font-semibold text-un1t-text">{title}</Text>
          {badge ? (
            <View className="ml-2 bg-amber-500 rounded-full min-w-[20px] h-5 px-1.5 items-center justify-center">
              <Text className="text-[11px] text-white font-bold">{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text className="text-sm text-un1t-subtle mt-0.5">{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
    </Pressable>
  )
}

export default function AccountingHub() {
  const router = useRouter()
  const { profile, activeLocation } = useAuth()

  const { more } = resolveLayoutForUser(profile, activeLocation)
  const has = new Set(more)
  const canExpenses = has.has('expenses')
  const canInvoices = has.has('invoices')
  const canInbox = canMobile(profile, 'invoices_inbox', activeLocation)
  // SPEND.P3 — card_receipts isn't a nav-feature in the layout `more`
  // set, so read it directly via canMobile (same as the inbox).
  const canCardReceipts = canMobile(profile, 'card_receipts', activeLocation)
  // EVENTS-HUB.2 — Orders (revenue ledger) reads its own `orders` gate.
  const canOrders = canMobile(profile, 'orders', activeLocation)
  // INV-M.1 — bookkeeper queue (bulk extract + Not-in-Xero flag).
  // `bookkeeper` is cross-platform: the same top-level toggle the web
  // bulk routes enforce (master by default).
  const canQueue = canMobile(profile, 'bookkeeper', activeLocation)
  const landing = accountingLanding({ canExpenses, canInvoices, canInbox, canCardReceipts, canOrders, canQueue })

  // Awaiting-approval count for the Invoices inbox card badge (approvers
  // only). listInvoices() is role-aware — for an approver it returns the
  // studio queue; 'submitted' = waiting on them.
  const [awaiting, setAwaiting] = useState(0)
  useFocusEffect(useCallback(() => {
    if (!canInbox) return
    let alive = true
    listInvoices().then((res) => {
      if (alive && res.success !== false && Array.isArray(res.data)) {
        setAwaiting(res.data.filter((i) => i.status === 'submitted').length)
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [canInbox]))

  if (!profile) return null

  // Single-surface users skip the chooser; the degenerate no-surface
  // case bounces home (the tile is gated so it shouldn't get here).
  if (landing && landing !== 'chooser') return <Redirect href={ACCOUNTING_ROUTES[landing]} />
  if (!landing) return <Redirect href="/(tabs)/more" />

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerClassName="p-4">
      <Stack.Screen
        options={{
          title: 'Accounting',
          headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" />,
        }}
      />
      <Text className="text-sm text-un1t-subtle mb-3">What would you like to view?</Text>
      <View className="gap-3">
        {canExpenses && (
          <ChoiceCard
            icon="wallet-outline"
            title="Expenses"
            subtitle="Submit & track your own expense receipts"
            onPress={() => router.push('/expenses')}
          />
        )}
        {canInvoices && (
          <ChoiceCard
            icon="receipt-outline"
            title="Invoices"
            subtitle="Submit & track your own invoices"
            onPress={() => router.push('/invoices')}
          />
        )}
        {canCardReceipts && (
          <ChoiceCard
            icon="card-outline"
            title="Company-card receipts"
            subtitle="Snap a receipt for a company-card purchase"
            onPress={() => router.push('/card-receipts')}
          />
        )}
        {canInbox && (
          <ChoiceCard
            icon="file-tray-full-outline"
            title="Invoices inbox"
            subtitle="Review & approve supplier invoices"
            badge={awaiting > 0 ? String(awaiting) : null}
            onPress={() => router.push('/invoices/inbox')}
          />
        )}
        {canQueue && (
          <ChoiceCard
            icon="scan-outline"
            title="Bookkeeper queue"
            subtitle="Run extraction on queued supplier invoices"
            onPress={() => router.push('/invoices/queue')}
          />
        )}
        {canOrders && (
          <ChoiceCard
            icon="cash-outline"
            title="Orders"
            subtitle="Revenue across race signups & car deposits"
            onPress={() => router.push('/orders')}
          />
        )}
      </View>
    </ScrollView>
  )
}
