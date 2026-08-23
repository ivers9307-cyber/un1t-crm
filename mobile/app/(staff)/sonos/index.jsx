// SONOSMOB.5 — Studio music: live control of the Sonos speakers.
//
// Control only. Schedules (windows, run-now, the pause override) are set up
// on the web app under Marketing → Automations → Studio music; this screen
// lists the location's schedules and renders one SonosControlCard per
// schedule. Today that is one card — the studio floor — but a second zone
// needs no change here.
//
// Gates on `device_control`, cross-platform since SONOSMOB.2: the routes the
// cards call enforce that same key, so the gate and the server agree.

import { useState, useCallback, useRef, useEffect } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listSonosSchedules, getSonosHousehold } from '../../../lib/sonos-api'
import SonosControlCard from '../../../components/SonosControlCard'

export default function SonosScreen() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const locationId = activeLocation?.id
  const allowed = canMobile(profile, 'device_control', activeLocation)

  const [schedules, setSchedules] = useState(null)
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
    } catch (e) {
      if (!isActive()) return
      setError(e?.message || 'Could not load studio music')
    }
  }, [locationId])

  useFocusEffect(useCallback(() => {
    let active = true
    if (allowed) load(() => active)
    return () => { active = false }
  }, [allowed, load]))

  // Permission gate — defence in depth. The Studio tile hides the link
  // without access, but a hand-typed deep link would otherwise reach here.
  if (!allowed) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
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
      {error ? (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex-row items-start">
          <Ionicons name="alert-circle-outline" size={14} color="#DC2626" style={{ marginTop: 2 }} />
          <Text className="text-xs text-red-700 ml-2 flex-1">{error}</Text>
        </View>
      ) : schedules === null ? (
        <View className="py-8 items-center">
          <ActivityIndicator color="#94A3B8" />
        </View>
      ) : schedules.length === 0 ? (
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
          <View className="gap-3">
            {schedules.map((s) => (
              <SonosControlCard key={s.id} schedule={s} favorites={favorites} locationId={locationId} />
            ))}
          </View>
        </>
      )}
    </ScrollView>
  )
}
