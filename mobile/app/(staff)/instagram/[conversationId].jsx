// Instagram DM thread — message list + composer (MOBILE-MSG.M2).
//
// Mirrors the WhatsApp thread screen but rides the /api/instagram/*
// routes (the instagram_* tables deny direct authenticated reads).
// No template picker and no 24h-window banner: IG has no template
// mechanism — if Meta rejects a send because the messaging window
// lapsed, the send route surfaces the error and we show it.
//
// Loading the thread resets unread_count server-side (the GET does it).

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useLocalSearchParams, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '../../../lib/auth-context'
import {
  getThread, sendText, resolveConversation, rateAgentMessage,
  setAgentActive, igDisplayName,
} from '../../../lib/instagram-api'
import { listConversationApprovals } from '../../../lib/inbox-approvals-api'
import { needsReply, isAgentHandoff } from '../../../lib/inbox'
import { mergeTimeline } from 'shared/approval-cards'
import MessageBubble from '../../../components/MessageBubble'
import ThreadApprovalCard from '../../../components/ThreadApprovalCard'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function InstagramConversation() {
  const { conversationId } = useLocalSearchParams()
  const { activeLocation } = useAuth()
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const [conv, setConv] = useState(null)
  const [messages, setMessages] = useState([])
  const [approvals, setApprovals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [togglingAgent, setTogglingAgent] = useState(false)
  const [feedback, setFeedback] = useState({})
  const scrollRef = useRef(null)

  const refresh = useCallback(async () => {
    const [res, approvalsRes] = await Promise.all([
      getThread(conversationId, activeLocation?.id),
      listConversationApprovals(conversationId),
    ])
    if (!res.success) {
      setError(res.error || 'Failed to load conversation')
      return
    }
    setError(null)
    setConv(res.conversation)
    setMessages(res.messages || [])
    if (approvalsRes.success) setApprovals(approvalsRes.requests || [])
  }, [conversationId, activeLocation])

  useEffect(() => {
    setLoading(true)
    setApprovals([])
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

  // AGENT-TAKEOVER visibility — hand the thread to staff (silence Mia)
  // or back to her, mirroring the web IG inbox header toggle.
  async function toggleAgent(active) {
    if (togglingAgent) return
    setTogglingAgent(true)
    const res = await setAgentActive(conversationId, active, activeLocation?.id)
    setTogglingAgent(false)
    if (!res.success) {
      Alert.alert('Couldn’t update agent state', res.error || 'Unknown error')
      return
    }
    refresh()
  }

  // Mark handled — server-side this re-arms Mia on a handed-off thread
  // (AGENT-REARM.1), same loop as WhatsApp.
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

  const name = igDisplayName(conv)
  const contactFirstName = conv?.contacts?.first_name || conv?.ig_username || null

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
      ) : error ? (
        <View className="flex-1 items-center justify-center px-8">
          <Ionicons name="alert-circle-outline" size={32} color="#DC2626" />
          <Text className="text-sm text-red-600 mt-2 text-center">{error}</Text>
        </View>
      ) : (
        <>
          {/* AGENT-TAKEOVER visibility — who's driving this thread.
              Mirrors the web IG inbox: agent_active !== false means Mia
              replies; staff can take over (or a manual send does it),
              and hand back re-arms her. */}
          {conv && (
            <View className="bg-un1t-bg border-b border-un1t-border px-4 py-2 flex-row items-center">
              {conv.agent_active !== false ? (
                <>
                  <Ionicons name="sparkles" size={13} color="#64748B" />
                  <Text className="text-xs text-un1t-subtle flex-1 ml-1.5">Agent active</Text>
                  <Pressable onPress={() => toggleAgent(false)} disabled={togglingAgent} hitSlop={8}>
                    {togglingAgent
                      ? <ActivityIndicator size="small" />
                      : <Text className="text-xs text-amber-700 font-semibold">Take over</Text>}
                  </Pressable>
                </>
              ) : (
                <>
                  <Ionicons name="person-outline" size={13} color="#B45309" />
                  <Text className="text-xs text-amber-700 flex-1 ml-1.5">You’re handling this</Text>
                  <Pressable onPress={() => toggleAgent(true)} disabled={togglingAgent} hitSlop={8}>
                    {togglingAgent
                      ? <ActivityIndicator size="small" />
                      : <Text className="text-xs text-blue-600 font-semibold">Hand back to agent</Text>}
                  </Pressable>
                </>
              )}
            </View>
          )}

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

          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentContainerClassName="p-4"
            onContentSizeChange={() => scrollRef.current?.scrollToEnd?.({ animated: false })}
          >
            {mergeTimeline(messages, approvals).map(item => (
              item.kind === 'approval' ? (
                <ThreadApprovalCard
                  key={item.key}
                  request={item.request}
                  contactFirstName={contactFirstName}
                  onDecided={merged => { setApprovals(p => p.map(r => (r.id === merged.id ? merged : r))); refresh() }}
                  onPrefillComposer={t => setText(t)}
                />
              ) : (
                <MessageBubble key={item.key} msg={item.message} channel="instagram" myRating={feedback[item.message.id] || null} onRate={rate} />
              )
            ))}
          </ScrollView>

          <View
            className="border-t border-un1t-border bg-un1t-bg px-3 pt-2 flex-row items-end"
            style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          >
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              placeholder="Message…"
              placeholderTextColor="#94A3B8"
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
