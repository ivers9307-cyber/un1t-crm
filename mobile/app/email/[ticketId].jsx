// Email ticket thread — message list, lifecycle control, and a composer
// that can either reply to the member or leave a staff-only note
// (EMAIL-TICKET-M.1; replaces the INBOX-EMAIL-M.1 conversation screen).
// Pushed from the Email tab (app/(tabs)/email.jsx) since INBOX-SPLIT.M1.
//
// THE ONE THING THIS FILE MUST NEVER GET WRONG
// An internal note is stored with direction='outbound' — same as a real sent
// reply. ticketMessageKind() (lib/email-tickets.js) tests is_internal_note
// FIRST and this file only paints what it decides. A note renders as a
// full-width amber dashed panel headed "Internal note — not sent to the
// member"; a reply renders as an accent bubble headed "Sent to <address>".
// Nobody must ever be able to think a note went to the member, or that a
// reply stayed private. The composer states its mode three times over for
// the same reason: the selected pill, the colour of the box, and the
// sentence naming exactly who receives what.
//
// PLAIN TEXT ONLY. Messages render `text_body`. `html_body` never leaves the
// server, and the sanitised `html_document` the web thread renders is
// deliberately ignored here: that path depends on a sandboxed iframe, which
// React Native has no equivalent of. Raw email HTML is hostile input from an
// unauthenticated stranger — on mobile it simply is not rendered.
//
// Reads no longer clear the badge as a side effect (the GET is a GET), so the
// screen posts …/read itself once the thread loads.
// Replies ride Postmark's transactional stream with threading headers and the
// sender's signature — all server-side in the reply route.
//
// RECIPIENTS (EMAIL-CC.1) ARE SHOWN HERE BUT NOT EDITED. To/Cc/Bcc render
// under each message; Bcc is marked staff-only in words as well as an icon.
// The composer sends `{ text, internal }` and nothing else, which is not a
// gap: the reply route derives everybody on the thread server-side and always
// includes them, so a mobile reply on a multi-party thread IS a reply-all,
// identically to web. What mobile does not get is the ADD side — a chip input
// with a Cc/Bcc toggle is a confidentiality control that wants real device QA,
// and this is the quick-answer surface. Scoped out deliberately, not missed.

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useLocalSearchParams, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '../../lib/auth-context'
import {
  getTicket, replyToTicket, setTicketStatus, markTicketRead, emailDisplayName,
} from '../../lib/email-api'
import {
  ticketMessageKind, ticketStatusMeta, mailboxLabel, ticketDeliveryMeta,
  ticketMessageRecipients, isArchivedStatus, TICKET_STATUS_ORDER,
} from '../../lib/email-tickets'
import BackHeaderLeft from '../../components/BackHeaderLeft'

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
  return d.toLocaleString(undefined, {
    hour: 'numeric', minute: '2-digit',
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
  })
}

/**
 * The To / Cc / Bcc lines under a message (EMAIL-CC.1).
 *
 * BCC CARRIES A LOCK AND A SENTENCE, not just a label. The whole risk of
 * showing it is somebody reading the line as though the other recipients could
 * see it too; they could not, and never will. `onAccent` because the muted
 * ramp is unreadable on the blue outbound bubble.
 */
function RecipientLines({ msg, onAccent = false }) {
  const lines = ticketMessageRecipients(msg)
  if (lines.length === 0) return null
  const label = onAccent ? 'text-white/60' : 'text-un1t-subtle'
  const body = onAccent ? 'text-white/85' : 'text-un1t-text'
  return (
    <View className="mb-1">
      {lines.map(line => (
        <View key={line.key} className="flex-row items-start">
          {line.staffOnly ? (
            <Ionicons
              name="lock-closed"
              size={9}
              color={onAccent ? 'rgba(255,255,255,0.6)' : '#64748B'}
              style={{ marginRight: 3, marginTop: 3 }}
            />
          ) : null}
          <Text className={`text-[11px] ${label}`}>{line.label} </Text>
          <Text className={`text-[11px] flex-1 ${body}`}>
            {line.addresses.join(', ')}
            {line.staffOnly ? ' — staff only; no recipient of the email can see this' : ''}
          </Text>
        </View>
      ))}
    </View>
  )
}

function MessageBubble({ msg }) {
  const kind = ticketMessageKind(msg)
  const stamp = formatTime(msg.sent_at || msg.created_at)
  const body = msg.text_body || '(no text content)'

  // ── Internal note: staff only, nothing was sent ───────────────────
  // Full width and a different shape from every other bubble on the
  // screen, so it cannot be skim-read as correspondence.
  if (kind === 'note') {
    return (
      <View className="mb-2 rounded-xl border border-dashed border-amber-500/60 bg-amber-500/10 px-3.5 py-3">
        <View className="flex-row items-center mb-1.5">
          <Ionicons name="lock-closed" size={12} color="#B45309" style={{ marginRight: 5 }} />
          <Text className="text-[11px] font-bold uppercase text-amber-700">
            Internal note — not sent to the member
          </Text>
        </View>
        <Text className="text-sm text-un1t-text">{body}</Text>
        <Text className="text-[11px] text-un1t-subtle mt-1.5">
          {/* Who left it. On a shared queue an anonymous note is a note you
              cannot ask anyone about. author_name is NULL for anything
              written before mig 493, so the address is still the fallback. */}
          {msg.author_name ? `Note by ${msg.author_name}` : (msg.from_email || 'Staff')}
          {stamp ? ` · ${stamp}` : ''}
        </Text>
      </View>
    )
  }

  // ── A reply that actually went to the member ──────────────────────
  if (kind === 'outbound') {
    // EMAIL-DELIVERY.1 — null for "sent, no event yet", which is most messages
    // and every message written before mig 498. Nothing is rendered for it, so
    // the bubble makes no claim it cannot back up.
    const delivery = ticketDeliveryMeta(msg)
    return (
      <View className="mb-1.5">
        <View className="flex-row justify-end">
          <View className="max-w-[85%] px-3.5 py-2 rounded-2xl bg-blue-500">
            <View className="flex-row items-center mb-1">
              <Ionicons name="mail-open-outline" size={11} color="rgba(255,255,255,0.75)" style={{ marginRight: 4 }} />
              <Text className="text-[11px] text-white/75 flex-1" numberOfLines={1}>
                Sent to {msg.to_email || 'the member'}
              </Text>
            </View>
            <RecipientLines msg={msg} onAccent />
            <Text className="text-base text-white">{body}</Text>
            <Text className="text-[10px] text-white/60 mt-1 text-right">
              {msg.author_name ? `${msg.author_name} · ` : ''}{stamp}
              {/* The QUIET half: one word, in the line that is already there.
                  Confirming the normal case must not compete with the panel
                  below, which is the entire point of the feature. */}
              {delivery?.tone === 'quiet' ? ' · Delivered' : ''}
            </Text>
          </View>
        </View>
        {/* The LOUD half. Full width and outside the bubble, because the
            bubble's whole visual language says "we answered them" — and that
            belief is exactly what is wrong when a reply bounced. */}
        {delivery && delivery.tone !== 'quiet' && (
          <View className={`mt-1.5 rounded-xl border px-3.5 py-3 ${delivery.cls}`}>
            <View className="flex-row items-center mb-1">
              <Ionicons name={delivery.icon} size={12} color={delivery.iconColor} style={{ marginRight: 5 }} />
              <Text className={`text-[11px] font-bold uppercase flex-1 ${delivery.text}`}>
                {delivery.headline}
              </Text>
            </View>
            <Text className={`text-xs ${delivery.text}`}>{delivery.advice}</Text>
            {/* The provider's exact words — this is where "mailbox full" and
                "no such address" actually differ. */}
            {delivery.detail ? (
              <Text className={`text-[11px] mt-1.5 ${delivery.text}`}>{delivery.detail}</Text>
            ) : null}
            {delivery.status && formatTime(msg.delivery_status_at) ? (
              <Text className={`text-[11px] mt-1.5 ${delivery.text}`}>
                Reported {formatTime(msg.delivery_status_at)}
              </Text>
            ) : null}
          </View>
        )}
      </View>
    )
  }

  // ── The member wrote in ───────────────────────────────────────────
  return (
    <View className="flex-row mb-1.5 justify-start">
      <View className="max-w-[85%] px-3.5 py-2 rounded-2xl bg-un1t-surface border border-un1t-border">
        <Text className="text-[11px] text-un1t-subtle mb-1" numberOfLines={1}>
          From {msg.from_email || 'the member'}
        </Text>
        {/* THE MEMBER'S OWN Cc. Captured inbound since EMAIL-CC.1 — without
            it a staffer cannot tell that two colleagues are on the thread,
            and a reply from this screen reaches them without anyone knowing
            why. */}
        <RecipientLines msg={msg} />
        <Text className="text-base text-un1t-text">{body}</Text>
        <Text className="text-[10px] text-un1t-subtle mt-1 text-right">{stamp}</Text>
      </View>
    </View>
  )
}

export default function EmailTicket() {
  const { ticketId } = useLocalSearchParams()
  const { activeLocation } = useAuth()
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const [ticket, setTicket] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [text, setText] = useState('')
  const [isNote, setIsNote] = useState(false)
  const [sending, setSending] = useState(false)
  const [savingStatus, setSavingStatus] = useState(false)
  const scrollRef = useRef(null)
  const readMarked = useRef(false)

  const refresh = useCallback(async () => {
    const res = await getTicket(ticketId, activeLocation?.id)
    if (!res.success) {
      setError(res.error || 'Failed to load ticket')
      return
    }
    setError(null)
    setTicket(res.ticket)
    setMessages(res.messages || [])

    // Clearing the badge is its own call now. Fire-and-forget and once
    // per screen: it is idempotent, and a failure here must never look
    // like the thread failed to open.
    if (!readMarked.current) {
      readMarked.current = true
      markTicketRead(ticketId, activeLocation?.id).catch(() => {})
    }
  }, [ticketId, activeLocation])

  useEffect(() => {
    setLoading(true)
    refresh().finally(() => setLoading(false))
  }, [refresh])

  useEffect(() => {
    if (messages.length && scrollRef.current) {
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 50)
    }
  }, [messages.length])

  const canReply = !!ticket?.requester_email

  async function send() {
    const body = text.trim()
    if (!body || sending) return
    if (!isNote && !canReply) return
    setSending(true)
    const res = await replyToTicket(ticketId, body, {
      internal: isNote,
      locationId: activeLocation?.id,
    })
    setSending(false)
    if (!res.success) {
      Alert.alert(isNote ? 'Couldn’t add note' : 'Couldn’t send', res.error || 'Unknown error')
      return
    }
    setText('')
    refresh()
  }

  // Nothing in this system closes itself (Richard, 2026-08-06) — every
  // ticket is answered or closed by a person, so closing has to be
  // reachable from the thread rather than desktop-only.
  async function changeStatus(next) {
    if (savingStatus || next === ticket?.status) return
    setSavingStatus(true)
    const res = await setTicketStatus(ticketId, next, activeLocation?.id)
    setSavingStatus(false)
    if (!res.success) {
      Alert.alert('Couldn’t update status', res.error || 'Unknown error')
      return
    }
    setTicket(res.data?.ticket || ticket)
  }

  // 'Email' rather than the display helper's "Unknown sender" fallback while
  // the thread is still loading — a header that briefly accuses us of not
  // knowing who wrote in reads as a bug.
  const name = ticket ? emailDisplayName(ticket) : 'Email'
  const status = ticketStatusMeta(ticket?.status)

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      className="flex-1 bg-un1t-bg"
    >
      <Stack.Screen
        options={{
          title: name,
          // INBOX-SPLIT.M1 — back goes to the Email tab, not Messages: email
          // is its own surface now (and a cold-start deep link from a push
          // must not land someone in the chat inbox).
          headerLeft: () => <BackHeaderLeft label="Email" fallbackHref="/(tabs)/email" />,
        }}
      />

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center px-8">
          <Ionicons name="alert-circle-outline" size={32} color="#DC2626" />
          <Text className="text-sm text-red-600 mt-2 text-center">{error}</Text>
        </View>
      ) : (
        <>
          {/* Header strip — the native header holds the requester's name;
              this carries the address, the subject, which account it came
              in to, and the lifecycle control. */}
          <View className="border-b border-un1t-border bg-un1t-surface px-4 py-2">
            <View className="flex-row items-center">
              <Text className="text-xs text-un1t-subtle flex-1" numberOfLines={1}>
                {ticket?.requester_email || 'No requester address'}
              </Text>
              <View className={`ml-2 px-1.5 py-0.5 rounded ${status.cls}`}>
                <Text className={`text-[10px] font-semibold ${status.text}`}>{status.label}</Text>
              </View>
            </View>
            {ticket?.subject ? (
              <Text className="text-sm font-medium text-un1t-text mt-0.5" numberOfLines={2}>
                {ticket.subject}
              </Text>
            ) : null}
            <Text className="text-[11px] text-un1t-subtle mt-0.5" numberOfLines={1}>
              {/* mailbox_id is ON DELETE SET NULL, so a deleted address
                  orphans its correspondence rather than hiding it. */}
              {ticket?.mailbox ? `To ${mailboxLabel(ticket.mailbox)}` : 'No mailbox on this ticket'}
            </Text>

            <View className="flex-row items-center mt-2">
              {TICKET_STATUS_ORDER.map(s => {
                const m = ticketStatusMeta(s)
                const active = ticket?.status === s
                return (
                  <Pressable
                    key={s}
                    onPress={() => changeStatus(s)}
                    disabled={savingStatus || active}
                    className={`px-2.5 py-1 rounded-lg mr-1.5 border ${
                      active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-bg border-un1t-border'
                    } ${savingStatus && !active ? 'opacity-50' : ''}`}
                  >
                    <Text className={`text-xs ${active ? 'text-white font-semibold' : 'text-un1t-subtle'}`}>
                      {m.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </View>

          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentContainerClassName="p-4"
            onContentSizeChange={() => scrollRef.current?.scrollToEnd?.({ animated: false })}
          >
            {messages.length === 0 ? (
              <Text className="text-xs text-un1t-subtle text-center py-6">
                No messages on this ticket yet.
              </Text>
            ) : (
              messages.map(m => <MessageBubble key={m.id} msg={m} />)
            )}
          </ScrollView>

          {/* Composer. The whole box turns amber in note mode — the mode is
              never something you have to remember, it is something you can
              see. */}
          <View
            className={`border-t px-3 pt-2 ${
              isNote ? 'border-amber-500/40 bg-amber-500/10' : 'border-un1t-border bg-un1t-bg'
            }`}
            style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          >
            <View className="flex-row items-center mb-2">
              <Pressable
                onPress={() => setIsNote(false)}
                className={`flex-row items-center px-2.5 py-1 rounded-full mr-1.5 border ${
                  !isNote ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-surface border-un1t-border'
                }`}
              >
                <Ionicons name="send" size={11} color={!isNote ? '#FFFFFF' : '#64748B'} style={{ marginRight: 4 }} />
                <Text className={`text-xs ${!isNote ? 'text-white font-semibold' : 'text-un1t-subtle'}`}>
                  Reply to member
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setIsNote(true)}
                className={`flex-row items-center px-2.5 py-1 rounded-full border ${
                  isNote ? 'bg-amber-500/10 border-amber-600' : 'bg-un1t-surface border-un1t-border'
                }`}
              >
                <Ionicons name="lock-closed" size={11} color={isNote ? '#B45309' : '#64748B'} style={{ marginRight: 4 }} />
                <Text className={`text-xs ${isNote ? 'text-amber-700 font-bold' : 'text-un1t-subtle'}`}>
                  Internal note
                </Text>
              </Pressable>
            </View>

            <View className="flex-row items-end">
              <TextInput
                value={text}
                onChangeText={setText}
                multiline
                editable={isNote || canReply}
                placeholder={
                  isNote
                    ? 'Staff-only note. Nothing is sent.'
                    : canReply
                      ? `Reply to ${ticket?.requester_email}…`
                      : 'No requester address — add an internal note instead'
                }
                placeholderTextColor="#94A3B8"
                maxLength={10000}
                className={`flex-1 border rounded-2xl px-4 py-2.5 text-base text-un1t-text max-h-32 ${
                  isNote ? 'bg-un1t-bg border-amber-500/50' : 'bg-un1t-surface border-un1t-border'
                }`}
                textAlignVertical="top"
              />
              <Pressable
                onPress={send}
                disabled={!text.trim() || sending || (!isNote && !canReply)}
                className={`w-10 h-10 rounded-full ml-2 items-center justify-center ${
                  text.trim() && !sending && (isNote || canReply)
                    ? (isNote ? 'bg-amber-600' : 'bg-blue-500')
                    : 'bg-un1t-border'
                }`}
              >
                {sending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Ionicons name={isNote ? 'lock-closed' : 'arrow-up'} size={18} color="#FFFFFF" />
                )}
              </Pressable>
            </View>

            {/* Said in words as well as in colour: whoever is about to press
                send must be told, in the same glance, who receives this. */}
            <Text className={`text-[11px] mt-1.5 ${isNote ? 'text-amber-700' : 'text-un1t-subtle'}`}>
              {isNote
                ? `Staff only — written to the ticket and NOT sent to ${ticket?.requester_email || 'the member'}.`
                : canReply
                  ? `Sends an email to ${ticket.requester_email}${
                      ticket?.mailbox?.address ? ` · replies come back to ${ticket.mailbox.address}` : ''
                    }`
                  : 'This ticket has no requester address, so it cannot be replied to. You can still add an internal note.'}
            </Text>
            {!isNote && isArchivedStatus(ticket?.status) && (
              <Text className="text-[11px] text-un1t-subtle mt-1">
                This ticket is {status.label.toLowerCase()} — sending a reply moves it back to pending.
              </Text>
            )}
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  )
}
