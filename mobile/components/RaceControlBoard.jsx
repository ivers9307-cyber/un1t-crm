// RACEDAY.1 — the trackside race-day control board, lifted out of
// mobile/app/(staff)/races/[id].jsx so the race-day screen and the portrait
// display board render ONE implementation of the polling, the bucketing and
// the start/finish/reset actions rather than two that drift.
//
// It renders the board BODY only — deliberately no <Stack.Screen>, because
// the two callers want different headers: the race-day screen keeps its own
// title + back button + "Check in", while a caller with no navigation header
// passes its controls in as `headerRight`.
//
// Polls /api/events/[id]/control-board every 2s (multiple operators — start
// line, finish line, back office — stay in sync through the server, not
// through each other) and ticks a 1s clock so on-course elapsed times run
// live. WRITE surface: the action routes re-check the races permission and
// location access server-side.
import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, Alert, AppState } from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../lib/auth-context'
import { canMobile } from '../lib/permissions'
import { usePhysicalLocation } from '../lib/use-physical-location'
import {
  classifyBookingState,
  elapsedWithPenalties,
  formatElapsed,
  waveDisplayLabel,
  waveSortKey,
  participantNames,
  shouldShowParticipants,
  canStartRace,
} from 'shared/race-control'
import { getControlBoard, raceAction } from '../lib/races-api'

const POLL_MS = 2000
const TICK_MS = 1000

// One trailing bucket for every registration whose wave is missing, rather
// than one bucket per orphaned wave_id — see nextUpWaves below.
const NO_WAVE_KEY = '__no_wave__'

// RACEDAY.3 — can this row's clock actually be started?
//
// race-start refuses anything but `confirmed` with a 409 ("Cannot start race
// for a pending_payment registration"). classifyBookingState only diverts
// no_show and cancelled, so every OTHER non-confirmed status lands in Next Up
// — and the old flat list armed a Start button on it that could never work.
//
// Live tomorrow: registration 8f714b71 ("Allen Thomson", 11:12 wave) is
// pending_payment. Wave grouping is what turns that from a stray dud row into
// a trap, because the heading now says "11:12 · 2 teams" and invites the
// operator to start BOTH. Better they see, before the wave goes off, that one
// of them cannot be timed and why — a 409 banner mid-wave tells them nothing
// actionable while a competitor is standing on the line.
//
// The button is withheld, NOT the row: the team is really there, and the
// operator needs to see them to sort the payment out.
// (the rule itself is canStartRace in shared/race-control.js)

// Operator-facing wording for a status that blocks the start.
const BLOCKED_STATUS_LABEL = {
  pending_payment: 'Payment pending',
  pending: 'Not confirmed',
  refunded: 'Refunded',
  waitlisted: 'Waitlisted',
}
function blockedStatusLabel(status) {
  if (!status) return null
  return BLOCKED_STATUS_LABEL[status] || String(status).replace(/_/g, ' ')
}

/**
 * @param {object}   props
 * @param {string}   props.eventId      race_events.id to control.
 * @param {React.ReactNode} [props.headerRight]  Controls for a caller that has
 *   no navigation header of its own; rendered right-aligned above the board.
 * @param {(name: string|null) => void} [props.onRaceName]  Optional; called
 *   with the race's name once the board loads. The race name lives in the
 *   polled payload, and the screen that owns the <Stack.Screen> needs it for
 *   the title — this hands it back rather than making that screen poll the
 *   same endpoint a second time. MUST be identity-stable (useCallback) — it
 *   is an effect dependency.
 */
export default function RaceControlBoard({ eventId, headerRight, onRaceName }) {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'races', activeLocation)
  const phys = usePhysicalLocation()

  const [board, setBoard] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [actionError, setActionError] = useState(null)
  // RACEDAY.6 — when the board last actually heard from the server. A frozen
  // board is indistinguishable from a live one otherwise: the 1s tick keeps
  // counting off the stale race_started_at, so it looks MORE alive the longer
  // it has been dead.
  const [lastLoadedAt, setLastLoadedAt] = useState(null)
  // RACEDAY.1 — the offsite unlock, held in COMPONENT STATE on purpose. It
  // must die with the screen: a coach who unlocked from the car park on
  // Saturday must not find the controls already live next weekend, which is
  // exactly what AsyncStorage (or anything else that outlives the visit)
  // would give them. React clears this on unmount for free — do not "improve"
  // it into a persisted flag.
  const [unlocked, setUnlocked] = useState(false)

  // RACEDAY.5 — which race this board is CURRENTLY for, readable from inside
  // an async callback that was created for a previous one. Clearing the poll
  // interval does not abort a request already in flight, and `load` closes
  // over the eventId it was built with, so comparing against that closure
  // proves nothing — the stale response would match its own stale id.
  const currentEventIdRef = useRef(eventId)

  const load = useCallback(async () => {
    const res = await getControlBoard(eventId, { locationId: activeLocation?.id })
    // RACEDAY.5 — drop a reply for a race we have since navigated away from.
    // Resetting state on the pill switch (below) does not help on its own: a
    // control-board request fired for the 10:00 heat can resolve seconds
    // later on trackside cellular, AFTER the 14:00 payload has landed, and
    // repaint the old heat's rows — with armed Start buttons — under the new
    // heat's pill. A tap there starts a team from the wrong heat, and the
    // route cannot tell: the races permission and the location both pass.
    if (res?.race?.id && res.race.id !== currentEventIdRef.current) return
    if (res.success === false) { setError(res.error || 'Failed to load'); return }
    setError(null)
    setBoard(res)
    setLastLoadedAt(Date.now())
  }, [eventId, activeLocation?.id])

  // RACEDAY.3 — a NEW race means none of the old race's state is true any
  // more, and this component is reused rather than remounted when the race
  // changes: (tabs)/race.jsx renders it at the same position for whichever
  // pill is selected, so React updates props and keeps state. Without this,
  // tapping the 14:00 pill leaves the 10:00 heat's rows on screen — with
  // ARMED Start buttons — until the first poll returns, because the loading
  // branch is `loading && !board` and `board` is still the old race's. A tap
  // in that window starts a team from the other heat: the route checks the
  // races permission and the race's location, both of which pass.
  //
  // Deliberately NOT solved with `key={raceId}` in race.jsx. A key remount
  // would also reset `unlocked`, forcing an offsite operator to re-tap the
  // unlock every time they switch pills. Same lesson as the studio switch in
  // sonos/index.jsx: new target -> spinner, not the previous target's list.
  useEffect(() => {
    currentEventIdRef.current = eventId
    setUnlocked(false)
    setBoard(null)
    setLastLoadedAt(null)
    setError(null)
    setActionError(null)
    setBusyId(null)
  }, [eventId])

  // RACEDAY.3 — drop the unlock whenever the screen stops being looked at.
  //
  // The spec leaned on "component state dies with the screen", which is true
  // for races/[id].jsx (a pushed screen that unmounts on pop) and FALSE for
  // the new bottom-tab surface: React Navigation keeps tab screens mounted,
  // this layout sets no unmountOnBlur, and `activeRace` never goes null
  // during a race day — so the board is never unmounted and `unlocked`
  // latched for the life of the JS runtime. A coach who unlocked from the
  // car park to peek at the roster would find live Start/Finish buttons on
  // every later visit, that afternoon and next weekend, which is precisely
  // what the gate exists to prevent. Blur is the honest boundary: it ends
  // "this visit" on both surfaces.
  // RACEDAY.6 — the unlock ends when the APP is put away, not when the screen
  // loses focus.
  //
  // Blur was the wrong boundary and cost more than it bought. On the tab it
  // fires on every trip to Messages and back, and because 'loading' counts as
  // on site (below), the board then repaints with every button ARMED for the
  // second or two the GPS takes to resolve, before they all vanish under the
  // operator's thumb. A tap re-paid on every tab switch for the whole race,
  // plus a flicker, in exchange for very little — that same loading window
  // means a blur-clear denies an offsite coach nothing for those seconds.
  //
  // Background -> active is the honest signal, and it is the one
  // usePhysicalLocation itself treats as "the phone may have MOVED". It keeps
  // the property the gate exists for (the controls are never still live next
  // weekend, because the app is certainly backgrounded in between) without
  // charging the on-site operator anything.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setUnlocked(false)
    })
    return () => sub.remove()
  }, [])

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

  // Keyed on the NAME, not on `board` — the board object is replaced every 2s
  // by the poll, and firing the callback that often would churn the caller's
  // header options for a string that almost never changes.
  const raceName = board?.race?.name || null
  useEffect(() => { if (onRaceName) onRaceName(raceName) }, [raceName, onRaceName])

  // ─── Write gating: offsite is read-only ────────────────────────────────
  //
  // RACEDAY.1 — the same usePhysicalLocation primitive that gates Sonos,
  // Shelly, the doors and the AC. 'loading' deliberately counts as ON SITE:
  // detection takes a GPS acquisition, and flashing a "viewing only" banner
  // for a second or two on the screen an operator is reaching for is worse
  // than the accidental tap it would prevent.
  //
  // THIS IS A UI GUARD, NOT A SECURITY BOUNDARY. The phone asserts its own
  // position, so anyone who wants the controls has them (the unlock button
  // below is right there). What it stops is the real failure — an offsite
  // coach thumbing "Finish" on a race that is still running. The actual
  // boundary stays where it always was: the route's own races-permission and
  // assertLocationAccess checks, which run regardless of anything here.
  // RACEDAY.3 — "at THIS race's studio", not "at A studio". usePhysicalLocation
  // resolves WHICH site the phone is standing in and returns it alongside the
  // status (control-location.js is the established consumer of that pair); the
  // first cut read only `status`, so a coach standing in Hatch Street had full
  // Start/Finish control of the Stillorgan race, with no banner — the exact
  // offsite write this is here to stop, from inside another building.
  //
  // The race's own location_id is the thing to match against, not
  // activeLocation: the operator's active studio is a UI preference that can
  // lag, while the board is unambiguously for one race at one site.
  //
  // Ordering matters. Until the first poll lands we do not KNOW the race's
  // location, so a positive match is impossible and requiring one would flash
  // the banner on every load. While it is unknown we fall back to the status
  // alone; once known, being at a different site reads as offsite.
  const raceLocationId = board?.race?.location_id || null
  const atWrongStudio = Boolean(
    raceLocationId &&
    phys.status === 'at_studio' &&
    phys.location?.id &&
    phys.location.id !== raceLocationId
  )
  const offsite = phys.status === 'offsite' || phys.status === 'unknown' || atWrongStudio
  const readOnly = offsite && !unlocked
  const usingOverride = offsite && unlocked
  // Name the studio the operator needs to BE at, falling back to their active
  // one only while the race's own name is still loading.
  const siteName = board?.race?.location?.name || activeLocation?.name || 'the studio'

  async function fireAction(registrationId, action) {
    setBusyId(registrationId); setActionError(null)
    const res = await raceAction(registrationId, action, {
      locationId: activeLocation?.id,
      // Stamped when, and only when, the operator went through the unlock —
      // the route logs it, so an audit can tell "started from the start line"
      // apart from "started by someone the phone placed somewhere else".
      ...(usingOverride ? { override: true } : {}),
    })
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
    // RACEDAY.1 — waveSortKey, not `(wave?.start_time || '')`. The empty
    // string sorts BEFORE every real time, so a wave-less registration used
    // to float to the TOP of Next Up and read as the team starting next —
    // which on a race morning is the row an operator starts. It sorts LAST.
    // Array.prototype.sort is stable, so within a wave the rows keep the
    // route's registered_at order.
    next_up.sort((a, b) => waveSortKey(wavesById.get(a.wave_id)).localeCompare(waveSortKey(wavesById.get(b.wave_id))))
    on_course.sort((a, b) => (a.race_started_at || '').localeCompare(b.race_started_at || ''))
    completed.sort((a, b) =>
      (elapsedWithPenalties(a.race_started_at, a.race_finished_at, a.penalties) ?? Infinity) -
      (elapsedWithPenalties(b.race_started_at, b.race_finished_at, b.penalties) ?? Infinity))
    return { next_up, on_course, completed }
  }, [board, wavesById])

  // Next Up is the only section that groups: an operator starts a WAVE, so
  // the heading has to make "the rows under this" the unit of work. On course
  // and Completed stay flat — they are ordered by elapsed time, and a wave is
  // no longer what relates two rows there.
  //
  // `buckets.next_up` is already wave-sorted, so first-seen order gives the
  // groups in wave order with the wave-less one last. A registration whose
  // wave row failed to join collapses into that same trailing group rather
  // than minting a "No wave" heading of its own per orphaned id.
  const nextUpWaves = useMemo(() => {
    const groups = []
    const byKey = new Map()
    for (const r of buckets.next_up) {
      const label = waveDisplayLabel(wavesById.get(r.wave_id))
      const key = label ? r.wave_id : NO_WAVE_KEY
      let group = byKey.get(key)
      if (!group) { group = { key, label, rows: [] }; byKey.set(key, group); groups.push(group) }
      group.rows.push(r)
    }
    return groups
  }, [buckets.next_up, wavesById])

  const nowIso = useMemo(() => new Date(now).toISOString(), [now])
  const total = (board?.registrations || []).filter(r => classifyBookingState(r) !== 'no_show').length

  return (
    <View className="flex-1 bg-un1t-bg">
      {headerRight ? (
        <View className="flex-row items-center justify-end px-4 pt-3">{headerRight}</View>
      ) : null}

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
        <>
          {/* Pinned above the sections, not inside the scroller: while the
              board is read-only the banner is the ONLY thing standing in for
              a button on every row, so it must stay on screen as the operator
              scrolls looking for the row whose button is missing. */}
          {readOnly && (
            <View className="mx-4 mt-3 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">
              <Text className="text-amber-700 text-sm font-medium">
                Viewing only - you&apos;re not at {siteName}.
              </Text>
              <Pressable
                onPress={() => setUnlocked(true)}
                accessibilityRole="button"
                className="mt-2.5 self-start px-3 py-2 rounded-lg bg-amber-600 active:opacity-80"
              >
                <Text className="text-white text-sm font-semibold">I&apos;m at the gym - enable controls</Text>
              </Pressable>
            </View>
          )}

          <ScrollView contentContainerClassName="px-4 py-3 pb-12">
            {/* RACEDAY.6 — a poll that fails once `board` exists used to set
              `error` and render NOTHING: the full-screen error branch is
              `error && !board`. Two operators keep in sync only through this
              2s poll, so a start-line phone that loses cellular in the
              warehouse kept showing teams the finish line had already
              finished, under live Finish buttons, with the clock still
              running. The race LIST one screen up already reports exactly
              this for far less consequential data. */}
          {error && board ? (
            <View className="bg-amber-500/15 border border-amber-500/30 rounded-xl p-3 mb-3">
              <Text className="text-amber-700 text-sm font-semibold">Not updating</Text>
              <Text className="text-amber-700 text-xs mt-0.5">
                {lastLoadedAt
                  ? `Showing the board as of ${new Date(lastLoadedAt).toLocaleTimeString()}.`
                  : 'Showing the last board we received.'}
              </Text>
            </View>
          ) : null}

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
                        members={r.teams?.team_members}
                        waveLabel={waveDisplayLabel(wavesById.get(r.wave_id))}
                        time={formatElapsed(elapsedWithPenalties(r.race_started_at, nowIso, r.penalties))}
                        timeTone="blue"
                        busy={busyId === r.id}
                        action={readOnly ? null : { label: 'Finish', tone: 'green', icon: 'flag', onPress: () => fireAction(r.id, 'race-finish') }}
                      />
                    ))}
                  </Section>
                )}

                {/* Next up — grouped by wave, so "start this wave" reads as
                    the rows under one heading. */}
                {buckets.next_up.length > 0 && (
                  <Section title="Next up" count={buckets.next_up.length} tone="amber">
                    {nextUpWaves.map(group => (
                      <View key={group.key}>
                        <WaveHeading label={group.label} count={group.rows.length} />
                        {group.rows.map(r => (
                          <RaceRow
                            key={r.id}
                            name={r.teams?.name}
                            members={r.teams?.team_members}
                            waveLabel={group.label}
                            blockedStatus={canStartRace(r) ? null : r.status}
                            busy={busyId === r.id}
                            action={(readOnly || !canStartRace(r)) ? null : { label: 'Start', tone: 'blue', icon: 'play', onPress: () => fireAction(r.id, 'race-start') }}
                          />
                        ))}
                      </View>
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
                        members={r.teams?.team_members}
                        waveLabel={waveDisplayLabel(wavesById.get(r.wave_id))}
                        time={formatElapsed(elapsedWithPenalties(r.race_started_at, r.race_finished_at, r.penalties))}
                        timeTone="green"
                        busy={busyId === r.id}
                        action={readOnly ? null : { label: 'Reset', tone: 'slate', icon: 'arrow-undo', onPress: () => confirmReset(r.id, r.teams?.name) }}
                      />
                    ))}
                  </Section>
                )}
              </>
            )}
          </ScrollView>
        </>
      )}
    </View>
  )
}

const TONE_TEXT = { blue: 'text-blue-700', amber: 'text-amber-700', green: 'text-green-700', slate: 'text-slate-700' }

// The separator between participant names and inside the wave heading. The
// middle dot is the house idiom (Section below already uses it).
const DOT = ' · '

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

// Small heading between the wave groups of Next Up: "10:30 · 2 teams".
// A group with no wave says so in amber, matching its rows' chips — it is the
// one an operator has to chase down before the horn.
function WaveHeading({ label, count }) {
  return (
    <Text className={`text-[11px] font-semibold mb-1.5 mt-0.5 ${label ? 'text-un1t-subtle' : 'text-amber-700'}`}>
      {(label || 'No wave') + DOT + count + (count === 1 ? ' team' : ' teams')}
    </Text>
  )
}

// A registration with no wave never renders a blank chip: an empty pill reads
// as "loading", while the operator needs to see that this team has nowhere to
// start from. Amber on the mobile light theme is bg-amber-500/15 with the text
// colour on the inner <Text> — a React Native <View> cannot take a text colour.
// RACEDAY.3 — says why a Next Up row has no Start button. Without it the row
// reads as a rendering bug rather than "this entry needs sorting out".
function BlockedChip({ status }) {
  return (
    <View className="self-start rounded-full px-2 py-0.5 mb-1 ml-1.5 bg-rose-500/15">
      <Text className="text-[11px] font-semibold text-rose-700">{blockedStatusLabel(status)}</Text>
    </View>
  )
}

function WaveChip({ label }) {
  const missing = !label
  return (
    <View className={`self-start rounded-full px-2 py-0.5 mb-1 ${missing ? 'bg-amber-500/15' : 'bg-slate-500/10'}`}>
      <Text className={`text-[11px] font-semibold ${missing ? 'text-amber-700' : 'text-slate-700'}`}>
        {missing ? 'No wave' : label}
      </Text>
    </View>
  )
}

const BTN_TONE = {
  green: 'bg-green-600',
  blue: 'bg-blue-600',
  slate: 'bg-slate-500/15 border border-slate-400/40',
}
const BTN_TEXT = { green: 'text-white', blue: 'text-white', slate: 'text-slate-700' }

// Row anatomy (RACEDAY.1):
//     [ 10:30 ]                   wave chip — first thing read
//     Tu Pac                      team name, the headline
//     Furlong · Graham Cullen     participants, 2 lines max
//                       [ Start ]
// `action` is null when the board is read-only (offsite, not unlocked): the
// banner above the sections stands in for every button rather than each row
// growing a disabled one.
function RaceRow({ rank, name, members, waveLabel, blockedStatus, time, timeTone, busy, action }) {
  const names = participantNames(members)
  // A solo entry whose one member IS the team ("John O'Kane" / "John") would
  // otherwise print the same person twice down the card.
  const showNames = shouldShowParticipants(name, names)
  return (
    <View className="bg-white border border-un1t-border rounded-2xl p-3.5 mb-2 flex-row items-center">
      {rank ? (
        <View className="w-7 h-7 rounded-full bg-un1t-bg items-center justify-center mr-3">
          <Text className="text-xs font-bold text-un1t-text">{rank}</Text>
        </View>
      ) : null}
      <View className="flex-1">
        <View className="flex-row items-center flex-wrap">
          <WaveChip label={waveLabel} />
          {blockedStatus ? <BlockedChip status={blockedStatus} /> : null}
        </View>
        <Text className="text-base font-semibold text-un1t-text" numberOfLines={1}>{name || 'Team'}</Text>
        {showNames ? (
          <Text className="text-xs text-un1t-subtle mt-0.5" numberOfLines={2}>{names.join(DOT)}</Text>
        ) : null}
      </View>
      {time ? (
        <Text className={`text-base font-bold tabular-nums mr-3 ${TONE_TEXT[timeTone] || 'text-un1t-text'}`}>{time}</Text>
      ) : null}
      {action ? (
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
      ) : null}
    </View>
  )
}
