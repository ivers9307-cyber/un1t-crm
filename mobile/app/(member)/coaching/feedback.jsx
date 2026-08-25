// Coach feedback history — every note a coach has shared with this member.
//
// Pushed from the Coaching hub's "All feedback ›". Reads the CRM-API route
// GET /api/consultations/me (crmApi attaches the member's Bearer JWT). That
// route returns ONLY feedback-bearing consultations, newest-first, and never
// the coach's private notes — { id, consulted_at, member_feedback, coach_name }.
//
// Back-header + loading / empty / error pattern mirrors inbody.jsx.

import { useState, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { crmApi } from '../../../lib/member/api'
import Card from '../../../components/member/ui/Card'
import ErrorRetry from '../../../components/member/ErrorRetry'
import { PEARL } from '../../../lib/member/brand'

// ── Formatting ───────────────────────────────────────────────────────────────

const fmtDate = (iso) => {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  return new Intl.DateTimeFormat('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(t))
}

// First initial of the coach's name → avatar glyph. Falls back to a generic
// person icon when there's no name.
const initial = (name) => {
  const c = String(name || '').trim().charAt(0)
  return c ? c.toUpperCase() : ''
}

export default function CoachFeedback() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState([])
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await crmApi('/api/consultations/me')
      if (res?.success === false) throw new Error(res.error || 'Failed to load feedback')
      setItems(Array.isArray(res?.data) ? res.data : [])
    } catch (e) {
      setError(e?.message || 'Failed to load feedback')
    } finally {
      setLoading(false)
    }
  }, [])

  useFocusEffect(
    useCallback(() => { load() }, [load])
  )

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center" edges={['left', 'right']}>
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  // Only show the error screen on a failed load with nothing rendered — a
  // transient focus-refetch failure must not blank an already-listed history.
  if (error && items.length === 0) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
        <ScrollView contentContainerClassName="p-5 pb-24">
          <Header onBack={() => router.back()} />
          <View className="mt-6">
            <ErrorRetry onPress={load} />
          </View>
        </ScrollView>
      </SafeAreaView>
    )
  }

  if (items.length === 0) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
        <ScrollView contentContainerClassName="p-5 pb-24">
          <Header onBack={() => router.back()} />
          <Card className="mt-6 items-center py-8">
            <Ionicons name="chatbubble-ellipses-outline" size={32} color="#727170" />
            <Text className="mt-3 text-base font-display text-chalk">No feedback yet</Text>
            <Text className="mt-1 text-sm text-chalk-2 text-center">
              When a coach shares feedback after a session, it'll show up here.
            </Text>
          </Card>
        </ScrollView>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24" showsVerticalScrollIndicator={false}>
        <Header onBack={() => router.back()} />

        <View className="mt-6" style={{ gap: 16 }}>
          {items.map((item, i) => (
            <FeedbackCard key={item.id || i} item={item} />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({ onBack }) {
  return (
    <View>
      <Pressable
        onPress={onBack}
        className="flex-row items-center gap-1 mb-4 self-start active:opacity-60"
      >
        <Ionicons name="chevron-back-outline" size={18} color="#B3B2AC" />
        <Text className="text-sm text-chalk-2">Back</Text>
      </Pressable>
      <View className="flex-row items-center" style={{ gap: 10 }}>
        <Text className="text-2xl font-display-bold text-chalk">Coach feedback</Text>
        <View className="rounded-full border border-iron-hairline bg-iron-raised px-2.5 py-0.5">
          <Text className="font-mono text-[10px] uppercase text-chalk-2" style={{ letterSpacing: 1.2 }}>From your coach</Text>
        </View>
      </View>
    </View>
  )
}

// ── Feedback card ────────────────────────────────────────────────────────────

function FeedbackCard({ item }) {
  const glyph = initial(item.coach_name)
  return (
    <Card>
      <View className="flex-row items-center" style={{ gap: 12 }}>
        <View
          className="h-9 w-9 items-center justify-center rounded-full"
          style={{ backgroundColor: 'rgba(214,210,201,0.16)' }}
        >
          {glyph ? (
            <Text className="text-sm font-display-bold" style={{ color: PEARL }}>{glyph}</Text>
          ) : (
            <Ionicons name="person-outline" size={16} color={PEARL} />
          )}
        </View>
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-body-semibold text-chalk" numberOfLines={1}>
            {item.coach_name || 'Your coach'}
            <Text className="text-chalk-3"> · Coach</Text>
          </Text>
        </View>
        <Text className="font-mono text-xs text-chalk-2 shrink-0">{fmtDate(item.consulted_at)}</Text>
      </View>

      <Text className="mt-3 text-sm leading-5 text-chalk-2">{item.member_feedback}</Text>
    </Card>
  )
}
