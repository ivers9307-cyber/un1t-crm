// MOBILE-COMPOSER.1 — WhatsApp message composer for the Deal Detail
// Contact section. Mirrors the web ContactComposer: free text while
// the 24-hour customer-service window is open; a utility-template
// picker once it's closed.
//
// SMS sending on mobile lands with the two-way SMS work; this v1 is
// WhatsApp only (the .mobile.whatsapp permission already exists).

import { useState, useEffect, useCallback } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { getMessagingContext, sendContactWhatsApp } from '../lib/messaging-api'

export default function ContactComposer({ contactId, contactName, onSent }) {
  const [ctx, setCtx] = useState(null)
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null)
  // The window can lapse while the screen sits open — the send
  // endpoint is the source of truth and flips this via window_expired.
  const [windowClosed, setWindowClosed] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    const res = await getMessagingContext(contactId)
    if (res.success) {
      setCtx(res.data)
      setWindowClosed(!res.data?.whatsapp?.windowOpen)
    } else {
      setError(res.error || 'Could not load messaging')
    }
  }, [contactId])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  function showFlash(msg) {
    setFlash(msg)
    setTimeout(() => setFlash(null), 4000)
  }

  async function send(payload) {
    setSending(true)
    setError(null)
    const res = await sendContactWhatsApp(contactId, payload)
    setSending(false)
    if (!res.success) {
      if (res.window_expired) setWindowClosed(true)
      setError(res.error || 'Send failed')
      return false
    }
    return true
  }

  async function sendText() {
    if (!text.trim()) return
    const ok = await send({ text: text.trim() })
    if (ok) { setText(''); showFlash('WhatsApp message sent'); onSent?.() }
  }

  async function sendTemplate(name) {
    const ok = await send({ templateName: name })
    if (ok) { showFlash('WhatsApp template sent'); onSent?.() }
  }

  const templates = ctx?.templates || []

  return (
    <View className="mb-5">
      <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2 px-1">
        Message {contactName || 'contact'}
      </Text>
      <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4">
        {loading ? (
          <ActivityIndicator />
        ) : windowClosed ? (
          <View>
            <Text className="text-xs text-un1t-light mb-2">
              The 24-hour WhatsApp window is closed. Send a utility template to reopen the conversation.
            </Text>
            {templates.length === 0 ? (
              <Text className="text-xs text-un1t-light">
                No approved utility templates yet. Add one on the web under WhatsApp → Templates.
              </Text>
            ) : (
              templates.map((t) => (
                <Pressable
                  key={t.name}
                  disabled={sending}
                  onPress={() => sendTemplate(t.name)}
                  className="border border-un1t-gray rounded-xl p-3 mb-2 active:opacity-70"
                >
                  <View className="flex-row items-center justify-between">
                    <Text className="text-sm font-medium text-un1t-white flex-1 mr-2">{t.name}</Text>
                    <Ionicons name="send-outline" size={15} color="#111827" />
                  </View>
                  {!!t.bodyText && (
                    <Text className="text-xs text-un1t-light mt-1">{t.bodyText}</Text>
                  )}
                </Pressable>
              ))
            )}
          </View>
        ) : (
          <View>
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              placeholder={`Message ${contactName || 'the customer'} on WhatsApp…`}
              placeholderTextColor="#94A3B8"
              className="text-base text-un1t-white min-h-[72px]"
              textAlignVertical="top"
            />
            <Text className="text-[11px] text-un1t-mid mt-1">
              Free-texting is open — replies keep the 24-hour window alive.
            </Text>
            <Pressable
              onPress={sendText}
              disabled={!text.trim() || sending}
              className={`mt-2 py-2.5 rounded-lg items-center ${
                text.trim() && !sending ? 'bg-un1t-white' : 'bg-un1t-gray'
              }`}
            >
              {sending ? (
                <ActivityIndicator />
              ) : (
                <Text className="text-un1t-black font-semibold text-sm">Send WhatsApp</Text>
              )}
            </Pressable>
          </View>
        )}

        {!!flash && <Text className="text-xs text-green-700 mt-2">{flash}</Text>}
        {!!error && <Text className="text-xs text-red-500 mt-2">{error}</Text>}
      </View>
    </View>
  )
}
