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
// ATTACHMENTS (EMAIL-ATTACH-PREVIEW.1)
// A message's files render as tappable chips. Tapping one asks the server for
// a short-lived signed URL: an allow-listed image opens in the in-app viewer,
// and EVERY other type — PDF, Office, HEIC, SVG, unknown — is handed to the OS
// as a DOWNLOAD, which is both the safe disposition and the better phone
// experience. Which types may be previewed is the server's decision
// (`preview_kind` on the row); this file never forms that judgement, so the
// allow-list cannot drift between the two platforms.
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
// Until EMAIL-PARTICIPANTS.9 the composer footer did not say any of this —
// it named only the requester, unconditionally, so a multi-party thread had
// the operator believing a reply-all was a reply to one person (2026-08-09
// audit). The footer now reads reply_recipients (ticketReplyAudienceMeta in
// lib/email-tickets.js) and REMOVAL STAYS WEB-ONLY: this screen only
// describes the audience the server settled on, same as the recipient lines
// above — it never offers a way to change it.
//
// THE OTHER TWO PLACES A NAME APPEARS (EMAIL-PARTICIPANTS.12) went the same
// way, because .9 fixed the footer and left them reading requester_email raw:
// the header line under the subject, and the composer's own placeholder. On
// the 2026-08-12 ticket that had the box an operator types into saying "Reply
// to ratesoffice@dublincity.ie" one line above a footer saying the mail goes
// to Eleanor and one other — the composer contradicting itself. All three now
// come from ONE derivation (ticketReplyAudience in lib/email-tickets.js), so
// this screen cannot say three things about who a reply reaches, and an
// emptied audience names nobody rather than resurrecting the person a web
// operator removed.

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform, Modal, Image, Linking,
} from 'react-native'
import { useLocalSearchParams, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '../../../lib/auth-context'
import {
  getTicket, replyToTicket, setTicketStatus, markTicketRead, assignTicket, emailDisplayName,
  previewTicketAttachment, downloadTicketAttachment,
} from '../../../lib/email-api'
import {
  ticketMessageKind, ticketStatusMeta, mailboxLabel, ticketDeliveryMeta,
  ticketMessageRecipients, sentToLabel, isArchivedStatus, TICKET_STATUS_ORDER,
  formatAttachmentSize, ticketAttachmentSkippedLabel, ticketAttachmentIcon,
  threadRefreshMs, ticketReplyAudienceMeta, ticketReplyPlaceholder,
  ticketThreadAudienceLines, ticketSendOriginMeta,
} from '../../../lib/email-tickets'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

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
 *
 * `toShownInHeader` is DELIBERATELY NOT DERIVED FROM `onAccent`, even though
 * today only the accent bubble sets both. Reusing "is this the blue bubble?"
 * to mean "does the header name the recipients?" is how the single-To rule got
 * this wrong in the first place — it was written for the outbound bubble's
 * "Sent to …" line and then applied to the inbound one, whose header is
 * "From …" and names nobody on our side. Two questions, two props.
 */
function RecipientLines({ msg, onAccent = false, toShownInHeader = false }) {
  const lines = ticketMessageRecipients(msg, { toShownInHeader })
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

/**
 * A message's files, as chips (EMAIL-ATTACH-PREVIEW.1).
 *
 * MOBILE USED TO SHOW NOTHING HERE — a member's photo email rendered as an
 * empty bubble, which is the same "the operator saw nothing" bug the web thread
 * had, one platform over.
 *
 * Tapping a chip asks the server for a preview URL. `preview_kind: 'image'`
 * opens the viewer below; ANYTHING ELSE — a PDF, a Word document, a HEIC photo,
 * an SVG — is handed to the OS via Linking with a DOWNLOAD url, which on a
 * phone is the better answer anyway: iOS and Android both have real viewers for
 * those, and an in-app frame for a stranger's document would need a WebView
 * this app deliberately does not carry.
 *
 * A not-stored attachment shows its reason and is not tappable. There are no
 * bytes, and a spinner that ended in an error would bury the one sentence staff
 * act on.
 */
function Attachments({ ticketId, locationId, attachments, onAccent = false, onViewImage }) {
  const [busy, setBusy] = useState(null)
  if (!attachments || attachments.length === 0) return null

  async function open(att) {
    if (busy) return
    setBusy(att.id)
    try {
      if (att.preview_kind === 'image') {
        const res = await previewTicketAttachment(ticketId, att.id, locationId)
        if (res.success) {
          onViewImage({ url: res.url, filename: att.filename })
          return
        }
        // Fall through to the download path rather than dead-ending: the file
        // is still reachable, which is the guarantee that holds for every type.
      }
      const dl = await downloadTicketAttachment(ticketId, att.id, locationId)
      if (!dl.success) {
        Alert.alert('Couldn’t open file', dl.error)
        return
      }
      const opened = await Linking.canOpenURL(dl.url).catch(() => false)
      if (!opened) {
        Alert.alert('Couldn’t open file', 'This device could not open that link.')
        return
      }
      await Linking.openURL(dl.url)
    } catch {
      Alert.alert('Couldn’t open file', 'Something went wrong opening that file.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <View className="mt-2">
      {attachments.map(att => (
        att.stored ? (
          <Pressable
            key={att.id}
            onPress={() => open(att)}
            disabled={busy === att.id}
            className={`flex-row items-center rounded-lg border px-2 py-1.5 mt-1 ${
              onAccent ? 'border-white/30 bg-white/10' : 'border-un1t-border bg-un1t-bg'
            } ${busy === att.id ? 'opacity-60' : ''}`}
          >
            <Ionicons
              name={ticketAttachmentIcon(att.mime_type, att.filename)}
              size={14}
              color={onAccent ? 'rgba(255,255,255,0.9)' : '#64748B'}
              style={{ marginRight: 6 }}
            />
            <Text
              className={`text-xs flex-1 ${onAccent ? 'text-white' : 'text-un1t-text'}`}
              numberOfLines={1}
            >
              {att.filename}
            </Text>
            <Text className={`text-[11px] ml-2 ${onAccent ? 'text-white/70' : 'text-un1t-subtle'}`}>
              {formatAttachmentSize(att.size_bytes)}
            </Text>
          </Pressable>
        ) : (
          <View
            key={att.id}
            className={`flex-row items-center rounded-lg border border-dashed px-2 py-1.5 mt-1 ${
              onAccent ? 'border-white/30' : 'border-amber-500/60'
            }`}
          >
            <Ionicons
              name="alert-circle-outline"
              size={14}
              color={onAccent ? 'rgba(255,255,255,0.8)' : '#B45309'}
              style={{ marginRight: 6 }}
            />
            <View className="flex-1">
              <Text
                className={`text-xs ${onAccent ? 'text-white/80' : 'text-un1t-text'}`}
                numberOfLines={1}
              >
                {att.filename}
              </Text>
              {/* Kept in words, on the chip. Staff ACT on this text — it is the
                  difference between "ask them to resend" and "we lost it". */}
              <Text className={`text-[11px] ${onAccent ? 'text-white/70' : 'text-amber-700'}`}>
                {ticketAttachmentSkippedLabel(att.skipped_reason)} · {formatAttachmentSize(att.size_bytes)}
              </Text>
            </View>
          </View>
        )
      ))}
    </View>
  )
}

/**
 * The image viewer. An <Image> is a decode-only container — it renders pixels
 * and runs nothing — and the only URLs that reach it are the ones the server
 * allow-listed as images, so no scriptable file can arrive here.
 */
function ImageViewer({ image, onClose }) {
  return (
    <Modal visible={!!image} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 bg-black/90">
        <Pressable
          onPress={onClose}
          accessibilityLabel="Close image"
          className="flex-row items-center px-4 pt-14 pb-2"
        >
          <Ionicons name="close" size={22} color="#FFFFFF" />
          <Text className="text-white text-sm ml-2 flex-1" numberOfLines={1}>
            {image?.filename}
          </Text>
        </Pressable>
        <Pressable className="flex-1" onPress={onClose}>
          {image?.url ? (
            <Image
              source={{ uri: image.url }}
              resizeMode="contain"
              className="flex-1 w-full"
              accessibilityLabel={image.filename}
            />
          ) : null}
        </Pressable>
      </View>
    </Modal>
  )
}

function MessageBubble({ msg, ticketId, locationId, onViewImage }) {
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
    // MAILBOX-COEXIST.1 — null for everything composed in the CRM, which is
    // every outbound row this thread had before Phase 8 polled a Sent folder.
    const origin = ticketSendOriginMeta(msg)
    return (
      <View className="mb-1.5">
        <View className="flex-row justify-end">
          <View className="max-w-[85%] px-3.5 py-2 rounded-2xl bg-blue-500">
            <View className="flex-row items-center mb-1">
              <Ionicons name="mail-open-outline" size={11} color="rgba(255,255,255,0.75)" style={{ marginRight: 4 }} />
              <Text className="text-[11px] text-white/75 flex-1" numberOfLines={1}>
                Sent to {sentToLabel(msg)}
              </Text>
            </View>
            {/* WHERE IT WAS SENT FROM, when that was not the CRM. Its own row,
                not a clause on the footer below, because it changes how the
                whole bubble reads: nobody here typed it, so there is no author
                to ask and no delivery to chase. The footer's author slot is
                empty for these rows, and without this line that gap reads as
                missing data rather than as a fact. */}
            {origin ? (
              <View className="flex-row items-center mb-1">
                <Ionicons name={origin.icon} size={11} color="rgba(255,255,255,0.75)" style={{ marginRight: 4 }} />
                <Text className="text-[11px] text-white/75 flex-1" numberOfLines={1}>
                  {origin.label}
                </Text>
              </View>
            ) : null}
            {/* toShownInHeader: the "Sent to" header above names the recipient
                in full when there is one, and the first of several otherwise —
                so a lone To here would just repeat it. */}
            <RecipientLines msg={msg} onAccent toShownInHeader />
            <Text className="text-base text-white">{body}</Text>
            <Attachments
              ticketId={ticketId}
              locationId={locationId}
              attachments={msg.attachments}
              onViewImage={onViewImage}
              onAccent
            />
            <Text className="text-[10px] text-white/60 mt-1 text-right">
              {msg.author_name ? `${msg.author_name} · ` : ''}{stamp}
              {/* The QUIET half: a short phrase in the line that is already
                  there. Confirming the normal case must not compete with the
                  panel below, which is the entire point of the feature.
                  🔴 IT PRINTS delivery.label AND USED TO PRINT "Delivered".
                  That was true while `delivered` was the only quiet outcome;
                  "Not tracked" is a second one, and printing "Delivered" for
                  it made the rows that can NEVER be confirmed the ones
                  asserting confirmation hardest. The lib was careful and this
                  line threw the care away. Read the label. */}
              {delivery?.tone === 'quiet' ? ` · ${delivery.label}` : ''}
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
        {/* THE MEMBER'S OWN To and Cc. Captured inbound since EMAIL-CC.1 —
            without the Cc a staffer cannot tell that two colleagues are on the
            thread, and a reply from this screen reaches them without anyone
            knowing why. No toShownInHeader here on purpose: the header above
            is "From …", so it names the sender and nobody we were written to,
            and the To has to carry itself however short it is. */}
        <RecipientLines msg={msg} />
        <Text className="text-base text-un1t-text">{body}</Text>
        <Attachments
          ticketId={ticketId}
          locationId={locationId}
          attachments={msg.attachments}
          onViewImage={onViewImage}
        />
        <Text className="text-[10px] text-un1t-subtle mt-1 text-right">{stamp}</Text>
      </View>
    </View>
  )
}

export default function EmailTicket() {
  const { ticketId } = useLocalSearchParams()
  const { activeLocation, profile } = useAuth()
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
  const [savingAssign, setSavingAssign] = useState(false)
  // The route sets this when the ATTACHMENT lookup failed (2026-08-08 audit):
  // the messages below are real, but their files are unknown — which must be
  // said, or a blipped lookup reads as "the member sent no files". Web renders
  // the same warning (AttachmentsUnavailableNotice).
  const [attachmentsUnavailable, setAttachmentsUnavailable] = useState(false)
  // EMAIL-PARTICIPANTS.9 — { to, mode, over_cap, empty } | null, straight off
  // getTicket(). Kept alongside `ticket` rather than folded into it: it comes
  // back from the SAME response but is answered as its own top-level field
  // (see getTicket's doc), and the assign-route merge below only ever spreads
  // `ticket` fields back in, which must not clobber this.
  const [replyRecipients, setReplyRecipients] = useState(null)
  // EMAIL-ATTACH-PREVIEW.1 — the one image being looked at, if any. Held here
  // rather than in a bubble so the viewer covers the screen, and so switching
  // tickets cannot leave a stale one open. The signed URL lives only as long as
  // this state does.
  const [viewingImage, setViewingImage] = useState(null)
  const scrollRef = useRef(null)
  const readMarked = useRef(false)

  // `quiet` is a background re-read of a thread already on screen (the poll
  // below), as opposed to opening one. It never paints an error: a blip on a
  // background read must not replace correspondence the operator is reading
  // with a failure message. What is on screen is still true, just seconds old.
  const refresh = useCallback(async ({ quiet = false } = {}) => {
    const res = await getTicket(ticketId, activeLocation?.id)
    if (!res.success) {
      if (!quiet) setError(res.error || 'Failed to load ticket')
      return
    }
    setError(null)
    setTicket(res.ticket)
    setMessages(res.messages || [])
    setAttachmentsUnavailable(!!res.attachmentsUnavailable)
    setReplyRecipients(res.reply_recipients || null)

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

  // EMAIL-ATTACH-RACE.1 — the thread re-reads itself while it is open.
  //
  // It used to load once on mount and never again, so anything written after
  // that first read stayed invisible for the life of the screen. The inbound
  // webhook writes email_ticket_attachments AFTER the message row they hang
  // off, so a ticket opened inside that window showed a member's photo as no
  // attachment at all, and a file that could not be stored showed neither the
  // file nor the reason.
  //
  // Cadence comes from the thread itself (threadRefreshMs): fast while its
  // newest message is young enough that rows may still be arriving, 60s
  // otherwise. It is a primitive, so a poll that changes nothing does not
  // restart the interval — and the interval is torn down with the screen, so
  // a backgrounded thread costs nothing.
  const threadPollMs = threadRefreshMs(messages)
  useEffect(() => {
    if (!ticketId) return undefined
    const timer = setInterval(() => { refresh({ quiet: true }) }, threadPollMs)
    return () => clearInterval(timer)
  }, [ticketId, threadPollMs, refresh])

  useEffect(() => {
    if (messages.length && scrollRef.current) {
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 50)
    }
  }, [messages.length])

  const canReply = !!ticket?.requester_email
  // EMAIL-PARTICIPANTS.9 — the footer's real audience, and whether Send must
  // be blocked. `audience.disabled` already covers "no requester address"
  // (ticketReplyAudienceMeta checks that first), so it alone gates Send;
  // `canReply` above stays scoped to the text input, which keeps taking a
  // draft even on a thread nobody can currently be sent to — the route 400s,
  // not the keyboard.
  const audience = ticketReplyAudienceMeta(ticket, replyRecipients)
  const sendBlocked = !isNote && audience.disabled
  // EMAIL-PARTICIPANTS.12 — the OTHER two strings that named the requester
  // raw: the header line under the subject, and the composer's placeholder.
  // Both derive from the same audience the footer does (one derivation, in
  // lib/email-tickets.js), so this screen cannot say three different things
  // about who a reply reaches. STILL READ-ONLY — describing the set, never
  // editing it.
  const threadLines = ticketThreadAudienceLines(ticket, replyRecipients)
  const replyPlaceholder = ticketReplyPlaceholder(ticket, replyRecipients)

  async function send() {
    const body = text.trim()
    if (!body || sending) return
    if (sendBlocked) return
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
  // EMAIL-ASSIGN.1 — claim or release from the phone. Reassign-to-anyone
  // stays a desk task (the picker enumerates colleagues' access); claim is
  // the on-the-floor action this screen exists for.
  async function changeAssignee(next) {
    if (savingAssign) return
    setSavingAssign(true)
    const res = await assignTicket(ticketId, next, { locationId: activeLocation?.id })
    setSavingAssign(false)
    if (!res.success) {
      Alert.alert('Couldn’t update owner',
        res.error === 'already_assigned'
          ? 'Somebody claimed this ticket just now.'
          : res.error || 'Unknown error')
      // Their claim beat ours — show the truth.
      refresh({ quiet: true })
      return
    }
    // The route's row lacks the mailbox/contact enrichment — merge, never
    // replace (the EMAIL-MOPUP.4 lesson).
    if (res.ticket) {
      setTicket(prev => (prev ? { ...prev, ...res.ticket, assignee_name: res.assigneeName } : prev))
    }
  }

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
              this carries WHO THE TICKET IS WITH, the subject, which account
              it came in to, and the lifecycle control.

              EMAIL-PARTICIPANTS.12 — that first line was requester_email
              raw, i.e. the address the FIRST message arrived from. Once a
              shared mailbox hands a thread to a named person it is the wrong
              name in the most prominent place on the screen, which is the
              2026-08-12 incident exactly. It is the LIVE audience now,
              straight off the server's own derivation, with the requester
              demoted to an "Opened by" line that appears only when the two
              have actually diverged. */}
          <View className="border-b border-un1t-border bg-un1t-surface px-4 py-2">
            <View className="flex-row items-center">
              <Text className="text-xs text-un1t-subtle flex-1" numberOfLines={1}>
                {threadLines.primary}
              </Text>
              <View className={`ml-2 px-1.5 py-0.5 rounded ${status.cls}`}>
                <Text className={`text-[10px] font-semibold ${status.text}`}>{status.label}</Text>
              </View>
            </View>
            {threadLines.opener ? (
              <Text className="text-[11px] text-un1t-muted mt-0.5" numberOfLines={1}>
                {threadLines.opener}
              </Text>
            ) : null}
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

            {/* Ownership (EMAIL-ASSIGN.1): who's on it, and one-tap claim /
                release. Names resolve server-side; 'you' beats the name. */}
            <View className="flex-row items-center mt-0.5">
              <Text className="text-[11px] text-un1t-subtle flex-1" numberOfLines={1}>
                {!ticket?.assigned_to
                  ? 'Unassigned'
                  : ticket.assigned_to === profile?.id
                    ? 'Assigned to you'
                    : ticket.assignee_name
                      ? `Assigned to ${ticket.assignee_name}`
                      : 'Assigned'}
              </Text>
              {!ticket?.assigned_to && (
                <Pressable
                  onPress={() => changeAssignee('me')}
                  disabled={savingAssign}
                  className={`ml-2 rounded border border-un1t-border px-2 py-0.5 ${savingAssign ? 'opacity-50' : ''}`}
                >
                  <Text className="text-[11px] text-un1t-text">Claim</Text>
                </Pressable>
              )}
              {ticket?.assigned_to === profile?.id && (
                <Pressable
                  onPress={() => changeAssignee(null)}
                  disabled={savingAssign}
                  className={`ml-2 rounded border border-un1t-border px-2 py-0.5 ${savingAssign ? 'opacity-50' : ''}`}
                >
                  <Text className="text-[11px] text-un1t-subtle">Release</Text>
                </Pressable>
              )}
            </View>

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
            {attachmentsUnavailable && (
              <View className="mb-3 rounded-xl border border-amber-500/60 bg-amber-500/10 px-3.5 py-2.5">
                <Text className="text-[11px] text-amber-700">
                  Attachments could not be loaded for this ticket. Messages sent with files may
                  look as though they had none.
                </Text>
              </View>
            )}
            {messages.length === 0 ? (
              <Text className="text-xs text-un1t-subtle text-center py-6">
                No messages on this ticket yet.
              </Text>
            ) : (
              messages.map(m => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  ticketId={ticketId}
                  locationId={activeLocation?.id}
                  onViewImage={setViewingImage}
                />
              ))
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
                // EMAIL-PARTICIPANTS.12 — the real audience, not the
                // requester. It said "Reply to <requester>" while the footer
                // one line below named somebody else entirely; see
                // ticketReplyPlaceholder, which also carries the no-requester
                // wording this used to spell out inline.
                placeholder={isNote ? 'Staff-only note. Nothing is sent.' : replyPlaceholder}
                placeholderTextColor="#94A3B8"
                maxLength={10000}
                className={`flex-1 border rounded-2xl px-4 py-2.5 text-base text-un1t-text max-h-32 ${
                  isNote ? 'bg-un1t-bg border-amber-500/50' : 'bg-un1t-surface border-un1t-border'
                }`}
                textAlignVertical="top"
              />
              <Pressable
                onPress={send}
                disabled={!text.trim() || sending || sendBlocked}
                className={`w-10 h-10 rounded-full ml-2 items-center justify-center ${
                  text.trim() && !sending && !sendBlocked
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
                send must be told, in the same glance, who receives this.
                EMAIL-PARTICIPANTS.9 — audience.text is the real, WHOLE-thread
                audience (one name, or the first plus a count), not the
                requester alone; see ticketReplyAudienceMeta. */}
            <Text className={`text-[11px] mt-1.5 ${isNote ? 'text-amber-700' : 'text-un1t-subtle'}`}>
              {isNote
                ? `Staff only — written to the ticket and NOT sent to ${ticket?.requester_email || 'the member'}.`
                : audience.text}
            </Text>
            {!isNote && isArchivedStatus(ticket?.status) && (
              <Text className="text-[11px] text-un1t-subtle mt-1">
                This ticket is {status.label.toLowerCase()} — sending a reply moves it back to pending.
              </Text>
            )}
          </View>
        </>
      )}
      <ImageViewer image={viewingImage} onClose={() => setViewingImage(null)} />
    </KeyboardAvoidingView>
  )
}
