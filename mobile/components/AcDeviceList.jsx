// MOBILE-AC.2 — shared AC device list (Sensibo + LG ThinQ), grouped by
// device_group. Extracted from app/ac/index.jsx so the Studio Management tab
// and the /ac screen render the SAME unified list (web parity with
// AcControlPanel). Renders a plain <View> — the parent supplies the scroll
// container, so it can sit inside the Studio tab's ScrollView alongside Doors.
//
// Per-device allowlist is enforced server-side (profile_locations.ac_device_ids);
// this just renders what /devices returns. Each card polls its own /devices/[id].

import { useState, useEffect, useRef, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator, Alert, AppState } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from 'expo-router'
import {
  listAcDevices,
  getAcDevice,
  turnOnAcDevice,
  turnOffAcDevice,
  extendAcDevice,
} from '../lib/studio-mgmt-api'

const POLL_INTERVAL_MS = 30_000

/**
 * Poll on an interval, but only while the app is FOREGROUNDED, and
 * re-fetch immediately on returning to the foreground.
 *
 * SENSIBO-RATE.1 follow-up. Until mig 580 each of these polls was a
 * LIVE vendor call, so a backgrounded phone left on this screen kept
 * burning Sensibo's burst budget indefinitely — which is how the AC
 * crons found nothing left when they needed to act. It reads the DB
 * now, so this is no longer load-bearing for the vendor; it is just
 * correct, and it stops a pocketed phone doing work nobody can see.
 *
 * Complementary to useFocusEffect: that fires on SCREEN focus within
 * the app, this one on APP foreground/background.
 */
function useForegroundPoll(load, deps) {
  const ref = useRef(load)
  // Assigned in an effect, not during render — writing a ref during
  // render is a React Compiler violation ("Cannot access refs during
  // render") and eslint fails the build on it.
  useEffect(() => { ref.current = load })
  useEffect(() => {
    const run = () => { if (AppState.currentState === 'active') ref.current() }
    run()
    const timer = setInterval(run, POLL_INTERVAL_MS)
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') ref.current()
    })
    return () => { clearInterval(timer); sub.remove() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/**
 * "as of HH:MM" for a cached vendor reading. The state shown here
 * comes from ac_devices.last_state — refreshed by the
 * ac-external-rule cron every 5 min and written immediately on every
 * CRM-initiated change — so it must not be labelled "Live".
 */
function asOfLabel(iso) {
  if (!iso) return null
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return null
  return t.toLocaleTimeString('en-IE', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin',
  })
}

export default function AcDeviceList({ locationId }) {
  const [devices, setDevices] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!locationId) return
    const r = await listAcDevices(locationId)
    if (!r.success) {
      setError(r.error || 'Failed to load AC devices')
      return
    }
    setError(null)
    setDevices(r.data || [])
  }, [locationId])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  // Re-fetch the list every 30s in case a master enables / disables a device
  // while the screen is mounted. Individual cards drive their own state polls.
  // Paused while the app is backgrounded.
  useForegroundPoll(load, [load])

  useFocusEffect(useCallback(() => { load() }, [load]))

  if (loading) {
    return (
      <View className="py-8 items-center">
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }

  if (error) {
    return (
      <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex-row items-start">
        <Ionicons name="alert-circle-outline" size={14} color="#DC2626" style={{ marginTop: 2 }} />
        <Text className="text-xs text-red-700 ml-2 flex-1">{error}</Text>
      </View>
    )
  }

  if (!devices || devices.length === 0) {
    return (
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 flex-row items-start">
        <Ionicons name="settings-outline" size={14} color="#94A3B8" style={{ marginTop: 2 }} />
        <Text className="text-xs text-un1t-subtle ml-2 flex-1">
          No AC units are set up for you at this location yet. A master adds devices on the
          web app under <Text className="text-un1t-text font-semibold">Settings → Locations → AC Devices</Text>
          {' '}and ticks the ones you can control on your staff record.
        </Text>
      </View>
    )
  }

  // STUDIO-AC-GROUPS.1 — same grouping logic as the web AcControlPanel. Master
  // sets the group per device on the web settings tab; mobile is read-only on it.
  const groups = groupDevicesMobile(devices)

  return (
    <View className="gap-5">
      {groups.map(({ name, devices: groupDevices }) => (
        <View key={name} className="gap-2">
          <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle px-1">
            {name}
          </Text>
          <View className="gap-3">
            {groupDevices.map((d) => (
              <DeviceCard key={d.id} device={d} locationId={locationId} />
            ))}
          </View>
        </View>
      ))}
    </View>
  )
}

function groupDevicesMobile(devices) {
  const map = new Map()
  for (const d of devices) {
    const key = d.device_group || 'Other'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(d)
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === 'Other') return 1
      if (b === 'Other') return -1
      return a.localeCompare(b)
    })
    .map(([name, ds]) => ({ name, devices: ds }))
}

// ── DeviceCard ────────────────────────────────────────────────────

function DeviceCard({ device, locationId }) {
  const [state, setState] = useState(null)     // { state, active_session }
  const [stateError, setStateError] = useState(null)
  const [busy, setBusy] = useState(null)       // 'on' | 'off' | 'extend'
  const [tick, setTick] = useState(0)

  const load = useCallback(async () => {
    const r = await getAcDevice(device.id, locationId)
    if (!r.success) {
      setStateError(r.error || 'Failed to load')
      return
    }
    setStateError(null)
    setState(r.data)
  }, [device.id, locationId])

  useForegroundPoll(load, [load])

  // Re-render every second when active so the countdown updates without polling.
  // Either source — app-session auto_off_at or the cron-set expected_off_at on
  // the external_start row — drives the same countdown.
  useEffect(() => {
    if (!state?.active_session?.auto_off_at && !state?.external_start?.expected_off_at) return
    const i = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(i)
  }, [state?.active_session?.auto_off_at, state?.external_start?.expected_off_at])
  void tick

  async function turnOn() {
    setBusy('on')
    const r = await turnOnAcDevice(device.id, locationId)
    setBusy(null)
    if (r.code === 'already_running') {
      Alert.alert('AC is already on', r.error || 'Still running, no action taken.')
      load()
    } else if (!r.success) {
      Alert.alert('Could not turn on', r.error || 'Unknown error')
    } else {
      load()
    }
  }

  function confirmTurnOff() {
    Alert.alert(`Turn ${device.label} off?`, '', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: turnOff },
    ])
  }
  async function turnOff() {
    setBusy('off')
    const r = await turnOffAcDevice(device.id, locationId)
    setBusy(null)
    if (!r.success) Alert.alert('Could not turn off', r.error || 'Unknown error')
    else load()
  }

  async function extend() {
    setBusy('extend')
    const r = await extendAcDevice(device.id, locationId)
    setBusy(null)
    if (r.code === 'no_active_session') {
      Alert.alert('Not running', r.error || 'There is no active session to extend.')
      load()
    } else if (!r.success) {
      Alert.alert('Could not extend', r.error || 'Unknown error')
    } else {
      load()
    }
  }

  // STUDIO-AC-EXTERNAL.1 — same reconciliation as the web panel. Vendor on +
  // no session = control_source 'external' (wall panel or vendor schedule).
  const session = state?.active_session
  const vendorOn = state?.state?.on === true
  const externalStart = state?.external_start
  const controlSource = session ? 'app' : (vendorOn ? 'external' : null)
  const isOn = !!controlSource
  let minsLeft = null
  if (session?.auto_off_at) {
    const ms = new Date(session.auto_off_at).getTime() - Date.now()
    minsLeft = Math.max(0, Math.ceil(ms / 60_000))
  } else if (externalStart?.expected_off_at && controlSource === 'external') {
    const ms = new Date(externalStart.expected_off_at).getTime() - Date.now()
    minsLeft = Math.max(0, Math.ceil(ms / 60_000))
  }

  const providerLabel = device.provider === 'thinq' ? 'LG ThinQ' : 'Sensibo'
  const presetLabel =
    `${device.default_mode || 'cool'} · ${device.default_temp_c ?? 22}°C` +
    ` · fan ${device.default_fan || 'auto'} · ${device.session_minutes || 30} min`

  return (
    <View
      className={`rounded-2xl p-4 ${
        isOn
          ? 'bg-blue-600/10 border-2 border-blue-500/40'
          : 'bg-un1t-surface border border-un1t-border'
      }`}
    >
      {/* Header row */}
      <View className="flex-row items-start gap-3 mb-2">
        <Ionicons name="snow-outline" size={20} color={isOn ? '#93C5FD' : '#60A5FA'} />
        <View className="flex-1 min-w-0">
          <View className="flex-row items-center gap-2">
            <Text className="text-base font-bold text-un1t-text flex-shrink" numberOfLines={1}>
              {device.label}
            </Text>
            <Text className="text-[10px] uppercase tracking-wider text-un1t-muted font-mono">
              {providerLabel}
            </Text>
          </View>
          <Text className="text-[11px] text-un1t-subtle mt-0.5">{presetLabel}</Text>
        </View>
        {isOn && controlSource === 'app' && (
          <View className="items-end">
            <View className="flex-row items-center">
              <Ionicons name="time-outline" size={14} color="#93C5FD" />
              <Text className="text-xl font-bold text-blue-200 ml-1">
                {minsLeft != null ? `${minsLeft}m` : '—'}
              </Text>
            </View>
            <Text className="text-[10px] text-un1t-subtle">auto-off</Text>
          </View>
        )}
        {isOn && controlSource === 'external' && minsLeft != null && (
          <View className="items-end">
            <View className="flex-row items-center">
              <Ionicons name="time-outline" size={14} color="#93C5FD" />
              <Text className="text-xl font-bold text-blue-200 ml-1">{minsLeft}m</Text>
            </View>
            <Text className="text-[10px] text-un1t-subtle">auto-off · external</Text>
          </View>
        )}
        {isOn && controlSource === 'external' && minsLeft == null && (
          <View className="items-end">
            <Text className="text-[11px] uppercase tracking-wider text-blue-200">Running</Text>
            <Text className="text-[10px] text-un1t-subtle">externally</Text>
          </View>
        )}
      </View>

      {/* Soft error strip — keep the buttons usable so a vendor blip doesn't
          strand the user. */}
      {stateError && !isOn && (
        <View className="bg-amber-500/10 border border-amber-500/30 rounded-md p-2 mb-2 flex-row items-start">
          <Ionicons name="warning-outline" size={11} color="#F59E0B" style={{ marginTop: 2 }} />
          <Text className="text-[11px] text-amber-700 ml-1.5 flex-1">
            Couldn&apos;t reach the AC vendor just now. Buttons still work.
          </Text>
        </View>
      )}

      {!isOn ? (
        <Pressable
          onPress={turnOn}
          disabled={busy === 'on'}
          className="bg-blue-600 active:opacity-80 disabled:opacity-50 px-4 py-3.5 rounded-xl flex-row items-center justify-center"
        >
          {busy === 'on'
            ? <ActivityIndicator color="#FFFFFF" />
            : <Ionicons name="snow" size={18} color="#FFFFFF" />}
          <Text className="text-base font-bold text-white ml-2">
            {busy === 'on' ? 'Turning on…' : 'Turn on'}
          </Text>
        </Pressable>
      ) : (
        <View className="gap-2">
          {controlSource === 'app' && session?.profiles?.full_name && (
            <Text className="text-[11px] text-un1t-subtle">
              Started by {session.profiles.full_name}
            </Text>
          )}
          {controlSource === 'external' && (
            <View className="bg-amber-500/10 border border-amber-500/30 rounded-md p-2 flex-row items-start">
              <Ionicons name="warning-outline" size={11} color="#F59E0B" style={{ marginTop: 2 }} />
              <Text className="text-[11px] text-amber-700 ml-1.5 flex-1">
                Turned on externally. No auto-off timer — use Off when done.
              </Text>
            </View>
          )}
          {state?.state && (
            <View className="bg-un1t-bg/40 rounded-md px-3 py-1.5">
              <Text className="text-[11px] text-un1t-subtle">
                {state.state.on ? 'on' : 'off'}
                {state.state.mode ? ` · ${state.state.mode}` : ''}
                {state.state.target_temp_c != null ? ` · ${state.state.target_temp_c}°C` : ''}
                {state.state.fan ? ` · fan ${state.state.fan}` : ''}
                {/* Not "Live" — the last observed reading, not a fresh
                    vendor call. When it was taken is the difference
                    between "the AC is off" and "it was off 5 min ago". */}
                {asOfLabel(state.state_as_of) ? ` · as of ${asOfLabel(state.state_as_of)}` : ''}
              </Text>
            </View>
          )}
          <View className="flex-row gap-2">
            {controlSource === 'app' && (
              <Pressable
                onPress={extend}
                disabled={busy === 'extend'}
                className="flex-1 bg-un1t-border/40 active:opacity-70 disabled:opacity-50 px-3 py-2.5 rounded-xl flex-row items-center justify-center"
              >
                {busy === 'extend'
                  ? <ActivityIndicator color="#94A3B8" />
                  : <Ionicons name="add" size={14} color="#94A3B8" />}
                <Text className="text-sm font-semibold text-un1t-subtle ml-1.5">
                  +{device.session_minutes || 30}m
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={confirmTurnOff}
              disabled={busy === 'off'}
              className="flex-1 bg-red-500/15 border border-red-500/30 active:opacity-70 disabled:opacity-50 px-3 py-2.5 rounded-xl flex-row items-center justify-center"
            >
              {busy === 'off'
                ? <ActivityIndicator color="#DC2626" />
                : <Ionicons name="power" size={14} color="#DC2626" />}
              <Text className="text-sm font-semibold text-red-700 ml-1.5">Off</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  )
}
