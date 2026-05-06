// Studio Management — door unlock + AC control for staff at the
// active location. Permission: studio_management (cross-platform key,
// (mig 093). Web has the same surface at /studio-management.

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator, Alert,
} from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import {
  listDoors, unlockDoor, getAcState, turnAcOn, turnAcOff,
} from '../../lib/studio-mgmt-api'

export default function StudioManagementScreen() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()

  // Permission gate — defence in depth. The More tab won't show
  // the link unless permitted, but a hand-typed deep-link bypass
  // would otherwise reach the page.
  if (!canMobile(profile, 'studio_management', activeLocation)) {
    return (
      <View className="flex-1 bg-un1t-black items-center justify-center p-6">
        <Text className="text-sm text-un1t-light text-center">
          Studio Management isn&apos;t enabled for your role at this location.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  const [refreshing, setRefreshing] = useState(false)

  async function onRefresh() {
    setRefreshing(true)
    // Children re-fetch via their own focus/load effects when keys change.
    // Bumping refreshKey forces remount so they refetch.
    setRefreshKey(k => k + 1)
    setTimeout(() => setRefreshing(false), 600)
  }

  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
      <Stack.Screen options={{ title: 'Studio management' }} />
      <ScrollView
        className="flex-1 bg-un1t-black"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
      >
        <Text className="text-sm text-un1t-light mb-4">
          On-site actions for {activeLocation?.name || 'your active location'}.
        </Text>

        <AcCard key={`ac-${refreshKey}`} locationId={activeLocation?.id} />

        <View className="h-4" />

        <DoorsCard key={`doors-${refreshKey}`} locationId={activeLocation?.id} />
      </ScrollView>
    </>
  )
}

// ── AC card ───────────────────────────────────────────────────────

function AcCard({ locationId }) {
  const [data, setData] = useState(null)
  const [notConfigured, setNotConfigured] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [tick, setTick] = useState(0)
  const pollRef = useRef(null)

  const load = useCallback(async () => {
    if (!locationId) return
    const r = await getAcState(locationId)
    if (r.code === 'sensibo_not_configured') {
      setNotConfigured(true)
      setData(null)
    } else if (!r.success) {
      setError(r.error || 'Failed to load')
    } else {
      setNotConfigured(false)
      setError(null)
      setData(r.data)
    }
  }, [locationId])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
    // Poll every 30s while the screen is mounted.
    pollRef.current = setInterval(load, 30_000)
    return () => clearInterval(pollRef.current)
  }, [load])

  // Re-render every second when the AC is active so the countdown
  // updates without polling.
  useEffect(() => {
    if (!data?.active_session?.auto_off_at) return
    const i = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(i)
  }, [data?.active_session?.auto_off_at])
  void tick

  async function turnOn() {
    setBusy('on'); setError(null)
    const r = await turnAcOn(locationId)
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
    Alert.alert('Turn the AC off?', '', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: turnOff },
    ])
  }
  async function turnOff() {
    setBusy('off')
    const r = await turnAcOff(locationId)
    setBusy(null)
    if (!r.success) Alert.alert('Could not turn off', r.error || 'Unknown error')
    else load()
  }

  if (loading) {
    return (
      <Card>
        <Header label="Air conditioning" icon="snow-outline" tint="#2563EB" />
        <ActivityIndicator color="#94A3B8" />
      </Card>
    )
  }
  if (notConfigured) {
    return (
      <Card>
        <Header label="Air conditioning" icon="snow-outline" tint="#2563EB" />
        <View className="bg-un1t-black/40 border border-un1t-gray rounded-xl p-3 flex-row items-start">
          <Ionicons name="settings-outline" size={14} color="#94A3B8" style={{ marginTop: 2 }} />
          <Text className="text-xs text-un1t-light ml-2 flex-1">
            AC isn&apos;t set up for this location yet. A master can add the Sensibo API key + pod ID
            under Settings → Locations → AC on the web app.
          </Text>
        </View>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <Header label="Air conditioning" icon="snow-outline" tint="#2563EB" />
        <Text className="text-sm text-red-700">{error}</Text>
      </Card>
    )
  }
  if (!data) return null

  const session = data.active_session
  const isOn = !!session
  let minsLeft = null
  if (session?.auto_off_at) {
    const ms = new Date(session.auto_off_at).getTime() - Date.now()
    minsLeft = Math.max(0, Math.ceil(ms / 60_000))
  }

  return (
    <Card>
      <Header label="Air conditioning" icon="snow-outline" tint="#2563EB" />
      <Text className="text-xs text-un1t-light mb-3">
        Preset:{' '}
        <Text className="text-un1t-white font-semibold">
          {data.defaults.mode || 'cool'} · {data.defaults.temp ?? 18}°C · fan {data.defaults.fan || 'high'}
        </Text>
        {' '}for{' '}
        <Text className="text-un1t-white font-semibold">{data.defaults.session_minutes || 90} min</Text>.
      </Text>

      {!isOn ? (
        <Pressable
          onPress={turnOn}
          disabled={busy === 'on'}
          className="bg-blue-600 active:opacity-80 disabled:opacity-50 px-4 py-4 rounded-xl items-center flex-row justify-center"
        >
          {busy === 'on'
            ? <ActivityIndicator color="#FFFFFF" />
            : <Ionicons name="snow" size={22} color="#FFFFFF" />}
          <Text className="text-base font-bold text-white ml-2">
            {busy === 'on' ? 'Turning on…' : 'Turn on AC'}
          </Text>
        </Pressable>
      ) : (
        <View className="bg-blue-600/10 border-2 border-blue-500/40 rounded-xl p-4">
          <View className="flex-row items-start">
            <Ionicons name="snow" size={28} color="#60A5FA" />
            <View className="flex-1 ml-3">
              <Text className="text-base font-bold text-un1t-white">AC is running</Text>
              {session?.profiles?.full_name && (
                <Text className="text-xs text-un1t-light mt-0.5">
                  Started by {session.profiles.full_name}
                </Text>
              )}
            </View>
            <View className="items-end">
              <View className="flex-row items-center">
                <Ionicons name="time-outline" size={16} color="#93C5FD" />
                <Text className="text-2xl font-bold text-blue-200 ml-1.5">
                  {minsLeft != null ? `${minsLeft} min` : '—'}
                </Text>
              </View>
              <Text className="text-[10px] text-un1t-light">until auto-off</Text>
            </View>
          </View>

          {data.pod_state && (
            <Text className="text-xs text-un1t-light bg-un1t-black/40 rounded px-3 py-2 mt-3">
              Sensibo: {data.pod_state.on ? 'on' : 'off'}
              {data.pod_state.mode ? ` · ${data.pod_state.mode}` : ''}
              {data.pod_state.targetTemperature != null ? ` · ${data.pod_state.targetTemperature}°C` : ''}
              {data.pod_state.fanLevel ? ` · fan ${data.pod_state.fanLevel}` : ''}
            </Text>
          )}

          <Pressable
            onPress={confirmTurnOff}
            disabled={busy === 'off'}
            className="bg-red-500/15 border border-red-500/30 active:opacity-70 disabled:opacity-50 px-4 py-3 rounded-xl items-center flex-row justify-center mt-3"
          >
            {busy === 'off'
              ? <ActivityIndicator color="#DC2626" />
              : <Ionicons name="power" size={16} color="#DC2626" />}
            <Text className="text-sm font-semibold text-red-700 ml-2">Turn off now</Text>
          </Pressable>
        </View>
      )}
    </Card>
  )
}

// ── Doors card ────────────────────────────────────────────────────

function DoorsCard({ locationId }) {
  const [doors, setDoors] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!locationId) return
    setLoading(true)
    listDoors(locationId).then(r => {
      if (r.code === 'unifi_not_configured' || (!r.success && /not.*configured/i.test(r.error || ''))) {
        setDoors([])
        setError(r.error || 'UniFi not configured for this location.')
      } else if (!r.success) {
        setError(r.error || 'Failed to load doors')
        setDoors([])
      } else {
        setDoors(r.data || [])
      }
    }).finally(() => setLoading(false))
  }, [locationId])

  return (
    <Card>
      <Header label="Door unlock" icon="key-outline" tint="#A855F7" />
      {loading ? (
        <ActivityIndicator color="#94A3B8" />
      ) : error ? (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
          <Text className="text-sm text-red-700">{error}</Text>
        </View>
      ) : doors.length === 0 ? (
        <Text className="text-sm text-un1t-light">No doors configured at this studio.</Text>
      ) : (
        doors.map((door, i) => (
          <DoorRow
            key={door.id}
            door={door}
            locationId={locationId}
            isLast={i === doors.length - 1}
          />
        ))
      )}
    </Card>
  )
}

// Two-stage unlock: first tap "arms" the button (3-second window),
// second tap fires. Matches the web pattern + UniFi mobile UX.
function DoorRow({ door, locationId, isLast }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [unlockedAt, setUnlockedAt] = useState(null)
  const armTimer = useRef(null)
  const fadeTimer = useRef(null)

  function arm() {
    if (busy) return
    setArmed(true)
    clearTimeout(armTimer.current)
    armTimer.current = setTimeout(() => setArmed(false), 3000)
  }

  async function fire() {
    clearTimeout(armTimer.current)
    setArmed(false)
    setBusy(true)
    const r = await unlockDoor(door.id, locationId)
    setBusy(false)
    if (r.success) {
      setUnlockedAt(Date.now())
      clearTimeout(fadeTimer.current)
      fadeTimer.current = setTimeout(() => setUnlockedAt(null), 5000)
    } else {
      Alert.alert('Unlock failed', r.error || 'Unknown error')
    }
  }

  useEffect(() => () => {
    clearTimeout(armTimer.current)
    clearTimeout(fadeTimer.current)
  }, [])

  return (
    <Pressable
      onPress={armed ? fire : arm}
      disabled={busy}
      className={`flex-row items-center px-1 py-3.5 active:opacity-70 ${!isLast ? 'border-b border-un1t-gray' : ''}`}
    >
      <Ionicons
        name={armed ? 'lock-open' : 'lock-closed-outline'}
        size={20}
        color={armed ? '#A855F7' : '#94A3B8'}
      />
      <View className="flex-1 ml-3">
        <Text className="text-base font-semibold text-un1t-white">{door.name}</Text>
        {unlockedAt && !armed && !busy && (
          <Text className="text-xs text-green-600 mt-0.5">Unlocked just now</Text>
        )}
        {armed && (
          <Text className="text-xs text-purple-700 font-medium mt-0.5">
            Tap again within 3s to unlock
          </Text>
        )}
      </View>
      {busy
        ? <ActivityIndicator color="#94A3B8" />
        : armed
          ? <Ionicons name="arrow-forward-circle" size={22} color="#A855F7" />
          : <Ionicons name="chevron-forward" size={16} color="#94A3B8" />}
    </Pressable>
  )
}

// ── Shared ────────────────────────────────────────────────────────

function Card({ children }) {
  return (
    <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5">
      {children}
    </View>
  )
}
function Header({ label, icon, tint }) {
  return (
    <View className="flex-row items-center mb-3">
      <Ionicons name={icon} size={18} color={tint} />
      <Text className="text-xs font-bold text-un1t-white uppercase tracking-wider ml-2">{label}</Text>
    </View>
  )
}
