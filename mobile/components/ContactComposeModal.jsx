// MOBILE-CONTACT-SEND.1 — channel composer modal for the contact card.
//
// Routes the SMS / WhatsApp / Email actions through the platform's
// linked services (Twilio / WhatsApp Cloud API / Postmark) so the
// message comes from the company, not the staffer's personal phone.
// Replaces the old sms: / wa.me / mailto: deep-links.
//
//   • whatsapp → reuses <ContactComposer> (24h-window free text +
//                approved-template picker).
//   • sms      → a text box → POST /api/contacts/[id]/sms (Twilio).
//   • email    → subject + body. MOBILE-MAILPARITY.1 — the web card's
//                PROFILE-MAIL.1 branch, ported: with a usable studio account
//                at the CONTACT'S location the send IS a Mail compose
//                (POST /api/email/tickets/compose, mailbox_id + the contact's
//                address), filed as a conversation the reply threads back
//                into; only with none does it fall back to the company
//                sender (POST /api/contacts/[id]/email), which is what the
//                phone did unconditionally before. mail-sender.js decides.

import { useState, useEffect } from 'react'
import {
  Modal, View, Text, TextInput, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import ContactComposer from './ContactComposer'
import { sendContactSms, sendContactEmail } from '../lib/messaging-api'
import { listMail, composeEmail, fetchSignatureContexts } from '../lib/email-api'
import { defaultMailboxId, mailboxDisplay, mailboxLocationId } from '../lib/mail-compose'
import { resolveContactEmailSend, contactEmailFooter, mailboxesFromListResult, MAILBOXES_UNAVAILABLE } from '../lib/mail-sender'
import { resolveSignatureHint } from '../lib/signature-hint'

const TITLES = { sms: 'Text', whatsapp: 'WhatsApp', email: 'Email' }

export default function ContactComposeModal({
  visible, channel, contactId, contactName, onClose,
  // MOBILE-MAILPARITY.1 — the Mail path needs the contact's own studio (to
  // load the caller's visible accounts there) and address (the compose route
  // takes recipients, not a contact id). Absent props degrade to the company
  // path, so older render sites keep working — same contract as the web card.
  contactLocationId = null,
  contactEmail = null,
}) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View className="flex-1 bg-black/40 justify-end">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View className="bg-un1t-bg rounded-t-3xl max-h-[88%]">
            <View className="flex-row items-center justify-between px-4 pt-4 pb-1">
              <Text className="text-lg font-bold text-un1t-text" numberOfLines={1}>
                {TITLES[channel] || 'Message'} {contactName || ''}
              </Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
                <Ionicons name="close" size={24} color="#111827" />
              </Pressable>
            </View>
            {/* MOBILE-MAILPARITY.1 — the email form states its own sender
                (a studio account, or the company address) under its Send
                button, off the same inputs as the send itself. A blanket
                "company" line above it would contradict a From row. */}
            {channel !== 'email' ? (
              <Text className="text-[11px] text-un1t-muted px-4 pb-2">Sends from the company — not your phone.</Text>
            ) : (
              <Text className="text-[11px] text-un1t-muted px-4 pb-2">Not sent from your phone — the From line below says which address.</Text>
            )}
            <ScrollView
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: insets.bottom + 16 }}
              keyboardShouldPersistTaps="handled"
            >
              {channel === 'whatsapp' && contactId ? (
                <ContactComposer contactId={contactId} contactName={contactName} onSent={onClose} />
              ) : null}
              {channel === 'sms' && contactId ? (
                <SmsForm contactId={contactId} contactName={contactName} onSent={onClose} />
              ) : null}
              {channel === 'email' && contactId ? (
                <EmailForm
                  contactId={contactId}
                  contactName={contactName}
                  contactLocationId={contactLocationId}
                  contactEmail={contactEmail}
                  onSent={onClose}
                />
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

function SmsForm({ contactId, contactName, onSent }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null)

  async function send() {
    if (!text.trim() || sending) return
    setSending(true)
    setError(null)
    const res = await sendContactSms(contactId, { body: text.trim() })
    setSending(false)
    if (!res.success) { setError(res.error || 'Send failed'); return }
    setFlash('SMS sent')
    setText('')
    setTimeout(() => onSent?.(), 800)
  }

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder={`Text ${contactName || 'the contact'}…`}
        placeholderTextColor="#94A3B8"
        className="text-base text-un1t-text min-h-[88px]"
        textAlignVertical="top"
      />
      <Text className="text-[11px] text-un1t-muted mt-1">{text.length} characters</Text>
      <Pressable
        onPress={send}
        disabled={!text.trim() || sending}
        accessibilityRole="button"
        accessibilityLabel="Send SMS"
        className={`mt-2 py-2.5 rounded-lg items-center ${text.trim() && !sending ? 'bg-un1t-text' : 'bg-un1t-border'}`}
      >
        {sending ? <ActivityIndicator /> : <Text className="text-un1t-bg font-semibold text-sm">Send SMS</Text>}
      </Pressable>
      {!!flash && <Text className="text-xs text-green-700 mt-2">{flash}</Text>}
      {!!error && <Text className="text-xs text-red-500 mt-2">{error}</Text>}
    </View>
  )
}

function EmailForm({ contactId, contactName, contactLocationId, contactEmail, onSent }) {
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null)

  // MOBILE-MAILPARITY.1 — the caller's visible email accounts at the
  // CONTACT'S studio, off the same list call the compose sheet uses. Three
  // states, all decided by mail-sender.js off the same inputs the send uses:
  //   null  = asked for, not yet answered → `awaiting`: Send is DISABLED and
  //           the footer reads "Checking studio accounts…". (Review fix: a
  //           tap in this window used to go out as the company sender — the
  //           very bug this feature fixes, made timing-dependent.)
  //   []    = a successful empty list: none usable (no connected account) →
  //           the company path, permanently, exactly as before this feature.
  //   MAILBOXES_UNAVAILABLE = the list FAILED (transport blip, route 500,
  //           non-JSON) → still the company path, never blocking the
  //           operator on a blip, but the footer names the failure instead
  //           of claiming there are no accounts.
  //   MAILBOXES_FORBIDDEN = the list answered 403 (MAIL-403.1): the operator
  //           holds no Mail access at the contact's studio. A state, not a
  //           fault — company path, footer says so. listMail passes api()'s
  //           `status` through so the two can be told apart.
  // Default From = the account starred Default on the studio's Email
  // settings card, else the first.
  const [mailboxes, setMailboxes] = useState(null)
  const [mailboxId, setMailboxId] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [signatureContexts, setSignatureContexts] = useState([])
  useEffect(() => {
    if (!contactLocationId || !contactEmail) return
    let alive = true
    listMail(contactLocationId).then(res => {
      if (!alive) return
      const boxes = mailboxesFromListResult(res)
      setMailboxes(boxes)
      setMailboxId(Array.isArray(boxes) ? defaultMailboxId(boxes) : null)
    }).catch(() => { if (alive) setMailboxes(MAILBOXES_UNAVAILABLE) })
    // Cosmetic preview of the sign-off the compose route appends; [] on any
    // failure (fetchSignatureContexts' own posture), which simply hides it.
    // api() cannot reject today; the catch is symmetry with the call above.
    fetchSignatureContexts().then(rows => { if (alive) setSignatureContexts(rows) }).catch(() => {})
    return () => { alive = false }
  }, [contactLocationId, contactEmail])

  const ready = subject.trim() && text.trim()
  const route = resolveContactEmailSend({ mailboxes, mailboxId, contactEmail, contactLocationId })
  const footer = contactEmailFooter({ mailboxes, mailboxId, contactEmail, contactLocationId })
  // The list is in flight: no send may leave until it answers, because the
  // path it takes is not yet known. Never true when there is nothing to await.
  const awaitingAccounts = route.path === 'awaiting'
  // Only on the Mail path: the company-sender fallback appends nothing, and
  // absence is the truth there (web MAILFIX-SIGTRUTH.1).
  const signatureHint = route.path === 'mail'
    ? resolveSignatureHint(signatureContexts, mailboxLocationId(mailboxes, mailboxId) || contactLocationId)
    : null

  async function send() {
    if (!ready || sending) return
    // The path is re-resolved at tap time from the same inputs the footer
    // renders from — never a captured decision from an earlier render.
    const plan = resolveContactEmailSend({ mailboxes, mailboxId, contactEmail, contactLocationId })
    // Belt to the disabled-prop braces: an awaiting plan is not a send.
    if (plan.path === 'awaiting') return
    setSending(true)
    setError(null)
    const res = plan.path === 'mail'
      ? await composeEmail({
          mailboxId: plan.mailboxId,
          to: plan.to,
          subject: subject.trim(),
          text: text.trim(),
          locationId: plan.locationId,
        })
      : await sendContactEmail(contactId, { subject: subject.trim(), body: text.trim() })
    setSending(false)
    if (!res.success) { setError(res.error || 'Send failed'); return }
    setFlash(plan.path === 'mail' ? 'Email sent — the conversation is in Mail' : 'Email sent')
    setSubject('')
    setText('')
    setTimeout(() => onSent?.(), 800)
  }

  const canPick = Array.isArray(mailboxes) && mailboxes.length > 1

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <TextInput
        value={subject}
        onChangeText={setSubject}
        placeholder="Subject"
        placeholderTextColor="#94A3B8"
        className="text-base text-un1t-text border-b border-un1t-border pb-2"
      />
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder={`Email ${contactName || 'the contact'}…`}
        placeholderTextColor="#94A3B8"
        className="text-base text-un1t-text min-h-[120px] mt-3"
        textAlignVertical="top"
      />
      {signatureHint ? (
        <View className="mt-2 rounded-lg border border-dashed border-un1t-border px-3 py-2">
          <Text className="text-[10px] font-bold uppercase tracking-wider text-un1t-muted">
            Added automatically
          </Text>
          {signatureHint.body ? (
            <Text className="mt-1 text-xs text-un1t-subtle">{signatureHint.body}</Text>
          ) : null}
          {signatureHint.suffix ? (
            <Text className="mt-1 text-[10px] text-un1t-muted">{signatureHint.suffix}</Text>
          ) : null}
        </View>
      ) : null}
      {/* From — the address the member hears from, or the company wording.
          Tappable only when there is a choice to make. */}
      <Pressable
        onPress={() => canPick && setPickerOpen(true)}
        disabled={!canPick}
        accessibilityRole={canPick ? 'button' : undefined}
        accessibilityLabel={canPick ? 'Choose the From account' : undefined}
        className="flex-row items-center mt-3"
      >
        {route.path === 'mail' ? (
          <Text className="text-[11px] text-un1t-muted mr-1">From</Text>
        ) : null}
        <Text className="text-[11px] text-un1t-muted flex-1" numberOfLines={1}>{footer}</Text>
        {canPick ? <Ionicons name="chevron-down" size={12} color="#64748B" /> : null}
      </Pressable>
      <Pressable
        onPress={send}
        disabled={!ready || sending || awaitingAccounts}
        accessibilityRole="button"
        accessibilityLabel="Send email"
        className={`mt-2 py-2.5 rounded-lg items-center ${ready && !sending && !awaitingAccounts ? 'bg-un1t-text' : 'bg-un1t-border'}`}
      >
        {sending ? <ActivityIndicator /> : <Text className="text-un1t-bg font-semibold text-sm">Send email</Text>}
      </Pressable>
      {!!flash && <Text className="text-xs text-green-700 mt-2">{flash}</Text>}
      {!!error && <Text className="text-xs text-red-500 mt-2">{error}</Text>}

      {/* From picker — the compose sheet's, flat (one studio's accounts). */}
      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <Pressable className="flex-1 bg-black/40 justify-end" onPress={() => setPickerOpen(false)}>
          <View className="bg-un1t-surface rounded-t-2xl px-4 pt-4 pb-6">
            <Text className="text-xs font-extrabold uppercase text-un1t-subtle mb-2">Send from</Text>
            {(Array.isArray(mailboxes) ? mailboxes : []).filter(Boolean).map(m => (
              <Pressable
                key={m.id}
                onPress={() => { setMailboxId(m.id); setPickerOpen(false) }}
                accessibilityRole="button"
                accessibilityLabel={`Send from ${mailboxDisplay(m)}`}
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
                {m.id === mailboxId ? <Ionicons name="checkmark" size={16} color="#111827" /> : null}
              </Pressable>
            ))}
            <Text className="text-[11px] text-un1t-subtle mt-2.5">
              The reply comes back to this account, and the conversation is filed under it.
            </Text>
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}
