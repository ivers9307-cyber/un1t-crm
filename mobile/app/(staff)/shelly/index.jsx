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
//  1. `last_state.output === null` IS "UNKNOWN", NEVER "OFF" — lightStateLabel
//     owns that, and it is tested.
//
//  2. BRANCH ON `pending` BEFORE PAINTING THE NEW STATE. A toggle answers
//     `{ success: true, applied: false, pending: true }` when the override is
//     saved and the relay has NOT moved. Painting the requested state there
//     would show a plug as ON while it is physically off. The rate-limited
//     shape of that body arrives with HTTP 429; api() passes a non-2xx body
//     that carries our envelope through unchanged, so `pending: true` arrives
//     intact and `isQueued` reads that field (mobile/lib/shelly.js).
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
//
// SHELLYGROUPS.10 — GROUPS. The plugs are drawn as group cards (one switch
// for the group, its members underneath with their own small switches) and a
// last "Not in a group" card. Every decision — which card a device is in, the
// switch's colour and label, what a group press says, the header line, the
// banner — is a tested helper in mobile/lib/shelly.js (mobile has no screen
// harness); this file does IO and layout only. Two more rules:
//
//  5. A GROUP PRESS BRANCHES ON `pending` BEFORE PAINTING (rule 2, for groups):
//     groupToggleOutcome reads the queued / partial answer first and shows the
//     route's `message`; a partial press paints amber "N of M on" until the
//     next POLL replaces it with the server's counts (the press's own reload
//     does not clear it).
//
//  6. THE DISCOVER CALL (unadopted banner) AND THE CLASS READ (next class) RUN
//     ONCE PER SCREEN FOCUS, never on the 30 s poll: discover reads Shelly's
//     cloud live, and the next class is picked from today's list at render.
//
// Authoring — creating groups, their schedules and membership — stays on the
// web CRM, like every other schedule.

import { useState, useCallback, useRef, useEffect } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, RefreshControl } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { usePhysicalLocation } from '../../../lib/use-physical-location'
import { resolveControlLocation, pickerLocations } from '../../../lib/control-location'
import {
  api, listShellyGroups, toggleShellyGroup, countUnadoptedShelly, listClassesRemainingToday,
} from '../../../lib/api'
import {
  plugTone, plugDisplayName, toggleResultText, errorText, isQueued,
  arrangeShellyCards, groupSwitchView, groupToggleOutcome, deviceSwitchView, memberMeta,
  groupReasonLine, groupIconName, totalWattsText, unadoptedBannerText, nextClassWindow,
  showBackToSchedule, groupAutoOutcome,
  nextClassLabel, screenHeaderLine,
  PLUG_TONE_TEXT, PLUG_TONE_DOT,
} from '../../../lib/shelly'
import { zoneOfLocationRow } from '../../../lib/studio-zone'
import LocationPill from '../../../components/LocationPill'

const POLL_MS = 30_000
// Long enough to read a queued sentence, short enough that it is gone before
// the operator wonders whether it is about the press they just made.
const NOTE_CLEAR_MS = 6_000

const WEB_HINT = 'Groups, schedules and setup live on the web CRM.'

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

// Switch colours (a style, not a class: the track is a plain <View>). Green
// on, grey off, amber mixed (some of a group on), slate for a group whose
// every member is offline, and a pale track with a centred knob for a plug
// whose relay is UNKNOWN (rule 1: neither side is claimed).
const TRACK = Object.freeze({
  on: '#10B981',
  off: '#CBD5E1',
  mixed: '#F59E0B',
  offline: '#94A3B8',
  unknown: '#E2E8F0',
})

// A copy of `set` with `id` added or removed (state sets are never mutated).
function withId(set, id, on) {
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

const NOTE_CLASS = Object.freeze({
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  error: 'text-red-700',
})

// One switch, used for a group and (small) for each device. `checked` is
// true / false / 'mixed' / undefined (unknown); mixed and unknown sit the
// knob in the middle.
function ToggleSwitch({ tone, checked, disabled, busy, small, onPress, accessibilityLabel, accessibilityValue }) {
  const w = small ? 40 : 52
  const h = small ? 24 : 30
  const knob = h - 6
  const left = checked === true ? w - knob - 3 : checked === false ? 3 : (w - knob) / 2
  const off = disabled || busy
  return (
    <View className="flex-row items-center">
      {busy && <ActivityIndicator color="#94A3B8" style={{ marginRight: 8 }} />}
      <Pressable
        onPress={onPress}
        disabled={off}
        // ≥ 44 pt touch target: the small track is 40×24, the large 52×30.
        hitSlop={small ? { top: 10, bottom: 10, left: 4, right: 4 } : { top: 7, bottom: 7, left: 4, right: 4 }}
        accessibilityRole="switch"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={accessibilityValue ? { text: accessibilityValue } : undefined}
        accessibilityState={{ checked, disabled: off, busy: Boolean(busy) }}
        className="active:opacity-70"
        style={{ opacity: off ? 0.4 : 1 }}
      >
        <View style={{ width: w, height: h, borderRadius: h / 2, backgroundColor: TRACK[tone] || TRACK.off }}>
          <View
            style={{
              position: 'absolute', top: 3, left, width: knob, height: knob, borderRadius: knob / 2,
              backgroundColor: '#FFFFFF',
              shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 2, shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            }}
          />
        </View>
      </Pressable>
    </View>
  )
}

// One device row: a member under a group, or a "Not in a group" row. Keeps
// every rule of the old PlugRow — freshness dot, queued/pending notes, the
// offline "your choice is queued" line, controls off only on connected===false.
function DeviceRow({ device, connected, busy, locked, note, onToggle, first }) {
  const health = plugTone(device, connected)
  const meta = memberMeta(device)
  const sw = deviceSwitchView(device, connected)
  // Rule 3 — only a missing CONNECTION kills the switch.
  const controlsOff = connected === false
  return (
    <View className={`py-3 ${first ? '' : 'border-t border-un1t-border'}`}>
      <View className="flex-row items-center">
        <View className="w-2 h-2 rounded-full mr-2" style={{ backgroundColor: PLUG_TONE_DOT[health.tone] }} />
        <View className="flex-1 pr-3">
          <Text className="text-sm font-semibold text-un1t-text" numberOfLines={1}>{plugDisplayName(device)}</Text>
          <Text className="text-xs text-un1t-subtle mt-0.5" numberOfLines={1}>
            {meta.state}
            {/* The freshness verdict only when it is not the healthy green —
                "Online" on every row is noise; "Last seen 9 min ago" is not. */}
            {health.tone !== 'green' && !meta.offline ? (
              <Text className={PLUG_TONE_TEXT[health.tone]}>{` · ${health.label}`}</Text>
            ) : null}
          </Text>
        </View>
        {meta.offline ? (
          <View className="rounded-full px-2 py-0.5 mr-3 bg-slate-500/10">
            <Text className="text-[11px] font-semibold text-slate-700">Offline</Text>
          </View>
        ) : meta.power ? (
          <Text className="text-xs text-un1t-subtle mr-3">{meta.power}</Text>
        ) : null}
        <ToggleSwitch
          small
          tone={sw.tone}
          checked={sw.checked}
          // `locked`: its group's press is in flight — one command at a time.
          disabled={sw.disabled || Boolean(locked)}
          busy={busy}
          accessibilityLabel={sw.accessibilityLabel}
          accessibilityValue={sw.accessibilityValue}
          onPress={() => onToggle(device, sw.nextState)}
        />
      </View>
      {/* An offline plug is still settable — say so rather than looking broken. */}
      {!controlsOff && health.reason === 'offline' && !note && (
        <Text className="text-xs text-un1t-subtle mt-1.5 ml-4">
          Offline — your choice is queued and applied when the plug is back.
        </Text>
      )}
      {note && (
        <Text className={`text-xs mt-1.5 ml-4 ${NOTE_CLASS[note.tone] || NOTE_CLASS.ok}`} accessibilityRole="text">{note.text}</Text>
      )}
    </View>
  )
}

function GroupCard({ group, members, devices, connected, zone, busy, note, partial, onToggle, onAuto, rowProps }) {
  const sw = groupSwitchView(group, devices, { connected, partial })
  // withCount:false — the count is printed once, on the amber line below.
  const reason = groupReasonLine(group, zone, Date.now(), { withCount: false })
  const offerAuto = showBackToSchedule(group) && !sw.empty
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <View className="flex-row items-center">
        <View
          className="w-9 h-9 rounded-full bg-un1t-bg border border-un1t-border items-center justify-center mr-3"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Ionicons name={groupIconName(group.icon)} size={18} color="#111827" />
        </View>
        <View className="flex-1 pr-3">
          <Text className="text-base font-semibold text-un1t-text" numberOfLines={1}>{group.name}</Text>
          <Text className="text-xs text-un1t-subtle mt-0.5" numberOfLines={2}>{reason}</Text>
          {sw.countText && (
            <Text className={`text-xs font-semibold mt-0.5 ${sw.tone === 'mixed' ? 'text-amber-700' : 'text-un1t-subtle'}`}>
              {sw.countText}
            </Text>
          )}
        </View>
        <ToggleSwitch
          tone={sw.tone}
          checked={sw.checked}
          disabled={sw.disabled}
          busy={busy}
          accessibilityLabel={sw.accessibilityLabel}
          accessibilityValue={sw.accessibilityValue}
          onPress={() => onToggle(group, sw.nextState, members.length || Number(group?.now?.member_count) || 0, members)}
        />
      </View>
      {offerAuto && (
        <Pressable
          onPress={() => onAuto(group, members)}
          disabled={busy || connected === false}
          hitSlop={{ top: 12, bottom: 12 }}
          accessibilityRole="button"
          accessibilityLabel={`Back to schedule, ${group.name}`}
          className="self-start mt-2 active:opacity-70"
          style={{ opacity: busy || connected === false ? 0.4 : 1 }}
        >
          <Text className="text-xs font-semibold text-blue-700">Back to schedule</Text>
        </Pressable>
      )}
      {note && (
        <Text className={`text-xs mt-2 ${NOTE_CLASS[note.tone] || NOTE_CLASS.ok}`} accessibilityRole="text">{note.text}</Text>
      )}
      {members.length > 0 && (
        <View className="mt-2">
          {members.map((d, i) => (
            <DeviceRow key={d.id} device={d} first={i === 0} {...rowProps(d)} locked={busy} />
          ))}
        </View>
      )}
    </View>
  )
}

function DeviceListCard({ title, devices, rowProps }) {
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 pt-3 pb-1">
      <Text className="text-xs font-semibold text-un1t-subtle uppercase tracking-wide">{title}</Text>
      <View className="mt-1">
        {devices.map((d, i) => (
          <DeviceRow key={d.id} device={d} first={i === 0} {...rowProps(d)} />
        ))}
      </View>
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
  // The STUDIO's clock for every time on the screen (reason lines, next class).
  const zone = zoneOfLocationRow(controlLocation)
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
  // Per-id busy SETS: one press's finally must not clear another's spinner.
  const [busyIds, setBusyIds] = useState(() => new Set())
  const [notes, setNotes] = useState({})
  // SHELLYGROUPS.10. undefined = not answered yet; null = the list could not
  // be read (every plug is then drawn in one plain card, never hidden).
  const [groups, setGroups] = useState(undefined)
  const [busyGroupIds, setBusyGroupIds] = useState(() => new Set())
  // groupId → { on, count } from a partial press, painted until the next poll.
  const [partials, setPartials] = useState({})
  // Read once per focus (rule 6). null = unknown → no banner / no next class.
  const [unadopted, setUnadopted] = useState(null)
  const [classes, setClasses] = useState(null)

  // The location the painted list was fetched for, without putting `devices` in
  // load()'s deps (that would defeat the [locationId]-only memoisation and
  // re-subscribe the focus effect on every render). Keyed on the location, not
  // a boolean: a blip while refetching for a NEW location must not keep the OLD
  // location's rows painted. Same shape as the Sonos screen.
  const listLocationRef = useRef(null)
  // The groups list's twin of listLocationRef: a failed groups read keeps the
  // painted cards for THIS location (rule 4) rather than collapsing them.
  const groupsLocationRef = useRef(null)
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
    setGroups(undefined)
    setPartials({})
    setUnadopted(null)
    setClasses(null)
    listLocationRef.current = null
    groupsLocationRef.current = null
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
  //
  // `clearPartials` is set by the focus read and the 30 s poll (and the pull
  // to refresh), never by a press's own reload: a partial press's amber
  // "N of M on" stays until the NEXT poll (rule 5).
  const load = useCallback(async (isActive, { clearPartials = false } = {}) => {
    if (!locationId) return
    const n = ++seq.current
    const painted = () => listLocationRef.current === locationId
    const stale = () => locationId !== currentLocationRef.current
    try {
      // In parallel: the groups read never delays the plugs, and a failed one
      // costs only the grouping (below), never the rows.
      const [r, g] = await Promise.all([
        api('/api/shelly/devices', { locationId }),
        (async () => {
          try { return await listShellyGroups(locationId) } catch { return null }
        })(),
      ])
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
      if (g?.success === true && Array.isArray(g.groups)) {
        setGroups(g.groups)
        groupsLocationRef.current = locationId
      } else if (groupsLocationRef.current !== locationId) {
        // Never painted for this studio: draw every plug in one card and say
        // the groups could not be read. Painted already: keep the cards.
        setGroups(null)
      }
      if (clearPartials) setPartials({})
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
    load(isActive, { clearPartials: true })
    const timer = setInterval(() => load(isActive, { clearPartials: true }), POLL_MS)
    return () => { active = false; clearInterval(timer) }
  }, [allowed, load]))

  // Rule 6 — once per focus (and per studio: a flip re-runs it), never on the
  // poll. Both answers are optional decoration, so a failure is null and the
  // banner / next-class part simply does not render.
  useFocusEffect(useCallback(() => {
    let active = true
    if (!allowed || !locationId) return () => { active = false }
    const live = () => active && locationId === currentLocationRef.current
    ;(async () => {
      try {
        const n = await countUnadoptedShelly(locationId)
        if (live()) setUnadopted(n)
      } catch {
        if (live()) setUnadopted(null)
      }
    })()
    ;(async () => {
      try {
        const list = await listClassesRemainingToday(locationId, nextClassWindow(Date.now(), zone))
        if (live()) setClasses(list)
      } catch {
        if (live()) setClasses(null)
      }
    })()
    return () => { active = false }
  }, [allowed, locationId, zone]))

  // A pull also re-asks the unadopted count past its 5-minute cache: the
  // operator asked for "now" (they may have just added a plug in the Shelly
  // app). Best-effort and NOT awaited — the discover read is a live Shelly
  // cloud call, so the spinner ends with the list and the banner updates when
  // the count lands. A studio flip mid-read drops it.
  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    const loc = locationId
    if (allowed && loc) {
      countUnadoptedShelly(loc, { fresh: true })
        .then((n) => { if (loc === currentLocationRef.current) setUnadopted(n) })
        .catch(() => { if (loc === currentLocationRef.current) setUnadopted(null) })
    }
    try {
      await load(() => true, { clearPartials: true })
    } finally {
      setRefreshing(false)
    }
  }, [load, allowed, locationId])

  // try/finally, not a bare await: whatever happens above, the row must not be
  // left spinning. (Since MOBILE-SESSION.1 a failed token refresh answers an
  // envelope rather than throwing, so this is the last-resort net.)
  const toggle = useCallback(async (device, state) => {
    setBusyIds((prev) => withId(prev, device.id, true))
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
      setBusyIds((prev) => withId(prev, device.id, false))
    }
  }, [locationId, load, setNote])

  // Rule 5. groupToggleOutcome reads `pending` / `applied` BEFORE anything is
  // painted: the note is the route's message, a partial paints its amber
  // count, and the reload repaints from the server's counts — so nothing here
  // asserts the requested state.
  const toggleGroup = useCallback(async (group, state, memberCount, members) => {
    const key = `group:${group.id}`
    setBusyGroupIds((prev) => withId(prev, group.id, true))
    setNote(key, null)
    const names = new Map((members || []).map((d) => [d.id, plugDisplayName(d)]))
    try {
      const json = await toggleShellyGroup(group.id, { state }, locationId)
      const out = groupToggleOutcome(json, state, memberCount, (id) => names.get(id) || 'a device')
      setPartials((prev) => {
        const next = { ...prev }
        if (out.partial) next[group.id] = out.partial
        else delete next[group.id]
        return next
      })
      setNote(key, { tone: out.tone, text: out.text })
      await load(() => true)
    } catch {
      setNote(key, { tone: 'error', text: 'That did not work — try again' })
    } finally {
      setBusyGroupIds((prev) => withId(prev, group.id, false))
    }
  }, [locationId, load, setNote])

  // "Back to schedule" (state 'auto'): the same press discipline as the
  // switch — groupAutoOutcome reads partial / none / results[] before any
  // success, and the reload repaints from the server.
  const autoGroup = useCallback(async (group, members) => {
    const key = `group:${group.id}`
    setBusyGroupIds((prev) => withId(prev, group.id, true))
    setNote(key, null)
    const names = new Map((members || []).map((d) => [d.id, plugDisplayName(d)]))
    try {
      const json = await toggleShellyGroup(group.id, { state: 'auto' }, locationId)
      const out = groupAutoOutcome(json, (id) => names.get(id) || 'a device')
      setPartials((prev) => {
        const next = { ...prev }
        delete next[group.id]
        return next
      })
      setNote(key, { tone: out.tone, text: out.text })
      await load(() => true)
    } catch {
      setNote(key, { tone: 'error', text: 'That did not work — try again' })
    } finally {
      setBusyGroupIds((prev) => withId(prev, group.id, false))
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

  const arranged = arrangeShellyCards(devices, groups)
  const rowProps = (d) => ({
    connected,
    busy: busyIds.has(d.id),
    note: notes[d.id],
    onToggle: toggle,
  })
  const headerLine = screenHeaderLine({
    studio: controlLocation?.name || null,
    nextClass: nextClassLabel(classes, Date.now(), zone),
    watts: totalWattsText(devices),
  })
  const banner = unadoptedBannerText(unadopted)

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
      {headerLine ? (
        <Text className="text-sm text-un1t-subtle -mt-2 mb-3">{headerLine}</Text>
      ) : null}
      {banner && (
        <View className="rounded-2xl p-3 flex-row items-start mb-3 bg-amber-500/10 border border-amber-500/30">
          <Ionicons name="warning-outline" size={14} color="#B45309" style={{ marginTop: 2 }} />
          <Text className="text-xs ml-2 flex-1 text-amber-700">{banner}</Text>
        </View>
      )}
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
        // Keyed on the location so a flip REMOUNTS the cards rather than
        // reusing them under the new pill.
        <View key={locationId} className="gap-3">
          {groups === null && (
            <NoticeCard icon="help-circle-outline">Couldn&apos;t read the groups — showing every plug. Retrying.</NoticeCard>
          )}
          {arranged.groups.map(({ group, members }) => (
            <GroupCard
              key={group.id}
              group={group}
              members={members}
              devices={devices}
              connected={connected}
              zone={zone}
              busy={busyGroupIds.has(group.id)}
              note={notes[`group:${group.id}`]}
              partial={partials[group.id]}
              onToggle={toggleGroup}
              onAuto={autoGroup}
              rowProps={rowProps}
            />
          ))}
          {arranged.ungrouped.length > 0 && (
            <DeviceListCard title={arranged.ungroupedTitle} devices={arranged.ungrouped} rowProps={rowProps} />
          )}
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
