// Messages tab — unified WhatsApp + Instagram + Email inbox
// (MOBILE-MSG.M2/M3; INBOX-EMAIL-M.1 added email as the third channel;
// EMAIL-TICKET-M.1 repointed that channel at the ticket system).
//
// Merges all three channels into one list (client-side, like the web
// unified inbox used to), newest message first, with unread-count badges
// and a channel glyph on each avatar. Queue chips (All / Needs reply /
// Agent handoff / Approval) mirror the web queues so a coach on their
// phone can triage exactly what the desk sees — especially threads Mia
// escalated or requests she's holding for a human decision.
// Tapping opens the per-channel conversation thread.
// Pull-to-refresh re-fetches.
//
// EMAIL IS TICKETS NOW. The web unified inbox is WhatsApp + Instagram
// only; email is worked at /communications/tickets there and via
// /api/email/tickets* here. Two consequences on this screen:
//   • the channel is gated on `email_inbox` (cross-platform key — the
//     same top-level key the ticket routes enforce), NOT on the
//     `whatsapp` key that gates the tab. A coach with the Messages tab
//     but no email grant simply sees no email rows.
//   • a row carries the ticket's SUBJECT as well as its preview, and —
//     when the studio runs more than one address — a chip naming which
//     account it arrived at. accounts@ and sales@ are otherwise
//     indistinguishable on a phone.
//
// pending_approval: the web /api/whatsapp/conversations route annotates
// it server-side, but mobile WA reads go direct to Supabase — so we
// re-derive it here from one batched pending-requests read. IG rows
// arrive pre-annotated from /api/instagram/conversations; ticket rows
// are stamped false by the mapper (no customer agent on email).

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { listConversations, isWindowOpen } from '../../lib/whatsapp-api'
import { listConversations as listInstagram, igDisplayName } from '../../lib/instagram-api'
import { listTickets, emailDisplayName } from '../../lib/email-api'
import { ticketStatusMeta } from '../../lib/email-tickets'
import { listPendingApprovalConversationIds } from '../../lib/inbox-approvals-api'
import { isAgentHandoff, hasPendingApproval, queueCounts, filterByQueue, QUEUES } from '../../lib/inbox'

const CHANNEL_GLYPHS = {
  whatsapp: { icon: 'logo-whatsapp', color: '#25D366' },
  instagram: { icon: 'logo-instagram', color: '#E1306C' },
  email: { icon: 'mail', color: '#2563EB' },
}

function ConversationRow({ conv, onPress }) {
  const ig = conv.channel === 'instagram'
  const em = conv.channel === 'email'
  const c = conv.contacts
  const name = ig
    ? igDisplayName(conv)
    : em
      ? emailDisplayName(conv)
      : (c?.name
        || [c?.first_name, c?.last_name].filter(Boolean).join(' ')
        || conv.wa_profile_name
        || conv.wa_phone)
  const isInbound = conv.last_message_direction === 'inbound'
  const time = conv.last_message_at
    ? new Date(conv.last_message_at).toLocaleString(undefined, {
        hour: 'numeric', minute: '2-digit',
        // If older than today, also show date
        ...(isToday(conv.last_message_at) ? {} : { month: 'short', day: 'numeric' }),
      })
    : ''
  // The 24h send window only exists on WhatsApp — IG and email rows
  // never show the Closed chip.
  const windowOpen = ig || em || isWindowOpen(conv)
  const glyph = CHANNEL_GLYPHS[conv.channel] || CHANNEL_GLYPHS.whatsapp
  // Ticket extras. The live queue is overwhelmingly `open`, so chipping
  // every row with it would be noise — only a status that changes what
  // you do gets one. `mailbox_label` is null unless the caller can see
  // more than one account (see ticketsToInboxRows).
  const status = em && conv.status && conv.status !== 'open' ? ticketStatusMeta(conv.status) : null
  // Boolean on purpose: a bare '' leaking into JSX is a hard RN crash
  // ("Text strings must be rendered within a <Text> component").
  const showTicketChips = !!(em && (conv.mailbox_label || status))
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 flex-row items-center active:opacity-70"
    >
      <View className="w-11 h-11 rounded-full bg-un1t-border/40 items-center justify-center mr-3">
        <Text className="text-base font-semibold text-un1t-text">
          {(name?.[0] || '?').toUpperCase()}
        </Text>
        <View className="absolute -bottom-0.5 -right-0.5 w-[18px] h-[18px] rounded-full bg-un1t-bg items-center justify-center">
          <Ionicons name={glyph.icon} size={12} color={glyph.color} />
        </View>
      </View>
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>
            {name}
          </Text>
          <Text className="text-xs text-un1t-subtle ml-2">{time}</Text>
        </View>
        {/* Ticket subject — what the enquiry is ABOUT, above what was last
            said about it. Email only; WhatsApp/Instagram have no subject. */}
        {em && conv.subject ? (
          <Text className="text-xs text-un1t-text mt-0.5" numberOfLines={1}>
            {conv.subject}
          </Text>
        ) : null}
        <View className="flex-row items-center mt-0.5">
          {isInbound ? null : (
            <Ionicons name="checkmark" size={12} color="#94A3B8" style={{ marginRight: 4 }} />
          )}
          <Text className="text-sm text-un1t-subtle flex-1" numberOfLines={1}>
            {conv.last_message_preview || '—'}
          </Text>
          {isAgentHandoff(conv) && (
            <View className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/20 flex-row items-center">
              <Ionicons name="hand-left-outline" size={10} color="#B45309" style={{ marginRight: 3 }} />
              <Text className="text-[10px] uppercase text-amber-700 font-semibold">Needs human</Text>
            </View>
          )}
          {hasPendingApproval(conv) && (
            <View className="ml-2 px-1.5 py-0.5 rounded bg-purple-500/10">
              <Text className="text-[10px] uppercase text-purple-700 font-semibold">Approval</Text>
            </View>
          )}
          {!windowOpen && !isAgentHandoff(conv) && (
            <View className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/20">
              <Text className="text-[10px] uppercase text-amber-700 font-medium">Closed</Text>
            </View>
          )}
        </View>
        {/* Which account it arrived at, and where it is in the lifecycle.
            Own row rather than crowding the preview: on a phone the
            mailbox name is the difference between a billing query and a
            sales enquiry, so it must not be the thing that truncates. */}
        {showTicketChips && (
          <View className="flex-row items-center mt-1">
            {conv.mailbox_label && (
              <View className="px-1.5 py-0.5 rounded bg-un1t-border/40 mr-1.5 flex-row items-center">
                <Ionicons name="at-outline" size={10} color="#64748B" style={{ marginRight: 3 }} />
                <Text className="text-[10px] text-un1t-subtle font-medium" numberOfLines={1}>
                  {conv.mailbox_label}
                </Text>
              </View>
            )}
            {status && (
              <View className={`px-1.5 py-0.5 rounded ${status.cls}`}>
                <Text className={`text-[10px] font-semibold ${status.text}`}>{status.label}</Text>
              </View>
            )}
          </View>
        )}
      </View>
      {conv.unread_count > 0 && (
        <View className="ml-2 min-w-[20px] h-5 px-1.5 rounded-full bg-green-500 items-center justify-center">
          <Text className="text-[11px] text-white font-semibold">{conv.unread_count}</Text>
        </View>
      )}
    </Pressable>
  )
}

function isToday(iso) {
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
}

const CHIP_BADGE_COLORS = {
  needs_reply: 'bg-green-500',
  handoff: 'bg-amber-500',
  pending_approval: 'bg-purple-500',
}

function routeForConversation(c) {
  if (c.channel === 'instagram') return `/instagram/${c.id}`
  if (c.channel === 'email') return `/email/${c.id}`
  return `/whatsapp/${c.id}`
}

export default function WhatsApp() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const [conversations, setConversations] = useState([])
  const [queue, setQueue] = useState('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [igError, setIgError] = useState(null)
  const [emError, setEmError] = useState(null)

  // `email_inbox` is cross-platform (shared/permissions.js): the same
  // top-level key the /api/email/tickets* routes enforce, so the gate
  // that decides whether to draw the rows is the gate that decides
  // whether the calls succeed. Without this the email fetch would 403
  // on every load for a coach who only holds the `whatsapp` key, and
  // the screen would carry a permanent "Email couldn't load" banner
  // for a feature they were never meant to see.
  const canEmail = canMobile(profile, 'email_inbox', activeLocation)

  const load = useCallback(async () => {
    if (!activeLocation) return
    setError(null)
    const [wa, ig, em, pendingIds] = await Promise.all([
      listConversations(activeLocation.id),
      listInstagram(activeLocation.id),
      canEmail ? listTickets(activeLocation.id) : Promise.resolve({ success: true, data: [] }),
      listPendingApprovalConversationIds(activeLocation.id),
    ])
    if (!wa.success) setError(wa.error || 'Failed to load conversations')
    // An Instagram or Email failure must never blank the other
    // channels — degrade to what loaded, with a soft note.
    setIgError(ig.success ? null : ig.error || 'Instagram couldn’t load')
    setEmError(em.success ? null : em.error || 'Email couldn’t load')
    const waRows = (wa.success ? wa.data || [] : []).map(c => ({ ...c, channel: 'whatsapp' }))
    const igRows = (ig.success ? ig.data || [] : []).map(c => ({ ...c, channel: 'instagram' }))
    // Ticket rows already carry channel: 'email' from ticketsToInboxRows.
    const emRows = em.success ? em.data || [] : []
    setConversations(
      [...waRows, ...igRows, ...emRows]
        // WA rows come direct from Supabase without the route's
        // pending_approval annotation — backfill it from the batched
        // pending-requests read (IG rows keep their server flag).
        .map(c => ({ ...c, pending_approval: c.pending_approval ?? pendingIds.has(c.id) }))
        .sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0))
    )
  }, [activeLocation, canEmail])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  // Re-fetch every time the tab becomes focused so unread counts update
  // after returning from a conversation thread.
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

  const counts = queueCounts(conversations)
  const visible = filterByQueue(conversations, queue)

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator />
      </View>
    )
  }

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
      {igError && (
        <View className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-3">
          <Text className="text-amber-700 text-sm">Instagram unavailable — showing other channels only. {igError}</Text>
        </View>
      )}
      {emError && (
        <View className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-3">
          <Text className="text-amber-700 text-sm">Email unavailable — showing other channels only. {emError}</Text>
        </View>
      )}

      {/* Queue chips — same triage queues as the web unified inbox.
          Horizontal scroll: four chips + counts overflow narrow phones. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="mb-3 -mx-4"
        contentContainerClassName="flex-row px-4"
      >
        {QUEUES.map(q => {
          const count = counts[q.key]
          const active = queue === q.key
          return (
            <Pressable
              key={q.key}
              onPress={() => setQueue(q.key)}
              className={`flex-row items-center px-3 py-1.5 rounded-full mr-2 border ${
                active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-surface border-un1t-border'
              }`}
            >
              <Text className={`text-xs font-semibold ${active ? 'text-white' : 'text-un1t-text'}`}>
                {q.label}
              </Text>
              {q.key !== 'all' && count > 0 && (
                <View className={`ml-1.5 min-w-[18px] px-1 h-[18px] rounded-full items-center justify-center ${
                  CHIP_BADGE_COLORS[q.key] || 'bg-green-500'
                }`}>
                  <Text className="text-[10px] text-white font-bold">{count}</Text>
                </View>
              )}
            </Pressable>
          )
        })}
      </ScrollView>

      {visible.length === 0 ? (
        <View className="py-16 items-center">
          <Ionicons
            name={queue === 'all' ? 'chatbubbles-outline' : 'checkmark-done-circle-outline'}
            size={32}
            color="#94A3B8"
          />
          <Text className="text-sm text-un1t-subtle mt-2">
            {queue === 'all' ? 'No conversations yet.'
              : queue === 'handoff' ? 'No conversations waiting on a human.'
              : queue === 'pending_approval' ? 'No requests waiting for approval.'
              : 'Queue clear — nothing needs a reply.'}
          </Text>
        </View>
      ) : (
        visible.map(c => (
          <ConversationRow
            key={`${c.channel}:${c.id}`}
            conv={c}
            onPress={() => router.push(routeForConversation(c))}
          />
        ))
      )}
    </ScrollView>
  )
}
