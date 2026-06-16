// EVENT-CHECKIN.E — mobile events browse list (all kinds). Mirrors web
// /events. Race rows open the existing race-day control board; non-race
// rows open the event detail (→ the kind-agnostic check-in roster).
// Gated by canMobile('races') — the same key that gates the whole events
// feature. The list endpoint is staff-accessible, so door staff see it.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { listEvents, eventDateLabel } from '../../lib/events-api'
import { eventKindLabel, eventKindTone, isRaceKind } from '../../../shared/events'
import BackHeaderLeft from '../../components/BackHeaderLeft'

// Semantic tone (shared/events) → NativeWind pill classes.
const TONE_CLS = {
  emerald: 'bg-emerald-500/15 text-emerald-700',
  sky:     'bg-sky-500/15 text-sky-700',
  indigo:  'bg-indigo-500/15 text-indigo-700',
  amber:   'bg-amber-500/15 text-amber-700',
  pink:    'bg-pink-500/15 text-pink-700',
  teal:    'bg-teal-500/15 text-teal-700',
}

function EventRow({ event, onPress }) {
  const toneCls = TONE_CLS[eventKindTone(event.kind)] || TONE_CLS.emerald
  return (
    <Pressable
      onPress={onPress}
      className="bg-white border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
    >
      <View className="flex-row items-center justify-between mb-0.5">
        <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>{event.name || 'Event'}</Text>
        <View className={`px-2 py-0.5 rounded-full ml-2 ${toneCls}`}>
          <Text className={`text-[10px] uppercase tracking-wider ${toneCls.split(' ')[1]}`}>{eventKindLabel(event.kind)}</Text>
        </View>
      </View>
      <Text className="text-xs text-un1t-subtle">
        {eventDateLabel(event.race_date)}
        {event.start_time ? ` · ${String(event.start_time).slice(0, 5)}` : ''}
        {event.active === false ? '  · Inactive' : ''}
      </Text>
      <Text className="text-xs text-un1t-subtle mt-1">{event.signup_summary}</Text>
    </Pressable>
  )
}

export default function EventsList() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'races', activeLocation)

  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const res = await listEvents({ locationId: activeLocation?.id })
    if (res.success === false) { setError(res.error || 'Failed to load'); setEvents([]); return }
    setError(null)
    setEvents(Array.isArray(res.data) ? res.data : [])
  }, [activeLocation?.id])

  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canView, load]))

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  function openEvent(ev) {
    // Race → existing control board; non-race → the event detail.
    if (isRaceKind(ev.kind)) router.push(`/races/${ev.id}`)
    else router.push(`/events/${ev.id}`)
  }

  // First past event marks where the "Past" divider goes.
  const firstPastId = events.find((e) => e.is_upcoming === false)?.id || null

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Events', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Events are only shown where they're enabled for you.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerClassName="px-4 py-3 pb-10"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
        >
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}

          {loading ? (
            <View className="py-12 items-center"><ActivityIndicator /></View>
          ) : events.length === 0 ? (
            <View className="py-16 items-center px-6">
              <Ionicons name="calendar-outline" size={30} color="#94A3B8" />
              <Text className="text-base font-semibold text-un1t-text mt-3">No events</Text>
              <Text className="text-xs text-un1t-subtle text-center mt-1">Events at {activeLocation?.name || 'this studio'} show up here. Create them on the web.</Text>
            </View>
          ) : (
            events.map((ev) => (
              <View key={ev.id}>
                {ev.id === firstPastId && (
                  <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mt-3 mb-2">Past</Text>
                )}
                <EventRow event={ev} onPress={() => openEvent(ev)} />
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  )
}
