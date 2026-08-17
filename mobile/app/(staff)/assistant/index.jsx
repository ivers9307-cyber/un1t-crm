// MOBILE-ASSISTANT.1 — native AI assistant chat (P2-8).
//
// A chat screen over the existing /api/assistant/chat route (buffered
// path — see lib/assistant-api.js). Mirrors the web AssistantBubble:
// same welcome copy + suggestion chips, same optimistic user-message →
// reply → optional navigation flow.
//
// Differences from the web bubble (deliberate, buffered-first):
//   • No streaming yet — we send without `stream` and render the whole
//     reply at once. Streaming (text/event-stream) is a fast-follow.
//   • navigateTo isn't auto-pushed (a chat that yanks you to another
//     screen mid-conversation is jarring on a phone). Instead we render
//     a tappable "Go there →" row under the reply, like a suggestion.
//
// Reached from the More tab, gated by the `assistant` mobile permission
// (already a MOBILE_PERMISSIONS key in shared/permissions.js).

import { useState, useRef, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native'
import { Stack, useRouter, usePathname } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '../../../lib/auth-context'
import { sendAssistantChat } from '../../../lib/assistant-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

// Mirrors WELCOME_SUGGESTIONS in src/components/AssistantBubble.jsx.
const WELCOME_SUGGESTIONS = [
  'How do I create a new shift?',
  'Show me how the pipeline works',
  'Who is working this week?',
  'Help me get started',
]

// One message in the transcript:
//   { role: 'user'|'assistant', content: string, navigateTo?: string|null, error?: boolean }

function AssistantAvatar() {
  return (
    <View className="w-7 h-7 rounded-full bg-blue-600 items-center justify-center mr-2 mt-0.5">
      <Ionicons name="sparkles" size={14} color="#FFFFFF" />
    </View>
  )
}

function Bubble({ msg, onNavigate }) {
  const isUser = msg.role === 'user'
  // A navigation hint only renders when the server returned an in-app
  // path (the route already guarantees navigateTo is null or a path,
  // but mirror the web's startsWith('/') guard defensively).
  const goPath = !isUser && typeof msg.navigateTo === 'string' && msg.navigateTo.startsWith('/')
    ? msg.navigateTo
    : null

  return (
    <View className={`flex-row mb-2.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && <AssistantAvatar />}
      <View className={`max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
        <View
          className={`px-3.5 py-2.5 rounded-2xl ${
            isUser
              ? 'bg-blue-600'
              : msg.error
                ? 'bg-red-500/10 border border-red-500/30'
                : 'bg-un1t-surface border border-un1t-border'
          }`}
        >
          <Text className={`text-base ${isUser ? 'text-white' : msg.error ? 'text-red-700' : 'text-un1t-text'}`}>
            {msg.content}
          </Text>
        </View>
        {goPath && (
          <Pressable
            onPress={() => onNavigate(goPath)}
            className="flex-row items-center mt-1.5 px-3.5 py-2 rounded-2xl bg-blue-600/10 border border-blue-600/30 active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={`Go to ${goPath}`}
          >
            <Text className="text-sm font-semibold text-blue-700">Go there</Text>
            <Ionicons name="arrow-forward" size={14} color="#1D4ED8" style={{ marginLeft: 4 }} />
          </Pressable>
        )}
      </View>
    </View>
  )
}

export default function AssistantChat() {
  const router = useRouter()
  const pathname = usePathname()
  const { profile } = useAuth()
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef(null)

  const firstName = profile?.full_name?.split(' ')[0] || 'there'

  const scrollToEnd = useCallback(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 50)
  }, [])

  const send = useCallback(async (raw) => {
    const text = (raw ?? input).trim()
    if (!text || loading) return

    // Optimistically append the user's message; the history we send is
    // exactly what's now on screen (role + content only).
    const userMessage = { role: 'user', content: text }
    const base = [...messages, userMessage]
    setMessages(base)
    setInput('')
    setLoading(true)
    scrollToEnd()

    const res = await sendAssistantChat(
      base.map(({ role, content }) => ({ role, content })),
      { currentPage: pathname },
    )
    setLoading(false)

    // api() never throws — it returns { success:false, error } on
    // failure. Surface either the reply or an inline error bubble.
    if (!res || res.success === false) {
      setMessages([
        ...base,
        { role: 'assistant', content: `Sorry, something went wrong: ${res?.error || 'unknown error'}`, error: true },
      ])
    } else {
      setMessages([
        ...base,
        { role: 'assistant', content: res.response || '…', navigateTo: res.navigateTo ?? null },
      ])
    }
    scrollToEnd()
  }, [input, loading, messages, pathname, scrollToEnd])

  // Tapping "Go there" leaves the chat and pushes the in-app route.
  const navigate = useCallback((path) => {
    router.push(path)
  }, [router])

  const empty = messages.length === 0

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      className="flex-1 bg-un1t-bg"
    >
      {/* assistant/ is a single-screen sub-stack pushed from /more, so
          iOS won't auto-render a back chevron — opt in. */}
      <Stack.Screen
        options={{
          title: 'AI Assistant',
          headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" />,
        }}
      />

      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName="p-4"
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd?.({ animated: false })}
      >
        {empty ? (
          <View>
            {/* Welcome message — mirrors the web bubble's greeting. */}
            <View className="flex-row mb-3">
              <AssistantAvatar />
              <View className="max-w-[80%] bg-un1t-surface border border-un1t-border rounded-2xl px-3.5 py-2.5">
                <Text className="text-base text-un1t-text">
                  Hi {firstName}! I&apos;m your UN1T assistant. I can help you navigate the CRM,
                  answer questions, or take actions for you. What can I help with?
                </Text>
              </View>
            </View>

            {/* Suggestion chips */}
            <View className="flex-row flex-wrap pl-9">
              {WELCOME_SUGGESTIONS.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => send(s)}
                  className="border border-un1t-border rounded-full px-3.5 py-2 mr-2 mb-2 active:bg-un1t-border/40"
                  accessibilityRole="button"
                  accessibilityLabel={s}
                >
                  <Text className="text-sm text-un1t-subtle">{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          messages.map((m, i) => (
            <Bubble key={i} msg={m} onNavigate={navigate} />
          ))
        )}

        {/* Thinking… indicator while awaiting the reply. */}
        {loading && (
          <View className="flex-row mb-2.5 justify-start">
            <AssistantAvatar />
            <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-3 flex-row items-center">
              <ActivityIndicator size="small" color="#94A3B8" />
              <Text className="text-sm text-un1t-subtle ml-2">Thinking…</Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Composer — bottom padding accounts for the home-indicator safe
          area when the keyboard is closed; KeyboardAvoidingView handles
          the open case. */}
      <View
        className="border-t border-un1t-border bg-un1t-bg px-3 pt-2 flex-row items-end"
        style={{ paddingBottom: Math.max(insets.bottom, 8) }}
      >
        <TextInput
          value={input}
          onChangeText={setInput}
          multiline
          placeholder="Ask me anything…"
          placeholderTextColor="#94A3B8"
          editable={!loading}
          className="flex-1 bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-2.5 text-base text-un1t-text max-h-32"
          textAlignVertical="top"
        />
        <Pressable
          onPress={() => send()}
          disabled={!input.trim() || loading}
          className={`w-10 h-10 rounded-full ml-2 items-center justify-center ${
            input.trim() && !loading ? 'bg-blue-600' : 'bg-un1t-border'
          }`}
          accessibilityRole="button"
          accessibilityLabel="Send"
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Ionicons name="arrow-up" size={20} color="#FFFFFF" />
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}
