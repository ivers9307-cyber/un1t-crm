// W3 — race-day control board (trackside). Mirrors the web RaceControlPanel:
// polls /api/events/[id]/control-board every 2s, buckets registrations into
// Next Up / On Course / Completed, and start/finish/reset each via
// /api/registrations/[id]/race-*. A live clock ticks elapsed for on-course
// teams. WRITE surface — the routes re-check races + location server-side.
import { useState, useCallback, useMemo } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, Alert } from 'react-native'
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { classifyBookingState, elapsedWithPenalties, formatElapsed } from 'shared/race-control'
import { getControlBoard, raceAction } from '../../../lib/races-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

const POLL_MS = 2000
const TICK_MS = 1000

function waveLabel(wave) {
  if (!wave) return ''
  return wave.label || (wave.start_time ? String(wave.start_time).slice(0, 5) : '')
}

export default function RaceControlBoard() {
  const { id } = useLocalSearchParams()
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'races', activeLocation)

  const [board, setBoard] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [actionError, setActionError] = useState(null)

  const load = useCallback(async () => {
    const res = await getControlBoard(id, { locationId: activeLocation?.id })
    if (res.success === false) { setError(res.error || 'Failed to load'); return }
    setError(null)
    setBoard(res)
  }, [id, activeLocation?.id])

  // Poll the board + tick a clock for live elapsed, only while focused.
  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return undefined }
    let alive = true
    setLoading(true)
    load().finally(() => { if (alive) setLoading(false) })
    const poll = setInterval(() => { load() }, POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => { alive = false; clearInterval(poll); clearInterval(tick) }
  }, [canView, load]))

  async function fireAction(registrationId, action) {
    setBusyId(registrationId); setActionError(null)
    const res = await raceAction(registrationId, action, { locationId: activeLocation?.id })
    if (res.success === false) { setActionError(res.error || 'Action failed'); setBusyId(null); return }
    await load()
    setBusyId(null)
  }

  function confirmReset(registrationId, teamName) {
    Alert.alert(
      'Reset this team?',
      `Clears the start and finish time for ${teamName || 'this team'} — they go back to Next Up.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => fireAction(registrationId, 'race-reset') },
      ]
    )
  }

  const wavesById = useMemo(() => {
    const m = new Map()
    for (const w of (board?.race?.waves || [])) m.set(w.id, w)
    return m
  }, [board])

  const buckets = useMemo(() => {
    const next_up = [], on_course = [], completed = []
    for (const r of (board?.registrations || [])) {
      const s = classifyBookingState(r)
      if (s === 'next_up') next_up.push(r)
      else if (s === 'on_course') on_course.push(r)
      else if (s === 'completed') completed.push(r)
      // no_show / cancelled filtered out
    }
    next_up.sort((a, b) => (wavesById.get(a.wave_id)?.start_time || '').localeCompare(wavesById.get(b.wave_id)?.start_time || ''))
    on_course.sort((a, b) => (a.race_started_at || '').localeCompare(b.race_started_at || ''))
    completed.sort((a, b) =>
      (elapsedWithPenalties(a.race_started_at, a.race_finished_at, a.penalties) ?? Infinity) -
      (elapsedWithPenalties(b.race_started_at, b.race_finished_at, b.penalties) ?? Infinity))
    return { next_up, on_course, completed }
  }, [board, wavesById])

  const nowIso = useMemo(() => new Date(now).toISOString(), [now])
  const total = (board?.registrations || []).filter(r => classifyBookingState(r) !== 'no_show').length

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: board?.race?.name || 'Race control', headerLeft: () => <BackHeaderLeft label="Races" fallbackHref="/races" />, headerRight: () => (canView ? (
        <Pressable onPress={() => router.push(`/races/checkin/${id}`)} className="px-2 py-1 active:opacity-60">
          <Text className="text-blue-700 text-sm font-medium">Check in</Text>
        </Pressable>
      ) : null) }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Race-day control is manager+ only.</Text>
        </View>
      ) : loading && !board ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator color="#94A3B8" /></View>
      ) : error && !board ? (
        <View className="flex-1 items-center justify-center p-6">
          <Text className="text-sm text-red-700 text-center">{error}</Text>
          <Pressable onPress={() => router.back()} className="mt-4"><Text className="text-sm text-blue-600">Back</Text></Pressable>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-3 pb-12">
          {actionError && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{actionError}</Text>
            </View>
          )}

          {total === 0 ? (
            <View className="py-16 items-center px-6">
              <Ionicons name="people-outline" size={30} color="#94A3B8" />
              <Text className="text-base font-semibold text-un1t-text mt-3">No teams registered</Text>
            </View>
          ) : (
            <>
              {/* On course — most actionable, on top */}
              {buckets.on_course.length > 0 && (
                <Section title="On course" count={buckets.on_course.length} tone="blue">
                  {buckets.on_course.map(r => (
                    <RaceRow
                      key={r.id}
                      name={r.teams?.name}
                      sub={waveLabel(wavesById.get(r.wave_id))}
                      time={formatElapsed(elapsedWithPenalties(r.race_started_at, nowIso, r.penalties))}
                      timeTone="blue"
                      busy={busyId === r.id}
                      action={{ label: 'Finish', tone: 'green', icon: 'flag', onPress: () => fireAction(r.id, 'race-finish') }}
                    />
                  ))}
                </Section>
              )}

              {/* Next up */}
              {buckets.next_up.length > 0 && (
                <Section title="Next up" count={buckets.next_up.length} tone="amber">
                  {buckets.next_up.map(r => (
                    <RaceRow
                      key={r.id}
                      name={r.teams?.name}
                      sub={waveLabel(wavesById.get(r.wave_id))}
                      busy={busyId === r.id}
                      action={{ label: 'Start', tone: 'blue', icon: 'play', onPress: () => fireAction(r.id, 'race-start') }}
                    />
                  ))}
                </Section>
              )}

              {/* Completed — fastest first */}
              {buckets.completed.length > 0 && (
                <Section title="Completed" count={buckets.completed.length} tone="green">
                  {buckets.completed.map((r, i) => (
                    <RaceRow
                      key={r.id}
                      rank={i + 1}
                      name={r.teams?.name}
                      sub={waveLabel(wavesById.get(r.wave_id))}
                      time={formatElapsed(elapsedWithPenalties(r.race_started_at, r.race_finished_at, r.penalties))}
                      timeTone="green"
                      busy={busyId === r.id}
                      action={{ label: 'Reset', tone: 'slate', icon: 'arrow-undo', onPress: () => confirmReset(r.id, r.teams?.name) }}
                    />
                  ))}
                </Section>
              )}
            </>
          )}
        </ScrollView>
      )}
    </View>
  )
}

const TONE_TEXT = { blue: 'text-blue-700', amber: 'text-amber-700', green: 'text-green-700', slate: 'text-slate-700' }

function Section({ title, count, tone, children }) {
  return (
    <View className="mb-4">
      <View className="flex-row items-center mb-2">
        <Text className={`text-xs uppercase font-semibold ${TONE_TEXT[tone] || 'text-un1t-subtle'}`}>{title}</Text>
        <Text className="text-xs text-un1t-subtle ml-1.5">· {count}</Text>
      </View>
      {children}
    </View>
  )
}

const BTN_TONE = {
  green: 'bg-green-600',
  blue: 'bg-blue-600',
  slate: 'bg-slate-500/15 border border-slate-400/40',
}
const BTN_TEXT = { green: 'text-white', blue: 'text-white', slate: 'text-slate-700' }

function RaceRow({ rank, name, sub, time, timeTone, busy, action }) {
  return (
    <View className="bg-white border border-un1t-border rounded-2xl p-3.5 mb-2 flex-row items-center">
      {rank ? (
        <View className="w-7 h-7 rounded-full bg-un1t-bg items-center justify-center mr-3">
          <Text className="text-xs font-bold text-un1t-text">{rank}</Text>
        </View>
      ) : null}
      <View className="flex-1">
        <Text className="text-base font-semibold text-un1t-text" numberOfLines={1}>{name || 'Team'}</Text>
        {sub ? <Text className="text-xs text-un1t-subtle mt-0.5">Wave {sub}</Text> : null}
      </View>
      {time ? (
        <Text className={`text-base font-bold tabular-nums mr-3 ${TONE_TEXT[timeTone] || 'text-un1t-text'}`}>{time}</Text>
      ) : null}
      <Pressable
        onPress={action.onPress}
        disabled={busy}
        className={`px-4 py-2.5 rounded-xl items-center flex-row justify-center min-w-[84px] active:opacity-80 ${BTN_TONE[action.tone]}`}
      >
        {busy
          ? <ActivityIndicator color={action.tone === 'slate' ? '#475569' : '#FFFFFF'} />
          : <Ionicons name={action.icon} size={15} color={action.tone === 'slate' ? '#475569' : '#FFFFFF'} />}
        <Text className={`text-sm font-semibold ml-1.5 ${BTN_TEXT[action.tone]}`}>{action.label}</Text>
      </Pressable>
    </View>
  )
}
