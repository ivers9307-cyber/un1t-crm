// MOBILE-MAIL-COMPOSE.1 — the compose sheet (approved mockup §05). The phone
// has never been able to START an email; this is a full sheet pushed from the
// Mail tab's FAB: From is the studio account picker (default = the location's
// default mailbox), To autocompletes against the CRM's own contacts (tagged
// MEMBER/LEAD) alongside free-typed addresses, and sending files it as a
// conversation like any other — POST /api/email/tickets/compose via
// composeEmail(), which sends FIRST server-side, so a failed send writes
// nothing and the draft stays on this screen.
//
// THIN BY CONTRACT. Every branchable decision — pill state, validation,
// attachment size maths, refusal wording — lives in lib/mail-compose.js,
// where it is tested and mutation-tested; this file renders those decisions
// and owns nothing but React state and the wire calls.
//
// SERVER REFUSALS RENDER INLINE, DRAFT INTACT. The 25-recipient cap and the
// cross-list dedupe are the route's (deliberately not re-implemented — two
// caps drift); a refusal, including the "sent but could not be filed — do not
// resend" 500, renders as the red panel above the dock with every field
// untouched. A failed send must not cost the operator the email.
//
// ATTACHMENTS mirror the web picker's shape (AttachmentPicker.jsx): each file
// uploads the moment it is chosen — the waiting happens while they type, and
// Send can be honestly disabled while anything is still moving — via
// signOutboundAttachment() + uploadSignedAttachment() (lib/email-api.js), so
// the bytes go straight to Storage and never through a Vercel body limit. An
// oversize file is a RED CHIP naming the 7 MiB ceiling, not a failed send
// (mockup §05 note 4). Removing a chip only forgets it here: mobile has no
// discard helper, and the residue is one unmetered draft object under
// outbound/ — quota is charged only when a message row is filed (the web
// picker documents the same accepted race).

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform, Modal,
} from 'react-native'
import { router, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { useAuth } from '../../../lib/auth-context'
import {
  listMail, composeEmail, signOutboundAttachment, uploadSignedAttachment,
} from '../../../lib/email-api'
import { searchContacts, contactDisplayName } from '../../../lib/contacts-api'
import {
  addRecipients, addContactPill, removePill, popPill, pillInitials, contactTag,
  filterContactSuggestions, shouldSearchContacts,
  classifyPickedFiles, attachmentBudget, readyAttachmentRefs,
  composeSendState, sendFailureMessage, defaultMailboxId, mailboxDisplay,
  composeIsDirty,
} from '../../../lib/mail-compose'
import { formatAttachmentSize } from '../../../lib/email-tickets'

// How long a keystroke rests before the directory is asked. Matches the feel
// of the search screen's debounce without importing its state machine — this
// field autocompletes, it does not search mail.
const SUGGEST_DEBOUNCE_MS = 250

/** The MEMBER/LEAD tag on a suggestion row — chip recipe per CLAUDE.md
 * (bg-<c>-500/10 + text-<c>-700, split for RN's non-inheriting Text). */
function tagChip(contact) {
  return contactTag(contact) === 'member'
    ? { label: 'MEMBER', cls: 'bg-emerald-500/10', text: 'text-emerald-700' }
    : { label: 'LEAD', cls: 'bg-blue-500/10', text: 'text-blue-700' }
}

export default function ComposeEmail() {
  const { activeLocation } = useAuth()
  const insets = useSafeAreaInsets()
  const locationId = activeLocation?.id

  // From — the caller's visible mailboxes, off the same list call as the
  // inbox. A caller with none gets the honest refusal below, not a form that
  // 404s on send.
  const [mailboxes, setMailboxes] = useState([])
  const [mailboxId, setMailboxId] = useState(null)
  const [mailboxesLoading, setMailboxesLoading] = useState(true)
  const [mailboxesError, setMailboxesError] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // To — pills + the text being typed after them.
  const [pills, setPills] = useState([])
  const [pending, setPending] = useState('')
  const [inputError, setInputError] = useState(null)
  const [suggestions, setSuggestions] = useState([])

  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')

  // Attachments — entries shaped by classifyPickedFiles; `ref` is filled by
  // the upload flow and is what the compose body carries.
  const [files, setFiles] = useState([])
  const nextFileIndex = useRef(0)

  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [sent, setSent] = useState(false)

  const toInputRef = useRef(null)
  // Suggestion requests can resolve out of order — only the newest may paint.
  const suggestSeq = useRef(0)

  useEffect(() => {
    if (!locationId) return
    let alive = true
    setMailboxesLoading(true)
    listMail(locationId).then(res => {
      if (!alive) return
      setMailboxesLoading(false)
      if (!res.success) {
        setMailboxesError(res.error || 'Could not load your email accounts.')
        return
      }
      setMailboxesError(null)
      const boxes = res.mailboxes || []
      setMailboxes(boxes)
      setMailboxId(prev => defaultMailboxId(boxes, prev))
    })
    return () => { alive = false }
  }, [locationId])

  // Contact autocomplete — debounced, stale responses dropped. Filtering
  // against the current pills happens at render time so a just-added pill
  // vanishes from the list without another round trip.
  useEffect(() => {
    if (!locationId || !shouldSearchContacts(pending)) {
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
  }, [pending, locationId])

  const visibleSuggestions = filterContactSuggestions(suggestions, { pills })

  // ── Recipient input ─────────────────────────────────────────────────
  // Commit turns whatever is typed into pills; invalid tokens are SHOWN, never
  // silently dropped (mail-compose.addRecipients).
  const commitPending = useCallback((value) => {
    const { pills: next, invalid } = addRecipients(pills, value)
    setPills(next)
    setPending('')
    setInputError(invalid.length ? `Not a valid email address: ${invalid.join(', ')}` : null)
    return invalid.length === 0
  }, [pills])

  function onPendingChange(value) {
    setInputError(null)
    // A trailing space or comma is the "make it a pill" gesture.
    if (/[\s,;]$/.test(value)) {
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
        // The popped address drops back into the input for editing.
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

  // ── Attachments ─────────────────────────────────────────────────────
  const patchFile = useCallback((key, patch) => {
    // Always the updater form — uploads finish out of order, and a stale
    // snapshot would drop whichever chip resolved second (the web picker's
    // own rule).
    setFiles(prev => prev.map(f => (f.key === key ? { ...f, ...patch } : f)))
  }, [])

  const uploadEntry = useCallback(async (entry, forMailboxId) => {
    try {
      const signed = await signOutboundAttachment({
        filename: entry.filename,
        size: entry.size,
        mime: entry.mime,
        mailboxId: forMailboxId,
        locationId,
      })
      if (!signed.success) {
        patchFile(entry.key, { status: 'failed', error: signed.error || 'Could not start that upload.' })
        return
      }
      // A's actual shapes (integration fix over the pre-landing assumption):
      // sign → { success, path, token, draft }; upload takes the WHOLE signed
      // result and answers { success, draft } — the draft ref the compose
      // body carries. This screen never reshapes it (see readyAttachmentRefs).
      const up = await uploadSignedAttachment(signed, entry.uri)
      if (!up.success) {
        patchFile(entry.key, { status: 'failed', error: up.error || 'Upload failed — check your connection.' })
        return
      }
      patchFile(entry.key, { status: 'ready', ref: up.draft, error: null })
    } catch {
      patchFile(entry.key, { status: 'failed', error: 'Upload failed — check your connection.' })
    }
  }, [locationId, patchFile])

  const [pickError, setPickError] = useState(null)

  function acceptPicked(assets) {
    const { entries, error: capError, nextIndex } = classifyPickedFiles(
      files, assets, nextFileIndex.current,
    )
    nextFileIndex.current = nextIndex
    setPickError(capError)
    if (!entries.length) return
    setFiles(prev => [...prev, ...entries])
    // Files survive a later change of From — safe, not just convenient: the
    // draft key derives from the SENDER's profile, and the send re-runs the
    // full send-as gate at the mailbox finally chosen (web TicketCompose).
    for (const entry of entries) {
      if (entry.status === 'uploading') uploadEntry(entry, mailboxId)
    }
  }

  async function pickDocuments() {
    try {
      const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
      if (res.canceled || !res.assets?.length) return
      acceptPicked(res.assets)
    } catch {
      setPickError('Could not open the file picker.')
    }
  }

  async function pickPhotos() {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ allowsMultipleSelection: true, quality: 0.8 })
      if (res.canceled || !res.assets?.length) return
      // ImagePicker names its fields differently from DocumentPicker —
      // normalise to the { uri, name, size, mimeType } shape the lib reads.
      acceptPicked(res.assets.map((a, i) => ({
        uri: a.uri,
        name: a.fileName || `photo-${nextFileIndex.current + i}.jpg`,
        size: a.fileSize,
        mimeType: a.mimeType || 'image/jpeg',
      })))
    } catch {
      setPickError('Could not open the photo library.')
    }
  }

  function addFile() {
    Alert.alert('Add a file', null, [
      { text: 'Photo library', onPress: pickPhotos },
      { text: 'Browse files', onPress: pickDocuments },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  function removeFile(entry) {
    setFiles(prev => prev.filter(f => f.key !== entry.key))
    setPickError(null)
  }

  // ── Send ────────────────────────────────────────────────────────────
  const state = composeSendState({ mailboxId, pills, subject, text, files })
  const canSend = state.canSend && !sending && !sent

  async function send() {
    // Half-typed text in the To field is committed first — tapping Send with
    // "bob@x.com" still in the input means bob, not nobody.
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
    const check = composeSendState({ mailboxId, pills: toPills, subject, text, files })
    if (!check.canSend || sending) return

    setSending(true)
    setError(null)
    const attachments = readyAttachmentRefs(files)
    const res = await composeEmail({
      mailboxId,
      to: toPills.map(p => p.address),
      cc: [],
      bcc: [],
      subject: subject.trim(),
      text,
      attachments: attachments.length ? attachments : undefined,
      locationId,
    })
    setSending(false)
    if (!res?.success) {
      // Includes the sent-but-unfiled 500 ("Do not resend…") — the draft is
      // the only remaining record of what the recipient got, so it stays.
      setError(sendFailureMessage(res))
      return
    }
    // Dismiss + toast: the overlay confirms, then the sheet leaves. The new
    // conversation is already in the inbox (the route filed it before
    // answering), so the list behind this sheet shows it on its next refresh.
    setSent(true)
    setTimeout(() => router.back(), 900)
  }

  function requestClose() {
    if (sending) return
    if (composeIsDirty({ pills, pending, subject, text, files })) {
      Alert.alert(
        'Discard this email?',
        'Nothing has been sent, and the draft is not kept.',
        [
          { text: 'Keep writing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => router.back() },
        ],
      )
      return
    }
    router.back()
  }

  const mailbox = mailboxes.find(m => m.id === mailboxId) || null
  const budget = attachmentBudget(files)

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-un1t-bg"
    >
      {/* Custom sheet chrome (mockup §05) — the native header is off. */}
      <Stack.Screen options={{ headerShown: false, presentation: 'modal' }} />

      {/* ── Header: Cancel · New message · Send ─────────────────────── */}
      <View
        className="flex-row items-center justify-between px-4 pb-3 border-b border-un1t-border bg-un1t-surface"
        style={{ paddingTop: Math.max(insets.top, 12) }}
      >
        <Pressable onPress={requestClose} disabled={sending} hitSlop={8}>
          <Text className="text-sm font-semibold text-un1t-subtle">Cancel</Text>
        </Pressable>
        <Text className="text-[15px] font-extrabold text-un1t-text">New message</Text>
        {/* One ink square — disabled-grey until there is something to send. */}
        <Pressable
          onPress={send}
          disabled={!canSend}
          accessibilityLabel="Send"
          className={`w-[34px] h-[34px] rounded-xl items-center justify-center ${
            canSend ? 'bg-un1t-text' : 'bg-un1t-border'
          }`}
        >
          {sending ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Ionicons name="send" size={14} color={canSend ? '#FFFFFF' : '#94A3B8'} />
          )}
        </Pressable>
      </View>

      <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
        {/* ── From ──────────────────────────────────────────────────── */}
        <Pressable
          onPress={() => mailboxes.length > 1 && setPickerOpen(true)}
          className="flex-row items-center px-4 py-3 border-b border-un1t-border bg-un1t-surface"
        >
          <Text className="text-[13px] text-un1t-muted font-semibold w-14">From</Text>
          {mailboxesLoading ? (
            <ActivityIndicator size="small" />
          ) : (
            <>
              <Text className="text-[13px] font-semibold text-un1t-text flex-1" numberOfLines={1}>
                {mailbox ? mailboxDisplay(mailbox) : 'No email account'}
              </Text>
              {mailboxes.length > 1 ? (
                <Ionicons name="chevron-down" size={14} color="#64748B" />
              ) : null}
            </>
          )}
        </Pressable>
        {mailboxesError ? (
          <Text className="px-4 py-2 text-xs text-red-700 bg-red-500/10">{mailboxesError}</Text>
        ) : null}
        {!mailboxesLoading && !mailboxesError && mailboxes.length === 0 ? (
          <Text className="px-4 py-2 text-xs text-un1t-subtle">
            This studio has no email account you can send from — an owner can add one or grant
            you access to an existing one.
          </Text>
        ) : null}

        {/* ── To: pills + free typing ───────────────────────────────── */}
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

        {/* Suggestions — the CRM's contacts answer, tagged MEMBER or LEAD,
            because knowing which you are writing to changes what you say. */}
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

        {/* ── Subject ───────────────────────────────────────────────── */}
        <View className="flex-row items-center px-4 py-2 border-b border-un1t-border bg-un1t-surface">
          <Text className="text-[13px] text-un1t-muted font-semibold w-14">Subject</Text>
          <TextInput
            value={subject}
            onChangeText={setSubject}
            placeholder="What this is about"
            placeholderTextColor="#94A3B8"
            maxLength={200}
            className="flex-1 text-[13px] font-bold text-un1t-text py-1"
          />
        </View>

        {/* ── Body ──────────────────────────────────────────────────── */}
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder="Write the email…"
          placeholderTextColor="#94A3B8"
          maxLength={10000}
          textAlignVertical="top"
          className="px-4 py-3 text-[14px] text-un1t-text min-h-[160px] bg-un1t-surface"
        />
      </ScrollView>

      {/* ── Inline refusal — the draft stays exactly as it was ───────── */}
      {error ? (
        <View className="mx-3 mb-2 rounded-xl bg-red-500/10 px-3.5 py-2.5 flex-row items-start">
          <Ionicons name="alert-circle-outline" size={14} color="#B91C1C" style={{ marginRight: 6, marginTop: 1 }} />
          <Text className="text-xs text-red-700 flex-1">{error}</Text>
        </View>
      ) : null}
      {pickError ? (
        <Text className="mx-3 mb-2 text-[11px] text-red-700">{pickError}</Text>
      ) : null}

      {/* ── Attachment strip ─────────────────────────────────────────── */}
      <View
        className="border-t border-un1t-border bg-un1t-surface px-3 pt-2"
        style={{ paddingBottom: Math.max(insets.bottom, 10) }}
      >
        <View className="flex-row flex-wrap items-center">
          {files.map(f => {
            const bad = f.status === 'failed' || f.status === 'oversize'
            return (
              <View
                key={f.key}
                className={`flex-row items-center rounded-lg border pl-2 pr-1 py-1 mr-1.5 mb-1.5 max-w-[240px] ${
                  bad ? 'border-red-500/60 bg-red-500/10' : 'border-un1t-border bg-un1t-bg'
                }`}
              >
                {f.status === 'uploading' ? (
                  <ActivityIndicator size="small" style={{ transform: [{ scale: 0.7 }], marginRight: 4 }} />
                ) : (
                  <Ionicons
                    name={bad ? 'alert-circle-outline' : 'document-outline'}
                    size={12}
                    color={bad ? '#B91C1C' : '#64748B'}
                    style={{ marginRight: 4 }}
                  />
                )}
                <Text
                  className={`text-[11px] font-bold ${bad ? 'text-red-700' : 'text-un1t-text'}`}
                  numberOfLines={1}
                  style={{ maxWidth: 130 }}
                >
                  {f.filename}
                </Text>
                <Text className={`text-[10px] ml-1 ${bad ? 'text-red-700' : 'text-un1t-subtle'}`}>
                  {f.status === 'uploading' ? 'Uploading…' : formatAttachmentSize(f.size)}
                </Text>
                <Pressable
                  onPress={() => removeFile(f)}
                  accessibilityLabel={`Remove ${f.filename}`}
                  hitSlop={6}
                  className="p-1"
                >
                  <Ionicons name="close" size={12} color={bad ? '#B91C1C' : '#64748B'} />
                </Pressable>
              </View>
            )
          })}
          {/* Disabled until a From account exists — the upload is authorised
              against the mailbox it will be sent from (web AttachmentPicker's
              scope), so there is nothing to sign against yet. */}
          <Pressable
            onPress={addFile}
            disabled={!mailboxId}
            className={`flex-row items-center rounded-lg border border-dashed border-un1t-border px-2.5 py-1.5 mb-1.5 ${
              mailboxId ? '' : 'opacity-50'
            }`}
          >
            <Ionicons name="add" size={12} color="#94A3B8" style={{ marginRight: 3 }} />
            <Text className="text-[11px] font-bold text-un1t-subtle">Add file</Text>
          </Pressable>
          {files.length > 0 ? (
            <Text className="text-[11px] text-un1t-muted ml-1.5 mb-1.5">
              {formatAttachmentSize(budget.used)} of {formatAttachmentSize(budget.limit)}
            </Text>
          ) : null}
        </View>
        {/* The red chip's own sentence — the one the operator acts on. */}
        {files.filter(f => f.error).slice(0, 1).map(f => (
          <Text key={`err-${f.key}`} className="text-[11px] text-red-700 mb-1">{f.error}</Text>
        ))}
        {/* Why Send is grey, in words, once the sheet is past pristine. */}
        {!state.canSend && composeIsDirty({ pills, pending, subject, text, files }) ? (
          <Text className="text-[11px] text-un1t-subtle mb-1">{state.reason}</Text>
        ) : null}
      </View>

      {/* ── From picker ──────────────────────────────────────────────── */}
      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <Pressable className="flex-1 bg-black/40 justify-end" onPress={() => setPickerOpen(false)}>
          <View className="bg-un1t-surface rounded-t-2xl px-4 pt-4" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
            <Text className="text-xs font-extrabold uppercase text-un1t-subtle mb-2">
              Send from
            </Text>
            {mailboxes.map(m => (
              <Pressable
                key={m.id}
                onPress={() => { setMailboxId(m.id); setPickerOpen(false) }}
                className="flex-row items-center py-3 border-b border-un1t-border"
              >
                <View className="flex-1">
                  <Text className={`text-sm ${m.id === mailboxId ? 'font-extrabold text-un1t-text' : 'text-un1t-text'}`}>
                    {mailboxDisplay(m)}
                  </Text>
                  {m.label && m.address ? (
                    <Text className="text-[11px] text-un1t-subtle">{m.label}</Text>
                  ) : null}
                </View>
                {m.id === mailboxId ? (
                  <Ionicons name="checkmark" size={16} color="#111827" />
                ) : null}
              </Pressable>
            ))}
            <Text className="text-[11px] text-un1t-subtle mt-2.5">
              The reply comes back to this account, and the conversation is filed under it.
            </Text>
          </View>
        </Pressable>
      </Modal>

      {/* ── Sent toast — confirms, then the sheet dismisses itself ───── */}
      {sent ? (
        <View className="absolute left-0 right-0 top-0 bottom-0 items-center justify-center bg-black/20">
          <View className="flex-row items-center bg-un1t-text rounded-2xl px-5 py-3">
            <Ionicons name="checkmark-circle" size={18} color="#FFFFFF" style={{ marginRight: 7 }} />
            <Text className="text-sm font-bold text-white">Email sent</Text>
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  )
}
