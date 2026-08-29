// Mail tab — the studio's email, mail-client shaped (MOBILE-MAIL.1).
//
// EMAIL IS ITS OWN SURFACE, exactly as on web: /communications/mail there,
// this tab here (RETIRE-TICKETS.1 — the ticket queue this screen used to
// mirror is deleted; Mail won the mig-575 A/B). The unified Messages tab
// stays WhatsApp + Instagram.
//
// GATED ON `email_inbox`, the TOP-LEVEL key (cross-platform — see
// CROSS_PLATFORM_KEYS in shared/permissions.js). That is the same key every
// /api/email/* route enforces, so the gate that places this tab is the gate
// that lets its calls through; a mobile-namespaced key could drift and
// render an inbox where every request 403s. Per-account visibility is a
// second, separate gate (email_mailbox_access), resolved server-side — which
// is why "no mailboxes" is a normal, non-error state here.
//
// Rows carry what a phone actually needs to triage: who wrote in, what about
// (the subject — chat has no equivalent), the last line, unread weight, a
// paperclip when a real file rode along, which account it arrived at, and
// Archived / Needs reply. Tapping opens the thread at /email/[ticketId];
// ARCHIVE — the surface's primary verb — is the row's trailing button, with
// the whole lifecycle ceremony (assignment, four states) gone.
//
// Nothing auto-closes: the inbox only shrinks when a person archives, and a
// member's reply brings an archived conversation straight back.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listMail, archiveConversation, emailDisplayName } from '../../../lib/email-api'
import {
  mailStatusChip, ticketViewTab, ticketViewWire,
  TICKET_VIEW_TABS, DEFAULT_TICKET_VIEW, NO_MAILBOX_EMPTY,
} from '../../../lib/email-tickets'

function isToday(iso) {
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
}

function MailRow({ row, onPress, onArchiveToggle, archiving }) {
  const name = emailDisplayName(row)
  const isInbound = row.last_message_direction === 'inbound'
  const time = row.last_message_at
    ? new Date(row.last_message_at).toLocaleString(undefined, {
        hour: 'numeric', minute: '2-digit',
        ...(isToday(row.last_message_at) ? {} : { month: 'short', day: 'numeric' }),
      })
    : ''
  // Only a fact that changes what you do next gets a chip — Archived, or
  // Needs reply. Same rule as the web list. `mailbox_label` is already null
  // unless the caller can see more than one account (ticketsToInboxRows).
  const chip = mailStatusChip(row)
  // Boolean on purpose: a bare '' leaking into JSX is a hard RN crash
  // ("Text strings must be rendered within a <Text> component").
  const showChips = !!(row.mailbox_label || chip)
  // Unread carries WEIGHT, like every mail client: the row's facts go bold
  // rather than growing a counter pill. `unread` mirrors per-message seen_at
  // (IMAP \Seen where connected), so mail read at the desk reads here too.
  const weight = row.unread ? 'font-bold' : 'font-semibold'

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
          {row.unread ? (
            <View className="w-2 h-2 rounded-full bg-blue-500 mr-1.5" />
          ) : null}
          <Text className={`text-base ${weight} text-un1t-text flex-1`} numberOfLines={1}>
            {name}
          </Text>
          <Text className="text-xs text-un1t-subtle ml-2">{time}</Text>
        </View>
        {/* The subject — what the enquiry is ABOUT, above what was last said
            about it. This is the line email has and chat does not. */}
        {row.subject ? (
          <Text className={`text-xs text-un1t-text mt-0.5 ${row.unread ? 'font-semibold' : ''}`} numberOfLines={1}>
            {row.subject}
          </Text>
        ) : null}
        <View className="flex-row items-center mt-0.5">
          {isInbound ? null : (
            <Ionicons name="checkmark" size={12} color="#94A3B8" style={{ marginRight: 4 }} />
          )}
          {row.has_attachments ? (
            <Ionicons name="attach-outline" size={12} color="#64748B" style={{ marginRight: 4 }} />
          ) : null}
          <Text className="text-sm text-un1t-subtle flex-1" numberOfLines={1}>
            {row.last_message_preview || '—'}
          </Text>
        </View>
        {/* Which account it arrived at, and Archived / Needs reply. Own row
            rather than crowding the preview: on a phone the mailbox name is
            the difference between a billing query and a sales enquiry, so it
            must not be the thing that truncates. */}
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
            {chip ? (
              <View className={`px-1.5 py-0.5 rounded ${chip.cls}`}>
                <Text className={`text-[10px] font-semibold ${chip.text}`}>{chip.label}</Text>
              </View>
            ) : null}
          </View>
        )}
      </View>
      {/* Archive — THE verb of this surface, one tap from the list. hitSlop
          keeps the target finger-sized without growing the row. */}
      <Pressable
        onPress={onArchiveToggle}
        disabled={archiving}
        hitSlop={10}
        className="ml-2 w-9 h-9 rounded-full items-center justify-center active:opacity-60"
        accessibilityLabel={row.archived ? 'Bring back to inbox' : 'Archive'}
      >
        {archiving ? (
          <ActivityIndicator size="small" />
        ) : (
          <Ionicons
            name={row.archived ? 'arrow-undo-outline' : 'archive-outline'}
            size={18}
            color="#64748B"
          />
        )}
      </Pressable>
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
    const res = await listMail(activeLocation.id, { view: ticketViewWire(viewId) })
    if (!res.success) {
      setError(res.error || 'Failed to load email')
      return
    }
    setError(null)
    setRows(res.data || [])
    setMailboxes(res.mailboxes || [])
  }, [activeLocation, canEmail, viewId])

  // Archive / bring back, straight off the row. OPTIMISTIC: the row leaves
  // (or changes) immediately and comes back with an alert if the write
  // failed — a mail app that spins per archive is a mail app nobody triages
  // on. `archivingId` still disables the tapped button so a double-tap can't
  // fire twice.
  const [archivingId, setArchivingId] = useState(null)
  async function toggleArchive(row) {
    const next = !row.archived
    setArchivingId(row.id)
    const prevRows = rows
    // In the inbox/needs-reply views an archived row disappears; in the
    // Archived view an un-archived one does. Either direction: drop the row.
    setRows(rs => rs.filter(r => r.id !== row.id))
    const res = await archiveConversation(row.id, next, activeLocation?.id)
    setArchivingId(null)
    if (!res.success) {
      setRows(prevRows)
      setError(res.error || (next ? 'Could not archive that' : 'Could not bring that back'))
      return
    }
    // The write-back half (moving the real message in a connected mailbox)
    // can lag or refuse independently — the server says so in `writeback`,
    // and the DB half above already stands either way. Silent here: the
    // thread screen is where that notice belongs.
  }

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
          Mail isn’t enabled for you at this location.
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

      {/* View chips — the same views, in the same words, as the web Mail
          surface: Inbox / Needs reply / Archived. */}
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
          <MailRow
            key={r.id}
            row={r}
            archiving={archivingId === r.id}
            onArchiveToggle={() => toggleArchive(r)}
            onPress={() => router.push(`/email/${r.id}`)}
          />
        ))
      )}
    </ScrollView>
  )
}
