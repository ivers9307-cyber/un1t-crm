// mobile/app/(staff)/(tabs)/index.jsx
//
// HOME-LOC.8 — Home is the PHYSICAL surface: "your work life, here and now".
//   at_studio        → that studio's name + control tiles + today's roster
//   offsite/unknown  → your next-7-days shifts across ALL your studios
//                      (one /api/schedule/shifts call, no location_id →
//                      the route fans out to every assignment) + a demoted
//                      "Studio controls" manual entry
//   loading          → spinner
//
// The offsite layout needs NO location permission — a denied user gets a
// fully useful Home, and the on-site flip simply never fires for them.
// activeLocation is never the SOURCE of content here and is NEVER written; it
// is read only as a gate — the all-features-off nudge (per-location), and
// HOME-LOC.12's tile safety filter, which withholds the tiles whose screens
// still bind to it.
// Dashboards live on the Dashboard tab since HOME-LOC.7.

import { useState, useCallback, useRef, useEffect } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable, RefreshControl } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { hasAnyMobileFeature } from '../../../lib/permissions'
import { usePhysicalLocation } from '../../../lib/use-physical-location'
import { pickerLocations } from '../../../lib/control-location'
import { promptLocationPick } from '../../../lib/pick-location-alert'
import { shiftWindow, shiftTimeLabel, groupShiftsByDay, safeHomeTiles } from '../../../lib/home-logic'
import { getMyShifts, getTeamShifts } from '../../../lib/schedule-api'
import { isoDate } from '../../../lib/dates'
import { pickLocationColor } from 'shared/location-colors'
import { groupTeamShiftsByCoach, coachSpanLabel } from 'shared/team-today'
import * as SecureStore from 'expo-secure-store'
import { shouldShowLocationNudge, hasOnSiteFeatures } from '../../../lib/location-nudge'
import EnableLocationCard from '../../../components/EnableLocationCard'
import ChoiceCard from '../../../components/ChoiceCard'
import LocationPill from '../../../components/LocationPill'

const NUDGE_DISMISSED_KEY = 'home_location_nudge_dismissed_v1'

// GET /api/schedule/shifts returns `location_id` and does NOT embed
// `locations` (src/lib/roster-read.js's API_SHIFT_SELECT embeds
// shift_blocks + profiles only) — so the studio chip resolves its NAME from
// the caller's own assignment list rather than from the row. The `?.locations`
// read stays first so the chip keeps working if this route ever grows the
// embed the personal dashboard already has (that one is NOT this route: it is
// shared/dashboard-data.js's own direct select, which joins
// `locations:location_id ( id, name )` onto the block).
function shiftLocationId(shift) {
  return shift?.locations?.id || shift?.location_id || null
}
function shiftLocationName(shift, locations) {
  if (shift?.locations?.name) return shift.locations.name
  const id = shift?.location_id
  if (!id) return null
  return (locations || []).find((l) => l.id === id)?.name || null
}

export default function Home() {
  const { profile, activeLocation, locations } = useAuth()
  const router = useRouter()
  // Destructured, and the id extracted, rather than written inline in the
  // dep arrays below: exhaustive-deps runs at ERROR here and demands the
  // whole hook result as one dependency the moment a method is CALLED off
  // it (refresh()), which would re-arm every effect on each render.
  const {
    status: physStatus,
    foregroundPermission,
    location: physLocation,
    refresh: refreshPhysical,
  } = usePhysicalLocation()
  const physLocationId = physLocation?.id || null

  const [myShifts, setMyShifts] = useState(null)   // null = loading
  const [shiftsError, setShiftsError] = useState(null)
  // On-site: today's team at the detected studio, KEYED to the location it
  // was fetched for (the sonos listLocationRef class). Without the key,
  // walking Stillorgan → Hatch paints Stillorgan's coaches under the header
  // "Today at Hatch Street" for the whole of the next fetch.
  const [roster, setRoster] = useState({ locationId: null, rows: [] })
  const [refreshing, setRefreshing] = useState(false)
  // LOC-NUDGE.1 — the enable-location card's inputs that live outside the
  // hook: the sticky per-device dismissal and the kiosk carve-out (a shared
  // studio iPad can't meaningfully grant location — same rule as
  // LocationGate). null = not read yet, which shouldShowLocationNudge's
  // truthiness treats as "don't show" until both reads land.
  const [nudgeDismissed, setNudgeDismissed] = useState(null)
  const [isKiosk, setIsKiosk] = useState(null)
  // Keep the last painted list through a transport blip (api() tags its
  // self-minted envelopes transport:true — the sonos screen's convention).
  // Holds the profile id it was painted FOR, not a bare boolean: under
  // View-as the identity changes without a remount, and a bare flag would
  // let a blip on the new identity's first fetch keep the PREVIOUS user's
  // shifts on screen.
  const paintedRef = useRef(null)
  // Screen liveness for loads that aren't owned by a focus effect (the
  // pull-to-refresh below) — a resolve landing after a blur must not paint.
  const focusedRef = useRef(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const v = await SecureStore.getItemAsync(NUDGE_DISMISSED_KEY)
        if (alive) setNudgeDismissed(v === '1')
      } catch { if (alive) setNudgeDismissed(false) }
      try {
        const { getPairing } = await import('../../../lib/studio-device')
        const paired = await getPairing()
        if (alive) setIsKiosk(!!paired)
      } catch { if (alive) setIsKiosk(false) }
    })()
    return () => { alive = false }
  }, [])

  const dismissNudge = useCallback(() => {
    setNudgeDismissed(true)
    // Best-effort persistence — a failed write only means the card returns
    // next launch, which is the safe direction for a nudge.
    SecureStore.setItemAsync(NUDGE_DISMISSED_KEY, '1').catch(() => {})
  }, [])

  // Identity swap (View-as, or a sign-in on a shared studio device) — drop
  // the previous user's shifts rather than showing them while the new
  // user's load is in flight. The roster is location-keyed, not
  // profile-keyed: it is the same list of coaches whoever is looking.
  useEffect(() => {
    setMyShifts(null)
    setShiftsError(null)
    paintedRef.current = null
  }, [profile?.id])

  const loadShifts = useCallback(async (isActive) => {
    if (!profile?.id) return
    try {
      const { startDate, endDate } = shiftWindow()
      // No locationId → the route fans out to all my locations.
      const res = await getMyShifts({ profileId: profile.id, startDate, endDate })
      if (!isActive()) return
      if (!res.success) {
        // Keep the painted list through a blip only when it belongs to the
        // identity being refetched.
        if (!(res.transport && paintedRef.current === profile.id)) {
          setShiftsError(res.error || 'Could not load your shifts')
        }
        return
      }
      setShiftsError(null)
      setMyShifts(res.data || [])
      paintedRef.current = profile.id
    } catch (e) {
      // authHeaders() → supabase.auth.getSession() runs OUTSIDE api()'s own
      // try, so an uncaught rejection there would strand the spinner forever.
      if (isActive()) setShiftsError(e?.message || 'Could not load your shifts')
    }
  }, [profile?.id])

  const loadRoster = useCallback(async (isActive, locationId) => {
    if (!locationId) {
      if (isActive()) setRoster({ locationId: null, rows: [] })
      return
    }
    const today = isoDate(new Date())
    try {
      const res = await getTeamShifts({ locationId, startDate: today, endDate: today })
      // Stamped with the location it was fetched FOR, so the render can
      // refuse to show it under a different studio's name.
      if (isActive()) setRoster({ locationId, rows: res.success ? (res.data || []) : [] })
    } catch {
      if (isActive()) setRoster({ locationId, rows: [] }) // a garnish — never an error state
    }
  }, [])

  useFocusEffect(useCallback(() => {
    let active = true
    focusedRef.current = true
    loadShifts(() => active)
    return () => { active = false; focusedRef.current = false }
  }, [loadShifts]))

  // Roster follows the DETECTED location (re-runs when detection lands).
  useFocusEffect(useCallback(() => {
    let active = true
    if (physStatus === 'at_studio') loadRoster(() => active, physLocationId)
    return () => { active = false }
  }, [physStatus, physLocationId, loadRoster]))

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    // Real liveness, not `() => true`: a pull-to-refresh the user walks away
    // from must not repaint the screen they left. The spinner is stopped
    // unconditionally, though — a stuck spinner is worse than a late one.
    const isActive = () => focusedRef.current
    // Detection is part of "refresh": the whole point of the gesture on this
    // screen is usually "I've just walked in" / "I've just left".
    await Promise.all([
      refreshPhysical(),
      loadShifts(isActive),
      physStatus === 'at_studio' ? loadRoster(isActive, physLocationId) : Promise.resolve(),
    ])
    setRefreshing(false)
  }, [loadShifts, loadRoster, refreshPhysical, physStatus, physLocationId])

  if (!profile) return null
  const firstName = profile.full_name?.split(' ')[0] || 'there'

  // Moved here from the old Home (HOME-LOC.8): the all-features-off
  // onboarding nudge. It lives on Home, not the Dashboard tab, precisely
  // because a user with no mobile features has no dashboard permission
  // either and would never reach that tab.
  //
  // Gated on EVERY location the user holds, not just activeLocation
  // (HOME-LOC.8b). Features are per-location, and Home's own content is
  // cross-location — a coach with Schedule at Hatch whose activeLocation is
  // Stillorgan (features off there) would otherwise hit a wall telling them
  // to ask an admin, on a screen that has their Hatch shifts to show them.
  // Strictly a WIDENING of the old gate: with no locations at all the check
  // falls back to the location-less form the old Home ran (activeLocation
  // was null in exactly that case), so nobody who previously escaped the
  // nudge now hits it.
  const featureLocations = [activeLocation, ...(locations || [])].filter(Boolean)
  const anyLocationHasFeatures = featureLocations.length > 0
    ? featureLocations.some((l) => hasAnyMobileFeature(profile, l))
    : hasAnyMobileFeature(profile, null)
  if (!anyLocationHasFeatures) {
    return (
      <ScrollView className="flex-1 bg-un1t-bg" contentContainerClassName="p-6">
        <Text className="text-3xl font-bold text-un1t-text mb-1">Hi {firstName}</Text>
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mt-4">
          <Text className="text-base font-semibold text-un1t-text mb-1">Mobile features off</Text>
          <Text className="text-sm text-un1t-subtle">
            An admin hasn&apos;t enabled any mobile features for your account yet. Ask the gym
            manager to turn on Schedule, Pipeline, or WhatsApp from your profile in the web app.
          </Text>
        </View>
      </ScrollView>
    )
  }

  const controlsPickable = pickerLocations(profile, locations, 'device_control')

  function openManualControls() {
    if (controlsPickable.length === 0) return
    if (controlsPickable.length === 1) {
      router.push({ pathname: '/controls', params: { loc: controlsPickable[0].id } })
      return
    }
    // No currentId: nothing is "in force" from here — this row is the
    // remote entry, so every studio is an equally cold pick.
    promptLocationPick({
      pickable: controlsPickable,
      onPick: (id) => router.push({ pathname: '/controls', params: { loc: id } }),
    })
  }

  const onSite = physStatus === 'at_studio'
  // Location permission is the one thing between this user and the on-site
  // Home — and only then. Both async reads must have landed (non-null) so a
  // slow SecureStore can only delay the card, never flash it.
  const showNudge = shouldShowLocationNudge({
    physStatus,
    foregroundPermission,
    dismissed: nudgeDismissed !== false,
    onSiteFeatures: hasOnSiteFeatures(profile, locations),
    isKiosk: isKiosk !== false,
  })
  const todayIso = isoDate(new Date())
  // HOME-LOC.12 — safeHomeTiles, not homeTiles: the tiles are for the DETECTED
  // studio, which is routinely not activeLocation, and timer/TV read
  // activeLocation rather than the ?loc= override the other four honour. Tapping
  // Class timer at a studio that isn't your activeLocation would silently start
  // a timer at the OTHER gym — the same reason the /controls launcher filters to
  // loc-aware tiles (HOME-LOC.9b). Follow-up: make timer/TV loc-aware.
  const tiles = onSite ? safeHomeTiles(profile, physLocation, activeLocation?.id) : []
  const groups = groupShiftsByDay(myShifts || [], todayIso)
  // ONE ROW PER COACH, via the same shared grouper the personal dashboard's
  // "On with you today" strip uses — a coach working three blocks today is
  // one person, and rendering them three times here while the Dashboard tab
  // renders them once is the drift this module exists to prevent. Includes
  // ME: the point is who is in, and "who's on" reads wrong without myself.
  // Only paint a roster that was fetched for the studio now on screen.
  const rosterToday = roster.locationId && roster.locationId === physLocationId
    ? groupTeamShiftsByCoach(roster.rows)
    : []
  const showChips = (locations || []).length > 1

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerClassName="px-4 pt-4 pb-24"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
    >
      <Text className="text-3xl font-bold text-un1t-text">Hi {firstName}</Text>

      {physStatus === 'loading' ? (
        <View className="py-10 items-center"><ActivityIndicator color="#94A3B8" /></View>
      ) : onSite ? (
        <>
          {/* ON-SITE — the studio you are standing in, unmissable. The pill is
              informational here (no picker): Home shows where you ARE, and
              commanding a different studio is the offsite "Studio controls"
              route, which is explicit about being remote. */}
          <Text className="text-xl font-semibold text-un1t-text mt-1 mb-1">{physLocation.name}</Text>
          <LocationPill location={physLocation} source="detected" />

          {tiles.length > 0 ? (
            <View className="gap-3">
              {tiles.map((t) => (
                <ChoiceCard
                  key={t.key}
                  icon={t.icon}
                  tint={t.tint}
                  title={t.title}
                  subtitle={t.subtitle}
                  onPress={() => router.push(t.href)}
                />
              ))}
            </View>
          ) : (
            <Text className="text-sm text-un1t-subtle">No studio controls are enabled for you here.</Text>
          )}

          {rosterToday.length > 0 && (
            <>
              <Text className="text-base font-semibold text-un1t-text mt-6 mb-2">
                Today at {physLocation.name}
              </Text>
              <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-1">
                {rosterToday.map((c, i) => (
                  <View
                    key={c.profileId}
                    className={`flex-row items-center justify-between py-2.5 ${i > 0 ? 'border-t border-un1t-border' : ''}`}
                  >
                    <Text className="text-sm text-un1t-text flex-1 mr-2">{c.name}</Text>
                    <Text className="text-xs text-un1t-subtle">{coachSpanLabel(c)}</Text>
                  </View>
                ))}
              </View>
            </>
          )}
        </>
      ) : (
        <>
          {/* OFFSITE / UNKNOWN — when you're next in, and where. */}
          {showNudge && (
            <EnableLocationCard
              mode={foregroundPermission}
              onChanged={refreshPhysical}
              onDismiss={dismissNudge}
            />
          )}
          <Text className="text-sm text-un1t-subtle mb-4">Your next 7 days</Text>

          {/* The banner sits ABOVE the list rather than replacing it: once a
              good list has been painted, a later failure means "this may be
              stale", not "you have no shifts". Only a failure with nothing
              painted yet (myShifts === null) owns the whole space. */}
          {shiftsError ? (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4 flex-row items-start">
              <Ionicons name="alert-circle-outline" size={14} color="#DC2626" style={{ marginTop: 2 }} />
              <Text className="text-xs text-red-700 ml-2 flex-1">{shiftsError}</Text>
            </View>
          ) : null}

          {myShifts === null ? (
            shiftsError ? null : (
              <View className="py-6 items-center"><ActivityIndicator color="#94A3B8" /></View>
            )
          ) : groups.length === 0 ? (
            <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-4">
              <Text className="text-sm text-un1t-subtle">No shifts this week.</Text>
            </View>
          ) : (
            groups.map((g) => (
              <View key={g.iso} className="mb-4">
                <Text className="text-xs font-semibold text-un1t-subtle uppercase mb-1.5">{g.label}</Text>
                <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-1">
                  {g.shifts.map((s, i) => {
                    const name = showChips ? shiftLocationName(s, locations) : null
                    const c = name ? pickLocationColor(shiftLocationId(s)) : null
                    return (
                      <View
                        key={s.id || i}
                        className={`flex-row items-center justify-between py-2.5 ${i > 0 ? 'border-t border-un1t-border' : ''}`}
                      >
                        <View className="flex-1 mr-2">
                          <Text className="text-sm font-medium text-un1t-text">{s.shift_templates?.name || 'Shift'}</Text>
                          <Text className="text-xs text-un1t-subtle mt-0.5">{shiftTimeLabel(s)}</Text>
                        </View>
                        {c ? (
                          <View className={`rounded-full px-2 py-0.5 ${c.bg}`}>
                            <Text className={`text-[10px] font-semibold ${c.text}`}>{name}</Text>
                          </View>
                        ) : null}
                      </View>
                    )
                  })}
                </View>
              </View>
            ))
          )}

          {controlsPickable.length > 0 && (
            <Pressable
              onPress={openManualControls}
              accessibilityRole="button"
              accessibilityLabel="Studio controls, remote"
              className="flex-row items-center bg-un1t-surface border border-un1t-border rounded-2xl p-4 mt-2 active:opacity-70"
            >
              <Ionicons name="options-outline" size={18} color="#94A3B8" />
              <Text className="text-sm text-un1t-text ml-3 flex-1">Studio controls</Text>
              <Text className="text-xs text-un1t-subtle mr-1">remote</Text>
              <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
            </Pressable>
          )}
        </>
      )}
    </ScrollView>
  )
}
