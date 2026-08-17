// Email tab — the studio's ticket queue (INBOX-SPLIT.M1).
//
// EMAIL IS ITS OWN SURFACE, exactly as on web. The unified inbox
// (/communications/inbox, and the mobile Messages tab) is WhatsApp +
// Instagram; email is worked at /communications/tickets there and here.
// It used to ride along as a third channel inside Messages — a queue with a
// lifecycle, a subject line, per-account access and nothing that auto-closes
// does not belong interleaved with chat threads, and burying it there meant
// the studio's mail was triaged by whoever happened to scroll past it.
//
// GATED ON `email_inbox`, the TOP-LEVEL key (cross-platform — see
// CROSS_PLATFORM_KEYS in shared/permissions.js). That is the same key every
// /api/email/tickets* route enforces, so the gate that places this tab is the
// gate that lets its calls through; a mobile-namespaced key could drift and
// render an inbox where every request 403s. Per-account visibility is a
// second, separate gate (email_mailbox_access), resolved server-side — which
// is why "no mailboxes" is a normal, non-error state here.
//
// Rows carry what a phone actually needs to triage: who wrote in, what about
// (the subject — chat has no equivalent), the last line, an unread count,
// which account it arrived at (accounts@ and sales@ are otherwise
// indistinguishable) and where it is in the lifecycle. Tapping opens the
// existing thread screen at /email/[ticketId], which owns replying, internal
// notes and the status control.
//
// NOTHING AUTO-CLOSES anywhere in this feature by design, so the queue only
// shrinks when a person solves or closes a ticket. The view chips exist so
// that is visible rather than implied.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listTickets, emailDisplayName } from '../../../lib/email-api'
import {
  ticketStatusMeta, ticketViewTab, ticketViewWire,
  TICKET_VIEW_TABS, DEFAULT_TICKET_VIEW, NO_MAILBOX_EMPTY,
} from '../../../lib/email-tickets'

function isToday(iso) {
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
}

function TicketRow({ row, onPress }) {
  const name = emailDisplayName(row)
  const isInbound = row.last_message_direction === 'inbound'
  const time = row.last_message_at
    ? new Date(row.last_message_at).toLocaleString(undefined, {
        hour: 'numeric', minute: '2-digit',
        ...(isToday(row.last_message_at) ? {} : { month: 'short', day: 'numeric' }),
      })
    : ''
  // Open is the overwhelming majority of the live queue, so chipping every
  // row with it would be noise — only a status that changes what you do next
  // gets one. Same rule as the web list. `mailbox_label` is already null
  // unless the caller can see more than one account (ticketsToInboxRows).
  const status = row.status && row.status !== 'open' ? ticketStatusMeta(row.status) : null
  // Boolean on purpose: a bare '' leaking into JSX is a hard RN crash
  // ("Text strings must be rendered within a <Text> component").
  const showChips = !!(row.mailbox_label || status)

  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 flex-row items-center active:opacity-70"
    >
      <View className="w-11 h-11 rounded-full bg-un1t-border/40 items-center justify-center mr-3">
        <Text className="text-base font-semibold text-un1t-text">
          {(name?.[0] || '?').toUpperCase()}
        </Text>
      </View>
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>
            {name}
          </Text>
          <Text className="text-xs text-un1t-subtle ml-2">{time}</Text>
        </View>
        {/* The subject — what the enquiry is ABOUT, above what was last said
            about it. This is the line email has and chat does not. */}
        {row.subject ? (
          <Text className="text-xs text-un1t-text mt-0.5" numberOfLines={1}>
            {row.subject}
          </Text>
        ) : null}
        <View className="flex-row items-center mt-0.5">
          {isInbound ? null : (
            <Ionicons name="checkmark" size={12} color="#94A3B8" style={{ marginRight: 4 }} />
          )}
          <Text className="text-sm text-un1t-subtle flex-1" numberOfLines={1}>
            {row.last_message_preview || '—'}
          </Text>
        </View>
        {/* Which account it arrived at, and where it is in the lifecycle. Own
            row rather than crowding the preview: on a phone the mailbox name
            is the difference between a billing query and a sales enquiry, so
            it must not be the thing that truncates. */}
        {showChips && (
          <View className="flex-row items-center mt-1">
            {row.mailbox_label ? (
              <View className="px-1.5 py-0.5 rounded bg-un1t-border/40 mr-1.5 flex-row items-center">
                <Ionicons name="at-outline" size={10} color="#64748B" style={{ marginRight: 3 }} />
                <Text className="text-[10px] text-un1t-subtle font-medium" numberOfLines={1}>
                  {row.mailbox_label}
                </Text>
              </View>
            ) : null}
            {status ? (
              <View className={`px-1.5 py-0.5 rounded ${status.cls}`}>
                <Text className={`text-[10px] font-semibold ${status.text}`}>{status.label}</Text>
              </View>
            ) : null}
          </View>
        )}
      </View>
      {row.unread_count > 0 && (
        <View className="ml-2 min-w-[20px] h-5 px-1.5 rounded-full bg-green-500 items-center justify-center">
          <Text className="text-[11px] text-white font-semibold">{row.unread_count}</Text>
        </View>
      )}
    </Pressable>
  )
}

export default function Email() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const [viewId, setViewId] = useState(DEFAULT_TICKET_VIEW)
  const [rows, setRows] = useState([])
  const [mailboxes, setMailboxes] = useState([])
  const [loading, setLoading] = useState(true)
  // Whether a first load has ever completed. Switching view re-fetches, and
  // swapping the whole screen for a spinner would take the chips away from
  // under the finger that just tapped one — so the full-screen spinner is
  // for the cold start only; a view change keeps the chips and spins in the
  // list's place.
  const [ready, setReady] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  // The tab is only navigable when this resolves true (shared/mobile-nav →
  // resolveLayoutForUser), but the screen re-checks rather than trusting its
  // own reachability — a stale deep link should read as "not enabled", not as
  // an inbox that 403s on every call.
  const canEmail = canMobile(profile, 'email_inbox', activeLocation)

  const load = useCallback(async () => {
    if (!activeLocation || !canEmail) return
    const res = await listTickets(activeLocation.id, { view: ticketViewWire(viewId) })
    if (!res.success) {
      setError(res.error || 'Failed to load email')
      return
    }
    setError(null)
    setRows(res.data || [])
    setMailboxes(res.mailboxes || [])
  }, [activeLocation, canEmail, viewId])

  useEffect(() => {
    setLoading(true)
    load().finally(() => { setLoading(false); setReady(true) })
  }, [load])

  // Re-fetch on focus so unread counts and statuses settle after coming back
  // from a thread (replying moves a ticket to pending; opening clears its
  // badge). Same cadence as the Messages tab.
  useFocusEffect(
    useCallback(() => {
      load()
    }, [load])
  )

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  if (!canEmail) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center px-8">
        <Ionicons name="mail-outline" size={32} color="#94A3B8" />
        <Text className="text-sm text-un1t-subtle mt-2 text-center">
          The studio email inbox isn’t enabled for you at this location.
        </Text>
      </View>
    )
  }

  if (!ready) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator />
      </View>
    )
  }

  const view = ticketViewTab(viewId)
  // Only meaningful once something actually loaded: a failed fetch also
  // leaves zero mailboxes, and that has nothing to do with access. The error
  // branch below runs first for exactly that reason.
  const noMailboxes = mailboxes.length === 0

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerClassName="p-4 pb-24"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
    >
      {error && (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
          <Text className="text-red-500 text-sm">{error}</Text>
        </View>
      )}

      {/* View chips — the same queues, in the same words, as the web ticket
          inbox. Horizontal scroll: five chips overflow narrow phones. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="mb-3 -mx-4"
        contentContainerClassName="flex-row px-4"
      >
        {TICKET_VIEW_TABS.map(v => {
          const active = viewId === v.id
          return (
            <Pressable
              key={v.id}
              onPress={() => setViewId(v.id)}
              className={`px-3 py-1.5 rounded-full mr-2 border ${
                active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-surface border-un1t-border'
              }`}
            >
              <Text className={`text-xs font-semibold ${active ? 'text-white' : 'text-un1t-text'}`}>
                {v.label}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>

      {loading && !refreshing ? (
        // A view change, not a cold start — the chips stay put.
        <View className="py-16 items-center">
          <ActivityIndicator />
        </View>
      ) : error && rows.length === 0 ? (
        // The banner above already says what went wrong. What must NOT happen
        // here is "Queue clear" — a failed fetch reading as an empty inbox is
        // how a studio stops answering its mail without noticing.
        <View className="py-10 items-center px-6">
          <Text className="text-sm text-un1t-subtle text-center">
            Pull down to try again.
          </Text>
        </View>
      ) : noMailboxes ? (
        // Not an empty queue — a different situation with a different fix.
        <View className="py-14 items-center px-6">
          <Ionicons name="mail-outline" size={32} color="#94A3B8" />
          <Text className="text-base font-semibold text-un1t-text mt-2 text-center">
            {NO_MAILBOX_EMPTY.title}
          </Text>
          <Text className="text-sm text-un1t-subtle mt-1 text-center">
            {NO_MAILBOX_EMPTY.body}
          </Text>
        </View>
      ) : rows.length === 0 ? (
        <View className="py-16 items-center px-6">
          <Ionicons name="checkmark-done-circle-outline" size={32} color="#94A3B8" />
          <Text className="text-base font-semibold text-un1t-text mt-2 text-center">
            {view.emptyTitle}
          </Text>
          <Text className="text-sm text-un1t-subtle mt-1 text-center">
            {view.emptyBody}
          </Text>
        </View>
      ) : (
        rows.map(r => (
          <TicketRow
            key={r.id}
            row={r}
            onPress={() => router.push(`/email/${r.id}`)}
          />
        ))
      )}
    </ScrollView>
  )
}
