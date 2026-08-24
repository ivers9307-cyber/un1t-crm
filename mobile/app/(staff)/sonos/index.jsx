// SONOSMOB.5 / SONOSGRP.4 — Studio music: live control of the Sonos speakers.
//
// Control only. Schedules (windows, run-now, the pause override) are set up
// on the web app under Marketing → Automations → Studio music; this screen
// renders a "Live now" card per current speaker GROUP (from the household
// response — no schedule needed, which is all Hatch has) above one
// SonosControlCard per schedule. A group card's `onStale` (its ephemeral
// group id answered `regrouped`) re-runs load() so the cards heal to the
// new grouping.
//
// Gates on `device_control`, cross-platform since SONOSMOB.2: the routes the
// cards call enforce that same key, so the gate and the server agree.

import { useState, useCallback, useRef, useEffect } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { usePhysicalLocation } from '../../../lib/use-physical-location'
import { resolveControlLocation, pickerLocations } from '../../../lib/control-location'
import { listSonosSchedules, getSonosHousehold } from '../../../lib/sonos-api'
import SonosControlCard from '../../../components/SonosControlCard'
import LocationPill from '../../../components/LocationPill'

export default function SonosScreen() {
  const { profile, activeLocation, locations } = useAuth()
  const router = useRouter()
  const params = useLocalSearchParams()
  const phys = usePhysicalLocation()
  const overrideId = typeof params.loc === 'string' ? params.loc : null
  // HOME-LOC.10 — override (this visit's ?loc=) ?? detected ?? activeLocation.
  // The pill below always names what the calls command; both derive from the
  // SAME resolved value, so what you see is what you send.
  const { location: controlLocation, source } = resolveControlLocation({
    overrideId,
    physical: phys,
    activeLocation,
    locations,
  })
  const locationId = controlLocation?.id
  const allowed = canMobile(profile, 'device_control', controlLocation)
  const pickable = pickerLocations(profile, locations, 'device_control')
  // HOME-LOC.10b — the screen is usable before the geofence answer lands, on
  // the activeLocation fallback; say so rather than letting an amber "manual"
  // pill flip green mid-reach. An explicit override needs no detection.
  const detecting = phys.status === 'loading' && !overrideId

  const [schedules, setSchedules] = useState(null)
  const [groups, setGroups] = useState([])
  const [favorites, setFavorites] = useState([])
  const [favoritesFailed, setFavoritesFailed] = useState(false)
  const [error, setError] = useState(null)
  // The location the painted list was fetched for, without putting
  // `schedules` in load()'s deps (would defeat the [locationId]-only
  // memoisation and re-subscribe the focus effect on every render). Keyed
  // on the location, not a boolean: a blip while refetching for a NEW
  // location must not keep the OLD location's cards painted.
  const listLocationRef = useRef(null)

  // New location → spinner, not the old list (whose cards would poll
  // now-playing against the new location and 404 until the new list lands).
  useEffect(() => {
    setSchedules(null)
    setGroups([])
    setFavorites([])
    setFavoritesFailed(false)
    listLocationRef.current = null
  }, [locationId])

  // Schedules + favourites change rarely: fetched on focus, not polled.
  // The cards poll now-playing themselves.
  //
  // try/catch: authHeaders() → supabase.auth.getSession() runs OUTSIDE
  // api()'s own try, so an uncaught rejection there would otherwise strand
  // the screen on its loading spinner forever (mirrors the card's `send`).
  //
  // `isActive` guards every setState against a blur-before-resolve race —
  // the effect below flips it false on cleanup, before it can paint stale
  // data over whatever the next-focused screen renders.
  const load = useCallback(async (isActive) => {
    if (!locationId) return
    try {
      const [s, h] = await Promise.all([listSonosSchedules(locationId), getSonosHousehold(locationId)])
      if (!isActive()) return
      if (!s.success) {
        // api() tags its own dropped-fetch envelopes transport:true — keep
        // the last list through a blip, same as the card, but only when that
        // list was fetched for the location being refetched.
        if (!(s.transport && listLocationRef.current === locationId)) setError(s.error || 'Could not load studio music')
        return
      }
      setError(null)
      setSchedules(s.schedules || [])
      listLocationRef.current = locationId
      // A failed favourites read hides the row rather than showing an empty
      // one; the household route flags it separately from "not connected".
      const connected = h.success && h.connected
      setFavorites(connected && !h.favoritesFailed ? (h.favorites || []) : [])
      setFavoritesFailed(Boolean(connected && h.favoritesFailed))
      // Live now cards — one per current speaker group. `reachable: false`
      // is only present when the household's groups fetch failed (the route
      // omits `groups` then); connected + reachable always carries them.
      setGroups(connected && h.reachable !== false ? (h.groups || []) : [])
    } catch (e) {
      if (!isActive()) return
      setError(e?.message || 'Could not load studio music')
    }
  }, [locationId])

  // A group card's onStale re-runs load() through this ref so the reload
  // shares the CURRENT focus session's `active` flag (blur still cancels it)
  // and `handleStale` itself stays identity-stable — a fresh callback per
  // render would re-render every card for nothing.
  const staleReloadRef = useRef(() => {})

  useFocusEffect(useCallback(() => {
    let active = true
    staleReloadRef.current = () => { if (allowed) load(() => active) }
    if (allowed) load(() => active)
    return () => { active = false; staleReloadRef.current = () => {} }
  }, [allowed, load]))

  const handleStale = useCallback(() => { staleReloadRef.current() }, [])

  // Permission gate — defence in depth. The Studio tile hides the link
  // without access, but a hand-typed deep link would otherwise reach here.
  // The pill renders here too: denied at the RESOLVED studio is not denied
  // everywhere, so this is the escape hatch onto one the user does hold.
  if (!allowed) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <LocationPill
          location={controlLocation}
          source={source}
          pickable={pickable}
          onPick={(id) => router.setParams({ loc: id })}
          detecting={detecting}
          className="self-center mb-4"
        />
        <Text className="text-sm text-un1t-subtle text-center">
          Device control isn&apos;t enabled for your role at this location.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <LocationPill
        location={controlLocation}
        source={source}
        pickable={pickable}
        onPick={(id) => router.setParams({ loc: id })}
        detecting={detecting}
      />
      {error ? (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex-row items-start">
          <Ionicons name="alert-circle-outline" size={14} color="#DC2626" style={{ marginTop: 2 }} />
          <Text className="text-xs text-red-700 ml-2 flex-1">{error}</Text>
        </View>
      ) : schedules === null ? (
        <View className="py-8 items-center">
          <ActivityIndicator color="#94A3B8" />
        </View>
      ) : schedules.length === 0 && groups.length === 0 ? (
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 flex-row items-start">
          <Ionicons name="musical-notes-outline" size={14} color="#94A3B8" style={{ marginTop: 2 }} />
          <Text className="text-xs text-un1t-subtle ml-2 flex-1">
            No studio music is set up for this location yet. Someone with Device control sets it up on the
            web app under <Text className="text-un1t-text font-semibold">Marketing → Automations → Studio music</Text>.
          </Text>
        </View>
      ) : (
        <>
          {favoritesFailed && (
            <Text className="text-xs text-un1t-subtle mb-2">
              Favourites couldn&apos;t be loaded just now — leave and come back to retry.
            </Text>
          )}
          {/* Keyed on the location so a flip REMOUNTS the cards rather than
              reusing them: a card's own now-playing poll is state about the
              studio it mounted for, and must not outlive it. */}
          <View key={locationId} className="gap-3">
            {/* SONOSGRP.4 — one live card per current speaker group, no
                schedule needed. The heading only earns its place when there
                are groups; the matching Schedules label only when BOTH
                sections render, so a schedules-only screen looks as before. */}
            {groups.length > 0 && (
              <>
                <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle">Live now</Text>
                {groups.map((g) => (
                  <SonosControlCard
                    key={g.id}
                    group={g}
                    favorites={favorites}
                    locationId={locationId}
                    onStale={handleStale}
                  />
                ))}
              </>
            )}
            {schedules.length > 0 && (
              <>
                {groups.length > 0 && (
                  <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle">Schedules</Text>
                )}
                {schedules.map((s) => (
                  <SonosControlCard key={s.id} schedule={s} favorites={favorites} locationId={locationId} />
                ))}
              </>
            )}
          </View>
          {schedules.length === 0 && (
            <Text className="text-xs text-un1t-subtle mt-3">
              No studio music is set up for this location yet. Someone with Device control sets it up on the
              web app under <Text className="text-un1t-text font-semibold">Marketing → Automations → Studio music</Text>.
            </Text>
          )}
        </>
      )}
    </ScrollView>
  )
}
