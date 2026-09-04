// RACE-TAB.1 — the Race tab. The trackside surface, reachable in one tap on
// a day this studio is running a race (the bottom bar inserts this tab
// contextually — see (tabs)/_layout.jsx) or permanently for anyone who has
// pinned it.
//
// The whole point of this screen is that it costs an operator standing at
// the start line ZERO taps to get to the board. So:
//   - one race today  → the board, immediately. No list, no picker.
//   - two or more     → a compact row of pills, defaulted to the race
//                       nearest to now, board below. One tap to switch.
//   - none            → an empty state pointing at Events.
//
// Deliberately NOT built: "the next upcoming race". That was cut as scope
// creep — this tab is about the race happening NOW, and a tab that quietly
// shows next month's race is a tab nobody trusts on the day.
//
// This screen owns its header; RaceControlBoard renders none of its own.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { Stack, useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listTodaysRaces } from '../../../lib/races-api'
import RaceControlBoard from '../../../components/RaceControlBoard'

/**
 * 'HH:MM[:SS]' → minutes since midnight, or null for an untimed race.
 * The route hands back the first WAVE's start (race_events.start_time is
 * deprecated per mig 083), already a fixed-width 24h clock.
 */
function startMinutes(startTime) {
  if (!startTime) return null
  const [h, m] = String(startTime).split(':')
  const hh = Number(h)
  const mm = Number(m)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  return hh * 60 + mm
}

/**
 * Which race to open first on a multi-race day: the one whose start time is
 * closest to now, before or after. "Closest" rather than "next" on purpose —
 * at 10:05 on a day with 10:00 and 14:00 heats the operator wants the heat
 * that is ON, not the one after lunch.
 *
 * An untimed race (no wave carries a start time) can only win when nothing
 * else is on offer — a half-configured row must not steal the default.
 *
 * @param {Array<{id: string, start_time?: string|null}>} races  in running order
 * @param {number} nowMinutes  minutes since local midnight
 * @returns {string|null} race id
 */
function nearestRaceId(races, nowMinutes) {
  let bestId = null
  let bestDelta = Infinity
  for (const race of races || []) {
    const mins = startMinutes(race?.start_time)
    if (mins === null) continue
    const delta = Math.abs(mins - nowMinutes)
    // Strict `<` keeps the earlier race on a tie — the list arrives in
    // running order, so the tie-break reads as "the one that went first".
    if (delta < bestDelta) { bestDelta = delta; bestId = race.id }
  }
  return bestId || races?.[0]?.id || null
}

/** 'HH:MM:SS' → 'HH:MM' for a pill label; untimed races show their name only. */
function startLabel(startTime) {
  return startTime ? String(startTime).slice(0, 5) : null
}

export default function RaceTab() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'races', activeLocation)

  const [races, setRaces] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // The operator's own choice on a multi-race day. Null = follow the
  // nearest-to-now default; once they tap a pill their pick sticks through
  // every refresh, because re-deciding for them mid-race would be worse
  // than any default we could compute.
  const [pickedId, setPickedId] = useState(null)
  // The race name as the BOARD sees it. RaceControlBoard hands it back
  // through onRaceName precisely so this screen — which owns the header —
  // does not have to poll /control-board a second time for a string. It is
  // only a refinement of the name our own list already carries: it lands a
  // couple of seconds later, so the header never starts blank.
  const [boardRaceName, setBoardRaceName] = useState(null)

  const load = useCallback(async () => {
    if (!activeLocation?.id) { setRaces([]); return }
    const res = await listTodaysRaces({ locationId: activeLocation.id })
    if (!res?.success) {
      // Keep whatever we already had on screen — losing the board to a
      // blip in a badly-covered warehouse is the failure that actually
      // costs someone their race.
      setError(res?.error || 'Could not check for races')
      return
    }
    setError(null)
    setRaces(Array.isArray(res.data) ? res.data : [])
  }, [activeLocation?.id])

  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    let alive = true
    setLoading(true)
    load().finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [canView, load]))

  // Device-local clock. The operator running this board is physically at the
  // studio, so their phone's wall clock IS the studio's — the same proxy the
  // Bookings tab makes. The DAY boundary is the part that must not be
  // guessed, and the route already fixed that in Europe/Dublin server-side;
  // which of two same-day heats to open first is a soft default one tap
  // overrides.
  const defaultId = useMemo(() => {
    const now = new Date()
    return nearestRaceId(races, now.getHours() * 60 + now.getMinutes())
  }, [races])

  // A pick only survives while the race it names is still on today's list
  // (a studio switch replaces the list wholesale).
  const activeId = races.some(r => r.id === pickedId) ? pickedId : defaultId

  // RACEDAY.3 — PIN the first default, so the board cannot change race under
  // the operator's thumb.
  //
  // `defaultId` re-reads the wall clock, and `races` is a NEW array from every
  // focus poll, so the memo recomputed on each return to the tab. On a
  // two-heat day that means the board silently stops controlling the 10:00
  // heat and starts controlling the 14:00 one the moment "nearest to now"
  // tips over — no tap, no visible change but the pill highlight, and the
  // operator is one press away from starting a team in the wrong heat.
  // Promoting the resolved default to an explicit pick freezes it; a studio
  // switch drops the pick (its id is gone from the list) and re-pins.
  // Pin the RESOLVED id, not "pin once if nothing is pinned". The earlier
  // `!pickedId` guard could only ever fire once per session: `pickedId` is
  // never cleared when its race leaves the list (line above drops a stale
  // pick for DISPLAY only), so after a studio switch it stayed truthy, the
  // effect never re-armed, and activeId fell through to `defaultId` — which
  // re-reads the wall clock on every focus poll. That is exactly the
  // heat-switching-under-the-operator bug this was meant to remove, just
  // moved one step further along. nearestRaceId only ever returns an id
  // drawn from `races`, so activeId === pickedId on the next render and this
  // settles in a single pass.
  useEffect(() => {
    if (activeId && activeId !== pickedId) setPickedId(activeId)
  }, [activeId, pickedId])
  const activeRace = races.find(r => r.id === activeId) || null

  // A switch invalidates the board's name until its first poll for the new
  // race lands — otherwise the header would keep naming the race we left.
  useEffect(() => { setBoardRaceName(null) }, [activeId])

  // Identity-stable, as RaceControlBoard's contract requires (it is an
  // effect dependency there).
  const handleRaceName = useCallback((name) => { setBoardRaceName(name) }, [])

  // One race: name the race, because there is nothing else to call it. Two
  // or more: the pills already name every race, so the header stays a stable
  // label rather than echoing the selected pill back at the operator.
  const headerTitle = races.length === 1
    ? (boardRaceName || races[0].name || 'Race day')
    : 'Race day'
  const screenOptions = useMemo(
    // headerTitle, NOT title: `title` would also rename the bottom-bar
    // label, and the tab is called "Race" whatever race is on.
    () => ({ headerTitle }),
    [headerTitle]
  )

  if (!canView) {
    return (
      <View className="flex-1 bg-un1t-bg">
        <Stack.Screen options={screenOptions} />
        <View className="flex-1 items-center justify-center px-8">
          <Ionicons name="flag-outline" size={30} color="#94A3B8" />
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">
            Race-day control is only on where races are enabled for you.
          </Text>
        </View>
      </View>
    )
  }

  if (loading && races.length === 0) {
    return (
      <View className="flex-1 bg-un1t-bg">
        <Stack.Screen options={screenOptions} />
        <View className="flex-1 items-center justify-center"><ActivityIndicator color="#94A3B8" /></View>
      </View>
    )
  }

  if (races.length === 0) {
    return (
      <View className="flex-1 bg-un1t-bg">
        <Stack.Screen options={screenOptions} />
        <View className="flex-1 items-center justify-center px-8">
          <Ionicons name="flag-outline" size={30} color="#94A3B8" />
          <Text className="text-base font-semibold text-un1t-text mt-3">No race today</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">
            This tab opens the control board on race day at {activeLocation?.name || 'this studio'}.
          </Text>
          {error ? (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mt-4">
              <Text className="text-red-700 text-xs text-center">{error}</Text>
            </View>
          ) : null}
          <Pressable
            onPress={() => router.push('/events')}
            className="mt-5 bg-un1t-text rounded-xl px-5 py-3 active:opacity-80"
          >
            <Text className="text-un1t-bg font-semibold text-sm">Browse events</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={screenOptions} />

      {/* Two or more races today — a morning and an afternoon heat block run
          as separate events is a normal shape. One pill each, in running
          order, horizontally scrollable so four heats do not squeeze the
          labels to nothing. A single race renders no chrome at all: the
          whole point is zero taps. */}
      {races.length > 1 ? (
        <View className="border-b border-un1t-border bg-un1t-surface">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="px-3 py-2 gap-2"
          >
            {races.map(race => {
              const selected = race.id === activeId
              const time = startLabel(race.start_time)
              return (
                <Pressable
                  key={race.id}
                  onPress={() => setPickedId(race.id)}
                  className={`px-3 py-2 rounded-full border ${selected ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-bg border-un1t-border'}`}
                >
                  <Text
                    numberOfLines={1}
                    className={`text-sm ${selected ? 'text-un1t-bg font-semibold' : 'text-un1t-text'}`}
                  >
                    {time ? `${time} · ` : ''}{race.name || 'Race'}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
        </View>
      ) : null}

      {error ? (
        <View className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2">
          <Text className="text-amber-700 text-xs">{error} — showing the last known race list.</Text>
        </View>
      ) : null}

      {activeRace ? (
        <View className="flex-1">
          <RaceControlBoard eventId={activeRace.id} onRaceName={handleRaceName} clearUnlockOnBlur />
        </View>
      ) : null}
    </View>
  )
}
