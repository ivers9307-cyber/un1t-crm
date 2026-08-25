// EVENT-CHECKIN.E — mobile event detail (browse). Metadata + live
// attendance summary + actions. Data comes from the check-in roster GET
// (getCheckinRoster), which returns the event metadata + counts. The
// interactive roster lives on the existing /races/checkin/[id] screen
// (kind-agnostic, reused unchanged). Non-race kinds reach check-in here;
// races also expose the race-day control board.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, Linking } from 'react-native'
import Constants from 'expo-constants'
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { getCheckinRoster } from '../../../lib/event-checkin-api'
import { eventDateLabel, eventKindBadgeClasses } from '../../../lib/events-api'
import { eventKindLabel, isRaceKind } from 'shared/events'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

function MetaRow({ icon, children }) {
  if (!children) return null
  return (
    <View className="flex-row items-center mb-2">
      <Ionicons name={icon} size={15} color="#64748B" />
      <Text className="text-sm text-un1t-text ml-2">{children}</Text>
    </View>
  )
}

export default function EventDetail() {
  const { id } = useLocalSearchParams()
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'races', activeLocation)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const res = await getCheckinRoster(id, { locationId: activeLocation?.id })
    if (res.success === false) { setError(res.error || 'Failed to load'); return }
    setError(null)
    setData(res.data)
  }, [id, activeLocation?.id])

  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return undefined }
    let alive = true
    setLoading(true)
    load().finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [canView, load]))

  const event = data?.event
  const counts = data?.counts
  const badge = eventKindBadgeClasses(event?.kind ?? 'race')

  function openPublicPage() {
    const base = Constants.expoConfig?.extra?.apiBaseUrl
    if (base && event?.slug) Linking.openURL(`${base}/event/${event.slug}`)
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: event?.name || 'Event', headerLeft: () => <BackHeaderLeft label="Events" fallbackHref="/events" /> }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Events are only shown where they're enabled for you.</Text>
        </View>
      ) : loading && !data ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator color="#94A3B8" /></View>
      ) : error && !data ? (
        <View className="flex-1 items-center justify-center p-6">
          <Text className="text-sm text-red-700 text-center">{error}</Text>
          <Pressable onPress={() => router.back()} className="mt-4"><Text className="text-sm text-blue-600">Back</Text></Pressable>
        </View>
      ) : event ? (
        <ScrollView contentContainerClassName="px-4 py-4 pb-12">
          {/* Header: name + kind badge */}
          <View className="flex-row items-center mb-4">
            <Text className="text-xl font-bold text-un1t-text flex-1" numberOfLines={2}>{event.name}</Text>
            <View className={`px-2.5 py-1 rounded-full ml-2 ${badge.bg}`}>
              <Text className={`text-[11px] uppercase tracking-wider ${badge.text}`}>{eventKindLabel(event.kind)}</Text>
            </View>
          </View>

          {/* Metadata */}
          <View className="bg-white border border-un1t-border rounded-2xl p-4 mb-4">
            <MetaRow icon="calendar-outline">
              {eventDateLabel(event.race_date)}{event.start_time ? ` · ${String(event.start_time).slice(0, 5)}` : ''}
            </MetaRow>
            {Number.isFinite(event.capacity) && event.capacity > 0 ? (
              <MetaRow icon="people-outline">
                Capacity {event.capacity} {event.capacity_mode === 'people' ? 'people' : 'teams'}
              </MetaRow>
            ) : null}
            <MetaRow icon={event.active === false ? 'pause-circle-outline' : 'checkmark-circle-outline'}>
              {event.active === false ? 'Inactive' : 'Active'}
            </MetaRow>
            {event.slug ? (
              <Pressable onPress={openPublicPage} className="flex-row items-center mt-1 active:opacity-60">
                <Ionicons name="open-outline" size={15} color="#2563EB" />
                <Text className="text-sm text-blue-600 ml-2">Public signup page</Text>
              </Pressable>
            ) : null}
          </View>

          {/* Live attendance */}
          <View className="bg-white border border-un1t-border rounded-2xl p-4 mb-4">
            <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">Checked in</Text>
            {counts && counts.expected > 0 ? (
              <Text className="text-2xl font-bold text-un1t-text">{counts.present} <Text className="text-base font-normal text-un1t-subtle">/ {counts.expected} people</Text></Text>
            ) : (
              <Text className="text-sm text-un1t-subtle">No one registered yet.</Text>
            )}
          </View>

          {/* Actions */}
          <Pressable
            onPress={() => router.push(`/races/checkin/${id}`)}
            className="bg-blue-600 rounded-2xl py-3.5 items-center flex-row justify-center mb-2 active:opacity-80"
          >
            <Ionicons name="checkmark-done-outline" size={18} color="#FFFFFF" />
            <Text className="text-base font-semibold text-white ml-2">Attendees & check in</Text>
          </Pressable>

          {isRaceKind(event.kind) && (
            <Pressable
              onPress={() => router.push(`/races/${id}`)}
              className="border border-un1t-border rounded-2xl py-3.5 items-center flex-row justify-center active:bg-un1t-border/40"
            >
              <Ionicons name="flag-outline" size={18} color="#111827" />
              <Text className="text-base font-semibold text-un1t-text ml-2">Race-day control</Text>
            </Pressable>
          )}
        </ScrollView>
      ) : null}
    </View>
  )
}
