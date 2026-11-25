// Messages tab — unified WhatsApp + Instagram inbox (MOBILE-MSG.M2/M3).
//
// Merges both chat channels into one list (client-side, like the web
// unified inbox) with unread-count badges and a channel glyph on each
// avatar. The five queue chips (Needs reply / Mia needs help / Waiting /
// Approvals / All) are the web's, from the same shared rules
// (shared/inbox-queues) and the same words (shared/inbox-row-text): Needs
// reply is longest-waiting first, each row carries its wait chip, WhatsApp
// window chip and state line (INBOXFOLLOW.4). A coach on their phone triages
// exactly what the desk sees. The studio's follow-up config comes from
// /api/whatsapp/inbox-config; a failed read falls back to the defaults.
// Tapping opens the per-channel conversation thread.
// Pull-to-refresh re-fetches.
//
// EMAIL IS NOT A CHANNEL HERE (INBOX-SPLIT.M1). It was one briefly —
// INBOX-EMAIL-M.1 added it, EMAIL-TICKET-M.1 repointed it at the ticket
// system — and it is now its OWN tab (app/(tabs)/email.jsx), matching web,
// where the unified inbox is WhatsApp + Instagram and email is worked at
// /communications/tickets. A queue with a lifecycle, a subject line,
// per-account access and nothing that auto-closes does not belong
// interleaved with chat threads. Nothing on this screen should reach for
// /api/email/*, the `email_inbox` permission, or a conversation id.
//
// pending_approval: the web /api/whatsapp/conversations route annotates
// it server-side, but mobile WA reads go direct to Supabase — so we
// re-derive it here from one batched pending-requests read. IG rows
// arrive pre-annotated from /api/instagram/conversations.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { listConversations, getInboxConfig } from '../../../lib/whatsapp-api'
import { listConversations as listInstagram, igDisplayName } from '../../../lib/instagram-api'
import { listPendingApprovalConversationIds } from '../../../lib/inbox-approvals-api'
import { needsMiaHelp, hasPendingApproval, queueCounts, QUEUES, DEFAULT_FOLLOWUP_CFG } from '../../../lib/inbox'
import { rowsForQueue, rowDecor, defaultQueue } from '../../../lib/inbox-list'
import { zoneOfLocationRow } from '../../../lib/studio-zone'

// Wait / window chip colours, by the tone the shared row text names.
const TONE_CLASSES = {
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-700' },
  slate: { bg: 'bg-slate-500/10', text: 'text-slate-700' },
  gray: { bg: 'bg-gray-500/10', text: 'text-gray-700' },
  emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-700' },
}

function TextChip({ info }) {
  if (!info) return null
  const tone = TONE_CLASSES[info.tone] || TONE_CLASSES.gray
  return (
    <View className={`ml-2 px-1.5 py-0.5 rounded-full ${tone.bg}`}>
      <Text className={`text-[10px] font-medium ${tone.text}`}>{info.text}</Text>
    </View>
  )
}

const CHANNEL_GLYPHS = {
  whatsapp: { icon: 'logo-whatsapp', color: '#25D366' },
  instagram: { icon: 'logo-instagram', color: '#E1306C' },
}

function ConversationRow({ conv, onPress, nowMs, cfg, zone }) {
  const ig = conv.channel === 'instagram'
  const c = conv.contacts
  const name = ig
    ? igDisplayName(conv)
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
  // Wait chip, WhatsApp window chip (none for IG) and the state line that
  // replaces the preview when the thread's state matters more.
  const { wait, window: windowInfo, stateLine } = rowDecor(conv, nowMs, cfg, zone)
  const glyph = CHANNEL_GLYPHS[conv.channel] || CHANNEL_GLYPHS.whatsapp
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
        <View className="flex-row items-center mt-0.5">
          {isInbound ? null : (
            <Ionicons name="checkmark" size={12} color="#94A3B8" style={{ marginRight: 4 }} />
          )}
          <Text
            className={`text-sm flex-1 ${stateLine ? 'text-un1t-text' : 'text-un1t-subtle'}`}
            numberOfLines={1}
          >
            {stateLine || conv.last_message_preview || '—'}
          </Text>
          {needsMiaHelp(conv) && (
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
          <TextChip info={wait} />
          <TextChip info={windowInfo} />
        </View>
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
  mia_help: 'bg-amber-500',
  waiting: 'bg-slate-400',
  pending_approval: 'bg-purple-500',
}

function routeForConversation(c) {
  if (c.channel === 'instagram') return `/instagram/${c.id}`
  return `/whatsapp/${c.id}`
}

export default function WhatsApp() {
  const { activeLocation } = useAuth()
  const router = useRouter()
  const [conversations, setConversations] = useState([])
  const [queue, setQueue] = useState(defaultQueue)
  const [cfg, setCfg] = useState(DEFAULT_FOLLOWUP_CFG)
  // A one-minute tick, so a thread whose snooze ends or whose quiet window runs
  // out moves between queues (and its wait chip counts up) with the screen open.
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [igError, setIgError] = useState(null)

  const load = useCallback(async () => {
    if (!activeLocation) return
    setError(null)
    const [wa, ig, pendingIds, followup] = await Promise.all([
      listConversations(activeLocation.id),
      listInstagram(activeLocation.id),
      listPendingApprovalConversationIds(activeLocation.id),
      getInboxConfig(activeLocation.id),
    ])
    setCfg(followup)
    setNowMs(Date.now())
    if (!wa.success) setError(wa.error || 'Failed to load conversations')
    // An Instagram failure must never blank WhatsApp — degrade to what
    // loaded, with a soft note.
    setIgError(ig.success ? null : ig.error || 'Instagram couldn’t load')
    const waRows = (wa.success ? wa.data || [] : []).map(c => ({ ...c, channel: 'whatsapp' }))
    const igRows = (ig.success ? ig.data || [] : []).map(c => ({ ...c, channel: 'instagram' }))
    setConversations(
      [...waRows, ...igRows]
        // WA rows come direct from Supabase without the route's
        // pending_approval annotation — backfill it from the batched
        // pending-requests read (IG rows keep their server flag).
        .map(c => ({ ...c, pending_approval: c.pending_approval ?? pendingIds.has(c.id) }))
        .sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0))
    )
  }, [activeLocation])

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

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const zone = zoneOfLocationRow(activeLocation)
  const counts = useMemo(() => queueCounts(conversations, nowMs, cfg), [conversations, nowMs, cfg])
  const visible = useMemo(() => rowsForQueue(conversations, queue, nowMs, cfg), [conversations, queue, nowMs, cfg])

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
          <Text className="text-amber-700 text-sm">Instagram unavailable — showing WhatsApp only. {igError}</Text>
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
              : queue === 'mia_help' ? 'Nothing Mia needs help with.'
              : queue === 'waiting' ? 'Nothing waiting on a customer.'
              : queue === 'pending_approval' ? 'No requests waiting for approval.'
              : 'Queue clear — nothing needs a reply.'}
          </Text>
        </View>
      ) : (
        visible.map(c => (
          <ConversationRow
            key={`${c.channel}:${c.id}`}
            conv={c}
            nowMs={nowMs}
            cfg={cfg}
            zone={zone}
            onPress={() => router.push(routeForConversation(c))}
          />
        ))
      )}
    </ScrollView>
  )
}
