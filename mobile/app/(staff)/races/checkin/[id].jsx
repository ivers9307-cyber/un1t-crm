// EVENT-CHECKIN.C — mobile per-person event check-in. Reuses the `races`
// permission; reached from the race control board's "Check in" button. Tap a
// person to mark present / undo, or "Check in all" for a team. Roster + live
// counts come from GET /api/events/[id]/checkin (counts computed server-side;
// recomputed locally for optimistic toggles).
import { useState, useCallback, useMemo } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator, TextInput } from 'react-native'
import { useLocalSearchParams, Stack, useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../../lib/auth-context'
import { canMobile } from '../../../../lib/permissions'
import BackHeaderLeft from '../../../../components/BackHeaderLeft'
import { getCheckinRoster, checkInMember, undoCheckInMember, checkInWholeTeam } from '../../../../lib/event-checkin-api'

function countPeople(registrations) {
  let present = 0, expected = 0
  for (const r of registrations || []) {
    const members = r.team?.team_members || []
    if (members.length === 0) { expected += 1; continue }
    for (const m of members) { expected += 1; if (m.checked_in) present += 1 }
  }
  return { present, expected }
}

export default function MobileEventCheckin() {
  const { id } = useLocalSearchParams()
  const router = useRouter()
  const { profile, activeLocation } = useAuth()
  const canView = canMobile(profile, 'races', activeLocation)

  const [event, setEvent] = useState(null)
  const [registrations, setRegistrations] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState({})

  const load = useCallback(async () => {
    const res = await getCheckinRoster(id, { locationId: activeLocation?.id })
    if (res.success === false) { setError(res.error || 'Failed to load'); return }
    setError(null)
    setEvent(res.data?.event || null)
    setRegistrations(Array.isArray(res.data?.registrations) ? res.data.registrations : [])
  }, [id, activeLocation?.id])

  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canView, load]))

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  const counts = useMemo(() => countPeople(registrations), [registrations])
  const isRace = event?.isRace !== false

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return registrations
    return registrations.map((r) => {
      const teamMatch = (r.team?.name || '').toLowerCase().includes(q)
      const members = teamMatch
        ? (r.team?.team_members || [])
        : (r.team?.team_members || []).filter(
            (m) => (m.name || '').toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q))
      return members.length ? { ...r, team: { ...r.team, team_members: members } } : null
    }).filter(Boolean)
  }, [registrations, query])

  function patchMember(regId, memberId, checked_in) {
    setRegistrations((prev) => prev.map((r) => r.id !== regId ? r : {
      ...r, team: { ...r.team, team_members: r.team.team_members.map((m) => m.id === memberId ? { ...m, checked_in } : m) },
    }))
  }
  function patchTeam(regId, checked_in) {
    setRegistrations((prev) => prev.map((r) => r.id !== regId ? r : {
      ...r, team: { ...r.team, team_members: r.team.team_members.map((m) => ({ ...m, checked_in })) },
    }))
  }

  async function toggleMember(regId, member) {
    const next = !member.checked_in
    setBusy((b) => ({ ...b, [member.id]: true }))
    patchMember(regId, member.id, next)
    const res = next
      ? await checkInMember(id, { teamMemberId: member.id, registrationId: regId, locationId: activeLocation?.id })
      : await undoCheckInMember(id, { teamMemberId: member.id, registrationId: regId, locationId: activeLocation?.id })
    if (res.success === false) patchMember(regId, member.id, !next)
    setBusy((b) => ({ ...b, [member.id]: false }))
  }

  async function checkTeam(reg) {
    const prev = reg.team.team_members.map((m) => ({ id: m.id, checked_in: m.checked_in }))
    patchTeam(reg.id, true)
    const res = await checkInWholeTeam(id, { registrationId: reg.id, locationId: activeLocation?.id })
    if (res.success === false) {
      setRegistrations((cur) => cur.map((r) => r.id !== reg.id ? r : {
        ...r, team: { ...r.team, team_members: r.team.team_members.map((m) => {
          const was = prev.find((p) => p.id === m.id); return was ? { ...m, checked_in: was.checked_in } : m
        }) },
      }))
    }
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{
        title: 'Check-in',
        headerLeft: () => <BackHeaderLeft label="Back" fallbackHref={`/races/${id}`} />,
        headerRight: () => (canView ? (
          <Pressable onPress={() => router.push('/races/scan')} className="px-2 py-1 active:opacity-60 flex-row items-center">
            <Ionicons name="scan-outline" size={16} color="#1d4ed8" />
            <Text className="text-blue-700 text-sm font-medium ml-1">Scan</Text>
          </Pressable>
        ) : null),
      }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Check-in is manager+ and only where events are enabled.</Text>
        </View>
      ) : (
        <>
          <View className="px-4 py-3 border-b border-un1t-border flex-row items-center justify-between">
            <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>{event?.name || 'Event'}</Text>
            <View className="flex-row items-center ml-2">
              <Ionicons name="people-outline" size={15} color="#94A3B8" />
              <Text className="text-sm font-medium text-un1t-text ml-1">{counts.present} / {counts.expected}</Text>
            </View>
          </View>

          <View className="px-4 pt-3">
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search name, email or team…"
              placeholderTextColor="#94A3B8"
              className="bg-white border border-un1t-border rounded-xl px-3 py-2 text-sm text-un1t-text"
            />
          </View>

          <ScrollView
            contentContainerClassName="px-4 py-3 pb-10"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
          >
            {error && (
              <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
                <Text className="text-red-500 text-sm">{error}</Text>
              </View>
            )}

            {loading && !registrations.length ? (
              <View className="py-12 items-center"><ActivityIndicator /></View>
            ) : filtered.length === 0 ? (
              <View className="py-16 items-center px-6">
                <Ionicons name="people-outline" size={28} color="#94A3B8" />
                <Text className="text-sm text-un1t-subtle text-center mt-2">No attendees{query ? ' match your search' : ' yet'}.</Text>
              </View>
            ) : filtered.map((reg) => {
              const members = reg.team?.team_members || []
              const allIn = members.length > 0 && members.every((m) => m.checked_in)
              const showName = isRace && members.length > 1
              return (
                <View key={reg.id} className="bg-white border border-un1t-border rounded-2xl p-3 mb-2">
                  <View className="flex-row items-center justify-between mb-1">
                    <View className="flex-1 min-w-0">
                      {showName ? <Text className="font-semibold text-un1t-text" numberOfLines={1}>{reg.team?.name}</Text> : null}
                      {reg.wave_label ? <Text className="text-[11px] text-un1t-subtle">{reg.wave_label}</Text> : null}
                    </View>
                    {members.length > 1 ? (
                      <Pressable onPress={() => checkTeam(reg)} disabled={allIn} className={`px-2.5 py-1 rounded-lg border border-un1t-border ml-2 ${allIn ? 'opacity-40' : 'active:opacity-60'}`}>
                        <Text className="text-[11px] text-un1t-subtle">{allIn ? 'All in' : 'Check in all'}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {members.map((m) => (
                    <Pressable
                      key={m.id}
                      onPress={() => toggleMember(reg.id, m)}
                      disabled={!!busy[m.id]}
                      className={`flex-row items-center justify-between px-3 py-2 rounded-xl border mt-1.5 active:opacity-70 ${m.checked_in ? 'bg-emerald-500/15 border-emerald-500/40' : 'bg-un1t-bg border-un1t-border'}`}
                    >
                      <Text className={`flex-1 text-sm ${m.checked_in ? 'text-emerald-800' : 'text-un1t-text'}`} numberOfLines={1}>{m.name}</Text>
                      <View className={`w-5 h-5 rounded-full items-center justify-center ${m.checked_in ? 'bg-emerald-500' : 'border border-un1t-border'}`}>
                        {m.checked_in ? <Ionicons name="checkmark" size={12} color="#fff" /> : null}
                      </View>
                    </Pressable>
                  ))}
                </View>
              )
            })}
          </ScrollView>
        </>
      )}
    </View>
  )
}
