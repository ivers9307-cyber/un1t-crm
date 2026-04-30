// WhatsApp conversation thread — message list + composer.
//
// iOS Messages-style bubbles: inbound on the left in grey, outbound
// on the right in white-on-blue. Sticky composer at the bottom; sends
// either a text (when within the 24h window) or a template (anytime,
// chosen from a sheet).
//
// On focus we mark the conversation read (unread_count -> 0), which
// matches the web behaviour in /api/whatsapp/conversations/[id] GET.

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform, FlatList,
} from 'react-native'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useHeaderHeight } from '@react-navigation/elements'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

// Explicit headerLeft so the back chevron is always visible — see the
// note in pipeline/[dealId].jsx for why this isn't auto-rendered.
function BackHeaderLeft({ router, label = 'Inbox' }) {
  return (
    <Pressable
      onPress={() => router.back()}
      hitSlop={12}
      className="flex-row items-center -ml-1"
    >
      <Ionicons name="chevron-back" size={26} color="#111827" />
      <Text className="text-base text-un1t-white">{label}</Text>
    </Pressable>
  )
}
import { useAuth } from '../../lib/auth-context'
import {
  getConversation, listMessages, markConversationRead,
  isWindowOpen, sendText, sendTemplate, listTemplates,
} from '../../lib/whatsapp-api'

function Bubble({ msg }) {
  const out = msg.direction === 'outbound'
  const time = msg.created_at
    ? new Date(msg.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : ''
  return (
    <View className={`flex-row mb-1.5 ${out ? 'justify-end' : 'justify-start'}`}>
      <View
        className={`max-w-[80%] px-3.5 py-2 rounded-2xl ${
          out ? 'bg-blue-500' : 'bg-un1t-dark border border-un1t-gray'
        }`}
      >
        {msg.template_name && (
          <Text className={`text-[10px] uppercase mb-1 ${out ? 'text-white/70' : 'text-un1t-mid'}`}>
            Template · {msg.template_name}
          </Text>
        )}
        <Text className={`text-base ${out ? 'text-white' : 'text-un1t-white'}`}>
          {msg.body || `[${msg.message_type}]`}
        </Text>
        <View className="flex-row items-center justify-end mt-1">
          <Text className={`text-[10px] ${out ? 'text-white/60' : 'text-un1t-light'}`}>
            {time}
          </Text>
          {out && (
            <Ionicons
              name={
                msg.read_at ? 'checkmark-done'
                : msg.delivered_at ? 'checkmark-done'
                : msg.status === 'sent' ? 'checkmark'
                : msg.status === 'failed' ? 'alert-circle'
                : 'time-outline'
              }
              size={12}
              color={msg.read_at ? '#FFFFFF' : 'rgba(255,255,255,0.6)'}
              style={{ marginLeft: 4 }}
            />
          )}
        </View>
      </View>
    </View>
  )
}

export default function Conversation() {
  const { conversationId } = useLocalSearchParams()
  const router = useRouter()
  const { activeLocation } = useAuth()
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const [conv, setConv] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [templates, setTemplates] = useState([])
  const scrollRef = useRef(null)

  const refresh = useCallback(async () => {
    const [convRes, msgRes] = await Promise.all([
      getConversation(conversationId),
      listMessages(conversationId),
    ])
    if (convRes.success) setConv(convRes.data)
    if (msgRes.success) setMessages(msgRes.data || [])
  }, [conversationId])

  useEffect(() => {
    setLoading(true)
    refresh().then(() => markConversationRead(conversationId)).finally(() => setLoading(false))
  }, [conversationId, refresh])

  useEffect(() => {
    // Auto-scroll to the latest message after load + on new messages.
    if (messages.length && scrollRef.current) {
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 50)
    }
  }, [messages.length])

  const windowOpen = isWindowOpen(conv)

  async function send() {
    if (!text.trim() || !windowOpen) return
    setSending(true)
    const res = await sendText(conversationId, text.trim(), activeLocation?.id)
    setSending(false)
    if (!res.success) {
      Alert.alert('Couldn’t send', res.error || 'Unknown error')
      return
    }
    setText('')
    refresh()
  }

  async function pickTemplate() {
    if (!templates.length) {
      const res = await listTemplates(activeLocation?.id)
      if (!res.success) {
        Alert.alert('Couldn’t load templates', res.error)
        return
      }
      setTemplates(res.data || [])
    }
    setShowTemplates(true)
  }

  async function sendChosenTemplate(tpl) {
    setShowTemplates(false)
    setSending(true)
    const res = await sendTemplate(conversationId, tpl.name, [], activeLocation?.id)
    setSending(false)
    if (!res.success) {
      Alert.alert('Couldn’t send template', res.error || 'Unknown error')
      return
    }
    refresh()
  }

  const c = conv?.contacts
  const name = c?.name
    || [c?.first_name, c?.last_name].filter(Boolean).join(' ')
    || conv?.wa_profile_name
    || conv?.wa_phone
    || 'Conversation'

  return (
    <KeyboardAvoidingView
      // 'padding' on iOS reflows the layout so the composer stays
      // pinned just above the keyboard. We feed it the actual header
      // height so the offset accounts for the navigation bar — without
      // this the composer ends up underneath the keyboard.
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      className="flex-1 bg-un1t-black"
    >
      <Stack.Screen
        options={{
          title: name,
          headerLeft: () => <BackHeaderLeft router={router} label="Inbox" />,
        }}
      />

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <>
          {/* Window status banner */}
          {!windowOpen && (
            <View className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2">
              <Text className="text-xs text-amber-700">
                24-hour window closed. Send an approved template to re-open.
              </Text>
            </View>
          )}

          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentContainerClassName="p-4"
            onContentSizeChange={() => scrollRef.current?.scrollToEnd?.({ animated: false })}
          >
            {messages.map(m => <Bubble key={m.id} msg={m} />)}
          </ScrollView>

          {/* Composer — bottom padding accounts for the home-indicator
              safe area when the keyboard is closed, but collapses to 8
              when the keyboard is open (KeyboardAvoidingView replaces
              the inset). */}
          <View
            className="border-t border-un1t-gray bg-un1t-black px-3 pt-2 flex-row items-end"
            style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          >
            <Pressable
              onPress={pickTemplate}
              className="w-10 h-10 rounded-full bg-un1t-dark border border-un1t-gray items-center justify-center mr-2 active:opacity-70"
            >
              <Ionicons name="document-text-outline" size={18} color="#111827" />
            </Pressable>
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              placeholder={windowOpen ? 'Message…' : 'Send a template instead'}
              placeholderTextColor="#94A3B8"
              editable={windowOpen}
              className="flex-1 bg-un1t-dark border border-un1t-gray rounded-2xl px-4 py-2.5 text-base text-un1t-white max-h-32"
              textAlignVertical="top"
            />
            <Pressable
              onPress={send}
              disabled={!text.trim() || !windowOpen || sending}
              className={`w-10 h-10 rounded-full ml-2 items-center justify-center ${
                text.trim() && windowOpen && !sending ? 'bg-blue-500' : 'bg-un1t-gray'
              }`}
            >
              {sending ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Ionicons name="arrow-up" size={20} color="#FFFFFF" />
              )}
            </Pressable>
          </View>

          {/* Templates picker (modal-ish overlay) */}
          {showTemplates && (
            <Pressable
              className="absolute inset-0 bg-black/40 items-end"
              onPress={() => setShowTemplates(false)}
            >
              <Pressable
                className="bg-un1t-black border-t border-un1t-gray rounded-t-3xl mt-auto w-full max-h-[60%] p-4"
                onPress={() => {}}
              >
                <View className="flex-row items-center justify-between mb-3">
                  <Text className="text-base font-semibold text-un1t-white">Send template</Text>
                  <Pressable onPress={() => setShowTemplates(false)} hitSlop={10}>
                    <Ionicons name="close" size={22} color="#111827" />
                  </Pressable>
                </View>
                <ScrollView>
                  {templates.length === 0 && (
                    <Text className="text-sm text-un1t-light text-center py-6">
                      No approved templates available.
                    </Text>
                  )}
                  {templates.map(t => (
                    <Pressable
                      key={t.id}
                      onPress={() => sendChosenTemplate(t)}
                      className="bg-un1t-dark border border-un1t-gray rounded-xl p-3 mb-2 active:opacity-70"
                    >
                      <Text className="text-sm font-semibold text-un1t-white">{t.name}</Text>
                      {t.body_text && (
                        <Text className="text-xs text-un1t-light mt-1" numberOfLines={2}>
                          {t.body_text}
                        </Text>
                      )}
                    </Pressable>
                  ))}
                </ScrollView>
              </Pressable>
            </Pressable>
          )}
        </>
      )}
    </KeyboardAvoidingView>
  )
}
