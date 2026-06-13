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
//   • email    → subject + body → POST /api/contacts/[id]/email (Postmark).

import { useState } from 'react'
import {
  Modal, View, Text, TextInput, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import ContactComposer from './ContactComposer'
import { sendContactSms, sendContactEmail } from '../lib/messaging-api'

const TITLES = { sms: 'Text', whatsapp: 'WhatsApp', email: 'Email' }

export default function ContactComposeModal({ visible, channel, contactId, contactName, onClose }) {
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
            <Text className="text-[11px] text-un1t-muted px-4 pb-2">Sends from the company — not your phone.</Text>
            <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4 }} keyboardShouldPersistTaps="handled">
              {channel === 'whatsapp' && contactId ? (
                <ContactComposer contactId={contactId} contactName={contactName} onSent={onClose} />
              ) : null}
              {channel === 'sms' && contactId ? (
                <SmsForm contactId={contactId} contactName={contactName} onSent={onClose} />
              ) : null}
              {channel === 'email' && contactId ? (
                <EmailForm contactId={contactId} contactName={contactName} onSent={onClose} />
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

function EmailForm({ contactId, contactName, onSent }) {
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null)

  const ready = subject.trim() && text.trim()

  async function send() {
    if (!ready || sending) return
    setSending(true)
    setError(null)
    const res = await sendContactEmail(contactId, { subject: subject.trim(), body: text.trim() })
    setSending(false)
    if (!res.success) { setError(res.error || 'Send failed'); return }
    setFlash('Email sent')
    setSubject('')
    setText('')
    setTimeout(() => onSent?.(), 800)
  }

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
      <Pressable
        onPress={send}
        disabled={!ready || sending}
        accessibilityRole="button"
        accessibilityLabel="Send email"
        className={`mt-2 py-2.5 rounded-lg items-center ${ready && !sending ? 'bg-un1t-text' : 'bg-un1t-border'}`}
      >
        {sending ? <ActivityIndicator /> : <Text className="text-un1t-bg font-semibold text-sm">Send email</Text>}
      </Pressable>
      {!!flash && <Text className="text-xs text-green-700 mt-2">{flash}</Text>}
      {!!error && <Text className="text-xs text-red-500 mt-2">{error}</Text>}
    </View>
  )
}
