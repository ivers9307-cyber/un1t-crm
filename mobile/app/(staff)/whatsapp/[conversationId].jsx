// WhatsApp conversation thread — message list + composer.
//
// iOS Messages-style bubbles: inbound on the left in grey, outbound
// on the right in white-on-blue. Sticky composer at the bottom; sends
// either a text (when within the 24h window) or a template (anytime,
// chosen from a sheet).
//
// The thread loads via the web /api/whatsapp/conversations/[id] GET
// (getThread) — one call for conversation + messages + booking-Flow
// availability, and it resets unread_count server-side (THREAD-M.1;
// previously three direct Supabase reads + a mark-read update).

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useHeaderHeight } from 'expo-router/react-navigation'
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
import { useAuth } from '../../../lib/auth-context'
import {
  getThread, isWindowOpen, sendText, sendTemplate, listTemplates,
  resolveConversation, rateAgentMessage, setBlocked,
  reactToInboundMessage, listCardSets, sendCardSet, sendBookingFlow,
} from '../../../lib/whatsapp-api'
import { listConversationApprovals } from '../../../lib/inbox-approvals-api'
import { needsReply, isAgentHandoff } from '../../../lib/inbox'
import { mergeTimeline } from 'shared/approval-cards'
import { groupWaTemplates, UNGROUPED_LABEL } from 'shared/wa-template-groups'
import MessageBubble from '../../../components/MessageBubble'
import ThreadApprovalCard from '../../../components/ThreadApprovalCard'

export default function Conversation() {
  const { conversationId } = useLocalSearchParams()
  const router = useRouter()
  const { activeLocation } = useAuth()
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const [conv, setConv] = useState(null)
  const [messages, setMessages] = useState([])
  const [approvals, setApprovals] = useState([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [templates, setTemplates] = useState([])
  const [resolving, setResolving] = useState(false)
  const [feedback, setFeedback] = useState({})
  // FLOW-SEND — whether this location has the booking Flow configured
  // (comes back on the thread GET, same as web).
  const [flowAvailable, setFlowAvailable] = useState(false)
  const [sendingFlow, setSendingFlow] = useState(false)
  // C4 — operator-curated card sets. null = not fetched yet (lazy —
  // loaded the first time an open-window composer renders, then cached;
  // [] on load failure hides the control, mirroring web).
  const [cardSets, setCardSets] = useState(null)
  const [showCardSets, setShowCardSets] = useState(false)
  const [sendingCardSet, setSendingCardSet] = useState(false)
  // WA-BLOCK + C6 action state.
  const [blocking, setBlocking] = useState(false)
  const [reactingId, setReactingId] = useState(null)
  const scrollRef = useRef(null)

  // One call for conversation + messages + flow availability; the GET
  // also resets unread_count server-side (no separate mark-read).
  const refresh = useCallback(async () => {
    const [threadRes, approvalsRes] = await Promise.all([
      getThread(conversationId, activeLocation?.id),
      listConversationApprovals(conversationId),
    ])
    if (threadRes.success) {
      setConv(threadRes.conversation)
      setMessages(threadRes.messages || [])
      setFlowAvailable(threadRes.flowAvailable)
    }
    if (approvalsRes.success) setApprovals(approvalsRes.requests || [])
  }, [conversationId, activeLocation])

  useEffect(() => {
    setLoading(true)
    setApprovals([])
    refresh().finally(() => setLoading(false))
  }, [conversationId, refresh])

  useEffect(() => {
    // Auto-scroll to the latest message after load + on new messages.
    if (messages.length && scrollRef.current) {
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 50)
    }
  }, [messages.length])

  const windowOpen = isWindowOpen(conv)

  // C4 — lazy card-set fetch: the first time the thread renders with an
  // open 24h window, load the location's card sets once and cache them
  // for the screen. [] (loaded-but-empty or failure) hides the control.
  useEffect(() => {
    if (cardSets !== null || !activeLocation?.id || !windowOpen) return
    let cancelled = false
    listCardSets(activeLocation.id).then(res => {
      if (!cancelled) setCardSets(res.success ? res.data : [])
    })
    return () => { cancelled = true }
  }, [cardSets, activeLocation, windowOpen])

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

  // WA-BLOCK — block/unblock the sender at Meta (spam/abuse; protects the
  // number's quality rating). Confirmed action, mirroring the web copy.
  function toggleBlocked() {
    if (!conv || blocking) return
    const next = !conv.is_blocked
    Alert.alert(
      next ? 'Block this sender?' : 'Unblock this sender?',
      next
        ? 'They will no longer be able to message this number (and it cannot message them).'
        : undefined,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: next ? 'Block' : 'Unblock',
          style: next ? 'destructive' : 'default',
          onPress: async () => {
            setBlocking(true)
            const res = await setBlocked(conversationId, next, activeLocation?.id)
            setBlocking(false)
            if (!res.success) {
              Alert.alert('Couldn’t update block state', res.error || 'Unknown error')
              return
            }
            setConv(prev => (prev ? { ...prev, is_blocked: next } : prev))
          },
        },
      ]
    )
  }

  // C6 — react to a customer message. The route logs the thread row; web
  // relies on realtime to surface it, mobile refreshes explicitly.
  async function react(msg, emoji) {
    if (!msg.wa_message_id || reactingId) return
    setReactingId(msg.id)
    const res = await reactToInboundMessage(conversationId, msg.wa_message_id, emoji, activeLocation?.id)
    setReactingId(null)
    if (!res.success) {
      Alert.alert('Couldn’t react', res.error || 'Unknown error')
      return
    }
    refresh()
  }

  // C4 — send the chosen card set as an in-session media carousel.
  async function sendChosenCardSet(set) {
    setShowCardSets(false)
    setSendingCardSet(true)
    const res = await sendCardSet(conversationId, set.id, activeLocation?.id)
    setSendingCardSet(false)
    if (!res.success) {
      Alert.alert('Couldn’t send card set', res.error || 'Unknown error')
      return
    }
    refresh()
  }

  // FLOW-SEND — drop the booking Flow into the chat (in-session; the
  // route enforces linked-contact + configured-Flow).
  async function sendFlow() {
    if (sendingFlow) return
    setSendingFlow(true)
    const res = await sendBookingFlow(conversationId, activeLocation?.id)
    setSendingFlow(false)
    if (!res.success) {
      Alert.alert('Couldn’t send booking Flow', res.error || 'Unknown error')
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
  const contactFirstName = conv?.contacts?.first_name || conv?.wa_profile_name?.split(' ')[0] || null

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
          headerRight: conv
            ? () => (
                <View className="flex-row items-center">
                  {/* WA-BLOCK — red when blocked (tap to unblock) */}
                  <Pressable onPress={toggleBlocked} disabled={blocking} hitSlop={10} className="mr-3">
                    {blocking
                      ? <ActivityIndicator size="small" />
                      : (
                        <Ionicons
                          name={conv.is_blocked ? 'ban' : 'ban-outline'}
                          size={22}
                          color={conv.is_blocked ? '#DC2626' : '#94A3B8'}
                        />
                      )}
                  </Pressable>
                  {!conv.resolved_at && (needsReply(conv) || isAgentHandoff(conv)) && (
                    <Pressable onPress={resolve} disabled={resolving} hitSlop={10}>
                      {resolving
                        ? <ActivityIndicator size="small" />
                        : <Ionicons name="checkmark-circle-outline" size={26} color="#16A34A" />}
                    </Pressable>
                  )}
                </View>
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

          {/* WA-BLOCK state chip — the sender is blocked at Meta; no
              messages can be exchanged until unblocked (header ban icon). */}
          {conv?.is_blocked && (
            <View className="bg-red-500/10 border-b border-red-500/30 px-4 py-2 flex-row items-center">
              <Ionicons name="ban" size={14} color="#B91C1C" />
              <Text className="text-xs text-red-700 ml-2">
                Sender blocked — messages can’t be exchanged with this number.
              </Text>
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
                <MessageBubble
                  key={item.key}
                  msg={item.message}
                  myRating={feedback[item.message.id] || null}
                  onRate={rate}
                  onReact={react}
                  reactingId={reactingId}
                  channel="whatsapp"
                />
              )
            ))}
          </ScrollView>

          {/* Composer — bottom padding accounts for the home-indicator
              safe area when the keyboard is closed, but collapses to 8
              when the keyboard is open (KeyboardAvoidingView replaces
              the inset). */}
          <View
            className="border-t border-un1t-border bg-un1t-bg px-3 pt-2"
            style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          >
            {/* Composer extras — same gating as web: card sets show when
                the location has any configured (C4), the booking Flow
                when it's configured AND the sender is a linked contact
                (FLOW-SEND). Both are in-session sends → window-open only. */}
            {windowOpen && ((Array.isArray(cardSets) && cardSets.length > 0) || (flowAvailable && conv?.contact_id)) && (
              <View className="flex-row items-center mb-2">
                {Array.isArray(cardSets) && cardSets.length > 0 && (
                  <Pressable
                    onPress={() => setShowCardSets(true)}
                    disabled={sendingCardSet}
                    className="flex-row items-center bg-un1t-surface border border-un1t-border rounded-full px-3 py-1.5 mr-2 active:opacity-70"
                  >
                    <Ionicons name="images-outline" size={14} color="#111827" />
                    <Text className="text-xs text-un1t-text ml-1.5">
                      {sendingCardSet ? 'Sending cards…' : 'Send cards'}
                    </Text>
                  </Pressable>
                )}
                {flowAvailable && conv?.contact_id && (
                  <Pressable
                    onPress={sendFlow}
                    disabled={sendingFlow}
                    className="flex-row items-center bg-un1t-surface border border-un1t-border rounded-full px-3 py-1.5 active:opacity-70"
                  >
                    <Ionicons name="calendar-outline" size={14} color="#111827" />
                    <Text className="text-xs text-un1t-text ml-1.5">
                      {sendingFlow ? 'Sending…' : 'Send booking Flow'}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
            <View className="flex-row items-end">
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
                  {/* WA-TPL-GROUPS — bucketed by operator-set display_group
                      (mig 450), same shared ordering as the web picker. A
                      lone Ungrouped bucket needs no header. */}
                  {groupWaTemplates(templates).map((group, _, groups) => (
                    <View key={group.label}>
                      {!(groups.length === 1 && group.label === UNGROUPED_LABEL) && (
                        <Text className="text-[11px] font-semibold text-un1t-subtle uppercase tracking-wider mb-1.5 mt-1">
                          {group.label}
                        </Text>
                      )}
                      {group.templates.map(t => (
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
                    </View>
                  ))}
                </ScrollView>
              </Pressable>
            </Pressable>
          )}

          {/* C4 — card-set picker (same sheet pattern as templates);
              tapping a set sends it as an in-session media carousel. */}
          {showCardSets && (
            <Pressable
              className="absolute inset-0 bg-black/40 items-end"
              onPress={() => setShowCardSets(false)}
            >
              <Pressable
                className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl mt-auto w-full max-h-[60%] p-4"
                onPress={() => {}}
              >
                <View className="flex-row items-center justify-between mb-3">
                  <Text className="text-base font-semibold text-un1t-text">Send card set</Text>
                  <Pressable onPress={() => setShowCardSets(false)} hitSlop={10}>
                    <Ionicons name="close" size={22} color="#111827" />
                  </Pressable>
                </View>
                <ScrollView>
                  {(cardSets || []).map(s => (
                    <Pressable
                      key={s.id}
                      onPress={() => sendChosenCardSet(s)}
                      className="bg-un1t-surface border border-un1t-border rounded-xl p-3 mb-2 active:opacity-70"
                    >
                      <Text className="text-sm font-semibold text-un1t-text">{s.name}</Text>
                      <Text className="text-xs text-un1t-subtle mt-1" numberOfLines={2}>
                        {s.cards?.length || 0} cards{s.body_text ? ` · ${s.body_text}` : ''}
                      </Text>
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
