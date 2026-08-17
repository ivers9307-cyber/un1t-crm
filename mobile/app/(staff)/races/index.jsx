// W3 — race picker. Lists races at the active studio (the manager-gated
// GET /api/races); tap one to open its control board. Gated by
// canMobile(races) (manager+ default, matching the route).
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { classifyBookingState } from 'shared/race-control'
import { listRaces, raceDateLabel } from '../../../lib/races-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

function summarise(registrations) {
  let teams = 0, onCourse = 0, completed = 0
  for (const r of registrations || []) {
    const s = classifyBookingState(r)
    if (s === 'no_show') continue
    teams++
    if (s === 'on_course') onCourse++
    else if (s === 'completed') completed++
  }
  return { teams, onCourse, completed }
}

export default function RacesList() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'races', activeLocation)

  const [races, setRaces] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const res = await listRaces({ locationId: activeLocation?.id })
    if (res.success === false) { setError(res.error || 'Failed to load'); setRaces([]); return }
    setError(null)
    setRaces(Array.isArray(res.data) ? res.data : [])
  }, [activeLocation?.id])

  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canView, load]))

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Races', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Race-day control is manager+ and only where races are enabled.</Text>
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
          ) : races.length === 0 ? (
            <View className="py-16 items-center px-6">
              <Ionicons name="flag-outline" size={30} color="#94A3B8" />
              <Text className="text-base font-semibold text-un1t-text mt-3">No races</Text>
              <Text className="text-xs text-un1t-subtle text-center mt-1">Races at {activeLocation?.name || 'this studio'} show up here. Create them on the web.</Text>
            </View>
          ) : (
            races.map(race => {
              const { teams, onCourse, completed } = summarise(race.registrations)
              return (
                <Pressable
                  key={race.id}
                  onPress={() => router.push(`/races/${race.id}`)}
                  className="bg-white border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
                >
                  <View className="flex-row items-center justify-between mb-0.5">
                    <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>{race.name || 'Race'}</Text>
                    {onCourse > 0 ? (
                      <View className="px-2 py-0.5 rounded-full bg-blue-500/20 flex-row items-center ml-2">
                        <View className="w-1.5 h-1.5 rounded-full bg-blue-600 mr-1" />
                        <Text className="text-[11px] uppercase font-medium text-blue-700">{onCourse} on course</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text className="text-xs text-un1t-subtle">{raceDateLabel(race.race_date)}</Text>
                  <Text className="text-xs text-un1t-subtle mt-1">{teams} team{teams === 1 ? '' : 's'} · {completed} finished</Text>
                </Pressable>
              )
            })
          )}
        </ScrollView>
      )}
    </View>
  )
}
