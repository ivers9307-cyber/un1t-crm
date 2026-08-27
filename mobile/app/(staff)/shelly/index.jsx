// SHELLY-MOB.1 — Smart plugs: what each adopted relay is doing, and on/off.
//
// CONTROL ONLY, deliberately. Schedules (fixed windows, class-linked rules),
// adopt/remove, the energy history and the Shelly account connection are the
// AUTHORING half of the surface and stay on the web CRM under Marketing →
// Automations → Smart plugs — they want a screen. Richard's scope for mobile
// was the toggle and nothing else.
//
// Gates on `device_control`, the same top-level cross-platform key the
// /api/shelly/* routes enforce (`withAuth({ permission: 'device_control' })`),
// so the gate and the server agree and the UI never offers something the
// server refuses. Same shape as the Sonos screen one directory over; no new
// server code, no new permission key.
//
// FOUR RULES CARRIED OVER FROM THE WEB CARD (src/components/automations/
// ShellyDeviceCard.jsx). Each was a backend review finding, and each is a lie
// waiting to happen if this file paraphrases it:
//
//  1. `last_state.output === null` IS "UNKNOWN", NEVER "OFF" — plugStateLabel
//     owns that, and it is tested.
//
//  2. BRANCH ON `pending` BEFORE PAINTING THE NEW STATE. A toggle answers
//     `{ success: true, applied: false, pending: true }` when the override is
//     saved and the relay has NOT moved. Painting the requested state there
//     would show a plug as ON while it is physically off. The rate-limited
//     shape of that body arrives with HTTP 429, which mobile's api() flattens
//     — `isQueued` recovers it by status, see mobile/lib/shelly.js.
//
//  3. ONLY `connected === false` DISABLES THE BUTTONS. An OFFLINE plug is
//     still settable: the toggle route writes the override BEFORE it sends
//     anything and the cron applies a live override to every adopted device,
//     enabled or not — so pressing On is a real instruction that lands when
//     the plug wakes up, not a no-op. The third state, `connected: null`
//     ('unknown'), is OUR read failing rather than the studio's, and disables
//     nothing at all.
//
//  4. A FAILED POLL NEVER BLANKS THE ROWS. The list is the operator's view of
//     live hardware; replacing it with "Network error" for a tick is worse
//     than showing a slightly stale reading under a retry line. Same posture
//     as SonosControlCard.

import { useState, useCallback, useRef, useEffect } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, RefreshControl } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { usePhysicalLocation } from '../../../lib/use-physical-location'
import { resolveControlLocation, pickerLocations } from '../../../lib/control-location'
import { api } from '../../../lib/api'
import {
  plugTone, plugStateLabel, plugDisplayName, toggleResultText, errorText, isQueued,
  PLUG_TONE_TEXT, PLUG_TONE_DOT,
} from '../../../lib/shelly'
import LocationPill from '../../../components/LocationPill'

const POLL_MS = 30_000
// Long enough to read a queued sentence, short enough that it is gone before
// the operator wonders whether it is about the press they just made.
const NOTE_CLEAR_MS = 6_000

const WEB_HINT = 'Schedules and setup live on the web CRM.'

function NoticeCard({ icon, tone, children }) {
  const isError = tone === 'error'
  return (
    <View
      className={`rounded-2xl p-3 flex-row items-start mb-3 ${
        isError ? 'bg-red-500/10 border border-red-500/30' : 'bg-un1t-surface border border-un1t-border'
      }`}
    >
      <Ionicons name={icon} size={14} color={isError ? '#DC2626' : '#94A3B8'} style={{ marginTop: 2 }} />
      <Text className={`text-xs ml-2 flex-1 ${isError ? 'text-red-700' : 'text-un1t-subtle'}`}>{children}</Text>
    </View>
  )
}

// The manual switch. Two halves of one pill so the CURRENT state is visible at
// a glance — and neither half is highlighted when the relay is Unknown, which
// is the honest render for a plug that has told us nothing (rule 1).
function OnOff({ output, busy, disabled, onPress }) {
  const half = (label, isOn) => {
    const active = output === isOn
    return (
      <Pressable
        onPress={() => onPress(isOn ? 'on' : 'off')}
        disabled={disabled || busy}
        accessibilityRole="button"
        accessibilityState={{ selected: active, disabled: disabled || busy }}
        accessibilityLabel={`Switch ${isOn ? 'on' : 'off'}`}
        className={`px-5 py-2 active:opacity-70 ${active ? 'bg-un1t-bg' : ''}`}
      >
        <Text className={`text-sm ${active ? 'font-semibold text-un1t-text' : 'text-un1t-subtle'}`}>{label}</Text>
      </Pressable>
    )
  }
  return (
    <View className="flex-row items-center">
      <View className={`flex-row rounded-full border border-un1t-border overflow-hidden ${disabled || busy ? 'opacity-40' : ''}`}>
        {half('On', true)}
        <View className="w-px bg-un1t-border" />
        {half('Off', false)}
      </View>
      {busy && <ActivityIndicator color="#94A3B8" style={{ marginLeft: 10 }} />}
    </View>
  )
}

function PlugRow({ device, connected, busy, note, onToggle }) {
  const health = plugTone(device, connected)
  // Rule 3 — only a missing CONNECTION kills the strip. `connected === false`,
  // never `!== true`: an unknown connection is our read failing.
  const controlsOff = connected === false
  const noteClass = note?.tone === 'error'
    ? 'text-red-700'
    : note?.tone === 'warn' ? 'text-amber-700' : 'text-emerald-700'

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <View className="flex-row items-start justify-between">
        <View className="flex-1 pr-3">
          <Text className="text-base font-semibold text-un1t-text" numberOfLines={1}>
            {plugDisplayName(device)}
          </Text>
          <Text className="text-sm text-un1t-text mt-0.5">{plugStateLabel(device)}</Text>
        </View>
        <View className="flex-row items-center shrink-0">
          <View
            className="w-2 h-2 rounded-full mr-1.5"
            style={{ backgroundColor: PLUG_TONE_DOT[health.tone] }}
          />
          <Text className={`text-[11px] ${PLUG_TONE_TEXT[health.tone]}`}>{health.label}</Text>
        </View>
      </View>

      <View className="mt-3">
        <OnOff
          output={device.last_state?.output}
          busy={busy}
          disabled={controlsOff}
          onPress={(state) => onToggle(device, state)}
        />
      </View>

      {/* An offline plug is still settable — say so rather than looking broken. */}
      {!controlsOff && health.reason === 'offline' && !note && (
        <Text className="text-xs text-un1t-subtle mt-2">
          Offline — your choice is queued and applied when the plug is back.
        </Text>
      )}
      {controlsOff && !note && (
        <Text className="text-xs text-un1t-subtle mt-2">Connect Shelly on the web CRM first.</Text>
      )}
      {note && (
        <Text className={`text-xs mt-2 ${noteClass}`} accessibilityRole="text">{note.text}</Text>
      )}
    </View>
  )
}

export default function ShellyScreen() {
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

  const [devices, setDevices] = useState(null)
  // undefined = not answered yet. The route sends true / false / null, and all
  // three mean something different (see rule 3 + plugTone).
  const [connected, setConnected] = useState(undefined)
  const [connectionStatus, setConnectionStatus] = useState(undefined)
  const [error, setError] = useState(null)     // only ever shown when NOTHING is painted
  const [retrying, setRetrying] = useState(false) // the subordinate line under painted rows
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [notes, setNotes] = useState({})

  // The location the painted list was fetched for, without putting `devices` in
  // load()'s deps (that would defeat the [locationId]-only memoisation and
  // re-subscribe the focus effect on every render). Keyed on the location, not
  // a boolean: a blip while refetching for a NEW location must not keep the OLD
  // location's rows painted. Same shape as the Sonos screen.
  const listLocationRef = useRef(null)
  // HOME-LOC.10b — the location the SCREEN is on NOW, readable from inside an
  // in-flight load(). `seq` alone does not cover this: it only invalidates a
  // load once a LATER one has started, and the toggle/refresh paths call
  // load(() => true) with the locationId their closure captured. Flip studios
  // mid-toggle and that resolve would repaint the PREVIOUS studio's plug rows
  // — and stamp listLocationRef with them — under a pill naming the new one,
  // for up to a full poll interval (spec §5: the list and the pill must never
  // disagree). Seeded from the first render's id so there is no window before
  // the effect below runs.
  const currentLocationRef = useRef(locationId)
  // Stops an older tick painting over a newer answer, which matters right after
  // a toggle's reload.
  const seq = useRef(0)
  const noteTimers = useRef({})

  // New location → spinner, not the old list.
  useEffect(() => {
    currentLocationRef.current = locationId
    setDevices(null)
    setConnected(undefined)
    setConnectionStatus(undefined)
    setError(null)
    setRetrying(false)
    setNotes({})
    listLocationRef.current = null
  }, [locationId])

  useEffect(() => {
    const timers = noteTimers.current
    return () => { Object.values(timers).forEach((t) => clearTimeout(t)) }
  }, [])

  const setNote = useCallback((id, note) => {
    setNotes((prev) => ({ ...prev, [id]: note }))
    if (noteTimers.current[id]) clearTimeout(noteTimers.current[id])
    if (!note) return
    noteTimers.current[id] = setTimeout(() => {
      delete noteTimers.current[id]
      setNotes((prev) => ({ ...prev, [id]: null }))
    }, NOTE_CLEAR_MS)
  }, [])

  // try/catch around the whole thing: defence in depth. MOBILE-SESSION.1 put
  // the token refresh inside api()'s guard — a failed one now answers a
  // transport envelope — so reaching this catch means a defect in the handler.
  //
  // `isActive` guards every setState against a blur-before-resolve race.
  // `stale()` is an INTERNAL guard on purpose — every exit below checks it,
  // so no call site can regress it by passing a permissive isActive (the
  // toggle and pull-to-refresh paths both pass `() => true`, which is right
  // for BLUR — they want their own reload to land — but says nothing about a
  // location flip). isActive stays for the blur race it was written for.
  const load = useCallback(async (isActive) => {
    if (!locationId) return
    const n = ++seq.current
    const painted = () => listLocationRef.current === locationId
    const stale = () => locationId !== currentLocationRef.current
    try {
      const r = await api('/api/shelly/devices', { locationId })
      if (stale() || n !== seq.current || !isActive()) return
      if (!r.success) {
        // Rule 4. The keep-or-blank decision is made on WHETHER WE ALREADY
        // HAVE ROWS FOR THIS LOCATION, not on api()'s `transport` tag: a 500
        // from the route is exactly as recoverable on the next tick as a
        // dropped fetch, and blanking a live studio's plug list for either is
        // the same wrong answer.
        if (painted()) setRetrying(true)
        else setError(r.error || 'Could not load the smart plugs')
        return
      }
      setError(null)
      setRetrying(false)
      setDevices(r.devices || [])
      setConnected(r.connected)
      setConnectionStatus(r.connection_status)
      listLocationRef.current = locationId
    } catch {
      if (stale() || n !== seq.current || !isActive()) return
      // MOBILE-SESSION.1 — never the raw `e.message`. api() answers a failed
      // session read or dropped fetch with an envelope now, so reaching this
      // catch means a defect in the handler above, and an operator cannot act
      // on a parser's wording (the Hatch Street "JSON Parse error" came from
      // exactly here).
      if (painted()) setRetrying(true)
      else setError('Could not load the smart plugs')
    }
  }, [locationId])

  useFocusEffect(useCallback(() => {
    let active = true
    const isActive = () => active
    if (!allowed) return () => { active = false }
    load(isActive)
    const timer = setInterval(() => load(isActive), POLL_MS)
    return () => { active = false; clearInterval(timer) }
  }, [allowed, load]))

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load(() => true)
    } finally {
      setRefreshing(false)
    }
  }, [load])

  // try/finally, not a bare await: whatever happens above, the row must not be
  // left spinning. (Since MOBILE-SESSION.1 a failed token refresh answers an
  // envelope rather than throwing, so this is the last-resort net.)
  const toggle = useCallback(async (device, state) => {
    setBusyId(device.id)
    setNote(device.id, null)
    try {
      const json = await api(`/api/shelly/devices/${device.id}/toggle`, {
        method: 'POST',
        locationId,
        body: { state },
      })
      const extra = toggleResultText(json)

      // RULE 2 — read the queued answer BEFORE anything that looks like the
      // new state. The reload below repaints from the ROW, which still carries
      // the old `last_state` because the relay has not moved; nothing here
      // asserts the requested state.
      if (isQueued(json)) {
        setNote(device.id, { tone: 'warn', text: extra })
        await load(() => true)
        return
      }
      if (json?.success === false) {
        // The routes fold their reassurance into `error` deliberately, so
        // errorText is the whole sentence — do not prefix it with our own.
        setNote(device.id, { tone: 'error', text: errorText(json, 'That did not work') })
        await load(() => true)
        return
      }
      const done = state === 'on' ? 'Switched on.' : 'Switched off.'
      setNote(device.id, { tone: 'ok', text: extra ? `${done} ${extra}` : done })
      await load(() => true)
    } catch {
      // Human copy, not the exception — see the load() catch above.
      setNote(device.id, { tone: 'error', text: 'That did not work — try again' })
    } finally {
      setBusyId(null)
    }
  }, [locationId, load, setNote])

  // Permission gate — defence in depth. The Studio tile hides the link without
  // access, but a hand-typed deep link would otherwise reach here. The pill
  // renders here too: denied at the RESOLVED studio is not denied everywhere,
  // so this is the escape hatch onto one the user does hold.
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

  // Nothing painted yet and the first read failed — this is the one place a
  // failure replaces the content, because there is no content to keep.
  if (error && devices === null) {
    return (
      <ScrollView
        className="flex-1 bg-un1t-bg"
        contentContainerStyle={{ padding: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
      >
        {/* The pill stays even here — a studio whose first read failed is
            still a studio the operator may want to swap away from. */}
        <LocationPill
          location={controlLocation}
          source={source}
          pickable={pickable}
          onPick={(id) => router.setParams({ loc: id })}
          detecting={detecting}
        />
        <NoticeCard icon="alert-circle-outline" tone="error">{error}</NoticeCard>
      </ScrollView>
    )
  }

  if (devices === null) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }

  // `=== null` rather than falsy: the route sends the status STRING, and
  // `undefined` (a body that carried none) must not be read as "not connected"
  // and sent to a Connect form that does not exist on this surface.
  const notConnected = connectionStatus === null
  const unknownConnection = connectionStatus === 'unknown'
  // 'action_needed' / 'error' — connected is false, so the controls are already
  // off; the operator needs to be told where the fix lives, not what the code is.
  const connectionNeedsAttention = connected === false && !notConnected

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
    >
      <LocationPill
        location={controlLocation}
        source={source}
        pickable={pickable}
        onPick={(id) => router.setParams({ loc: id })}
        detecting={detecting}
      />
      {notConnected && (
        <NoticeCard icon="flash-off-outline">
          Not connected — set up on the web CRM under{' '}
          <Text className="text-un1t-text font-semibold">Automations → Smart plugs</Text>.
        </NoticeCard>
      )}
      {connectionNeedsAttention && (
        <NoticeCard icon="alert-circle-outline">
          Shelly needs attention — check the connection on the web CRM under{' '}
          <Text className="text-un1t-text font-semibold">Automations → Smart plugs</Text>.
        </NoticeCard>
      )}
      {unknownConnection && (
        // The rows stay: the device list read fine and only the connection row
        // did not, which is exactly what this third state exists for.
        <NoticeCard icon="help-circle-outline">Couldn&apos;t read the connection — retrying.</NoticeCard>
      )}

      {devices.length === 0 ? (
        !notConnected && (
          <NoticeCard icon="flash-outline">
            No plugs are adopted at this location yet. Someone with Device control adopts them on the web CRM under{' '}
            <Text className="text-un1t-text font-semibold">Automations → Smart plugs</Text>.
          </NoticeCard>
        )
      ) : (
        // Keyed on the location so a flip REMOUNTS the rows rather than
        // reusing them under the new pill.
        <View key={locationId} className="gap-3">
          {devices.map((d) => (
            <PlugRow
              key={d.id}
              device={d}
              connected={connected}
              busy={busyId === d.id}
              note={notes[d.id]}
              onToggle={toggle}
            />
          ))}
        </View>
      )}

      {/* Subordinate on purpose: the rows above are the last good reading and
          still worth looking at. */}
      {retrying && (
        <Text className="text-xs text-un1t-subtle mt-3">Couldn&apos;t refresh just now — retrying.</Text>
      )}

      <Text className="text-xs text-un1t-subtle mt-4">{WEB_HINT}</Text>
    </ScrollView>
  )
}
