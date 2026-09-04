// MOBILE-MAIL-FORWARD.1 — passing one message on the ticket to somebody else
// (approved item 7's last piece; pushed as /email/forward?ticketId=…&messageId=…).
//
// THE THIRD SEND SURFACE, and the one whose recipients are furthest from the
// member: Reply writes to people the member put on the thread; New email
// writes to somebody a staff member chose; Forward takes what the member sent
// US and gives it to a third party. So the screen makes the operator look at
// three things before Send: WHO gets it (To pills — nothing locked, nothing
// derived; choosing a new audience IS the act), WHAT they can read (the
// quoted preview card — a forward is the one send where the operator may not
// have read what they are passing on), and WHICH files go (checkboxes with a
// running total; pre-ticked when the whole stored set fits, pre-ticked to
// NOTHING when it does not — a greedy subset would be a silent drop).
//
// THERE IS NO MOCKUP FOR THIS SCREEN — it wears the compose sheet's chrome
// (§05): custom header Cancel / title / ink-square Send, grouped field rows,
// the same pill + suggestion machinery. Deliberately, so the two send sheets
// read as one surface.
//
// THIN BY CONTRACT. Every branchable decision lives in lib/mail-forward.js
// (which message may go, which files may ride, the pre-tick, the send gate)
// and lib/mail-compose.js (pills, suggestions, failure mapping) — tested and
// mutation-tested there; this file renders those decisions and owns nothing
// but React state and the wire calls.
//
// SKIPPED FILES ARE LISTED, NOT HIDDEN: a file with no stored bytes (over
// quota on arrival, or pruned) shows disabled with its reason — hiding it
// would have staff telling a member "you never sent that". The server refuses
// its id anyway; the disabled row is why that refusal is never seen.
//
// The forward is PLAIN TEXT and the recipient is told so (the server's
// "forwarding is plain text" decision — a stranger's markup never leaves on
// our DKIM signature). The preview shows text_body, which is exactly what
// goes out: the preview and the mail are the same thing.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { getTicket, forwardMessage, fetchSignatureContexts } from '../../../lib/email-api'
import { searchContacts, contactDisplayName } from '../../../lib/contacts-api'
import {
  addRecipients, addContactPill, removePill, popPill, pillInitials, contactTag,
  filterContactSuggestions, shouldSearchContacts, sendFailureMessage, composeIsDirty,
} from '../../../lib/mail-compose'
import {
  canForwardMessage, forwardPreviewMeta,
  forwardableAttachments, unforwardableAttachments,
  forwardBudget, defaultForwardSelection, toggleForwardSelection,
  selectedForwardRows, forwardSendState,
} from '../../../lib/mail-forward'
import {
  formatAttachmentSize, ticketAttachmentSkippedLabel, ticketAttachmentIcon,
} from '../../../lib/email-tickets'
import { resolveSignatureHint } from '../../../lib/signature-hint'

// Same cadence as the compose sheet's autocomplete.
const SUGGEST_DEBOUNCE_MS = 250

/** MEMBER/LEAD tag — the compose sheet's recipe, verbatim (chip rule per CLAUDE.md). */
function tagChip(contact) {
  return contactTag(contact) === 'member'
    ? { label: 'MEMBER', cls: 'bg-emerald-500/10', text: 'text-emerald-700' }
    : { label: 'LEAD', cls: 'bg-blue-500/10', text: 'text-blue-700' }
}

export default function ForwardMessage() {
  const { ticketId, messageId } = useLocalSearchParams()
  const { profile, activeLocation } = useAuth()
  const insets = useSafeAreaInsets()
  const locationId = activeLocation?.id

  // Round-1 audit C1 — the same re-check as compose and search. This screen's
  // gate is the ONLY thing keeping the contact directory behind the email
  // permission: searchContacts is gated by location membership, not by the
  // email key, so a stale deep link onto a live form would still autocomplete.
  const canEmail = canMobile(profile, 'email_inbox', activeLocation)

  // The message being forwarded, off the same detail route the thread reads.
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [message, setMessage] = useState(null)

  // To — pills + the text being typed after them (compose's machinery).
  const [pills, setPills] = useState([])
  const [pending, setPending] = useState('')
  const [inputError, setInputError] = useState(null)
  const [suggestions, setSuggestions] = useState([])

  // The covering note. OPTIONAL — "here, look at this" is a legitimate
  // forward; demanding a sentence would get an empty full stop typed instead.
  const [note, setNote] = useState('')

  // Which of the original's stored files ride along (attachment row ids).
  const [selected, setSelected] = useState([])

  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [sent, setSent] = useState(false)
  // Audit C-2 — the detail route degrades a failed attachment lookup to
  // attachments_unavailable rather than a 500, precisely so no screen reads
  // the blip as "this message had no files". Dropping the flag here made the
  // Files section silently vanish — the operator forwards an invoice email
  // and the recipient gets no invoice, with nobody told anything.
  const [attachmentsUnavailable, setAttachmentsUnavailable] = useState(false)
  // MOBILE-SIGHINT.1 — the forward route appends the sender's signature the
  // same way reply and compose do, so this screen owes the same preview. The
  // studio is the TICKET'S, not this phone's active location: `locationId`
  // above is only the request-scoping header, while the route resolves the
  // signature against the conversation's own location.
  const [ticketLocationId, setTicketLocationId] = useState(null)
  const [signatureContexts, setSignatureContexts] = useState([])

  const toInputRef = useRef(null)
  // Suggestion requests can resolve out of order — only the newest may paint.
  const suggestSeq = useRef(0)

  useEffect(() => {
    if (!canEmail) return
    // A push with no ids is a coding error upstream — an honest sentence, not
    // a spinner that never resolves.
    if (!ticketId || !messageId) {
      setLoading(false)
      setLoadError('That message is no longer on this conversation.')
      return
    }
    let alive = true
    getTicket(ticketId, locationId).then(res => {
      if (!alive) return
      setLoading(false)
      if (!res.success) {
        setLoadError(res.error || 'Could not load that message.')
        return
      }
      setAttachmentsUnavailable(res.attachmentsUnavailable === true)
      setTicketLocationId(res.ticket?.location_id || null)
      const m = (res.messages || []).find(x => x?.id === messageId) || null
      setMessage(m)
      // The pre-tick decision is the lib's (everything when everything fits,
      // nothing when it does not) — made ONCE, at load, so a poll can never
      // fight the operator's unticking. This screen never re-reads.
      setSelected(defaultForwardSelection(forwardableAttachments(m?.attachments)))
    })
    return () => { alive = false }
  }, [ticketId, messageId, locationId, canEmail])

  // The viewer's per-studio signature contexts. Fetched per mount and NEVER
  // cached at module level: on a shared front-desk phone a cache outlives the
  // signed-in person, which is exactly why the web one was removed on review.
  useEffect(() => {
    if (!canEmail) return
    let cancelled = false
    fetchSignatureContexts().then(rows => { if (!cancelled) setSignatureContexts(rows) })
    return () => { cancelled = true }
  }, [canEmail])

  const signatureHint = resolveSignatureHint(signatureContexts, ticketLocationId)

  // Contact autocomplete — debounced, stale responses dropped (compose's rule).
  useEffect(() => {
    if (!locationId || !canEmail || !shouldSearchContacts(pending)) {
      setSuggestions([])
      return
    }
    const seq = ++suggestSeq.current
    const timer = setTimeout(() => {
      searchContacts({ locationId, query: pending.trim(), limit: 10 }).then(res => {
        if (suggestSeq.current !== seq) return
        setSuggestions(res.success ? res.data : [])
      })
    }, SUGGEST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [pending, locationId, canEmail])

  const visibleSuggestions = filterContactSuggestions(suggestions, { pills })

  // ── Recipient input — commit on comma/semicolon/blur/submit, NEVER on
  // space (round-1 audit F3: space killed two-word contact-name searches). ──
  const commitPending = useCallback((value) => {
    const { pills: next, invalid } = addRecipients(pills, value)
    setPills(next)
    setPending('')
    setInputError(invalid.length ? `Not a valid email address: ${invalid.join(', ')}` : null)
    return invalid.length === 0
  }, [pills])

  function onPendingChange(value) {
    setInputError(null)
    if (/[,;]$/.test(value)) {
      commitPending(value)
      return
    }
    setPending(value)
  }

  function onPendingKeyPress({ nativeEvent }) {
    if (nativeEvent.key === 'Backspace' && pending === '') {
      const { pills: next, removed } = popPill(pills)
      if (removed) {
        setPills(next)
        setPending(removed.address)
      }
    }
  }

  function pickSuggestion(contact) {
    const { pills: next, error: pillError } = addContactPill(pills, contact)
    setPills(next)
    setPending('')
    setSuggestions([])
    setInputError(pillError)
    toInputRef.current?.focus()
  }

  // ── The lib's decisions, read once per render ─────────────────────────
  const files = forwardableAttachments(message?.attachments)
  const skipped = unforwardableAttachments(message?.attachments)
  const chosenRows = selectedForwardRows(files, selected)
  const budget = forwardBudget(chosenRows)
  const state = forwardSendState({ pills, selectedRows: chosenRows })
  const canSend = state.canSend && !sending && !sent
  const meta = message ? forwardPreviewMeta(message) : null

  // ── Send ──────────────────────────────────────────────────────────────
  async function send() {
    // Half-typed text in the To field is committed first — tapping Send with
    // "bob@x.com" still in the input means bob, not nobody (compose's rule).
    let toPills = pills
    if (pending.trim()) {
      const { pills: next, invalid } = addRecipients(pills, pending)
      setPills(next)
      setPending('')
      if (invalid.length) {
        setInputError(`Not a valid email address: ${invalid.join(', ')}`)
        return
      }
      toPills = next
    }
    const check = forwardSendState({ pills: toPills, selectedRows: chosenRows })
    if (!check.canSend || sending || sent) return

    setSending(true)
    setError(null)
    const res = await forwardMessage({
      ticketId,
      messageId,
      to: toPills.map(p => p.address),
      note: note.trim() ? note : undefined,
      attachmentIds: selected,
      locationId,
    })
    setSending(false)
    if (!res?.success) {
      // The route's sentences render verbatim (sendFailureMessage — Zod
      // issues first, else the error).
      setError(sendFailureMessage(res))
      // Audit C-1 — sent-but-unfiled is NOT retryable, structurally: the
      // route sends FIRST, so `data.sent === true` means the third party
      // already has the mail and a second tap would mail them twice. "Do
      // not resend" was only prose while the Send button stayed live; this
      // makes the button obey the sentence. The note stays on screen as
      // the only record of what the recipient got.
      if (res?.data?.sent === true) setSent(true)
      return
    }
    // Toast, then back to the thread — the forward is already filed on it.
    setSent(true)
    setTimeout(() => router.back(), 900)
  }

  function requestClose() {
    if (sending) return
    // Once sent there is nothing left to discard — Cancel just dismisses
    // (the same posture the compose sheet takes after its toast).
    if (!sent && composeIsDirty({ pills, pending, subject: '', text: note, files: [] })) {
      Alert.alert(
        'Discard this forward?',
        'Nothing has been sent.',
        [
          { text: 'Keep writing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => router.back() },
        ],
      )
      return
    }
    router.back()
  }

  // ── Honest states ─────────────────────────────────────────────────────
  // Permission first, then load, then "that message cannot go". Each is a
  // full-screen sentence rather than a half-working form.
  let blocked = null
  if (!canEmail) {
    blocked = 'Mail isn’t enabled for you at this location.'
  } else if (!loading && loadError) {
    blocked = loadError
  } else if (!loading && !message) {
    blocked = 'That message is no longer on this conversation.'
  } else if (!loading && message && !canForwardMessage(message)) {
    // Mirrors the route's own 400 sentence in spirit: the affordances in the
    // thread never offer a note, so reaching this means a stale link.
    blocked = 'An internal note is staff-only and was never sent to anyone, so it can’t be forwarded.'
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-un1t-bg"
    >
      {/* Compose-sheet chrome (§05) — the native header is off. */}
      <Stack.Screen options={{ headerShown: false, presentation: 'modal' }} />

      {/* ── Header: Cancel · Forward · Send ─────────────────────────── */}
      <View
        className="flex-row items-center justify-between px-4 pb-3 border-b border-un1t-border bg-un1t-surface"
        style={{ paddingTop: Math.max(insets.top, 12) }}
      >
        <Pressable onPress={requestClose} disabled={sending} hitSlop={8}>
          <Text className="text-sm font-semibold text-un1t-subtle">Cancel</Text>
        </Pressable>
        <Text className="text-[15px] font-extrabold text-un1t-text">Forward</Text>
        <Pressable
          onPress={send}
          disabled={!canSend || !!blocked || loading}
          accessibilityLabel="Send forward"
          className={`w-[34px] h-[34px] rounded-xl items-center justify-center ${
            canSend && !blocked && !loading ? 'bg-un1t-text' : 'bg-un1t-border'
          }`}
        >
          {sending ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Ionicons name="send" size={14} color={canSend && !blocked ? '#FFFFFF' : '#94A3B8'} />
          )}
        </Pressable>
      </View>

      {loading && !blocked ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : blocked ? (
        <View className="flex-1 items-center justify-center px-8">
          <Ionicons name="mail-outline" size={32} color="#94A3B8" />
          <Text className="text-sm text-un1t-subtle mt-2 text-center">{blocked}</Text>
        </View>
      ) : (
        <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
          {/* ── To: pills + free typing (compose's machinery) ─────────── */}
          <Pressable
            onPress={() => toInputRef.current?.focus()}
            className="flex-row items-start px-4 py-2.5 border-b border-un1t-border bg-un1t-surface"
          >
            <Text className="text-[13px] text-un1t-muted font-semibold w-14 mt-1.5">To</Text>
            <View className="flex-1 flex-row flex-wrap items-center">
              {pills.map(p => (
                <Pressable
                  key={p.address}
                  onPress={() => setPills(prev => removePill(prev, p.address))}
                  accessibilityLabel={`Remove ${p.address}`}
                  className="flex-row items-center bg-un1t-bg border border-un1t-border rounded-full pl-1 pr-2 py-0.5 mr-1.5 my-0.5"
                >
                  <View className="w-5 h-5 rounded-full bg-un1t-text items-center justify-center mr-1.5">
                    <Text className="text-[9px] font-extrabold text-white">
                      {pillInitials(p.name, p.address)}
                    </Text>
                  </View>
                  <Text className="text-xs font-bold text-un1t-text" numberOfLines={1}>
                    {p.name || p.address}
                  </Text>
                </Pressable>
              ))}
              <TextInput
                ref={toInputRef}
                value={pending}
                onChangeText={onPendingChange}
                onKeyPress={onPendingKeyPress}
                onBlur={() => { if (pending.trim()) commitPending(pending) }}
                onSubmitEditing={() => commitPending(pending)}
                placeholder={pills.length ? '' : 'Name, or any email address'}
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                className="flex-1 min-w-[120px] text-[13px] text-un1t-text py-1"
              />
            </View>
          </Pressable>
          {inputError ? (
            <Text className="px-4 py-1.5 text-[11px] text-red-700 bg-red-500/10">{inputError}</Text>
          ) : null}

          {visibleSuggestions.length > 0 ? (
            <View className="border-b border-un1t-border bg-un1t-bg px-4 py-1">
              {visibleSuggestions.map(c => {
                const tag = tagChip(c)
                return (
                  <Pressable
                    key={c.id}
                    onPress={() => pickSuggestion(c)}
                    className="flex-row items-center py-2"
                  >
                    <View className="w-6 h-6 rounded-full bg-un1t-text items-center justify-center mr-2.5">
                      <Text className="text-[10px] font-extrabold text-white">
                        {pillInitials(c.name, c.email)}
                      </Text>
                    </View>
                    <View className="flex-1">
                      <Text className="text-[12.5px] font-bold text-un1t-text" numberOfLines={1}>
                        {contactDisplayName(c)}
                      </Text>
                      <Text className="text-[11px] text-un1t-subtle" numberOfLines={1}>{c.email}</Text>
                    </View>
                    <View className={`px-1.5 py-0.5 rounded ${tag.cls}`}>
                      <Text className={`text-[9px] font-extrabold ${tag.text}`}>{tag.label}</Text>
                    </View>
                  </Pressable>
                )
              })}
            </View>
          ) : null}

          {/* ── The optional covering note ─────────────────────────────── */}
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            placeholder="Add a note (optional) — it goes above the forwarded message…"
            placeholderTextColor="#94A3B8"
            maxLength={10000}
            textAlignVertical="top"
            className="px-4 py-3 text-[14px] text-un1t-text min-h-[88px] bg-un1t-surface border-b border-un1t-border"
          />

          {/* MOBILE-SIGHINT.1 — what the route is about to append. The web
              forward composer shows the same thing (TicketForward.jsx); this
              screen was the last composer on either platform still signing
              invisibly. Placed under the note because that is where the
              signature lands: BELOW the note and below the forwarded block.
              No "Edit signature" link — that editor is the web /account page
              and the phone has no screen for it. */}
          {signatureHint ? (
            <View className="mx-4 mt-2 rounded-lg border border-dashed border-un1t-border bg-un1t-surface px-3 py-2">
              <View className="flex-row items-center">
                <Ionicons name="create-outline" size={11} color="#64748B" style={{ marginRight: 5 }} />
                <Text className="text-[10px] font-bold uppercase tracking-wider text-un1t-muted">
                  Added automatically
                </Text>
              </View>
              {/* No text part (a photo-only rich signature) → no separator:
                  the send appends none either. The lib decides. */}
              {signatureHint.body ? (
                <Text className="mt-1 text-xs text-un1t-subtle">{signatureHint.body}</Text>
              ) : null}
              {signatureHint.suffix ? (
                <Text className="mt-1 text-[10px] text-un1t-muted">{signatureHint.suffix}</Text>
              ) : null}
            </View>
          ) : null}

          {/* ── WHAT they will be able to read — shown as plain text,
              because plain text is exactly what goes out. ──────────────── */}
          <View className="px-4 pt-3 pb-1">
            <Text className="text-[11px] font-extrabold uppercase tracking-wider text-un1t-muted mb-1">
              Forwarded message
            </Text>
            <View className="rounded-xl border border-un1t-border bg-un1t-surface px-3 py-2.5">
              <Text className="text-[11px] text-un1t-subtle" numberOfLines={1}>
                From {meta.from}{meta.when ? ` · ${meta.when}` : ''}
              </Text>
              <Text className="text-[12px] font-bold text-un1t-text mt-0.5" numberOfLines={1}>
                {meta.subject}
              </Text>
              <Text className="text-[12.5px] text-un1t-text mt-1.5">
                {meta.excerpt}{meta.excerptTruncated ? '…' : ''}
              </Text>
              {meta.excerptTruncated ? (
                <Text className="text-[11px] text-un1t-muted mt-1">
                  Shortened here — the recipient gets the full message.
                </Text>
              ) : null}
            </View>
            {message?.html_body || message?.html_document ? (
              <Text className="text-[11px] text-un1t-muted mt-1.5">
                This message was formatted. It is forwarded as plain text — the layout and any
                images are not included.
              </Text>
            ) : null}
          </View>

          {/* Audit C-2 — a failed attachment lookup must never wear "no
              files"'s clothes. Loud, amber, and it says what to do; the
              text-only forward stays possible on purpose. */}
          {attachmentsUnavailable && (
            <View className="mx-4 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <Text className="text-[11px] text-amber-700">
                Couldn’t check this message’s files — any attachments it carried can’t be
                forwarded right now. The text still can; try again later for the files.
              </Text>
            </View>
          )}

          {/* ── WHICH files go — checkboxes + running total; skipped ones
              listed disabled with the reason, never hidden. ────────────── */}
          {(files.length > 0 || skipped.length > 0) && (
            <View className="px-4 pt-2 pb-1">
              <Text className="text-[11px] font-extrabold uppercase tracking-wider text-un1t-muted mb-1">
                Files
              </Text>
              {files.map(file => {
                const ticked = selected.includes(file.id)
                return (
                  <Pressable
                    key={file.id}
                    onPress={() => setSelected(prev => toggleForwardSelection(prev, file.id))}
                    disabled={sending}
                    accessibilityLabel={`${ticked ? 'Untick' : 'Tick'} ${file.filename}`}
                    className="flex-row items-center rounded-lg border border-un1t-border bg-un1t-surface px-2.5 py-2 mt-1"
                  >
                    <Ionicons
                      name={ticked ? 'checkbox' : 'square-outline'}
                      size={17}
                      color={ticked ? '#111827' : '#94A3B8'}
                      style={{ marginRight: 7 }}
                    />
                    <Ionicons
                      name={ticketAttachmentIcon(file.mime_type, file.filename)}
                      size={13}
                      color="#64748B"
                      style={{ marginRight: 5 }}
                    />
                    <Text className="text-xs text-un1t-text flex-1" numberOfLines={1}>
                      {file.filename}
                    </Text>
                    <Text className="text-[11px] text-un1t-subtle ml-2">
                      {formatAttachmentSize(file.size_bytes)}
                    </Text>
                  </Pressable>
                )
              })}
              {skipped.map(file => (
                <View
                  key={file.id}
                  className="flex-row items-center rounded-lg border border-dashed border-amber-500/60 px-2.5 py-2 mt-1"
                >
                  <Ionicons name="alert-circle-outline" size={14} color="#B45309" style={{ marginRight: 6 }} />
                  <View className="flex-1">
                    <Text className="text-xs text-un1t-text" numberOfLines={1}>{file.filename}</Text>
                    <Text className="text-[11px] text-amber-700">
                      {ticketAttachmentSkippedLabel(file.skipped_reason)} — can’t be forwarded
                    </Text>
                  </View>
                </View>
              ))}
              {files.length > 0 ? (
                <Text className={`text-[11px] mt-1.5 ${budget.over ? 'text-red-700' : 'text-un1t-muted'}`}>
                  {formatAttachmentSize(budget.used)} of {formatAttachmentSize(budget.limit)} — the most
                  one email can carry.
                </Text>
              ) : null}
            </View>
          )}

          {/* Said once, plainly, at the point of decision (the web modal's
              sentence): this leaves the conversation the member started. */}
          <Text className="px-4 pt-2 pb-6 text-[11px] text-un1t-muted">
            This sends the message to someone outside the conversation, from the studio’s own
            address. It is recorded on the conversation under your name.
          </Text>
        </ScrollView>
      )}

      {/* ── Inline refusal — everything typed stays exactly as it was ── */}
      {error ? (
        <View className="mx-3 mb-2 rounded-xl bg-red-500/10 px-3.5 py-2.5 flex-row items-start">
          <Ionicons name="alert-circle-outline" size={14} color="#B91C1C" style={{ marginRight: 6, marginTop: 1 }} />
          <Text className="text-xs text-red-700 flex-1">{error}</Text>
        </View>
      ) : null}
      {/* Why Send is grey, in words, once something has been touched. */}
      {!blocked && !loading && !state.canSend && (pills.length || pending.trim() || note.trim()) ? (
        <Text
          className="mx-3 text-[11px] text-un1t-subtle"
          style={{ marginBottom: Math.max(insets.bottom, 10) }}
        >
          {state.reason}
        </Text>
      ) : null}

      {/* ── Sent toast — confirms, then the sheet dismisses itself ───── */}
      {sent ? (
        <View className="absolute left-0 right-0 top-0 bottom-0 items-center justify-center bg-black/20">
          <View className="flex-row items-center bg-un1t-text rounded-2xl px-5 py-3">
            <Ionicons name="checkmark-circle" size={18} color="#FFFFFF" style={{ marginRight: 7 }} />
            <Text className="text-sm font-bold text-white">Forwarded</Text>
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  )
}
