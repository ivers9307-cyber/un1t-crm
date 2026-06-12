// WhatsApp inbox tab.
//
// Lists conversations for the active location, newest message first,
// with unread-count badges. Queue chips (All / Needs reply / Agent
// handoff) mirror the web unified inbox so a coach on their phone can
// triage exactly what the desk sees — especially threads Mia escalated
// (MOBILE-MSG.M1). Tapping opens the conversation thread.
// Pull-to-refresh re-fetches.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { listConversations, isWindowOpen } from '../../lib/whatsapp-api'
import { isAgentHandoff, queueCounts, filterByQueue, QUEUES } from '../../lib/inbox'

function ConversationRow({ conv, onPress }) {
  const c = conv.contacts
  const name = c?.name
    || [c?.first_name, c?.last_name].filter(Boolean).join(' ')
    || conv.wa_profile_name
    || conv.wa_phone
  const isInbound = conv.last_message_direction === 'inbound'
  const time = conv.last_message_at
    ? new Date(conv.last_message_at).toLocaleString(undefined, {
        hour: 'numeric', minute: '2-digit',
        // If older than today, also show date
        ...(isToday(conv.last_message_at) ? {} : { month: 'short', day: 'numeric' }),
      })
    : ''
  const windowOpen = isWindowOpen(conv)
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 flex-row items-center active:opacity-70"
    >
      <View className="w-11 h-11 rounded-full bg-un1t-border/40 items-center justify-center mr-3">
        <Text className="text-base font-semibold text-un1t-text">
          {(name?.[0] || '?').toUpperCase()}
        </Text>
      </View>
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>
            {name}
          </Text>
          <Text className="text-xs text-un1t-subtle ml-2">{time}</Text>
        </View>
        <View className="flex-row items-center mt-0.5">
          {isInbound ? null : (
            <Ionicons name="checkmark" size={12} color="#94A3B8" style={{ marginRight: 4 }} />
          )}
          <Text className="text-sm text-un1t-subtle flex-1" numberOfLines={1}>
            {conv.last_message_preview || '—'}
          </Text>
          {isAgentHandoff(conv) && (
            <View className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/20 flex-row items-center">
              <Ionicons name="hand-left-outline" size={10} color="#B45309" style={{ marginRight: 3 }} />
              <Text className="text-[10px] uppercase text-amber-700 font-semibold">Needs human</Text>
            </View>
          )}
          {!windowOpen && !isAgentHandoff(conv) && (
            <View className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/20">
              <Text className="text-[10px] uppercase text-amber-700 font-medium">Closed</Text>
            </View>
          )}
        </View>
      </View>
      {conv.unread_count > 0 && (
        <View className="ml-2 min-w-[20px] h-5 px-1.5 rounded-full bg-green-500 items-center justify-center">
          <Text className="text-[11px] text-white font-semibold">{conv.unread_count}</Text>
        </View>
      )}
    </Pressable>
  )
}

function isToday(iso) {
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
}

export default function WhatsApp() {
  const { activeLocation } = useAuth()
  const router = useRouter()
  const [conversations, setConversations] = useState([])
  const [queue, setQueue] = useState('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!activeLocation) return
    setError(null)
    const res = await listConversations(activeLocation.id)
    if (!res.success) setError(res.error || 'Failed to load conversations')
    setConversations(res.success ? res.data || [] : [])
  }, [activeLocation])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  // Re-fetch every time the tab becomes focused so unread counts update
  // after returning from a conversation thread.
  useFocusEffect(
    useCallback(() => {
      load()
    }, [load])
  )

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const counts = queueCounts(conversations)
  const visible = filterByQueue(conversations, queue)

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerClassName="p-4 pb-24"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
    >
      {error && (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
          <Text className="text-red-500 text-sm">{error}</Text>
        </View>
      )}

      {/* Queue chips — same triage queues as the web unified inbox. */}
      <View className="flex-row mb-3">
        {QUEUES.map(q => {
          const count = counts[q.key]
          const active = queue === q.key
          return (
            <Pressable
              key={q.key}
              onPress={() => setQueue(q.key)}
              className={`flex-row items-center px-3 py-1.5 rounded-full mr-2 border ${
                active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-surface border-un1t-border'
              }`}
            >
              <Text className={`text-xs font-semibold ${active ? 'text-white' : 'text-un1t-text'}`}>
                {q.label}
              </Text>
              {q.key !== 'all' && count > 0 && (
                <View className={`ml-1.5 min-w-[18px] px-1 h-[18px] rounded-full items-center justify-center ${
                  q.key === 'handoff' ? 'bg-amber-500' : 'bg-green-500'
                }`}>
                  <Text className="text-[10px] text-white font-bold">{count}</Text>
                </View>
              )}
            </Pressable>
          )
        })}
      </View>

      {visible.length === 0 ? (
        <View className="py-16 items-center">
          <Ionicons
            name={queue === 'all' ? 'chatbubbles-outline' : 'checkmark-done-circle-outline'}
            size={32}
            color="#94A3B8"
          />
          <Text className="text-sm text-un1t-subtle mt-2">
            {queue === 'all' ? 'No conversations yet.'
              : queue === 'handoff' ? 'No conversations waiting on a human.'
              : 'Queue clear — nothing needs a reply.'}
          </Text>
        </View>
      ) : (
        visible.map(c => (
          <ConversationRow
            key={c.id}
            conv={c}
            onPress={() => router.push(`/whatsapp/${c.id}`)}
          />
        ))
      )}
    </ScrollView>
  )
}
