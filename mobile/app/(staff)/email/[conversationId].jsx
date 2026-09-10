// Email thread + reply — MOBILE-MAIL-THREAD.1, the approved mockup's §04
// (was EMAIL-TICKET-M.1's queue-era screen; same file, new shape).
//
// WHAT CHANGED IN THE REDESIGN, and what deliberately did not:
//   • The verbs ride the native header now (mark-unread, archive, and a ⋮
//     overflow whose one action is Forward, acting on the NEWEST forwardable
//     message) — the in-strip button row is gone. Forward also rides each
//     expanded non-note message as a small per-message icon: the ⋮ is the
//     discoverable affordance, the icon is the precise one (MOBILE-MAIL-
//     FORWARD.1). Internal notes offer neither — lib/mail-forward.js's
//     canForwardMessage is the rule, and the route 400s it besides.
//   • The header strip leads with the SUBJECT, then the status + account
//     chips, then the server's own audience derivation ("On this thread: …").
//   • MAIL-REFINE.1 §02 — the thread is FLAT EMAIL, not chat: full-width
//     messages with hairlines, one header row (avatar · sender · address ·
//     time), no bubbles and no right-alignment (outbound = the dark "me"
//     avatar). ONLY the newest message opens by default; every other folds
//     to a one-line row (avatar, sender, snippet, time) until tapped, and an
//     open header taps closed again (flatThreadPlan/flatMessageMeta in
//     lib/mail-conversations.js).
//   • MAIL-REFINE.1 §03 — a nudge banner under the header when the same
//     requester has other OPEN conversations here (relatedNudge over the
//     related endpoint — an unknown count shows NOTHING, never 0), a
//     bottom-sheet merge picker (sequential merges, stop on first failure —
//     a failed merge must never look merged), Undo on the success notice
//     only, and a read-only pointer on tombstone threads.
//   • The composer is a card: a full-width Reply / Internal-note segmented
//     toggle above it, the audience sentence and a "Draft saved" caption
//     inside it, a paperclip + photo picker for OUTBOUND attachments, and an
//     ink-square send. Note mode re-skins the whole card amber.
//   • Drafts persist per user + account + conversation over AsyncStorage
//     (lib/mail-drafts.js — the web store's semantics: fail closed with no
//     user id, 14-day TTL, 30-entry eviction, live-typing-wins hydration).
//   • UNCHANGED: every safety rule this screen already carried. Note-first
//     rendering (conversationMessageKind), plain text only, delivery panels,
//     recipient lines, the attachment preview/download split, the settle/
//     steady poll, and the GET-stays-a-GET read marking.
//
// THE ONE THING THIS FILE MUST NEVER GET WRONG
// An internal note is stored with direction='outbound' — same as a real sent
// reply. conversationMessageKind() (lib/mail-conversations.js) tests is_internal_note
// FIRST and this file only paints what it decides — collapsed rows included
// (flatMessageMeta applies the same ordering, so a folded note keeps its
// amber and its lock). Nobody must ever be able to think a note went to the member, or
// that a reply stayed private. The composer states its mode three times over:
// the selected segment, the colour of the card, and the sentence naming
// exactly who receives what.
//
// HTML IS RENDERED, WITHOUT AN HTML ENGINE (MAIL-READER.M1). The route serves
// `html_blocks` under ?body=blocks — a block tree src/lib/email-blocks.js walks
// out of the ALREADY SANITISED document, server-side. components/mail/EmailBody
// draws it with Text/View. `html_body` still never leaves the server, nothing
// is parsed on this device, and react-native-webview is still not a dependency:
// Layer 1 here is the ABSENCE of an HTML engine rather than a sandboxed iframe,
// which is why no script can run even in principle.
//
// The text path remains, and is not a legacy: an internal note (plain text by
// construction), a message with no HTML, one past the block budget, one whose
// HTML would not sanitise, and a server that sent no blocks at all — a rollback
// behind a shipped OTA — all render `text_body`. Absence of blocks is the text
// path, never an error.
//
// OUTBOUND ATTACHMENTS (MOBILE-MAIL-THREAD.1) ride the repo's standard
// three-step direct-to-storage flow via lib/email-api.js's helpers: sign
// (authorised against THIS conversation), upload the bytes device→bucket, then the
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
// sentence) come from ONE derivation (conversationReplyAudience in
// lib/mail-conversations.js), so this screen cannot say three things about who a
// reply reaches.

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform, Modal, Image, Linking, StyleSheet,
} from 'react-native'
import { router, useLocalSearchParams, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { useAuth } from '../../../lib/auth-context'
import {
  getConversation, replyToConversation, archiveConversation, setConversationSpam, setConversationSeen, emailDisplayName,
  previewConversationAttachment, downloadConversationAttachment,
  signOutboundAttachment, uploadSignedAttachment,
  fetchRelatedConversations, mergeConversation, unmergeConversation,
} from '../../../lib/email-api'
import {
  conversationMessageKind, mailStatusChip, conversationDeliveryMeta,
  conversationMessageRecipients, sentToLabel,
  formatAttachmentSize, conversationAttachmentSkippedLabel, conversationAttachmentIcon,
  threadRefreshMs, conversationReplyAudienceMeta, conversationReplyPlaceholder,
  conversationThreadAudienceLines, conversationSendOriginMeta,
  flatThreadPlan, flatMessageMeta, mergedInDividers,
  accountChipLabel, headerDetailLines, spamActionLabel,
  composerCap, audienceSummary,
} from '../../../lib/mail-conversations'
// MAIL-ARCH.3 — the thread route stamps `archived` now; read the stamp, never
// `status` (legacy `solved` is LIVE on the wire). MAIL-ARCH.4 — the one
// reading is shared's isArchived; see shared/mail-vocabulary.js.
import { isArchived } from 'shared/mail-vocabulary'
import { splitQuotedText } from 'shared/mail-quote'
import {
  readReplyDraft, writeReplyDraft, clearReplyDraft, resolveDraftHydration,
  attachmentBudget, readyAttachmentRefs, admitPickedFile, composerSendState,
} from '../../../lib/mail-drafts'
import {
  relatedNudge, mergePickerRows, mergeButtonLabel, toggleId, runMerges, mergeUndoNotice,
} from '../../../lib/mail-relate'
import { canForwardMessage, newestForwardableMessage } from '../../../lib/mail-forward'
import BackHeaderLeft from '../../../components/BackHeaderLeft'
import EmailBody, { openHref } from '../../../components/mail/EmailBody'
import { splitTextLinks, linkLabel } from '../../../lib/mail-blocks'
import { decodeCharRefs, stripInvisibleChars } from 'shared/mail-entities'

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
 * see it too; they could not, and never will.
 *
 * `toShownInHeader` is true only for outbound messages, whose "Sent to …"
 * line names the recipient in full when there is one (and the first of
 * several otherwise). The inbound header names the SENDER and nobody on our
 * side, so there a single To must carry itself — deriving this from "which
 * kind of row am I on?" is exactly how the single-To rule got it wrong the
 * first time. Two questions, two props.
 */
function RecipientLines({ msg, toShownInHeader = false }) {
  const lines = conversationMessageRecipients(msg, { toShownInHeader })
  if (lines.length === 0) return null
  return (
    <View className="mb-1">
      {lines.map(line => (
        <View key={line.key} className="flex-row items-start">
          {line.staffOnly ? (
            <Ionicons
              name="lock-closed"
              size={9}
              color="#64748B"
              style={{ marginRight: 3, marginTop: 3 }}
            />
          ) : null}
          <Text className="text-[11px] text-un1t-subtle">{line.label} </Text>
          <Text className="text-[11px] flex-1 text-un1t-text">
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
function Attachments({ conversationId, locationId, attachments, onViewImage }) {
  const [busy, setBusy] = useState(null)
  if (!attachments || attachments.length === 0) return null

  async function open(att) {
    if (busy) return
    setBusy(att.id)
    try {
      if (att.preview_kind === 'image') {
        const res = await previewConversationAttachment(conversationId, att.id, locationId)
        if (res.success) {
          onViewImage({ url: res.url, filename: att.filename })
          return
        }
        // Fall through to the download path rather than dead-ending: the file
        // is still reachable, which is the guarantee that holds for every type.
      }
      const dl = await downloadConversationAttachment(conversationId, att.id, locationId)
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
            className={`flex-row items-center rounded-lg border border-un1t-border bg-un1t-bg px-2 py-1.5 mt-1 ${busy === att.id ? 'opacity-60' : ''}`}
          >
            <Ionicons
              name={conversationAttachmentIcon(att.mime_type, att.filename)}
              size={14}
              color="#64748B"
              style={{ marginRight: 6 }}
            />
            <Text
              className={"text-xs flex-1 text-un1t-text"}
              numberOfLines={1}
            >
              {att.filename}
            </Text>
            <Text className={"text-[11px] ml-2 text-un1t-subtle"}>
              {formatAttachmentSize(att.size_bytes)}
            </Text>
          </Pressable>
        ) : (
          <View
            key={att.id}
            className={"flex-row items-center rounded-lg border border-dashed border-amber-500/60 px-2 py-1.5 mt-1"}
          >
            <Ionicons
              name="alert-circle-outline"
              size={14}
              color="#B45309"
              style={{ marginRight: 6 }}
            />
            <View className="flex-1">
              <Text
                className={"text-xs text-un1t-text"}
                numberOfLines={1}
              >
                {att.filename}
              </Text>
              {/* Kept in words, on the chip. Staff ACT on this text — it is the
                  difference between "ask them to resend" and "we lost it". */}
              <Text className={"text-[11px] text-amber-700"}>
                {conversationAttachmentSkippedLabel(att.skipped_reason)} · {formatAttachmentSize(att.size_bytes)}
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

/** The initial avatar every flat message row leads with — dark for "us"
 * (outbound), light for the correspondent. Lib maths (flatMessageMeta)
 * decides both the letters and the shade. */
function Avatar({ meta }) {
  return (
    <View
      className={`w-6 h-6 rounded-full items-center justify-center ${
        meta.dark ? 'bg-un1t-text' : 'bg-un1t-border/60'
      }`}
    >
      <Text className={`text-[10px] font-bold ${meta.dark ? 'text-white' : 'text-un1t-text'}`}>
        {meta.initials}
      </Text>
    </View>
  )
}

/**
 * One folded message — MAIL-REFINE.1 §02's one-line row: avatar, sender in
 * bold, the snippet in grey, the time on the right, on light un1t-bg with a
 * hairline under it. Tap to unfold. Tone 'note' keeps the amber skin and the
 * lock: a folded staff-only note must be as unmistakable as an open one.
 */
function FlatCollapsedRow({ msg, fallbackName, onExpand }) {
  const meta = flatMessageMeta(msg, { fallbackName })
  const isNoteRow = meta.tone === 'note'
  return (
    <Pressable
      onPress={onExpand}
      accessibilityLabel={`Expand message from ${meta.who}`}
      className={`flex-row items-center border-b px-4 py-2.5 ${
        isNoteRow ? 'border-amber-500/30 bg-amber-500/10' : 'border-un1t-border bg-un1t-bg'
      }`}
    >
      {isNoteRow ? (
        <Ionicons name="lock-closed" size={12} color="#B45309" style={{ marginRight: 6 }} />
      ) : (
        <Avatar meta={meta} />
      )}
      <Text
        className={`text-xs font-bold ml-2 ${isNoteRow ? 'text-amber-700' : 'text-un1t-text'}`}
        numberOfLines={1}
        style={{ flexShrink: 1 }}
      >
        {meta.who}
      </Text>
      <Text className="text-xs text-un1t-subtle flex-1 ml-1.5" numberOfLines={1}>
        {isNoteRow ? `Internal note — ${meta.snippet}` : meta.snippet}
      </Text>
      <Text className="text-[11px] text-un1t-muted ml-2">{meta.when}</Text>
    </Pressable>
  )
}

/**
 * The small per-message forward affordance (MOBILE-MAIL-FORWARD.1) — the
 * PRECISE one, on every expanded non-note message; the header's ⋮ is the
 * discoverable one and acts on the newest. Never rendered on a note:
 * canForwardMessage gates at the call sites, and a note has no envelope to
 * pass on.
 */
function ForwardIcon({ onForward, onAccent = false, label }) {
  if (!onForward) return null
  return (
    <Pressable
      onPress={onForward}
      hitSlop={8}
      accessibilityLabel={label}
      className="ml-2"
    >
      <Ionicons
        name="arrow-redo-outline"
        size={13}
        color={onAccent ? 'rgba(255,255,255,0.6)' : '#64748B'}
      />
    </Pressable>
  )
}

/**
 * One EXPANDED message — MAIL-REFINE.1 §02: flat and full-width, a hairline
 * under it, one header row (initial avatar · sender · address · time) above
 * the body. NO bubbles, NO right-alignment: outbound rows keep the same flat
 * layout and are told apart by the dark "me" avatar — plus everything the
 * bubble era already said about them (Sent to …, the mail-client origin,
 * recipient lines, and the delivery verdicts, quiet and loud). Tapping the
 * header folds the message back to its one-line row.
 */
function FlatMessage({ msg, conversationId, locationId, fallbackName, onViewImage, onForward, onCollapse }) {
  const kind = conversationMessageKind(msg)
  const meta = flatMessageMeta(msg, { fallbackName })
  const stamp = formatTime(msg.sent_at || msg.created_at)
  const body = msg.text_body || '(no text content)'
  const split = splitQuotedText(msg.text_body || '')
  const shown = split.body || body
  const [quoteOpen, setQuoteOpen] = useState(false)

  // MAIL-READER.M1 — the HTML path, when the server sent a tree. It falls back
  // to the text for a note (plain text by construction), a message with no
  // HTML, one past the block budget, one whose HTML would not sanitise, and a
  // server that sent no blocks at all.
  //
  // 🔴 Amendment (Task 5's review) — `|| null`, never `=== null`. A `null`
  // html_blocks means the server ran blocks mode and genuinely found nothing
  // renderable; `undefined` means ?body= failed open and this response is the
  // OTHER shape (html_document), because URLSearchParams.get returns only the
  // FIRST occurrence of a repeated param. Both must fall back to text_body —
  // tightening this to `=== null` would throw on `undefined` instead.
  const blocks = msg.html_blocks || null
  const quotedBlocks = msg.html_quoted_blocks || null

  // ── Internal note: staff only, nothing was sent ───────────────────
  // Keeps its amber styling as a flat block — full width, hairline, and the
  // STAFF-ONLY label — so it cannot be skim-read as correspondence.
  if (kind === 'note') {
    return (
      <View className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <Pressable
          onPress={onCollapse}
          accessibilityLabel="Collapse this note"
          className="flex-row items-center mb-1.5"
        >
          <Ionicons name="lock-closed" size={12} color="#B45309" style={{ marginRight: 5 }} />
          <Text className="text-[11px] font-bold uppercase text-amber-700 flex-1">
            Internal note — not sent to the member
          </Text>
          <Text className="text-[11px] text-un1t-muted ml-2">{stamp}</Text>
        </Pressable>
        <Text className="text-sm text-un1t-text">{body}</Text>
        <Text className="text-[11px] text-un1t-subtle mt-1.5">
          {/* Who left it. On a shared queue an anonymous note is a note you
              cannot ask anyone about. author_name is NULL for anything
              written before mig 493, so the address is still the fallback. */}
          {msg.author_name ? `Note by ${msg.author_name}` : (msg.from_email || 'Staff')}
        </Text>
      </View>
    )
  }

  // EMAIL-DELIVERY.1 — null for "sent, no event yet", which is most messages
  // and every message written before mig 498. Nothing is rendered for it, so
  // the row makes no claim it cannot back up. MAILBOX-COEXIST.1 — origin is
  // null for everything composed in the CRM.
  const delivery = kind === 'outbound' ? conversationDeliveryMeta(msg) : null
  const origin = kind === 'outbound' ? conversationSendOriginMeta(msg) : null

  return (
    <View className="border-b border-un1t-border bg-un1t-bg px-4 py-3">
      {/* The one header row. Tap folds the message again. */}
      <Pressable
        onPress={onCollapse}
        accessibilityLabel={`Collapse message from ${meta.who}`}
        className="flex-row items-center"
      >
        <Avatar meta={meta} />
        <Text
          className="text-[13px] font-semibold text-un1t-text ml-2"
          numberOfLines={1}
          style={{ flexShrink: 1 }}
        >
          {meta.who}
        </Text>
        {meta.address ? (
          <Text className="text-[11px] text-un1t-muted flex-1 ml-1.5" numberOfLines={1}>
            {meta.address}
          </Text>
        ) : (
          <View className="flex-1" />
        )}
        <Text className="text-[11px] text-un1t-muted ml-2">{stamp}</Text>
      </Pressable>

      {kind === 'outbound' ? (
        <View className="flex-row items-center mt-1.5">
          <Ionicons name="mail-open-outline" size={11} color="#64748B" style={{ marginRight: 4 }} />
          <Text className="text-[11px] text-un1t-subtle flex-1" numberOfLines={1}>
            Sent to {sentToLabel(msg)}
          </Text>
        </View>
      ) : null}
      {/* WHERE IT WAS SENT FROM, when that was not the CRM (MAILBOX-
          COEXIST.1). Its own row: nobody here typed it, so there is no author
          to ask and no delivery to chase. */}
      {origin ? (
        <View className="flex-row items-center mt-1">
          <Ionicons name={origin.icon} size={11} color="#64748B" style={{ marginRight: 4 }} />
          <Text className="text-[11px] text-un1t-subtle flex-1" numberOfLines={1}>
            {origin.label}
          </Text>
        </View>
      ) : null}

      {/* To / Cc / Bcc (EMAIL-CC.1). toShownInHeader only for outbound: its
          "Sent to …" line above names the recipient in full when there is
          one, so a lone To would repeat it. The inbound header names the
          SENDER and nobody on our side, so there the To carries itself. */}
      <View className="mt-1.5">
        <RecipientLines msg={msg} toShownInHeader={kind === 'outbound'} />
      </View>

      {blocks ? (
        <EmailBody blocks={blocks} />
      ) : (
        // 🔴 decodeCharRefs at RENDER, not only at ingest: every row stored
        // before MAIL-READER.M1 still holds `&#38;` in its text_body, and
        // fixing htmlToPlainText only helps new mail. splitTextLinks is the
        // other half of the URL wall — this used to be one unbroken <Text>, so
        // a 180-character tracking URL was three lines of screen and not even
        // tappable.
        <Text className="text-base text-un1t-text">
          {splitTextLinks(stripInvisibleChars(decodeCharRefs(shown))).map((seg, i) => (
            seg.href ? (
              <Text
                key={i}
                className="text-blue-700 underline"
                accessibilityRole="link"
                onPress={() => openHref(seg.href)}
                onLongPress={() => Alert.alert('Link', seg.href)}
              >
                {linkLabel(seg.href, seg.text)}
              </Text>
            ) : <Text key={i}>{seg.text}</Text>
          ))}
        </Text>
      )}

      {/* The notices the phone never had. Desktop shows the unsafe/omitted
          pair; this screen showed neither, so an email whose HTML would not
          sanitise looked exactly like an email that simply had none.
          html_truncated joins them here rather than living inside EmailBody
          (Amendment, Task 5's review): all three flags are meaningful even
          when html_blocks is null — a message can lose everything to a cap
          and still owe the reader a notice — but EmailBody returns null
          outright whenever its blocks prop is empty, which is exactly that
          case. Reading the flag here, off `msg` directly, means the notice
          shows regardless of which branch above actually drew the body. */}
      {msg.html_truncated ? (
        <Text className="text-[11px] text-un1t-muted mt-1.5">
          This email is very long — the rest of it is not shown here.
        </Text>
      ) : null}
      {msg.html_unsafe ? (
        <Text className="text-[11px] text-amber-700 mt-1.5">
          HTML could not be displayed safely — showing the plain-text version.
        </Text>
      ) : null}
      {msg.html_omitted ? (
        <Text className="text-[11px] text-un1t-muted mt-1.5">
          Formatted version not loaded — this thread is unusually long.
        </Text>
      ) : null}

      {/* ONE toggle, two possible bodies. The HTML quote and the text quote
          shipped as two complete copies of this Pressable — same classes, same
          copy, same label — differing only in what they expanded to, which is
          two places for a future copy change to land and only one of them to
          get it. */}
      {quotedBlocks || split.quoted ? (
        <View className="mt-2">
          <Pressable
            onPress={() => setQuoteOpen(v => !v)}
            accessibilityRole="button"
            accessibilityLabel={quoteOpen ? 'Hide quoted text' : 'Show quoted text'}
            className="self-start rounded-full border border-un1t-border bg-un1t-surface px-2 py-0.5"
          >
            <Text className="text-[11px] text-un1t-subtle">
              {quoteOpen ? 'Hide quoted text' : '··· Show quoted text'}
            </Text>
          </Pressable>
          {quoteOpen ? (
            quotedBlocks ? (
              <View className="mt-2 border-l-2 border-un1t-border pl-3">
                <EmailBody blocks={quotedBlocks} />
              </View>
            ) : (
              <Text className="mt-2 border-l-2 border-un1t-border pl-3 text-sm text-un1t-subtle">{split.quoted}</Text>
            )
          ) : null}
        </View>
      ) : null}
      <Attachments
        conversationId={conversationId}
        locationId={locationId}
        attachments={msg.attachments}
        onViewImage={onViewImage}
      />

      <View className="flex-row items-center justify-end mt-1">
        {/* The QUIET delivery half: one word, in a line already there.
            🔴 IT PRINTS delivery.label AND USED TO PRINT "Delivered" — "Not
            tracked" is a second quiet outcome, and printing "Delivered" for
            it made the rows that can NEVER be confirmed the ones asserting
            confirmation hardest. Read the label. */}
        {delivery?.tone === 'quiet' ? (
          <Text className="text-[10px] text-un1t-muted">{delivery.label}</Text>
        ) : null}
        <ForwardIcon
          onForward={onForward}
          label={kind === 'outbound' ? 'Forward this reply' : 'Forward this message'}
        />
      </View>

      {/* The LOUD half. Full width, because the flat row's calm reads as "we
          answered them" — and that belief is exactly what is wrong when a
          reply bounced. */}
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

export default function EmailConversation() {
  const { conversationId } = useLocalSearchParams()
  const { profile, activeLocation } = useAuth()
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [text, setText] = useState('')
  const [isNote, setIsNote] = useState(false)
  // MAIL-READER.1's pill, on the phone. 🔴 A TYPED DRAFT IS SACRED: collapsing
  // keeps every character (MAIL-DOCK.2's lesson — the pin types a draft,
  // collapses the tree, finds the words intact). Only ✕ with a confirm may
  // discard, and this screen has no ✕.
  const [composerOpen, setComposerOpen] = useState(false)
  // The height above the keyboard, measured off an INNER view — see the
  // onLayout site below for why it cannot be measured off the
  // KeyboardAvoidingView itself on iOS.
  const [availableHeight, setAvailableHeight] = useState(0)
  const [sending, setSending] = useState(false)
  const [savingAction, setSavingAction] = useState(false)
  // Per-message fold overrides: id → true (expanded) / false (collapsed).
  // Explicit verdicts, not a toggle set, so the poll appending a new message
  // (which moves the newest-expanded default) can never flip a choice the
  // operator already made. Tap a folded row to open it, tap an open header
  // to fold it again (MAIL-REFINE.1 §02).
  const [foldOverrides, setFoldOverrides] = useState(() => new Map())
  // §03 — the requester's other conversations here, off the related
  // endpoint. Null until (and unless) a good answer lands: a failed read
  // shows NO banner rather than a confident "nothing related".
  const [related, setRelated] = useState(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeSelected, setMergeSelected] = useState(() => new Set())
  const [merging, setMerging] = useState(false)
  // Option A, compact at rest: Details is the operator's tap, and it stays
  // where they put it for as long as they are on this conversation.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [nudgeSheetOpen, setNudgeSheetOpen] = useState(false)
  // Audit F6 — expanding a folded message grows the content, and the
  // auto-scroll-to-end below would immediately yank the viewport AWAY from
  // the message the operator just opened, down to the composer. One-shot
  // suppression, armed by the expand tap, consumed by the next size change.
  const suppressAutoScrollRef = useRef(false)
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
  // MAIL-REFINE.2 — provenance for the Merged-in dividers.
  const [mergedSources, setMergedSources] = useState([])
  // EMAIL-PARTICIPANTS.9 — { to, mode, over_cap, empty } | null, straight off
  // getConversation(). Kept alongside `conversation` rather than folded into it: it comes
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
  // EMAIL ACCOUNT (the conversation's mailbox; orphans use the lib's 'none'
  // sentinel), per conversation. mailbox_id only exists once the conversation has loaded,
  // which is why hydration below waits for it.
  const draftScope = useMemo(
    () => ({ userId: profile?.id, mailboxId: conversation?.mailbox_id, conversationId }),
    [profile?.id, conversation?.mailbox_id, conversationId]
  )

  // `quiet` is a background re-read of a thread already on screen (the poll
  // below), as opposed to opening one. It never paints an error: a blip on a
  // background read must not replace correspondence the operator is reading
  // with a failure message. What is on screen is still true, just seconds old.
  const refresh = useCallback(async ({ quiet = false } = {}) => {
    const res = await getConversation(conversationId, activeLocation?.id)
    if (!res.success) {
      if (!quiet) setError(res.error || 'Failed to load conversation')
      return
    }
    setError(null)
    setConversation(res.ticket)
    // Audit A2 — a poll appending a new message re-points the newest-expanded
    // default at the arrival, silently folding the message being READ. Seed an
    // explicit keep-open override for the previous newest before the list
    // grows, so only a tap ever folds it. (Manual overrides are untouched —
    // Map.has guards the seed.)
    setMessages((prev) => {
      const next = res.messages || []
      const prevNewest = prev[prev.length - 1]
      if (prevNewest && next.length > prev.length && next.some(m => m.id === prevNewest.id)) {
        setFoldOverrides((fo) => {
          if (fo.has(prevNewest.id)) return fo
          const copy = new Map(fo)
          copy.set(prevNewest.id, true)
          return copy
        })
      }
      return next
    })
    setAttachmentsUnavailable(!!res.attachmentsUnavailable)
    setMergedSources(res.mergedSources || [])
    setReplyRecipients(res.reply_recipients || null)

    // Read state is its own call. Fire-and-forget and once per screen: it is
    // idempotent, and a failure here must never look like the thread failed
    // to open. Unlike the conversation-era /read this also mirrors \Seen into a
    // connected real mailbox, so opening it here marks it read at the desk
    // and in the operator's own mail app too.
    if (!readMarked.current) {
      readMarked.current = true
      setConversationSeen(conversationId, true, activeLocation?.id).catch(() => {})
    }
  }, [conversationId, activeLocation])

  useEffect(() => {
    setLoading(true)
    refresh().finally(() => setLoading(false))
  }, [refresh])

  // §03 — does this requester have other conversations here? Best-effort and
  // quiet: a failed read clears the banner (null) rather than painting an
  // error over a thread that loaded fine — the nudge is an extra, never a
  // claim. Re-run after every merge/undo so the banner and picker stay true.
  const relatedSeqRef = useRef(0)
  const loadRelated = useCallback(async () => {
    // Audit A4 — last-write-wins raced a post-merge reload against a slow
    // initial fetch and could resurrect a just-merged row in the picker.
    const seq = ++relatedSeqRef.current
    const res = await fetchRelatedConversations(conversationId, activeLocation?.id)
    if (seq !== relatedSeqRef.current) return
    setRelated(res.success ? res : null)
  }, [conversationId, activeLocation?.id])

  useEffect(() => { loadRelated() }, [loadRelated])

  // DRAFT HYDRATION — once, after BOTH the viewer and the conversation are known
  // (the key needs profile.id and the conversation's mailbox_id; reading under a
  // wrong 'none' segment before the conversation lands would look up — and later
  // write — a different key than the one this conversation saves under).
  //
  // 🔴 LIVE TYPING OUTRANKS THE STORED DRAFT (resolveDraftHydration, tested in
  // lib/mail-drafts.test.js): the read is async, and an operator can be
  // mid-sentence by the time it resolves. If anything has been typed, their
  // words stand and are persisted now that the scope exists; the stored draft
  // is only restored into a composer that is still blank.
  useEffect(() => {
    if (hydrationStarted.current) return
    if (!profile?.id || !conversation) return
    hydrationStarted.current = true
    const scope = { userId: profile.id, mailboxId: conversation.mailbox_id, conversationId }
    readReplyDraft(scope).then((draft) => {
      const decision = resolveDraftHydration({ liveText: liveRef.current.text, draft })
      if (decision.action === 'hydrate') {
        setText(decision.text)
        setIsNote(decision.mode === 'note')
        setDraftSaved(true)
        // Desktop's rule, and it matters more here: taking focus would raise the
        // keyboard nobody asked for. The words are there; the cursor is not.
        if (decision.text) setComposerOpen(true)
      } else if (decision.action === 'keep-live') {
        writeReplyDraft(scope, {
          text: liveRef.current.text,
          mode: liveRef.current.isNote ? 'note' : 'reply',
        }).then((saved) => { if (saved) setDraftSaved(true) })
      }
      // Only now may the write-through below run — see draftReady's comment.
      setDraftReady(true)
    })
  }, [profile?.id, conversation, conversationId])

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

  // Audit F4 — FLUSH ON UNMOUNT. The web store writes every keystroke; the
  // debounce above means backing out within 600ms of the last keystroke
  // would silently lose those words. Refs, not state, so this effect runs
  // exactly once and its teardown sees the latest values without re-running
  // per keystroke (which would write stale text on every cleanup).
  const draftFlushRef = useRef(null)
  useEffect(() => {
    draftFlushRef.current = draftReady
      ? { scope: draftScope, draft: { text, mode: isNote ? 'note' : 'reply' } }
      : null
  })
  useEffect(() => () => {
    const f = draftFlushRef.current
    if (f) writeReplyDraft(f.scope, f.draft).catch(() => {})
  }, [])

  // EMAIL-ATTACH-RACE.1 — the thread re-reads itself while it is open.
  // Cadence comes from the thread itself (threadRefreshMs): fast while its
  // newest message is young enough that rows may still be arriving, 60s
  // otherwise. Torn down with the screen, so a backgrounded thread costs
  // nothing.
  const threadPollMs = threadRefreshMs(messages)
  useEffect(() => {
    if (!conversationId) return undefined
    const timer = setInterval(() => { refresh({ quiet: true }) }, threadPollMs)
    return () => clearInterval(timer)
  }, [conversationId, threadPollMs, refresh])

  useEffect(() => {
    if (messages.length && scrollRef.current) {
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 50)
    }
  }, [messages.length])

  const canReply = !!conversation?.requester_email
  // EMAIL-PARTICIPANTS.9 — the audience sentence and whether a reply is even
  // possible. `audience.disabled` covers "no requester", "everyone removed"
  // and over_cap; composerSendState folds it into the one send gate.
  const audience = conversationReplyAudienceMeta(conversation, replyRecipients)
  // EMAIL-PARTICIPANTS.12 — one derivation for every string that names the
  // audience (lib/mail-conversations.js), so this screen cannot say three things
  // about who a reply reaches.
  const threadLines = conversationThreadAudienceLines(conversation, replyRecipients)
  const replyPlaceholder = conversationReplyPlaceholder(conversation, replyRecipients)

  // MAIL-READER.1 decision 3, reply half only — whether the ⓘ tap has been
  // used to expand the compacted "To X & N others" sentence to the full one.
  // Reset is unnecessary: a disabled audience always shows full regardless
  // (audienceSummary's own rule), and note mode reads neither this state nor
  // audienceSummaryValue at all.
  const [audienceOpen, setAudienceOpen] = useState(false)
  const audienceSummaryValue = audienceSummary(conversation, replyRecipients)

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
  // helpers; a reply's file authorises against THIS conversation (the sign route's
  // exactly-one-of rule — conversationId, never mailboxId, for replies).
  async function uploadOne(entry) {
    try {
      const sign = await signOutboundAttachment({
        filename: entry.filename,
        size: entry.size,
        mime: entry.mime,
        conversationId: conversationId,
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
    const res = await replyToConversation(conversationId, body, {
      internal: isNote,
      locationId: activeLocation?.id,
      // Ready refs only (lib rule: STATUS gates, not the ref's presence) —
      // and replyToConversation itself refuses to put attachments on a note.
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
    // Back to the pill. This is the ONE place that may collapse the composer,
    // and only because the draft is provably gone: setText('') above emptied
    // it and clearReplyDraft removed the stored copy. Everywhere else a
    // collapse would risk hiding words somebody typed, which is why nothing
    // else in this screen sets this false. An expanded, empty composer after
    // a send is 40% of the screen spent on nothing.
    setComposerOpen(false)
    refresh()
  }

  // RETIRE-TICKETS.1 — assignment and the four-state lifecycle left with the
  // conversation queue. The two verbs of this surface, now riding the header:

  // Archive / bring back. The response's conversation row is stamped (MAIL-
  // ARCH.2) but not enriched — no mailbox, no contact — so merge, never replace
  // (the EMAIL-MOPUP.4 lesson: the enriched fields must survive).
  //
  // MAIL-ARCH.3 — `next` reads the server's `archived` stamp, not `status`.
  // Re-deriving from status read a legacy `solved` thread as archived while
  // the server calls it LIVE, so the header said "Bring back" and this tap
  // wrote status='open' over a conversation that was never closed — the
  // thread-screen twin of the swipe-reopen bug #1618 killed on the list.
  async function toggleArchive() {
    if (savingAction) return
    const next = !isArchived(conversation)
    setSavingAction(true)
    const res = await archiveConversation(conversationId, next, activeLocation?.id)
    setSavingAction(false)
    if (!res.success) {
      Alert.alert(next ? 'Couldn’t archive' : 'Couldn’t bring it back', res.error || 'Unknown error')
      return
    }
    if (res.data?.conversation) {
      setConversation(prev => (prev ? { ...prev, ...res.data.conversation } : prev))
    } else {
      refresh({ quiet: true })
    }
    // The mailbox half (moving the real message in a connected account) can
    // refuse independently; the DB half above stands either way.
    // Audit F1 — the route answers `writeback_notice` (a string), and this
    // read had said `writeback.notice` since the conversation era: the "the mailbox
    // move failed" valve could never fire, anywhere, while nothing ever
    // reconciles archive state after the fact.
    if (res.data?.writeback_notice) {
      Alert.alert('Archived here', res.data.writeback_notice)
    }
  }

  // Mark as spam / release (MAIL-SPAM.1) — the phone's first sight of the
  // quarantine.
  async function toggleSpam() {
    if (savingAction) return
    // 🔴 The failure sentence comes from the lib, finished. Deriving it here as
    // `Couldn't ${label.toLowerCase()}` reads "Couldn't not spam" in the release
    // direction — a double negative shipped to an operator. toggleArchive above
    // branches on direction for the same reason.
    const { next, failure } = spamActionLabel(conversation)
    setSavingAction(true)
    const res = await setConversationSpam(conversationId, next, activeLocation?.id)
    setSavingAction(false)
    if (!res.success) {
      Alert.alert(failure, res.error || 'Unknown error')
      return
    }
    // 🔴 The flag is ORTHOGONAL to the lifecycle — the route touches only the
    // spam columns. Take the row the route returns and infer nothing else from
    // it; in particular, never derive a status change from a quarantine.
    if (res.data?.conversation) {
      setConversation(prev => (prev ? { ...prev, ...res.data.conversation } : prev))
    } else {
      refresh({ quiet: true })
    }
  }

  // Mark as unread — the mail-app gesture for "deal with this later". The
  // screen's own open-marking already ran, so this flips it back and the row
  // regains its weight when the list refreshes on focus.
  async function markUnread() {
    if (savingAction) return
    setSavingAction(true)
    const res = await setConversationSeen(conversationId, false, activeLocation?.id)
    setSavingAction(false)
    if (!res.success) {
      Alert.alert('Couldn’t mark as unread', res.error || 'Unknown error')
      return
    }
    // Un-arm the open-marking so the poll's refresh doesn't silently re-read
    // it while the operator is still looking at the screen.
    readMarked.current = true
  }

  // ── §03 — merging the requester's other conversations into this one ──

  // Sequential, stop on the first failure, surface it — a failed merge must
  // never look merged (runMerges, lib/mail-relate.js). Whatever DID merge is
  // real either way: refresh the thread and the related answer for both
  // outcomes (the list screen re-reads itself on focus, so it catches up the
  // moment the operator goes back).
  async function confirmMerge() {
    const rows = mergePickerRows(related?.related)
    const ids = rows.map(r => r.id).filter(id => mergeSelected.has(id))
    if (merging || ids.length === 0) return
    setMerging(true)
    const out = await runMerges(ids, (id) => mergeConversation(id, conversationId, activeLocation?.id))
    setMerging(false)
    if (out.merged.length > 0) {
      setMergeSelected(new Set())
      refresh({ quiet: true })
      loadRelated()
    }
    if (out.failed) {
      // The sheet stays open: the operator can see what is left and retry.
      Alert.alert(
        'Couldn’t merge',
        `${out.failed.error}${out.merged.length > 0
          ? ` ${out.merged.length} of ${ids.length} had already merged before the failure.`
          : ''}`,
      )
      return
    }
    setMergeOpen(false)
    // Undo rides the success notice ONLY — no persistent un-merge UI.
    const notice = mergeUndoNotice(out.merged.length)
    Alert.alert(notice.title, notice.message, [
      { text: 'Undo', onPress: () => undoMerge(out.merged) },
      { text: 'OK', style: 'cancel' },
    ])
  }

  // Undo attempts EVERY un-merge rather than stopping at the first failure
  // (the attempt-all-then-judge rule): stopping early would strand the rest
  // merged with the notice gone and no other door back.
  async function undoMerge(ids) {
    const failures = []
    for (const id of ids) {
      const res = await unmergeConversation(id, activeLocation?.id)
      if (!res?.success) failures.push(res?.error || 'That conversation could not be un-merged.')
    }
    refresh({ quiet: true })
    loadRelated()
    if (failures.length > 0) {
      Alert.alert(
        'Couldn’t undo',
        failures.length === ids.length
          ? failures[0]
          : `${failures.length} of ${ids.length} could not be un-merged: ${failures[0]}`,
      )
    }
  }

  // MOBILE-MAIL-FORWARD.1 — push the forward sheet for one message. Both
  // affordances land here: the header ⋮ (with the newest forwardable message)
  // and the per-message icon (with its own).
  function pushForward(messageId) {
    router.push({ pathname: '/email/forward', params: { conversationId: conversationId, messageId } })
  }

  // The ⋮ overflow — Forward, acting on the NEWEST forwardable message (lib
  // rule: trailing internal notes are skipped; "forward" from the menu means
  // the correspondence on top, not the staff commentary about it), and now
  // Mark as spam / Not spam (MAIL-SPAM.1 — the phone's first sight of the
  // quarantine). Forward drops out of the menu with nothing to forward; spam
  // never does; the flag is orthogonal to what is or isn't forwardable.
  //
  // Both rows are already gated by the trigger Pressable's own
  // `disabled={savingAction || !conversation || tombstone}` — openOverflow
  // cannot run at all while any of those hold, so neither row needs a second
  // disablement here.
  //
  // React Native's Alert has no icon slot for its buttons — only `text` and
  // `style` reach the OS action sheet — so spamActionLabel's `.icon` has no
  // home on this menu; only `.label` renders, the same plain text the
  // Forward row already uses.
  function openOverflow() {
    const target = newestForwardableMessage(messages)
    const spam = spamActionLabel(conversation)
    const buttons = []
    if (target) buttons.push({ text: 'Forward…', onPress: () => pushForward(target.id) })
    buttons.push({ text: spam.label, onPress: toggleSpam })
    buttons.push({ text: 'Cancel', style: 'cancel' })
    Alert.alert('More actions', null, buttons)
  }

  // 'Email' rather than the display helper's "Unknown sender" fallback while
  // the thread is still loading — a header that briefly accuses us of not
  // knowing who wrote in reads as a bug.
  const name = conversation ? emailDisplayName(conversation) : 'Email'
  const chip = mailStatusChip(conversation)
  const archived = isArchived(conversation)

  // The folded/unfolded plan (MAIL-REFINE.1 §02, flatThreadPlan in
  // lib/mail-conversations.js): ONLY the newest opens by default; taps override
  // per message, both directions.
  const plan = flatThreadPlan(messages, foldOverrides)
  const mergedDividers = mergedInDividers(messages, mergedSources)
  // Audit A1 — merged-away = read-only everywhere, not just banner'd.
  const tombstone = !!conversation?.merged_into_id
  function setFolded(id, expanded) {
    // Growing content would yank the viewport to the composer (audit F6) —
    // and so would shrinking it back. One-shot suppression either way.
    suppressAutoScrollRef.current = true
    setFoldOverrides(prev => {
      const next = new Map(prev)
      next.set(id, expanded)
      return next
    })
  }

  // §03 — the nudge banner's verdict. Null hides the banner: nothing open,
  // an unknown count, or no related answer at all (never a confident zero).
  // A tombstone thread gets no nudge — it is a pointer, not a workspace.
  const nudge = related ? relatedNudge({ related: related.related, open_count: related.openCount }) : null
  const mergeRows = mergePickerRows(related?.related)
  const mergeButton = mergeButtonLabel(mergeSelected.size)
  // Audit S-2 — the caption must key on the SAME set the send gate blocks
  // on (failed OR oversize), or a future oversize chip greys Send silently.
  const failedFiles = files.some(f => f.status === 'failed' || f.status === 'oversize')

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      className="flex-1 bg-un1t-bg"
    >
      {/* 🔴 THE COMPOSER'S CAP IS MEASURED HERE, NOT ON THE
          KeyboardAvoidingView ITSELF. It was, and on iOS that silently never
          updated: behavior="padding" reacts to the keyboard by adding
          paddingBottom to its own style, and padding changes the INTERIOR
          content box, not the outer frame Yoga reports to onLayout — so the
          callback never refired and availableHeight stayed at the pre-keyboard
          screen height. composerCap then took 40% of a screen that was no
          longer there, exactly while somebody was typing, which is the one
          state this cap exists for. (Android takes behavior="height", which
          does shrink the style height and does refire — so it was iOS-only,
          the harder kind to notice.)

          An absolutely-filled child is positioned against the parent's PADDING
          box, so its own frame shrinks as that padding grows and its onLayout
          fires each time. pointerEvents="none" so it can never take a touch,
          and it draws nothing — it exists only to be measured. */}
      <View
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        onLayout={e => setAvailableHeight(e.nativeEvent.layout.height)}
      />
      <Stack.Screen
        options={{
          title: name,
          // INBOX-SPLIT.M1 — back goes to the Mail tab, not Messages: email
          // is its own surface (and a cold-start deep link from a push must
          // not land someone in the chat inbox).
          headerLeft: () => <BackHeaderLeft label="Mail" fallbackHref="/(tabs)/email" />,
          // THE VERBS RIDE THE HEADER (mockup §04 note 1): mark-unread,
          // archive, and the ⋮ overflow whose one action is Forward.
          headerRight: () => (
            <View className="flex-row items-center">
              <Pressable
                onPress={markUnread}
                disabled={savingAction || !conversation || tombstone}
                hitSlop={6}
                accessibilityLabel="Mark as unread"
                className={`px-2 py-1 ${savingAction ? 'opacity-50' : ''}`}
              >
                <Ionicons name="mail-unread-outline" size={19} color="#111827" />
              </Pressable>
              <Pressable
                onPress={toggleArchive}
                disabled={savingAction || !conversation || tombstone}
                hitSlop={6}
                accessibilityLabel={archived ? 'Bring back to inbox' : 'Archive'}
                className={`px-2 py-1 ${savingAction ? 'opacity-50' : ''}`}
              >
                <Ionicons name={archived ? 'arrow-undo-outline' : 'archive-outline'} size={19} color="#111827" />
              </Pressable>
              <Pressable
                onPress={openOverflow}
                disabled={savingAction || !conversation || tombstone}
                hitSlop={6}
                accessibilityLabel="More actions"
                className={`pl-2 py-1 ${savingAction ? 'opacity-50' : ''}`}
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
          {/* ONE band (MAIL-READER.M1, option A). Subject, then one meta row,
              then Details on demand. It was four bands — subject, chips, the
              audience line and the opener — which with the nudge banner below
              spent 21% of an 844pt screen before a word of email. */}
          <View className="border-b border-un1t-border bg-un1t-surface px-4 pt-2.5 pb-2.5">
            {conversation?.subject ? (
              <Text className="text-[16px] font-extrabold text-un1t-text leading-snug" numberOfLines={2}>
                {conversation.subject}
              </Text>
            ) : (
              <Text className="text-[16px] font-extrabold text-un1t-subtle leading-snug">
                (no subject)
              </Text>
            )}
            <View className="flex-row items-center flex-wrap mt-1.5">
              {chip ? (
                <View className={`px-1.5 py-0.5 rounded mr-1.5 ${chip.cls}`}>
                  <Text className={`text-[10px] font-semibold ${chip.text}`}>{chip.label}</Text>
                </View>
              ) : null}
              {/* 🔴 The no-mailbox case is said in WORDS, never shortened to a
                  chip: mailbox_id is ON DELETE SET NULL, so a deleted address
                  orphans its correspondence rather than hiding it. */}
              <View className="px-1.5 py-0.5 rounded bg-slate-500/10 mr-1.5">
                <Text className="text-[10px] font-semibold text-slate-700" numberOfLines={1}>
                  {accountChipLabel(conversation?.mailbox)}
                </Text>
              </View>
              {/* The nudge, as a chip rather than a full-width banner. Its two
                  actions live in the sheet it opens. */}
              {nudge && !conversation?.merged_into_id ? (
                <Pressable
                  onPress={() => setNudgeSheetOpen(true)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={nudge.text}
                  className="flex-row items-center px-1.5 py-0.5 rounded bg-blue-500/10 mr-1.5"
                >
                  <Ionicons name="link-outline" size={10} color="#1D4ED8" style={{ marginRight: 3 }} />
                  <Text className="text-[10px] font-semibold text-blue-700">{nudge.chip}</Text>
                </Pressable>
              ) : null}
              <View className="flex-1" />
              <Pressable
                onPress={() => setDetailsOpen(v => !v)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityState={{ expanded: detailsOpen }}
                accessibilityLabel={detailsOpen ? 'Hide conversation details' : 'Show conversation details'}
                className="flex-row items-center"
              >
                <Text className="text-[11px] text-un1t-subtle mr-1">Details</Text>
                <Ionicons name={detailsOpen ? 'chevron-up' : 'chevron-down'} size={12} color="#64748B" />
              </Pressable>
            </View>
            {detailsOpen ? (
              <View className="mt-2 pt-2 border-t border-un1t-border">
                {headerDetailLines(conversation, threadLines).map(line => (
                  <Text key={line.key} className="text-[11px] text-un1t-subtle mb-0.5">
                    {line.label ? <Text className="text-un1t-muted">{line.label}: </Text> : null}
                    {line.value}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>

          {/* §03 — a MERGED-AWAY thread is a tombstone: its messages live on
              the target now. Keep it reachable — one pointer, no rebuild. */}
          {conversation?.merged_into_id ? (
            <Pressable
              onPress={() => router.push(`/email/${conversation.merged_into_id}`)}
              accessibilityRole="button"
              accessibilityLabel="Open the conversation this one was merged into"
              className="flex-row items-center border-b border-un1t-border bg-un1t-surface px-4 py-2.5 active:opacity-70"
            >
              <Ionicons name="link-outline" size={14} color="#64748B" style={{ marginRight: 6 }} />
              <Text className="text-[12px] text-un1t-subtle flex-1">
                This conversation was merged into another — its messages live there now.
              </Text>
              <Text className="text-[12px] font-bold text-un1t-text ml-2">Open</Text>
            </Pressable>
          ) : null}

          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentContainerClassName="pb-3"
            onContentSizeChange={() => {
              if (suppressAutoScrollRef.current) {
                suppressAutoScrollRef.current = false
                return
              }
              scrollRef.current?.scrollToEnd?.({ animated: false })
            }}
          >
            {attachmentsUnavailable && (
              <View className="mx-4 mt-3 mb-1 rounded-xl border border-amber-500/60 bg-amber-500/10 px-3.5 py-2.5">
                <Text className="text-[11px] text-amber-700">
                  Attachments could not be loaded for this conversation. Messages sent with files may
                  look as though they had none.
                </Text>
              </View>
            )}
            {plan.length === 0 ? (
              <Text className="text-xs text-un1t-subtle text-center py-6">
                No messages in this conversation yet.
              </Text>
            ) : (
              plan.map(({ message: m, collapsed }) => (
                <React.Fragment key={m.id}>
                {mergedDividers.has(m.id) ? (
                  <View className="flex-row items-center border-b border-un1t-border bg-un1t-surface px-4 py-2">
                    <Ionicons name="git-merge-outline" size={12} color="#64748B" style={{ marginRight: 6 }} />
                    <Text className="text-[11px] text-un1t-subtle flex-1" numberOfLines={1}>
                      {mergedDividers.get(m.id).subject
                        ? <>Merged in: <Text className="font-semibold text-un1t-text">“{mergedDividers.get(m.id).subject}”</Text></>
                        : 'Merged in from another conversation'}
                      {' · '}
                      {mergedDividers.get(m.id).count} message{mergedDividers.get(m.id).count === 1 ? '' : 's'}
                    </Text>
                  </View>
                ) : null}
                {collapsed ? (
                  <FlatCollapsedRow
                    msg={m}
                    fallbackName={conversation?.requester_name || ''}
                    onExpand={() => setFolded(m.id, true)}
                  />
                ) : (
                  <FlatMessage
                    msg={m}
                    conversationId={conversationId}
                    locationId={activeLocation?.id}
                    fallbackName={conversation?.requester_name || ''}
                    onViewImage={setViewingImage}
                    onCollapse={() => setFolded(m.id, false)}
                    // The precise affordance — expanded non-note messages
                    // only. A note gets nothing: canForwardMessage is the
                    // rule, stated once in the lib.
                    onForward={canForwardMessage(m) ? () => pushForward(m.id) : null}
                  />
                )}
                </React.Fragment>
              ))
            )}
          </ScrollView>

          {/* Composer (mockup §04 "Reply, expanded"). The mode is stated
              three times over: the selected segment, the colour of the card,
              and the sentence naming exactly who receives what.
              Audit A1 — a MERGED-AWAY thread is read-only: its messages live
              on the target now, so offering a composer here invites typing a
              reply the server will 409 (conversationMergedAway). The pointer banner
              above is the way forward.
              MAIL-READER.M1 — collapsed to a pill until tapped (below), and
              bounded at composerCap(availableHeight) when expanded: it and the
              signature box (now gone, decision 2) were 43% of an 844pt screen. */}
          {tombstone ? null : composerOpen ? (
          <View
            className="border-t border-un1t-border bg-un1t-bg px-3 pt-2.5"
            style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          >
            {/* Everything below scrolls INSIDE the cap. Before this task only
                the TextInput was bounded (max-h-32) — the segmented toggle,
                the attachment chips, the budget line and the gate sentences
                were not, so a three-file reply could push Send off the
                screen entirely.
                🔴 THE CAP GOES ON THE SCROLLVIEW ITSELF, not its wrapping
                View: a maxHeight on a plain View bounds its OWN layout box
                but (Views default to overflow: visible) does not force an
                unconstrained child to size within it, so a ScrollView with
                no height of its own just grows to fit its content and never
                starts scrolling — this exact file's merge-picker sheet below
                (`<ScrollView style={{ maxHeight: 320 }}>`) is the working
                precedent this follows. */}
            <ScrollView
              style={{ maxHeight: composerCap(availableHeight) }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
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
              {/* 🔴 NOTE MODE KEEPS ITS SENTENCE, IN FULL, ALWAYS. The composer
                  states its mode three ways — the selected segment, the colour
                  of the card, and the sentence naming exactly who receives
                  what — and this is the third. Only the REPLY half compacts
                  (MAIL-READER.1 decision 3); on the phone there is no tooltip
                  to move it to, so it goes behind an ⓘ that expands in place.
                  A DISABLED reply audience does not compact either: a refusal
                  the operator has to read must not hide behind a tap. */}
              <View className="flex-row items-center mb-1">
                {isNote ? (
                  <Text className="text-[11px] text-amber-700 flex-1" numberOfLines={2}>
                    Staff only — written to the conversation and NOT sent to{' '}
                    {conversation?.requester_email || 'the member'}.
                  </Text>
                ) : (
                  <Pressable
                    onPress={() => setAudienceOpen(v => !v)}
                    disabled={audienceSummaryValue.disabled}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={audienceSummaryValue.full}
                    className="flex-1 flex-row items-center"
                  >
                    <Text className="text-[11px] text-un1t-subtle flex-1" numberOfLines={2}>
                      {audienceOpen || audienceSummaryValue.disabled
                        ? audienceSummaryValue.full
                        : audienceSummaryValue.short}
                    </Text>
                    {!audienceSummaryValue.disabled ? (
                      <Ionicons
                        name="information-circle-outline"
                        size={13}
                        color="#94A3B8"
                        style={{ marginLeft: 4 }}
                      />
                    ) : null}
                  </Pressable>
                )}
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
                          name={f.status === 'failed' ? 'alert-circle-outline' : conversationAttachmentIcon(f.mime, f.filename)}
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
            {/* Round-2 polish: a failed chip now BLOCKS the send (the
                composerSendState 'blocked_files' reason — a deliberate
                divergence from web's red-caption-only posture, documented in
                lib/mail-drafts.js), so this sentence names the block and the
                way out rather than promising a silent exclusion. */}
            {failedFiles && !isNote && (
              <Text className="text-[11px] text-red-700 mt-1.5">
                A file did not upload, so this reply can’t be sent yet. Remove the failed file,
                then attach it again.
              </Text>
            )}
            {!isNote && archived && (
              <Text className="text-[11px] text-un1t-subtle mt-1.5">
                This conversation is archived — replying brings it back to the inbox.
              </Text>
            )}
            </ScrollView>
          </View>
          ) : (
          // COLLAPSED MEANS EMPTY, and that is an invariant rather than a
          // coincidence: the composer opens whenever a stored draft hydrates
          // with text, and the only thing that ever closes it is a successful
          // send, which has already emptied the text and cleared the stored
          // copy. So the pill has no draft-preview state — that would be
          // unreachable code standing in for a situation this screen refuses
          // to create. Add a way to collapse a DIRTY composer and this pill
          // needs one; nothing else does.
          <Pressable
            onPress={() => setComposerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={replyPlaceholder}
            className="flex-row items-center border-t border-un1t-border bg-un1t-bg px-4 py-2.5"
            style={{ paddingBottom: Math.max(insets.bottom, 10) }}
          >
            <View className="flex-1 flex-row items-center rounded-full border-[1.5px] border-un1t-border px-3.5 py-2">
              <Text className="flex-1 text-[14px] text-un1t-muted" numberOfLines={1}>
                {replyPlaceholder}
              </Text>
            </View>
            {/* The lock is a second entry point straight to note mode, so
                switching modes never requires opening the composer first
                only to then tap the segmented toggle. */}
            <Pressable
              onPress={() => { setIsNote(true); setComposerOpen(true) }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Add an internal note"
              className="ml-3"
            >
              <Ionicons name="lock-closed-outline" size={18} color="#64748B" />
            </Pressable>
          </Pressable>
          )}
        </>
      )}
      {/* §03 B — the merge picker, a bottom sheet. ALL related conversations
          list here (open + archived), checkboxes; the confirm names its count
          and stays disabled at zero (mergeButtonLabel). While a run is in
          flight the sheet locks — a half-finished merge must not be
          re-submitted or dismissed into ambiguity. */}
      <Modal
        visible={mergeOpen}
        transparent
        animationType="slide"
        onRequestClose={() => { if (!merging) setMergeOpen(false) }}
      >
        <View className="flex-1 justify-end bg-black/40">
          <Pressable
            className="flex-1"
            accessibilityLabel="Close merge picker"
            onPress={() => { if (!merging) setMergeOpen(false) }}
          />
          <View
            className="bg-un1t-bg rounded-t-2xl px-4 pt-4"
            style={{ paddingBottom: Math.max(insets.bottom, 16) }}
          >
            <Text className="text-[15px] font-bold text-un1t-text">Merge conversations</Text>
            <Text className="text-[12px] text-un1t-subtle mt-1 mb-2">
              Their messages move into “{conversation?.subject || 'this conversation'}”. Each merged
              conversation keeps a pointer here — nothing is deleted.
            </Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {mergeRows.map(row => (
                <Pressable
                  key={row.id}
                  onPress={() => { if (!merging) setMergeSelected(prev => toggleId(prev, row.id)) }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: mergeSelected.has(row.id) }}
                  accessibilityLabel={`Merge ${row.subject}`}
                  className="flex-row items-center border-b border-un1t-border py-2.5"
                >
                  <Ionicons
                    name={mergeSelected.has(row.id) ? 'checkbox' : 'square-outline'}
                    size={20}
                    color={mergeSelected.has(row.id) ? '#0F172A' : '#94A3B8'}
                    style={{ marginRight: 10 }}
                  />
                  <View className="flex-1">
                    <Text className="text-[13px] font-semibold text-un1t-text" numberOfLines={1}>
                      {row.subject}
                    </Text>
                    <Text className="text-[11px] text-un1t-subtle mt-0.5" numberOfLines={1}>
                      {row.detail}
                    </Text>
                  </View>
                </Pressable>
              ))}
              {mergeRows.length === 0 ? (
                <Text className="text-xs text-un1t-subtle text-center py-5">
                  Nothing related to merge.
                </Text>
              ) : null}
            </ScrollView>
            <View className="flex-row items-center justify-end mt-3">
              <Pressable
                onPress={() => { if (!merging) setMergeOpen(false) }}
                disabled={merging}
                accessibilityLabel="Cancel merge"
                className={`px-4 py-2 rounded-xl border border-un1t-border mr-2 ${merging ? 'opacity-50' : ''}`}
              >
                <Text className="text-[13px] font-semibold text-un1t-text">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmMerge}
                disabled={mergeButton.disabled || merging}
                accessibilityLabel={mergeButton.label}
                className={`px-4 py-2 rounded-xl ${
                  mergeButton.disabled || merging ? 'bg-un1t-border' : 'bg-un1t-text'
                }`}
              >
                {merging ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text className="text-[13px] font-bold text-white">{mergeButton.label}</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* The nudge chip's two actions — the banner's View and Merge, now that
          the banner is a chip. 🔴 The chip only exists when relatedNudge said
          so: an unknown count renders NOTHING, never 0, and a failed related
          read is null rather than []. */}
      <Modal
        visible={nudgeSheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setNudgeSheetOpen(false)}
      >
        <View className="flex-1 justify-end bg-black/40">
          <Pressable
            className="flex-1"
            accessibilityLabel="Close related conversations"
            onPress={() => setNudgeSheetOpen(false)}
          />
          <View
            className="bg-un1t-bg rounded-t-2xl px-4 pt-4"
            style={{ paddingBottom: Math.max(insets.bottom, 16) }}
          >
            <Text className="text-[13px] text-un1t-subtle mb-3">{nudge?.text}</Text>
            {nudge?.viewId ? (
              <Pressable
                onPress={() => { setNudgeSheetOpen(false); router.push(`/email/${nudge.viewId}`) }}
                accessibilityRole="button"
                className="flex-row items-center border-t border-un1t-border py-3"
              >
                <Ionicons name="open-outline" size={16} color="#111827" style={{ marginRight: 10 }} />
                <Text className="text-[14px] text-un1t-text">Open the newest related conversation</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => { setNudgeSheetOpen(false); setMergeOpen(true) }}
              accessibilityRole="button"
              className="flex-row items-center border-t border-un1t-border py-3"
            >
              <Ionicons name="git-merge-outline" size={16} color="#111827" style={{ marginRight: 10 }} />
              <Text className="text-[14px] text-un1t-text">Merge related conversations…</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <ImageViewer image={viewingImage} onClose={() => setViewingImage(null)} />
    </KeyboardAvoidingView>
  )
}
