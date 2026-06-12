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
      <Text className="text-base text-un1t-text">{label}</Text>
    </Pressable>
  )
}
import { useAuth } from '../../lib/auth-context'
import {
  getConversation, listMessages, markConversationRead,
  isWindowOpen, sendText, sendTemplate, listTemplates,
  resolveConversation, rateAgentMessage,
} from '../../lib/whatsapp-api'
import { needsReply, isAgentHandoff, mediaLabel } from '../../lib/inbox'

function Bubble({ msg, myRating, onRate }) {
  const out = msg.direction === 'outbound'
  const isAgent = msg.source === 'agent'
  const media = mediaLabel(msg.message_type)
  const time = msg.created_at
    ? new Date(msg.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : ''
  return (
    <>
      <View className={`flex-row mb-1.5 ${out ? 'justify-end' : 'justify-start'}`}>
        <View
          className={`max-w-[80%] px-3.5 py-2 rounded-2xl ${
            out ? 'bg-blue-500' : 'bg-un1t-surface border border-un1t-border'
          }`}
        >
          {isAgent && (
            <View className="flex-row items-center mb-1">
              <Ionicons name="sparkles" size={10} color={out ? 'rgba(255,255,255,0.8)' : '#64748B'} />
              <Text className={`text-[10px] uppercase ml-1 font-semibold ${out ? 'text-white/70' : 'text-un1t-muted'}`}>
                Mia
              </Text>
            </View>
          )}
          {msg.template_name && (
            <Text className={`text-[10px] uppercase mb-1 ${out ? 'text-white/70' : 'text-un1t-muted'}`}>
              Template · {msg.template_name}
            </Text>
          )}
          {media && (
            <View className={`flex-row items-center ${msg.body ? 'mb-0.5' : ''}`}>
              <Ionicons name={media.icon} size={14} color={out ? 'rgba(255,255,255,0.85)' : '#64748B'} />
              <Text className={`text-sm italic ml-1.5 ${out ? 'text-white/85' : 'text-un1t-light'}`}>
                {media.label}
              </Text>
            </View>
          )}
          {msg.body ? (
            <Text className={`text-base ${out ? 'text-white' : 'text-un1t-text'}`}>
              {msg.body}
            </Text>
          ) : !media ? (
            <Text className={`text-base ${out ? 'text-white' : 'text-un1t-text'}`}>—</Text>
          ) : null}
          <View className="flex-row items-center justify-end mt-1">
            <Text className={`text-[10px] ${out ? 'text-white/60' : 'text-un1t-subtle'}`}>
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
      {/* Thumbs on agent replies (AGENT-QA.1) — same quality loop as the
          web inbox; ratings land on the agent analytics page. */}
      {isAgent && onRate && (
        <View className="flex-row justify-end items-center mb-2 mr-1 -mt-0.5">
          <Pressable onPress={() => onRate(msg, 'up')} hitSlop={8} className="mr-4">
            <Ionicons
              name={myRating === 'up' ? 'thumbs-up' : 'thumbs-up-outline'}
              size={14}
              color={myRating === 'up' ? '#16A34A' : '#94A3B8'}
            />
          </Pressable>
          <Pressable onPress={() => onRate(msg, 'down')} hitSlop={8}>
            <Ionicons
              name={myRating === 'down' ? 'thumbs-down' : 'thumbs-down-outline'}
              size={14}
              color={myRating === 'down' ? '#DC2626' : '#94A3B8'}
            />
          </Pressable>
        </View>
      )}
    </>
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
  const [resolving, setResolving] = useState(false)
  const [feedback, setFeedback] = useState({})
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

  // Mark the conversation handled. Server-side this also re-arms Mia on
  // a handed-off thread (AGENT-REARM.1) — the ✓ is "hand it back".
  async function resolve() {
    if (resolving) return
    setResolving(true)
    const res = await resolveConversation(conversationId, true, activeLocation?.id)
    setResolving(false)
    if (!res.success) {
      Alert.alert('Couldn’t resolve', res.error || 'Unknown error')
      return
    }
    refresh()
  }

  function rate(msg, rating) {
    const prev = feedback[msg.id] || null
    if (prev === rating) return
    const submit = async (note) => {
      setFeedback(f => ({ ...f, [msg.id]: rating }))
      const res = await rateAgentMessage({
        messageId: msg.id, rating, note, locationId: activeLocation?.id,
      })
      if (!res.success) {
        setFeedback(f => ({ ...f, [msg.id]: prev }))
        Alert.alert('Couldn’t save feedback', res.error || 'Unknown error')
      }
    }
    if (rating === 'down' && Platform.OS === 'ios') {
      // Optional note on a thumbs-down — surfaces on the agent analytics
      // quality list. Alert.prompt is iOS-only; Android sends without.
      Alert.prompt(
        'What was wrong?',
        'Optional — helps tune Mia.',
        [
          { text: 'Skip', onPress: () => submit(null) },
          { text: 'Send', onPress: (note) => submit(note || null) },
        ],
        'plain-text'
      )
    } else {
      submit(null)
    }
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
      className="flex-1 bg-un1t-bg"
    >
      <Stack.Screen
        options={{
          title: name,
          headerLeft: () => <BackHeaderLeft router={router} label="Inbox" />,
          headerRight: conv && !conv.resolved_at && (needsReply(conv) || isAgentHandoff(conv))
            ? () => (
                <Pressable onPress={resolve} disabled={resolving} hitSlop={10}>
                  {resolving
                    ? <ActivityIndicator size="small" />
                    : <Ionicons name="checkmark-circle-outline" size={26} color="#16A34A" />}
                </Pressable>
              )
            : undefined,
        }}
      />

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <>
          {/* Agent handoff banner — Mia escalated this thread and is
              muted until a human resolves it. */}
          {isAgentHandoff(conv) && (
            <View className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2.5 flex-row items-center">
              <Ionicons name="hand-left-outline" size={16} color="#B45309" />
              <Text className="text-xs text-amber-800 flex-1 ml-2">
                Mia handed this to the team. Reply below, then mark it handled to put her back on duty.
              </Text>
              <Pressable
                onPress={resolve}
                disabled={resolving}
                className="bg-amber-600 rounded-lg px-2.5 py-1.5 ml-2 active:opacity-80"
              >
                {resolving
                  ? <ActivityIndicator size="small" color="#FFFFFF" />
                  : <Text className="text-xs text-white font-semibold">Mark handled</Text>}
              </Pressable>
            </View>
          )}

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
            {messages.map(m => (
              <Bubble key={m.id} msg={m} myRating={feedback[m.id] || null} onRate={rate} />
            ))}
          </ScrollView>

          {/* Composer — bottom padding accounts for the home-indicator
              safe area when the keyboard is closed, but collapses to 8
              when the keyboard is open (KeyboardAvoidingView replaces
              the inset). */}
          <View
            className="border-t border-un1t-border bg-un1t-bg px-3 pt-2 flex-row items-end"
            style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          >
            <Pressable
              onPress={pickTemplate}
              className="w-10 h-10 rounded-full bg-un1t-surface border border-un1t-border items-center justify-center mr-2 active:opacity-70"
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
              className="flex-1 bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-2.5 text-base text-un1t-text max-h-32"
              textAlignVertical="top"
            />
            <Pressable
              onPress={send}
              disabled={!text.trim() || !windowOpen || sending}
              className={`w-10 h-10 rounded-full ml-2 items-center justify-center ${
                text.trim() && windowOpen && !sending ? 'bg-blue-500' : 'bg-un1t-border'
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
                className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl mt-auto w-full max-h-[60%] p-4"
                onPress={() => {}}
              >
                <View className="flex-row items-center justify-between mb-3">
                  <Text className="text-base font-semibold text-un1t-text">Send template</Text>
                  <Pressable onPress={() => setShowTemplates(false)} hitSlop={10}>
                    <Ionicons name="close" size={22} color="#111827" />
                  </Pressable>
                </View>
                <ScrollView>
                  {templates.length === 0 && (
                    <Text className="text-sm text-un1t-subtle text-center py-6">
                      No approved templates available.
                    </Text>
                  )}
                  {templates.map(t => (
                    <Pressable
                      key={t.id}
                      onPress={() => sendChosenTemplate(t)}
                      className="bg-un1t-surface border border-un1t-border rounded-xl p-3 mb-2 active:opacity-70"
                    >
                      <Text className="text-sm font-semibold text-un1t-text">{t.name}</Text>
                      {t.body_text && (
                        <Text className="text-xs text-un1t-subtle mt-1" numberOfLines={2}>
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
