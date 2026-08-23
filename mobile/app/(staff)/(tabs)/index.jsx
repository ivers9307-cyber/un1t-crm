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
// activeLocation is never read for CONTENT here (only for the all-features-off
// gate, which is per-location) and is NEVER written.
// Dashboards live on the Dashboard tab since HOME-LOC.7.

import { useState, useCallback, useRef } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable, RefreshControl, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { hasAnyMobileFeature } from '../../../lib/permissions'
import { usePhysicalLocation } from '../../../lib/use-physical-location'
import { pickerLocations } from '../../../lib/control-location'
import { shiftWindow, shiftTimeLabel, groupShiftsByDay, homeTiles } from '../../../lib/home-logic'
import { getMyShifts, getTeamShifts } from '../../../lib/schedule-api'
import { isoDate } from '../../../lib/dates'
import { pickLocationColor } from 'shared/location-colors'
import ChoiceCard from '../../../components/ChoiceCard'
import LocationPill from '../../../components/LocationPill'

// GET /api/schedule/shifts returns `location_id` and does NOT embed
// `locations` (src/lib/roster-read.js's API_SHIFT_SELECT embeds
// shift_blocks + profiles only) — so the studio chip resolves its NAME from
// the caller's own assignment list rather than from the row. The `?.locations`
// read stays first so the chip keeps working if the route ever grows the
// embed the personal-dashboard route already has.
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
  const phys = usePhysicalLocation()
  // Extracted rather than written inline in the dep arrays below:
  // exhaustive-deps runs at ERROR here and rejects complex expressions.
  const physLocationId = phys.location?.id || null

  const [myShifts, setMyShifts] = useState(null)   // null = loading
  const [shiftsError, setShiftsError] = useState(null)
  const [roster, setRoster] = useState([])         // on-site: today's team at the detected studio
  const [refreshing, setRefreshing] = useState(false)
  // Keep the last painted list through a transport blip (api() tags its
  // self-minted envelopes transport:true — the sonos screen's convention).
  const paintedRef = useRef(false)

  const loadShifts = useCallback(async (isActive) => {
    if (!profile?.id) return
    try {
      const { startDate, endDate } = shiftWindow()
      // No locationId → the route fans out to all my locations.
      const res = await getMyShifts({ profileId: profile.id, startDate, endDate })
      if (!isActive()) return
      if (!res.success) {
        if (!(res.transport && paintedRef.current)) setShiftsError(res.error || 'Could not load your shifts')
        return
      }
      setShiftsError(null)
      setMyShifts(res.data || [])
      paintedRef.current = true
    } catch (e) {
      // authHeaders() → supabase.auth.getSession() runs OUTSIDE api()'s own
      // try, so an uncaught rejection there would strand the spinner forever.
      if (isActive()) setShiftsError(e?.message || 'Could not load your shifts')
    }
  }, [profile?.id])

  const loadRoster = useCallback(async (isActive, locationId) => {
    if (!locationId) {
      if (isActive()) setRoster([])
      return
    }
    const today = isoDate(new Date())
    try {
      const res = await getTeamShifts({ locationId, startDate: today, endDate: today })
      if (isActive()) setRoster(res.success ? (res.data || []) : [])
    } catch {
      if (isActive()) setRoster([]) // roster is a garnish — never an error state
    }
  }, [])

  useFocusEffect(useCallback(() => {
    let active = true
    loadShifts(() => active)
    return () => { active = false }
  }, [loadShifts]))

  // Roster follows the DETECTED location (re-runs when detection lands).
  useFocusEffect(useCallback(() => {
    let active = true
    if (phys.status === 'at_studio') loadRoster(() => active, physLocationId)
    return () => { active = false }
  }, [phys.status, physLocationId, loadRoster]))

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await loadShifts(() => true)
    if (phys.status === 'at_studio') await loadRoster(() => true, physLocationId)
    setRefreshing(false)
  }, [loadShifts, loadRoster, phys.status, physLocationId])

  if (!profile) return null
  const firstName = profile.full_name?.split(' ')[0] || 'there'

  // Moved here from the old Home (HOME-LOC.8): the all-features-off
  // onboarding nudge. It lives on Home, not the Dashboard tab, precisely
  // because a user with no mobile features has no dashboard permission
  // either and would never reach that tab.
  if (!hasAnyMobileFeature(profile, activeLocation)) {
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
    // Android's Alert.alert silently caps at 3 buttons total and appends the
    // `cancel` one last — so a third pickable studio would push Cancel off
    // and the picker would just lose it, no error. Fine at today's
    // 2-location fleet; swap for an ActionSheet before a third goes live
    // (same constraint LocationPill's picker carries).
    Alert.alert('Control which studio?', 'Commands go to the studio you pick.', [
      ...controlsPickable.map((l) => ({
        text: l.name,
        onPress: () => router.push({ pathname: '/controls', params: { loc: l.id } }),
      })),
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const onSite = phys.status === 'at_studio'
  const todayIso = isoDate(new Date())
  const tiles = onSite ? homeTiles(profile, phys.location) : []
  const groups = groupShiftsByDay(myShifts || [], todayIso)
  // Reuses the agenda grouper for its (tested) within-day sort; a 1-day
  // window over today's rows is exactly the roster list. Includes ME — the
  // point is who else is in, and "who's on" reads wrong without myself.
  const rosterToday = groupShiftsByDay(roster, todayIso, 1)[0]?.shifts || []
  const showChips = (locations || []).length > 1

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerClassName="px-4 pt-4 pb-24"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
    >
      <Text className="text-3xl font-bold text-un1t-text">Hi {firstName}</Text>

      {phys.status === 'loading' ? (
        <View className="py-10 items-center"><ActivityIndicator color="#94A3B8" /></View>
      ) : onSite ? (
        <>
          {/* ON-SITE — the studio you are standing in, unmissable. The pill is
              informational here (no picker): Home shows where you ARE, and
              commanding a different studio is the offsite "Studio controls"
              route, which is explicit about being remote. */}
          <Text className="text-xl font-semibold text-un1t-text mt-1 mb-1">{phys.location.name}</Text>
          <LocationPill location={phys.location} source="detected" />

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
                Today at {phys.location.name}
              </Text>
              <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-1">
                {rosterToday.map((s, i) => (
                  <View
                    key={s.id || i}
                    className={`flex-row items-center justify-between py-2.5 ${i > 0 ? 'border-t border-un1t-border' : ''}`}
                  >
                    <Text className="text-sm text-un1t-text flex-1 mr-2">{s.profiles?.full_name || 'Coach'}</Text>
                    <Text className="text-xs text-un1t-subtle">{shiftTimeLabel(s)}</Text>
                  </View>
                ))}
              </View>
            </>
          )}
        </>
      ) : (
        <>
          {/* OFFSITE / UNKNOWN — when you're next in, and where. */}
          <Text className="text-sm text-un1t-subtle mb-4">Your next 7 days</Text>

          {shiftsError ? (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4 flex-row items-start">
              <Ionicons name="alert-circle-outline" size={14} color="#DC2626" style={{ marginTop: 2 }} />
              <Text className="text-xs text-red-700 ml-2 flex-1">{shiftsError}</Text>
            </View>
          ) : myShifts === null ? (
            <View className="py-6 items-center"><ActivityIndicator color="#94A3B8" /></View>
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
