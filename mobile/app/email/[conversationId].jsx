// Email thread — message list + reply composer (INBOX-EMAIL-M.1).
//
// Mirrors the Instagram thread screen structurally but rides the
// /api/email/* routes (the email_* tables deny direct authenticated
// reads — mig 394 mirrors the instagram_* RLS posture) and is simpler
// still: no customer agent, so no approvals, no handoff banner, no
// rating row. Messages render text_body ONLY (plain text, whitespace
// preserved) — raw HTML is never rendered, same rule as the web
// EmailInbox. Per-message subjects show inside the bubble when present.
//
// Loading the thread resets unread_count server-side (the GET does it).
// Replies ride Postmark's transactional stream with threading headers —
// all server-side in the send route.

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useLocalSearchParams, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '../../lib/auth-context'
import {
  getThread, sendText, resolveConversation, emailDisplayName,
} from '../../lib/email-api'
import { needsReply } from '../../lib/inbox'
import BackHeaderLeft from '../../components/BackHeaderLeft'

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

function EmailBubble({ msg }) {
  const out = msg.direction === 'outbound'
  return (
    <View className={`flex-row mb-1.5 ${out ? 'justify-end' : 'justify-start'}`}>
      <View
        className={`max-w-[85%] px-3.5 py-2 rounded-2xl ${
          out ? 'bg-blue-500' : 'bg-un1t-surface border border-un1t-border'
        }`}
      >
        {msg.subject ? (
          <Text className={`text-xs font-semibold mb-1 ${out ? 'text-white/80' : 'text-un1t-subtle'}`}>
            {msg.subject}
          </Text>
        ) : null}
        {/* text_body only — never raw HTML (see screen header). */}
        <Text className={`text-base ${out ? 'text-white' : 'text-un1t-text'}`}>
          {msg.text_body || '(no text content)'}
        </Text>
        <View className="flex-row items-center justify-end mt-1">
          {out && (
            <Text className={`text-[10px] mr-1 ${out ? 'text-white/60' : 'text-un1t-subtle'}`}>
              Staff
            </Text>
          )}
          <Text className={`text-[10px] ${out ? 'text-white/60' : 'text-un1t-subtle'}`}>
            {formatTime(msg.sent_at || msg.created_at)}
          </Text>
          {out && (
            <Ionicons name="checkmark" size={12} color="rgba(255,255,255,0.6)" style={{ marginLeft: 4 }} />
          )}
        </View>
      </View>
    </View>
  )
}

export default function EmailConversation() {
  const { conversationId } = useLocalSearchParams()
  const { activeLocation } = useAuth()
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const [conv, setConv] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [resolving, setResolving] = useState(false)
  const scrollRef = useRef(null)

  const refresh = useCallback(async () => {
    const res = await getThread(conversationId, activeLocation?.id)
    if (!res.success) {
      setError(res.error || 'Failed to load conversation')
      return
    }
    setError(null)
    setConv(res.conversation)
    setMessages(res.messages || [])
  }, [conversationId, activeLocation])

  useEffect(() => {
    setLoading(true)
    refresh().finally(() => setLoading(false))
  }, [refresh])

  useEffect(() => {
    if (messages.length && scrollRef.current) {
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 50)
    }
  }, [messages.length])

  async function send() {
    if (!text.trim() || sending) return
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

  // Mark handled — pure queue state on email (no agent to re-arm).
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

  const name = emailDisplayName(conv)

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      className="flex-1 bg-un1t-bg"
    >
      <Stack.Screen
        options={{
          title: name,
          headerLeft: () => <BackHeaderLeft label="Messages" fallbackHref="/(tabs)/whatsapp" />,
          headerRight: conv && needsReply(conv)
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
      ) : error ? (
        <View className="flex-1 items-center justify-center px-8">
          <Ionicons name="alert-circle-outline" size={32} color="#DC2626" />
          <Text className="text-sm text-red-600 mt-2 text-center">{error}</Text>
        </View>
      ) : (
        <>
          {/* Address + subject strip — the native header holds the name;
              this mirrors the web thread header's second line. */}
          <View className="border-b border-un1t-border bg-un1t-surface px-4 py-2">
            <Text className="text-xs text-un1t-subtle" numberOfLines={1}>
              {conv?.counterpart_email || '—'}
            </Text>
            {conv?.subject ? (
              <Text className="text-sm font-medium text-un1t-text mt-0.5" numberOfLines={1}>
                {conv.subject}
              </Text>
            ) : null}
          </View>

          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentContainerClassName="p-4"
            onContentSizeChange={() => scrollRef.current?.scrollToEnd?.({ animated: false })}
          >
            {messages.map(m => <EmailBubble key={m.id} msg={m} />)}
          </ScrollView>

          <View
            className="border-t border-un1t-border bg-un1t-bg px-3 pt-2 flex-row items-end"
            style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          >
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              placeholder={`Reply to ${conv?.counterpart_email || 'sender'}…`}
              placeholderTextColor="#94A3B8"
              maxLength={10000}
              className="flex-1 bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-2.5 text-base text-un1t-text max-h-32"
              textAlignVertical="top"
            />
            <Pressable
              onPress={send}
              disabled={!text.trim() || sending}
              className={`w-10 h-10 rounded-full ml-2 items-center justify-center ${
                text.trim() && !sending ? 'bg-blue-500' : 'bg-un1t-border'
              }`}
            >
              {sending ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Ionicons name="arrow-up" size={20} color="#FFFFFF" />
              )}
            </Pressable>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  )
}
