// Email thread + reply — MOBILE-MAIL-THREAD.1, the approved mockup's §04
// (was EMAIL-TICKET-M.1's queue-era screen; same file, new shape).
//
// WHAT CHANGED IN THE REDESIGN, and what deliberately did not:
//   • The verbs ride the native header now (mark-unread, archive, an
//     overflow reserved for forward later) — the in-strip button row is gone.
//   • The header strip leads with the SUBJECT, then the status + account
//     chips, then the server's own audience derivation ("On this thread: …").
//   • Older messages COLLAPSE to one-line rows: everything but the newest two
//     folds until tapped (threadDisplayPlan in lib/mail-drafts.js — a
//     six-message thread opens at the newest word, not a scroll marathon).
//   • The composer is a card: a full-width Reply / Internal-note segmented
//     toggle above it, the audience sentence and a "Draft saved" caption
//     inside it, a paperclip + photo picker for OUTBOUND attachments, and an
//     ink-square send. Note mode re-skins the whole card amber.
//   • Drafts persist per user + account + ticket over AsyncStorage
//     (lib/mail-drafts.js — the web store's semantics: fail closed with no
//     user id, 14-day TTL, 30-entry eviction, live-typing-wins hydration).
//   • UNCHANGED: every safety rule this screen already carried. Note-first
//     rendering (ticketMessageKind), plain text only, delivery panels,
//     recipient lines, the attachment preview/download split, the settle/
//     steady poll, and the GET-stays-a-GET read marking.
//
// THE ONE THING THIS FILE MUST NEVER GET WRONG
// An internal note is stored with direction='outbound' — same as a real sent
// reply. ticketMessageKind() (lib/email-tickets.js) tests is_internal_note
// FIRST and this file only paints what it decides — collapsed rows included
// (collapsedRowMeta applies the same ordering, so a folded note keeps its
// amber). Nobody must ever be able to think a note went to the member, or
// that a reply stayed private. The composer states its mode three times over:
// the selected segment, the colour of the card, and the sentence naming
// exactly who receives what.
//
// PLAIN TEXT ONLY. Messages render `text_body`. `html_body` never leaves the
// server, and the sanitised `html_document` the web thread renders is
// deliberately ignored here: that path depends on a sandboxed iframe, which
// React Native has no equivalent of. Raw email HTML is hostile input from an
// unauthenticated stranger — on mobile it simply is not rendered.
//
// OUTBOUND ATTACHMENTS (MOBILE-MAIL-THREAD.1) ride the repo's standard
// three-step direct-to-storage flow via lib/email-api.js's helpers: sign
// (authorised against THIS ticket), upload the bytes device→bucket, then the
// reply body carries the returned draft refs. Every size/count decision is
// lib maths (admitPickedFile / attachmentBudget / composerSendState), so an
// oversize pick is a refusal sentence BEFORE any upload — a red chip, never a
// failed send. A removed chip's already-uploaded object is accepted residue
// (one unmetered draft object; quota is charged only when a message files —
// the same trade the web picker documents on its discard race).
//
// Reads no longer clear the badge as a side effect (the GET is a GET), so the
// screen posts …/seen itself once the thread loads.
//
// RECIPIENTS (EMAIL-CC.1) ARE SHOWN HERE BUT NOT EDITED. To/Cc/Bcc render
// under each message; Bcc is marked staff-only in words as well as an icon.
// The composer sends `{ text, internal, attachments }` and nothing else,
// which is not a gap: the reply route derives everybody on the thread
// server-side and always includes them, so a mobile reply on a multi-party
// thread IS a reply-all, identically to web. The ADD side (chip input,
// Cc/Bcc) stays web-only — a confidentiality control that wants real device
// QA. All three places a name appears (header line, placeholder, audience
// sentence) come from ONE derivation (ticketReplyAudience in
// lib/email-tickets.js), so this screen cannot say three things about who a
// reply reaches.

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform, Modal, Image, Linking,
} from 'react-native'
import { useLocalSearchParams, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { useAuth } from '../../../lib/auth-context'
import {
  getTicket, replyToTicket, archiveConversation, setConversationSeen, emailDisplayName,
  previewTicketAttachment, downloadTicketAttachment,
  signOutboundAttachment, uploadSignedAttachment,
} from '../../../lib/email-api'
import {
  ticketMessageKind, mailStatusChip, mailboxLabel, ticketDeliveryMeta,
  ticketMessageRecipients, sentToLabel, isArchivedStatus,
  formatAttachmentSize, ticketAttachmentSkippedLabel, ticketAttachmentIcon,
  threadRefreshMs, ticketReplyAudienceMeta, ticketReplyPlaceholder,
  ticketThreadAudienceLines, ticketSendOriginMeta,
} from '../../../lib/email-tickets'
import {
  readReplyDraft, writeReplyDraft, clearReplyDraft, resolveDraftHydration,
  threadDisplayPlan, collapsedRowMeta,
  attachmentBudget, readyAttachmentRefs, admitPickedFile, composerSendState,
} from '../../../lib/mail-drafts'
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

// How long the "Draft saved" caption waits after the last keystroke before
// the write lands. Short enough that leaving the screen rarely beats it,
// long enough not to hammer AsyncStorage per keystroke.
const DRAFT_WRITE_DEBOUNCE_MS = 600

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
 * Tapping a chip asks the server for a preview URL. `preview_kind: 'image'`
 * opens the viewer below; ANYTHING ELSE — a PDF, a Word document, a HEIC photo,
 * an SVG — is handed to the OS via Linking with a DOWNLOAD url, which on a
 * phone is the better answer anyway: iOS and Android both have real viewers for
 * those, and an in-app frame for a stranger's document would need a WebView
 * this app deliberately does not carry. Which types may be previewed is the
 * SERVER's decision (`preview_kind` on the row) — one allow-list, no drift.
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

/**
 * One folded message — mockup §04's one-line row. WHO in bold, what happened
 * and when on the right, tap to unfold. The meta (who/what/when/tone) is lib
 * maths (collapsedRowMeta), and tone 'note' keeps the amber skin: a folded
 * staff-only note must be as unmistakable as an open one.
 */
function CollapsedRow({ msg, isFirst, fallbackName, onExpand }) {
  const meta = collapsedRowMeta(msg, { isFirst, fallbackName })
  const isNoteRow = meta.tone === 'note'
  return (
    <Pressable
      onPress={onExpand}
      accessibilityLabel={`Expand message: ${meta.who}, ${meta.what}`}
      className={`flex-row items-center rounded-xl border px-3 py-2.5 mb-2 ${
        isNoteRow ? 'border-amber-500/60 bg-amber-500/10' : 'border-un1t-border bg-un1t-surface'
      }`}
    >
      {isNoteRow ? (
        <Ionicons name="lock-closed" size={11} color="#B45309" style={{ marginRight: 5 }} />
      ) : null}
      <Text
        className={`text-xs font-bold flex-1 ${isNoteRow ? 'text-amber-700' : 'text-un1t-text'}`}
        numberOfLines={1}
      >
        {meta.who}
      </Text>
      <Text className="text-xs text-un1t-subtle ml-2">
        {meta.what}{meta.when ? ` · ${meta.when}` : ''}
      </Text>
      <Ionicons name="chevron-down" size={13} color="#94A3B8" style={{ marginLeft: 4 }} />
    </Pressable>
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
  const { profile, activeLocation } = useAuth()
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const [ticket, setTicket] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [text, setText] = useState('')
  const [isNote, setIsNote] = useState(false)
  const [sending, setSending] = useState(false)
  const [savingAction, setSavingAction] = useState(false)
  // Which folded messages the operator has tapped open. Only ever grows —
  // re-folding is a gesture nobody asked for, and a poll that re-collapsed a
  // message somebody just opened would read as the screen fighting them.
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  // Outbound files on the reply being written: { key, filename, size, mime,
  // uri, status: 'uploading'|'ready'|'failed', ref, error }. `ref` is the
  // draft ref uploadSignedAttachment answered — the thing the reply body
  // carries. NEVER persisted with the draft (recipients/files are derived or
  // re-picked per session; the web store's header explains the leak that rule
  // prevents).
  const [files, setFiles] = useState([])
  // "Draft saved" is STATED, NOT HOPED: true only after a write actually
  // landed (writeReplyDraft's return value), cleared on every keystroke.
  const [draftSaved, setDraftSaved] = useState(false)
  // Gates the write-through: false until the stored draft has been read and
  // the hydration decision applied. Without it the debounced writer could
  // fire with the pre-hydration blank text and CLEAR the very draft the read
  // is about to restore — the web composer's skipNextWriteRef trap, one
  // storage API over.
  const [draftReady, setDraftReady] = useState(false)
  // The route sets this when the ATTACHMENT lookup failed (2026-08-08 audit):
  // the messages below are real, but their files are unknown — which must be
  // said, or a blipped lookup reads as "the member sent no files". Web renders
  // the same warning (AttachmentsUnavailableNotice).
  const [attachmentsUnavailable, setAttachmentsUnavailable] = useState(false)
  // EMAIL-PARTICIPANTS.9 — { to, mode, over_cap, empty } | null, straight off
  // getTicket(). Kept alongside `ticket` rather than folded into it: it comes
  // back from the SAME response but is answered as its own top-level field.
  const [replyRecipients, setReplyRecipients] = useState(null)
  // EMAIL-ATTACH-PREVIEW.1 — the one image being looked at, if any.
  const [viewingImage, setViewingImage] = useState(null)
  const scrollRef = useRef(null)
  const readMarked = useRef(false)
  const hydrationStarted = useRef(false)
  const fileSeq = useRef(0)
  // What the composer holds RIGHT NOW, readable from the async hydration
  // callback without widening its deps to per-keystroke. Refreshed every
  // render in an effect (never during render); cheap.
  const liveRef = useRef({ text: '', isNote: false })
  useEffect(() => { liveRef.current = { text, isNote } })
  // files, readable from the picker handlers without a stale closure —
  // uploads finish out of order and picks can arrive in bursts.
  const filesRef = useRef(files)
  useEffect(() => { filesRef.current = files })

  // The draft's identity: per USER (fail closed without one — lib rule), per
  // EMAIL ACCOUNT (the ticket's mailbox; orphans use the lib's 'none'
  // sentinel), per ticket. mailbox_id only exists once the ticket has loaded,
  // which is why hydration below waits for it.
  const draftScope = useMemo(
    () => ({ userId: profile?.id, mailboxId: ticket?.mailbox_id, ticketId }),
    [profile?.id, ticket?.mailbox_id, ticketId]
  )

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

    // Read state is its own call. Fire-and-forget and once per screen: it is
    // idempotent, and a failure here must never look like the thread failed
    // to open. Unlike the ticket-era /read this also mirrors \Seen into a
    // connected real mailbox, so opening it here marks it read at the desk
    // and in the operator's own mail app too.
    if (!readMarked.current) {
      readMarked.current = true
      setConversationSeen(ticketId, true, activeLocation?.id).catch(() => {})
    }
  }, [ticketId, activeLocation])

  useEffect(() => {
    setLoading(true)
    refresh().finally(() => setLoading(false))
  }, [refresh])

  // DRAFT HYDRATION — once, after BOTH the viewer and the ticket are known
  // (the key needs profile.id and the ticket's mailbox_id; reading under a
  // wrong 'none' segment before the ticket lands would look up — and later
  // write — a different key than the one this conversation saves under).
  //
  // 🔴 LIVE TYPING OUTRANKS THE STORED DRAFT (resolveDraftHydration, tested in
  // lib/mail-drafts.test.js): the read is async, and an operator can be
  // mid-sentence by the time it resolves. If anything has been typed, their
  // words stand and are persisted now that the scope exists; the stored draft
  // is only restored into a composer that is still blank.
  useEffect(() => {
    if (hydrationStarted.current) return
    if (!profile?.id || !ticket) return
    hydrationStarted.current = true
    const scope = { userId: profile.id, mailboxId: ticket.mailbox_id, ticketId }
    readReplyDraft(scope).then((draft) => {
      const decision = resolveDraftHydration({ liveText: liveRef.current.text, draft })
      if (decision.action === 'hydrate') {
        setText(decision.text)
        setIsNote(decision.mode === 'note')
        setDraftSaved(true)
      } else if (decision.action === 'keep-live') {
        writeReplyDraft(scope, {
          text: liveRef.current.text,
          mode: liveRef.current.isNote ? 'note' : 'reply',
        }).then((saved) => { if (saved) setDraftSaved(true) })
      }
      // Only now may the write-through below run — see draftReady's comment.
      setDraftReady(true)
    })
  }, [profile?.id, ticket, ticketId])

  // DRAFT WRITE-THROUGH — debounced, gated on hydration having settled. Only
  // { text, mode } are ever persisted (never recipients or files — the web
  // store's header explains the leak that rule closes). Cleanup cancels the
  // pending timer on every keystroke, so at most one write per pause; the
  // empty-text branch inside writeReplyDraft is what clears the entry when
  // the operator deletes their words.
  useEffect(() => {
    if (!draftReady) return undefined
    setDraftSaved(false)
    const timer = setTimeout(() => {
      writeReplyDraft(draftScope, { text, mode: isNote ? 'note' : 'reply' })
        .then((saved) => setDraftSaved(saved))
    }, DRAFT_WRITE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draftReady, draftScope, text, isNote])

  // EMAIL-ATTACH-RACE.1 — the thread re-reads itself while it is open.
  // Cadence comes from the thread itself (threadRefreshMs): fast while its
  // newest message is young enough that rows may still be arriving, 60s
  // otherwise. Torn down with the screen, so a backgrounded thread costs
  // nothing.
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
  // EMAIL-PARTICIPANTS.9 — the audience sentence and whether a reply is even
  // possible. `audience.disabled` covers "no requester", "everyone removed"
  // and over_cap; composerSendState folds it into the one send gate.
  const audience = ticketReplyAudienceMeta(ticket, replyRecipients)
  // EMAIL-PARTICIPANTS.12 — one derivation for every string that names the
  // audience (lib/email-tickets.js), so this screen cannot say three things
  // about who a reply reaches.
  const threadLines = ticketThreadAudienceLines(ticket, replyRecipients)
  const replyPlaceholder = ticketReplyPlaceholder(ticket, replyRecipients)

  // THE send gate — one lib answer read by the button AND the submit guard,
  // so they cannot disagree (lib/mail-drafts.js).
  const sendState = composerSendState({
    text, isNote, files, audienceDisabled: audience.disabled, sending,
  })
  const budget = attachmentBudget(files)

  function patchFile(key, patch) {
    setFiles(prev => prev.map(f => (f.key === key ? { ...f, ...patch } : f)))
  }

  // Sign → upload → hold the draft ref. Both steps are lib/email-api.js's
  // helpers; a reply's file authorises against THIS ticket (the sign route's
  // exactly-one-of rule — ticketId, never mailboxId, for replies).
  async function uploadOne(entry) {
    try {
      const sign = await signOutboundAttachment({
        filename: entry.filename,
        size: entry.size,
        mime: entry.mime,
        ticketId,
        locationId: activeLocation?.id,
      })
      if (!sign.success) {
        patchFile(entry.key, { status: 'failed', error: sign.error || 'Could not start that upload.' })
        return
      }
      const up = await uploadSignedAttachment(sign, entry.uri)
      if (!up.success) {
        patchFile(entry.key, { status: 'failed', error: up.error || 'Upload failed.' })
        return
      }
      patchFile(entry.key, { status: 'ready', ref: up.draft, error: null })
    } catch {
      patchFile(entry.key, { status: 'failed', error: 'Upload failed — check your connection.' })
    }
  }

  // One admission decision per file, against the list AS IT GROWS (a burst of
  // picks must not each be measured against the pre-burst list) — the maths
  // is admitPickedFile in lib/mail-drafts.js: count cap, byte ceiling,
  // unreadable-size refusal. A refused file is a SENTENCE before any upload
  // starts — the red-chip-not-failed-send rule.
  function addPicked(assets) {
    let current = filesRef.current
    const admitted = []
    for (const a of assets || []) {
      const filename = a.name || a.fileName || 'file'
      const size = Number(a.size ?? a.fileSize)
      const refusal = admitPickedFile(current, { name: filename, size })
      if (refusal) {
        Alert.alert('Can’t attach that', refusal)
        continue
      }
      const entry = {
        key: `f${fileSeq.current++}`,
        filename,
        size,
        mime: a.mimeType || 'application/octet-stream',
        uri: a.uri,
        status: 'uploading',
        ref: null,
        error: null,
      }
      current = [...current, entry]
      admitted.push(entry)
    }
    if (admitted.length === 0) return
    setFiles(prev => [...prev, ...admitted])
    // Uploads start the moment a file is chosen (the web picker's rule): the
    // waiting happens while the operator types, and Send can be honestly
    // disabled while anything is still moving.
    for (const entry of admitted) uploadOne(entry)
  }

  async function pickDocuments() {
    try {
      const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
      if (res.canceled) return
      addPicked(res.assets)
    } catch {
      Alert.alert('Couldn’t open files', 'The file picker could not be opened on this device.')
    }
  }

  async function pickImages() {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.8,
      })
      if (res.canceled) return
      addPicked(res.assets)
    } catch {
      Alert.alert('Couldn’t open photos', 'The photo library could not be opened on this device.')
    }
  }

  // Remove = forget the chip. The already-uploaded object is accepted residue
  // (one unmetered draft under the caller's own prefix; quota is charged only
  // when a message files) — the same trade the web picker takes on its
  // discard race, minus the discard call this surface does not carry.
  function removeFile(entry) {
    setFiles(prev => prev.filter(f => f.key !== entry.key))
  }

  async function send() {
    if (!sendState.canSend) return
    const body = text.trim()
    setSending(true)
    const res = await replyToTicket(ticketId, body, {
      internal: isNote,
      locationId: activeLocation?.id,
      // Ready refs only (lib rule: STATUS gates, not the ref's presence) —
      // and replyToTicket itself refuses to put attachments on a note.
      attachments: readyAttachmentRefs(files),
    })
    setSending(false)
    if (!res.success) {
      Alert.alert(isNote ? 'Couldn’t add note' : 'Couldn’t send', res.error || 'Unknown error')
      return
    }
    setText('')
    setFiles([])
    // Cleared explicitly rather than left to the debounced writer's
    // empty-text branch: a successful send is the one moment this draft is
    // DEFINITELY done, and saying so must not depend on a timer firing.
    clearReplyDraft(draftScope)
    setDraftSaved(false)
    refresh()
  }

  // RETIRE-TICKETS.1 — assignment and the four-state lifecycle left with the
  // ticket queue. The two verbs of this surface, now riding the header:

  // Archive / bring back. The response's ticket row is a bare status write —
  // merge, never replace (the EMAIL-MOPUP.4 lesson: the enriched mailbox and
  // contact fields must survive).
  async function toggleArchive() {
    if (savingAction) return
    const next = !isArchivedStatus(ticket?.status)
    setSavingAction(true)
    const res = await archiveConversation(ticketId, next, activeLocation?.id)
    setSavingAction(false)
    if (!res.success) {
      Alert.alert(next ? 'Couldn’t archive' : 'Couldn’t bring it back', res.error || 'Unknown error')
      return
    }
    if (res.data?.conversation) {
      setTicket(prev => (prev ? { ...prev, ...res.data.conversation } : prev))
    } else {
      refresh({ quiet: true })
    }
    // The mailbox half (moving the real message in a connected account) can
    // refuse independently; the DB half above stands either way.
    if (res.data?.writeback?.notice) {
      Alert.alert('Archived here', res.data.writeback.notice)
    }
  }

  // Mark as unread — the mail-app gesture for "deal with this later". The
  // screen's own open-marking already ran, so this flips it back and the row
  // regains its weight when the list refreshes on focus.
  async function markUnread() {
    if (savingAction) return
    setSavingAction(true)
    const res = await setConversationSeen(ticketId, false, activeLocation?.id)
    setSavingAction(false)
    if (!res.success) {
      Alert.alert('Couldn’t mark as unread', res.error || 'Unknown error')
      return
    }
    // Un-arm the open-marking so the poll's refresh doesn't silently re-read
    // it while the operator is still looking at the screen.
    readMarked.current = true
  }

  // 'Email' rather than the display helper's "Unknown sender" fallback while
  // the thread is still loading — a header that briefly accuses us of not
  // knowing who wrote in reads as a bug.
  const name = ticket ? emailDisplayName(ticket) : 'Email'
  const chip = mailStatusChip(ticket)
  const archived = isArchivedStatus(ticket?.status)

  // The folded/unfolded plan for the thread (lib/mail-drafts.js): everything
  // but the newest two collapses until tapped.
  const plan = threadDisplayPlan(messages, expandedIds)
  const failedFiles = files.some(f => f.status === 'failed')

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      className="flex-1 bg-un1t-bg"
    >
      <Stack.Screen
        options={{
          title: name,
          // INBOX-SPLIT.M1 — back goes to the Mail tab, not Messages: email
          // is its own surface (and a cold-start deep link from a push must
          // not land someone in the chat inbox).
          headerLeft: () => <BackHeaderLeft label="Mail" fallbackHref="/(tabs)/email" />,
          // THE VERBS RIDE THE HEADER (mockup §04 note 1): mark-unread,
          // archive, and an overflow that is the reserved seat for forward —
          // drawn but honest about being empty, so its arrival later is not a
          // layout change.
          headerRight: () => (
            <View className="flex-row items-center">
              <Pressable
                onPress={markUnread}
                disabled={savingAction || !ticket}
                hitSlop={6}
                accessibilityLabel="Mark as unread"
                className={`px-2 py-1 ${savingAction ? 'opacity-50' : ''}`}
              >
                <Ionicons name="mail-unread-outline" size={19} color="#111827" />
              </Pressable>
              <Pressable
                onPress={toggleArchive}
                disabled={savingAction || !ticket}
                hitSlop={6}
                accessibilityLabel={archived ? 'Bring back to inbox' : 'Archive'}
                className={`px-2 py-1 ${savingAction ? 'opacity-50' : ''}`}
              >
                <Ionicons name={archived ? 'arrow-undo-outline' : 'archive-outline'} size={19} color="#111827" />
              </Pressable>
              <Pressable
                onPress={() => Alert.alert('More actions', 'Nothing lives here yet — forwarding will.')}
                hitSlop={6}
                accessibilityLabel="More actions"
                className="pl-2 py-1"
              >
                <Ionicons name="ellipsis-vertical" size={17} color="#111827" />
              </Pressable>
            </View>
          ),
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
          {/* Header strip (mockup §04): the SUBJECT leads, then the status +
              account chips, then the server's own audience derivation.
              EMAIL-PARTICIPANTS.12 — the audience line is the LIVE set off
              the server, with the requester demoted to "Opened by" only when
              the two have actually diverged. */}
          <View className="border-b border-un1t-border bg-un1t-surface px-4 pt-2.5 pb-3">
            {ticket?.subject ? (
              <Text className="text-[17px] font-extrabold text-un1t-text leading-snug" numberOfLines={2}>
                {ticket.subject}
              </Text>
            ) : (
              <Text className="text-[17px] font-extrabold text-un1t-subtle leading-snug">
                (no subject)
              </Text>
            )}
            <View className="flex-row items-center flex-wrap mt-1.5">
              {chip ? (
                <View className={`px-1.5 py-0.5 rounded mr-1.5 ${chip.cls}`}>
                  <Text className={`text-[10px] font-semibold ${chip.text}`}>{chip.label}</Text>
                </View>
              ) : null}
              {/* Which account it arrived at. mailbox_id is ON DELETE SET
                  NULL, so a deleted address orphans its correspondence rather
                  than hiding it — the no-mailbox case is said in words. */}
              <View className="px-1.5 py-0.5 rounded bg-slate-500/10">
                <Text className="text-[10px] font-semibold text-slate-700" numberOfLines={1}>
                  {ticket?.mailbox ? `@ ${mailboxLabel(ticket.mailbox)}` : 'No mailbox on this ticket'}
                </Text>
              </View>
            </View>
            <Text className="text-[11px] text-un1t-subtle mt-1.5" numberOfLines={1}>
              {threadLines.primary}
            </Text>
            {threadLines.opener ? (
              <Text className="text-[11px] text-un1t-muted mt-0.5" numberOfLines={1}>
                {threadLines.opener}
              </Text>
            ) : null}
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
            {plan.length === 0 ? (
              <Text className="text-xs text-un1t-subtle text-center py-6">
                No messages on this ticket yet.
              </Text>
            ) : (
              plan.map(({ message: m, collapsed }, i) => (
                collapsed ? (
                  <CollapsedRow
                    key={m.id}
                    msg={m}
                    isFirst={i === 0}
                    fallbackName={ticket?.requester_name || ''}
                    onExpand={() => setExpandedIds(prev => new Set(prev).add(m.id))}
                  />
                ) : (
                  <MessageBubble
                    key={m.id}
                    msg={m}
                    ticketId={ticketId}
                    locationId={activeLocation?.id}
                    onViewImage={setViewingImage}
                  />
                )
              ))
            )}
          </ScrollView>

          {/* Composer (mockup §04 "Reply, expanded"). The mode is stated
              three times over: the selected segment, the colour of the card,
              and the sentence naming exactly who receives what. */}
          <View
            className="border-t border-un1t-border bg-un1t-bg px-3 pt-2.5"
            style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          >
            {/* Reply / Internal note — a full-width segmented toggle. */}
            <View className="flex-row rounded-xl border border-un1t-border bg-un1t-bg p-0.5 mb-2">
              <Pressable
                onPress={() => setIsNote(false)}
                accessibilityLabel="Reply mode"
                className={`flex-1 flex-row items-center justify-center py-1.5 rounded-[10px] ${
                  !isNote ? 'bg-un1t-text' : ''
                }`}
              >
                <Ionicons name="send" size={11} color={!isNote ? '#FFFFFF' : '#64748B'} style={{ marginRight: 5 }} />
                <Text className={`text-xs ${!isNote ? 'text-white font-bold' : 'text-un1t-subtle font-semibold'}`}>
                  Reply
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setIsNote(true)}
                accessibilityLabel="Internal note mode"
                className={`flex-1 flex-row items-center justify-center py-1.5 rounded-[10px] ${
                  isNote ? 'bg-amber-500/10' : ''
                }`}
              >
                <Ionicons name="lock-closed" size={11} color={isNote ? '#B45309' : '#64748B'} style={{ marginRight: 5 }} />
                <Text className={`text-xs ${isNote ? 'text-amber-700 font-bold' : 'text-un1t-subtle font-semibold'}`}>
                  Internal note
                </Text>
              </Pressable>
            </View>

            {/* The card. Note mode re-skins the WHOLE thing amber — the mode
                is something you can see, never something you must remember. */}
            <View
              className={`rounded-2xl border-[1.5px] px-3 pt-2 pb-2.5 ${
                isNote ? 'border-amber-600 bg-amber-500/10' : 'border-un1t-text bg-un1t-surface'
              }`}
            >
              {/* The audience, named BEFORE a word is typed — and "Draft
                  saved" stated, not hoped (true only after the write landed). */}
              <View className="flex-row items-center mb-1">
                <Text
                  className={`text-[11px] flex-1 ${isNote ? 'text-amber-700' : 'text-un1t-subtle'}`}
                  numberOfLines={2}
                >
                  {isNote
                    ? `Staff only — written to the ticket and NOT sent to ${ticket?.requester_email || 'the member'}.`
                    : audience.text}
                </Text>
                {draftSaved && text.trim() ? (
                  <Text className="text-[11px] text-un1t-muted ml-2">Draft saved</Text>
                ) : null}
              </View>

              <TextInput
                value={text}
                onChangeText={setText}
                multiline
                editable={isNote || canReply}
                placeholder={isNote ? 'Staff-only note. Nothing is sent.' : replyPlaceholder}
                placeholderTextColor="#94A3B8"
                maxLength={10000}
                className="text-base text-un1t-text max-h-32 p-0"
                style={{ minHeight: 56 }}
                textAlignVertical="top"
              />

              {/* The outbound files. Visible in note mode too — switching to
                  a note must never silently drop what was attached; the send
                  gate blocks the note instead and the sentence below says
                  why. */}
              {files.length > 0 && (
                <View className="mt-2">
                  {files.map(f => (
                    <View
                      key={f.key}
                      className={`flex-row items-center rounded-lg border px-2 py-1.5 mt-1 ${
                        f.status === 'failed'
                          ? 'border-red-500/60 bg-red-500/10'
                          : 'border-un1t-border bg-un1t-bg'
                      }`}
                    >
                      {f.status === 'uploading' ? (
                        <ActivityIndicator size="small" style={{ marginRight: 6, transform: [{ scale: 0.7 }] }} />
                      ) : (
                        <Ionicons
                          name={f.status === 'failed' ? 'alert-circle-outline' : ticketAttachmentIcon(f.mime, f.filename)}
                          size={14}
                          color={f.status === 'failed' ? '#B91C1C' : '#64748B'}
                          style={{ marginRight: 6 }}
                        />
                      )}
                      <Text
                        className={`text-xs flex-1 ${f.status === 'failed' ? 'text-red-700' : 'text-un1t-text'}`}
                        numberOfLines={1}
                      >
                        {f.filename}
                      </Text>
                      <Text className={`text-[11px] ml-2 ${f.status === 'failed' ? 'text-red-700' : 'text-un1t-subtle'}`}>
                        {f.status === 'uploading'
                          ? 'Uploading…'
                          : f.status === 'failed'
                            ? 'Failed'
                            : formatAttachmentSize(f.size)}
                      </Text>
                      <Pressable
                        onPress={() => removeFile(f)}
                        hitSlop={8}
                        accessibilityLabel={`Remove ${f.filename}`}
                        className="ml-2"
                      >
                        <Ionicons name="close" size={14} color="#64748B" />
                      </Pressable>
                    </View>
                  ))}
                  <Text className={`text-[11px] mt-1 ${budget.over ? 'text-red-700' : 'text-un1t-muted'}`}>
                    {formatAttachmentSize(budget.used)} of {formatAttachmentSize(budget.limit)}
                    {budget.over ? ' — over the limit, remove a file' : ''}
                  </Text>
                </View>
              )}

              {/* Tools: the pickers (reply mode only — a note is sent to
                  nobody, so there is nothing for a file to ride on) and the
                  one ink square that sends. */}
              <View className="flex-row items-center justify-between mt-2">
                <View className="flex-row items-center">
                  {!isNote && (
                    <>
                      <Pressable
                        onPress={pickDocuments}
                        disabled={sending}
                        hitSlop={6}
                        accessibilityLabel="Attach a file"
                        className={`mr-4 ${sending ? 'opacity-50' : ''}`}
                      >
                        <Ionicons name="attach-outline" size={20} color="#64748B" />
                      </Pressable>
                      <Pressable
                        onPress={pickImages}
                        disabled={sending}
                        hitSlop={6}
                        accessibilityLabel="Attach a photo"
                        className={sending ? 'opacity-50' : ''}
                      >
                        <Ionicons name="image-outline" size={19} color="#64748B" />
                      </Pressable>
                    </>
                  )}
                </View>
                <Pressable
                  onPress={send}
                  disabled={!sendState.canSend}
                  accessibilityLabel={isNote ? 'Add internal note' : 'Send reply'}
                  className={`w-10 h-10 rounded-xl items-center justify-center ${
                    sendState.canSend
                      ? (isNote ? 'bg-amber-600' : 'bg-un1t-text')
                      : 'bg-un1t-border'
                  }`}
                >
                  {sending ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Ionicons name={isNote ? 'lock-closed' : 'send'} size={16} color="#FFFFFF" />
                  )}
                </Pressable>
              </View>
            </View>

            {/* The sentences under the card — each states a rule the send
                gate is enforcing, so a disabled button is never mute. */}
            {sendState.reason === 'note_has_files' && (
              <Text className="text-[11px] text-amber-700 mt-1.5">
                {files.length === 1 ? 'A file is' : `${files.length} files are`} attached, and an
                internal note is not sent to anyone. Switch back to Reply to send
                {files.length === 1 ? ' it' : ' them'}, or remove
                {files.length === 1 ? ' it' : ' them'} first.
              </Text>
            )}
            {sendState.reason === 'uploading' && (
              <Text className="text-[11px] text-un1t-subtle mt-1.5">
                Waiting for files to finish uploading…
              </Text>
            )}
            {failedFiles && !isNote && (
              <Text className="text-[11px] text-red-700 mt-1.5">
                A file did not upload. Remove it and try again — it will not be sent.
              </Text>
            )}
            {!isNote && archived && (
              <Text className="text-[11px] text-un1t-subtle mt-1.5">
                This conversation is archived — replying brings it back to the inbox.
              </Text>
            )}
          </View>
        </>
      )}
      <ImageViewer image={viewingImage} onClose={() => setViewingImage(null)} />
    </KeyboardAvoidingView>
  )
}
