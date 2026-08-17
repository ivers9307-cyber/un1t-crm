// Devices screen — mirrors src/app/account/devices/{page,DevicesManager,ScanForStraps}.jsx.
//
// Data:
//   contact_devices — fetched via supabase RLS (mig 112 grants customer full
//   CRUD on their own rows). Columns: id, device_type, identifier, label,
//   manufacturer, is_active, added_by_contact, created_at.
//
// Scan:
//   Calls supabase.rpc('scan_straps_for_contact') every 2 s — identical to
//   the web's ScanForStraps.jsx. The bridge (champ-bridge Pi) populates the
//   data this RPC reads; no browser-only API involved.
//
// Device-key helpers:
//   Inlined from src/lib/heart-rate-devices.js + src/lib/device-onboarding.js
//   (both pure; cannot be imported from src/lib in mobile).

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  View, Text, Pressable, ScrollView, TextInput, ActivityIndicator,
  Alert, Modal,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../../lib/member/supabase'
import { useAuth } from '../../../lib/member/contact-context'
import Card from '../../../components/member/ui/Card'

// ── Inlined from src/lib/heart-rate-devices.js ───────────────────────────────

const KNOWN_MANUFACTURERS = ['polar', 'wahoo', 'coospo', 'garmin', 'apple', 'whoop', 'unknown']

function canonicaliseMac(input) {
  if (typeof input !== 'string') return null
  const hex = input.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length !== 12) return null
  return hex.match(/.{2}/g).join(':')
}

function canonicaliseAntId(input) {
  if (input == null) return null
  const s = String(input).trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null
  return String(n)
}

function makeDeviceKey(protocol, rawId) {
  if (protocol === 'ble') {
    const mac = canonicaliseMac(rawId)
    return mac ? `ble:${mac}` : null
  }
  if (protocol === 'ant') {
    const id = canonicaliseAntId(rawId)
    return id ? `ant:${id}` : null
  }
  return null
}

function parseDeviceKey(key) {
  if (typeof key !== 'string') return null
  const idx = key.indexOf(':')
  if (idx < 1) return null
  const protocol = key.slice(0, idx)
  const rest = key.slice(idx + 1)
  if (protocol === 'ble') {
    const mac = canonicaliseMac(rest)
    return mac ? { protocol: 'ble', deviceId: mac } : null
  }
  if (protocol === 'ant') {
    const id = canonicaliseAntId(rest)
    return id ? { protocol: 'ant', deviceId: id } : null
  }
  return null
}

function canonicaliseDeviceKey(key) {
  const parsed = parseDeviceKey(key)
  return parsed ? `${parsed.protocol}:${parsed.deviceId}` : null
}

/** { protocol: 'ANT+' | 'BLE' | null, label: string } */
function describeIdentifier(identifier) {
  const parsed = parseDeviceKey(identifier)
  if (!parsed) return { protocol: null, label: identifier }
  return {
    protocol: parsed.protocol === 'ant' ? 'ANT+' : 'BLE',
    label: parsed.deviceId,
  }
}

function validateDeviceInput(input) {
  const deviceType = String(input?.device_type || '').trim()
  if (!['chest_strap', 'watch'].includes(deviceType)) {
    return { ok: false, error: 'Device type must be chest_strap or watch.' }
  }
  let identifier = String(input?.identifier || '').trim()
  if (!identifier) return { ok: false, error: 'Identifier is required.' }

  if (deviceType === 'chest_strap') {
    const asKey = canonicaliseDeviceKey(identifier)
    if (asKey) {
      identifier = asKey
    } else {
      const protocol = String(input?.protocol || 'ble').trim().toLowerCase()
      if (protocol !== 'ble' && protocol !== 'ant') {
        return { ok: false, error: 'Protocol must be Bluetooth or ANT+.' }
      }
      const key = makeDeviceKey(protocol, identifier)
      if (!key) {
        return {
          ok: false,
          error: protocol === 'ant'
            ? 'That doesn\'t look like a valid ANT+ device number (1–65535).'
            : 'That doesn\'t look like a valid MAC address (AA:BB:CC:DD:EE:FF).',
        }
      }
      identifier = key
    }
  } else if (identifier.length > 200) {
    return { ok: false, error: 'Identifier too long.' }
  }

  const label = input?.label != null ? String(input.label).trim().slice(0, 80) : null
  let manufacturer = input?.manufacturer != null ? String(input.manufacturer).toLowerCase().trim() : null
  if (manufacturer && !KNOWN_MANUFACTURERS.includes(manufacturer)) manufacturer = 'unknown'
  return {
    ok: true,
    normalised: {
      device_type: deviceType,
      identifier,
      label: label || null,
      manufacturer: manufacturer || null,
    },
  }
}

// ── Inlined from src/lib/device-onboarding.js ────────────────────────────────

const DEVICE_KINDS = [
  { key: 'chest_strap', label: 'Chest strap' },
  { key: 'watch',       label: 'Watch / wearable' },
]

function deviceTypeForKind(kind) {
  return ['chest_strap', 'watch'].includes(kind) ? kind : 'chest_strap'
}

function broadcastGuide(kind, manufacturer) {
  if (deviceTypeForKind(kind) === 'watch') {
    const isGarmin = String(manufacturer || '').toLowerCase() === 'garmin'
    return {
      title: isGarmin
        ? 'Turn on Broadcast Heart Rate (Garmin)'
        : 'Turn on Broadcast Heart Rate',
      steps: isGarmin
        ? [
            'On your watch: Settings → Sensors & Accessories → Wrist Heart Rate → Broadcast During Activity (or hold the menu and choose Broadcast HR).',
            'Wear the watch snugly so it has a steady pulse reading.',
            'Then tap Scan below — your watch appears within a few seconds.',
          ]
        : [
            "Turn on your watch's \"Broadcast heart rate\" mode (look under its heart-rate or sensor settings).",
            'Wear it snugly so it has a steady pulse reading.',
            'Then tap Scan below — your watch appears within a few seconds.',
          ],
      caveat: 'Most watches need broadcast switched on again before each class, and it uses a little extra battery.',
    }
  }
  return {
    title: 'Using a chest strap',
    steps: [
      "Wet the strap's contacts and put it on.",
      'Walk into the studio, then tap Scan below to pick it.',
    ],
    caveat: null,
  }
}

// Sniff manufacturer from BLE advertised name (mirrors ScanForStraps.jsx)
function detectManufacturer(name) {
  if (!name) return null
  const n = name.toLowerCase()
  if (n.includes('polar')) return 'polar'
  if (n.includes('wahoo') || n.includes('tickr')) return 'wahoo'
  if (n.includes('coospo')) return 'coospo'
  if (n.includes('garmin')) return 'garmin'
  if (n.includes('whoop')) return 'whoop'
  return null
}

// ── Scan modal (mirrors ScanForStraps.jsx exactly) ───────────────────────────

const POLL_INTERVAL_MS = 2000

function ScanModal({ onClose, onPick }) {
  const [straps, setStraps] = useState([])
  const [error, setError] = useState(null)
  const [_polling, setPolling] = useState(true)
  const [tickedAt, setTickedAt] = useState(null)
  const timerRef = useRef(null)

  async function poll() {
    const { data, error: e } = await supabase.rpc('scan_straps_for_contact')
    if (e) {
      clearInterval(timerRef.current)
      timerRef.current = null
      setError(e.message || 'Scan failed')
      setPolling(false)
      return
    }
    setStraps(data || [])
    setTickedAt(new Date())
    setError(null)
  }

  useEffect(() => {
    poll()
    timerRef.current = setInterval(() => { poll() }, POLL_INTERVAL_MS)
    return () => clearInterval(timerRef.current)
  }, [])

  function retryPoll() {
    clearInterval(timerRef.current)
    timerRef.current = null
    setPolling(true)
    setError(null)
    poll()
    timerRef.current = setInterval(() => { poll() }, POLL_INTERVAL_MS)
  }

  const timeStr = tickedAt
    ? tickedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null

  return (
    <Modal
      animationType="slide"
      transparent
      visible
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end bg-black/60">
        <View className="rounded-t-2xl bg-iron-surface border border-iron-hairline p-5 pb-8">
          {/* Header */}
          <View className="flex-row items-center justify-between mb-3">
            <View className="flex-row items-center gap-2">
              <Ionicons name="bluetooth-outline" size={18} color="#B3B2AC" />
              <Text className="text-base font-display text-chalk">Scan for your strap</Text>
            </View>
            <Pressable
              onPress={onClose}
              className="rounded p-1.5 active:bg-iron-raised"
            >
              <Ionicons name="close-outline" size={18} color="#B3B2AC" />
            </Pressable>
          </View>

          <Text className="text-xs text-chalk-2 mb-4">
            Wear your strap and stand near the studio. Nearby straps appear below — tap yours to register it.
          </Text>

          {/* Error */}
          {error && (
            <View className="mb-3 rounded-xl border border-red-900 bg-red-950 p-3">
              <Text className="text-sm text-red-200">{error}</Text>
              <Pressable onPress={retryPoll} className="mt-2 flex-row items-center gap-1">
                <Ionicons name="refresh-outline" size={12} color="#FCA5A5" />
                <Text className="text-xs font-body-medium text-red-300 underline">Try again</Text>
              </Pressable>
            </View>
          )}

          {/* Strap list */}
          {straps.length === 0 && !error ? (
            <View className="items-center py-8 rounded-xl border border-dashed border-iron-hairline">
              <ActivityIndicator color="#F1EEE7" />
              <Text className="mt-3 text-sm text-chalk-2">Looking for nearby straps…</Text>
              <Text className="mt-1 text-xs text-chalk-3">Make sure your strap is on and you're inside the studio.</Text>
            </View>
          ) : (
            <View className="gap-2 max-h-64">
              <ScrollView>
                {straps.map((s) => (
                  <Pressable
                    key={s.device_key}
                    onPress={() => onPick({
                      identifier: s.device_key,
                      protocol: s.protocol,
                      label: s.name || null,
                      manufacturer: detectManufacturer(s.name),
                      lastBpm: s.last_bpm,
                    })}
                    className="flex-row items-center gap-3 rounded-xl border border-iron-hairline bg-iron-surface p-3 mb-2 active:bg-iron-raised"
                  >
                    <Ionicons name="heart-outline" size={18} color="#FF4E42" />
                    <View className="flex-1 min-w-0">
                      <View className="flex-row items-center gap-1.5">
                        <Text className="text-sm font-body-medium text-chalk flex-1" numberOfLines={1}>
                          {s.name || 'Heart-rate strap'}
                        </Text>
                        <View className="rounded-full border border-iron-hairline px-2.5 py-0.5">
                          <Text className="font-mono text-[10px] text-chalk-2 uppercase" style={{ letterSpacing: 1.2 }}>
                            {s.protocol === 'ant' ? 'ANT+' : 'BLE'}
                          </Text>
                        </View>
                      </View>
                      <Text className="font-mono text-[11px] text-chalk-2" numberOfLines={1}>
                        {s.device_key}{typeof s.rssi === 'number' ? ` · ${s.rssi} dBm` : ''}
                      </Text>
                    </View>
                    {typeof s.last_bpm === 'number' && s.last_bpm > 0 && (
                      <View className="rounded-full border border-iron-hairline px-2.5 py-0.5">
                        <Text className="font-mono text-[10px] text-chalk-2" style={{ letterSpacing: 1.2 }}>{s.last_bpm} bpm</Text>
                      </View>
                    )}
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Footer */}
          <View className="mt-4 flex-row items-center justify-between">
            <Text className="font-mono text-[11px] text-chalk-3">
              {timeStr ? `Updated ${timeStr}` : 'Searching…'}
            </Text>
            <Pressable onPress={onClose}>
              <Text className="text-sm font-body-medium text-chalk-2">Cancel</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

// ── Add device form (mirrors AddDeviceForm in DevicesManager.jsx) ─────────────

function AddDeviceForm({ onSubmit, onCancel, prefill }) {
  const [protocol, setProtocol] = useState(prefill?.protocol || 'ble')
  const [kind, setKind] = useState(
    String(prefill?.manufacturer || '').toLowerCase() === 'garmin' ? 'watch' : 'chest_strap',
  )
  const [identifier, setIdentifier] = useState(prefill?.identifier || '')
  const [label, setLabel] = useState(prefill?.label || '')
  const [manufacturer, setManufacturer] = useState(prefill?.manufacturer || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const fromScan = Boolean(prefill?.identifier)
  const isAnt = protocol === 'ant'
  const guide = broadcastGuide(kind, manufacturer)

  async function submit() {
    setBusy(true)
    setErr(null)
    try {
      await onSubmit({
        device_type: deviceTypeForKind(kind),
        protocol,
        identifier: identifier.trim(),
        label: label.trim() || null,
        manufacturer: manufacturer || null,
      })
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="mt-4 rounded-[20px] border border-iron-hairline bg-iron-raised p-4">
      {/* Kind selector */}
      <Text className="text-xs font-body-medium text-chalk-2 mb-1">What are you adding?</Text>
      <View className="flex-row gap-2 mb-3">
        {DEVICE_KINDS.map((k) => (
          <Pressable
            key={k.key}
            onPress={() => setKind(k.key)}
            className={`flex-1 rounded-xl border px-3 py-2 items-center ${
              kind === k.key
                ? 'border-chalk bg-chalk'
                : 'border-iron-hairline bg-iron-surface'
            }`}
          >
            <Text className={`text-sm font-body-medium ${kind === k.key ? 'text-iron-bg' : 'text-chalk-2'}`}>
              {k.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Broadcast guide */}
      <View className="rounded-xl border border-iron-hairline bg-iron-surface p-3 mb-3">
        <Text className="text-xs font-body-semibold text-chalk">{guide.title}</Text>
        {guide.steps.map((step, i) => (
          <Text key={i} className="text-xs text-chalk-2 mt-1">
            {i + 1}. {step}
          </Text>
        ))}
        {guide.caveat ? (
          <Text className="text-[11px] text-chalk-3 mt-2">{guide.caveat}</Text>
        ) : null}
      </View>

      {/* Protocol selector (only for manual entry) */}
      {!fromScan && (
        <View className="mb-3">
          <Text className="text-xs font-body-medium text-chalk-2 mb-1">Connection type</Text>
          <View className="flex-row gap-2">
            {[['ble', 'Bluetooth'], ['ant', 'ANT+']].map(([val, lbl]) => (
              <Pressable
                key={val}
                onPress={() => setProtocol(val)}
                className={`flex-1 rounded-xl border px-3 py-2 items-center ${
                  protocol === val
                    ? 'border-chalk bg-chalk'
                    : 'border-iron-hairline bg-iron-surface'
                }`}
              >
                <Text className={`text-sm font-body-medium ${protocol === val ? 'text-iron-bg' : 'text-chalk-2'}`}>
                  {lbl}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* Identifier */}
      <View className="mb-3">
        <Text className="text-xs font-body-medium text-chalk-2 mb-1">
          {fromScan ? 'Strap' : isAnt ? 'ANT+ device number' : 'Strap MAC address'}
          {fromScan ? ' (detected via scan)' : ''}
        </Text>
        <TextInput
          value={identifier}
          onChangeText={setIdentifier}
          editable={!fromScan}
          placeholder={isAnt ? '12345' : 'AA:BB:CC:DD:EE:FF'}
          placeholderTextColor="#727170"
          autoCapitalize="none"
          autoCorrect={false}
          className="w-full rounded-xl border border-iron-hairline bg-iron-raised px-3 py-2 font-mono text-sm text-chalk"
        />
      </View>

      {/* Label + Manufacturer */}
      <View className="flex-row gap-3 mb-3">
        <View className="flex-1">
          <Text className="text-xs font-body-medium text-chalk-2 mb-1">Label (optional)</Text>
          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder="My Polar H10"
            placeholderTextColor="#727170"
            className="w-full rounded-xl border border-iron-hairline bg-iron-raised px-3 py-2 text-sm text-chalk"
          />
        </View>
        <View className="flex-1">
          <Text className="text-xs font-body-medium text-chalk-2 mb-1">Brand</Text>
          {/* RN has no <select>; render a mini inline picker */}
          <ManufacturerPicker value={manufacturer} onChange={setManufacturer} />
        </View>
      </View>

      {err ? <Text className="text-sm text-red-400 mb-2">{err}</Text> : null}

      <View className="flex-row items-center gap-3 mt-1">
        <Pressable
          onPress={submit}
          disabled={busy || !identifier.trim()}
          className="flex-row items-center gap-1 rounded-xl bg-chalk px-4 py-2.5 active:opacity-80 disabled:opacity-40"
        >
          {busy ? (
            <ActivityIndicator size="small" color="#131316" />
          ) : (
            <Ionicons name="add-outline" size={14} color="#131316" />
          )}
          <Text className="text-sm font-body-semibold text-iron-bg">{busy ? 'Saving…' : 'Add device'}</Text>
        </Pressable>
        <Pressable onPress={onCancel}>
          <Text className="text-sm font-body-medium text-chalk-2">Cancel</Text>
        </Pressable>
      </View>
    </View>
  )
}

// Mini manufacturer picker — cycles through options on press (no native <select>)
const MFR_OPTIONS = ['', ...KNOWN_MANUFACTURERS]
const MFR_LABELS = { '': 'Select…', polar: 'Polar', wahoo: 'Wahoo', coospo: 'Coospo', garmin: 'Garmin', apple: 'Apple', whoop: 'Whoop', unknown: 'Unknown' }

function ManufacturerPicker({ value, onChange }) {
  function next() {
    const idx = MFR_OPTIONS.indexOf(value)
    onChange(MFR_OPTIONS[(idx + 1) % MFR_OPTIONS.length])
  }
  return (
    <Pressable
      onPress={next}
      className="w-full flex-row items-center justify-between rounded-xl border border-iron-hairline bg-iron-raised px-3 py-2"
    >
      <Text className="text-sm text-chalk">{MFR_LABELS[value] || 'Select…'}</Text>
      <Ionicons name="chevron-down-outline" size={14} color="#B3B2AC" />
    </Pressable>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function Devices() {
  const router = useRouter()
  const { contact } = useAuth()

  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [prefill, setPrefill] = useState(null)

  const load = useCallback(async () => {
    if (!contact?.id) { setLoading(false); return }
    setLoading(true)
    setError(null)
    const { data, error: e } = await supabase
      .from('contact_devices')
      .select('id, device_type, identifier, label, manufacturer, is_active, added_by_contact, created_at')
      .eq('contact_id', contact.id)
      .order('is_active', { ascending: false })
      .order('created_at', { ascending: false })
    setLoading(false)
    if (e) setError(e.message)
    else setDevices(data || [])
  }, [contact?.id])

  const refresh = useCallback(async () => {
    if (!contact?.id) return
    const { data } = await supabase
      .from('contact_devices')
      .select('id, device_type, identifier, label, manufacturer, is_active, added_by_contact, created_at')
      .eq('contact_id', contact.id)
      .order('is_active', { ascending: false })
      .order('created_at', { ascending: false })
    setDevices(data || [])
  }, [contact?.id])

  useFocusEffect(
    useCallback(() => { load() }, [load])
  )

  async function handleAdd(input) {
    if (!contact?.id) throw new Error('Your account is still finishing setup — reopen the app in a moment.')
    const valid = validateDeviceInput(input)
    if (!valid.ok) throw new Error(valid.error)
    const { error: e } = await supabase
      .from('contact_devices')
      .insert({
        contact_id: contact.id,
        ...valid.normalised,
        added_by_contact: true,
      })
    if (e) {
      if (/duplicate key/i.test(e.message)) {
        throw new Error("You've already added this device.")
      }
      throw new Error(e.message)
    }
    setAdding(false)
    setPrefill(null)
    await refresh()
  }

  function handleDelete(deviceId) {
    Alert.alert(
      'Remove device',
      'Remove this device? Your heart rate will no longer auto-sync at the studio.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const { error: e } = await supabase
              .from('contact_devices')
              .delete()
              .eq('id', deviceId)
              .eq('contact_id', contact.id)
            if (e) setError(e.message)
            else await refresh()
          },
        },
      ]
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24">

        {/* Back */}
        <Pressable
          onPress={() => router.back()}
          className="flex-row items-center gap-1 mb-4 self-start active:opacity-60"
        >
          <Ionicons name="chevron-back-outline" size={18} color="#B3B2AC" />
          <Text className="text-sm text-chalk-2">Back</Text>
        </Pressable>

        {/* Header */}
        <Text className="text-2xl font-display-bold text-chalk">Heart rate devices</Text>
        <Text className="mt-1 text-sm text-chalk-2">
          Add the chest strap you train with so your heart rate auto-syncs at the studio. No more pairing each class.
        </Text>

        {/* Error banner */}
        {error ? (
          <View className="mt-4 rounded-xl border border-red-900 bg-red-950 p-3">
            <Text className="text-sm text-red-200">{error}</Text>
          </View>
        ) : null}

        {/* Unlinked-account state — contact hasn't been linked yet */}
        {!loading && !contact ? (
          <Card className="mt-6">
            <View className="flex-row items-center gap-2 mb-2">
              <ActivityIndicator size="small" color="#B3B2AC" />
              <Text className="text-sm font-body-semibold text-chalk">Finishing setting up your account…</Text>
            </View>
            <Text className="text-sm text-chalk-2">
              This usually takes a moment. Close and reopen the app if this persists.
            </Text>
          </Card>
        ) : null}

        {/* Device list card */}
        {(loading || contact) ? (
        <View className="mt-6 rounded-[20px] border border-iron-hairline bg-iron-surface p-5">
          {/* Card header + actions */}
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-base font-display text-chalk">Your devices</Text>
            {!adding && (
              <View className="flex-row gap-2">
                <Pressable
                  onPress={() => setScanning(true)}
                  className="flex-row items-center gap-1 rounded-xl border border-iron-hairline px-2.5 py-1.5 active:bg-iron-raised"
                >
                  <Ionicons name="bluetooth-outline" size={13} color="#B3B2AC" />
                  <Text className="text-xs font-body-medium text-chalk-2">Scan</Text>
                </Pressable>
                <Pressable
                  onPress={() => { setPrefill(null); setAdding(true) }}
                  className="flex-row items-center gap-1 rounded-xl bg-chalk px-2.5 py-1.5 active:opacity-80"
                >
                  <Ionicons name="add-outline" size={13} color="#131316" />
                  <Text className="text-xs font-body-semibold text-iron-bg">Add manually</Text>
                </Pressable>
              </View>
            )}
          </View>

          {loading ? (
            <View className="mt-6 items-center">
              <ActivityIndicator color="#F1EEE7" />
            </View>
          ) : devices.length === 0 && !adding ? (
            <Text className="mt-4 text-sm text-chalk-2">
              No devices yet. The easiest way: wear your strap, walk into the studio, then tap{' '}
              <Text className="font-body-medium text-chalk">Scan</Text>. We'll show every nearby strap and
              you can pick yours with one tap. Or use{' '}
              <Text className="font-body-medium text-chalk">Add manually</Text> if you know your strap's MAC address.
            </Text>
          ) : (
            <View className="mt-4 gap-2">
              {devices.map((d) => {
                const desc = describeIdentifier(d.identifier)
                return (
                  <View
                    key={d.id}
                    className="flex-row items-center gap-3 rounded-xl border border-iron-hairline bg-iron-raised p-3"
                  >
                    <Ionicons name="heart-outline" size={16} color="#FF4E42" />
                    <View className="flex-1 min-w-0">
                      <View className="flex-row flex-wrap items-center gap-1">
                        <Text className="text-sm font-body-medium text-chalk" numberOfLines={1}>
                          {d.label || desc.label}
                        </Text>
                        {desc.protocol ? (
                          <View className="rounded-full border border-iron-hairline px-2.5 py-0.5">
                            <Text className="font-mono text-[10px] text-chalk-2 uppercase" style={{ letterSpacing: 1.2 }}>{desc.protocol}</Text>
                          </View>
                        ) : null}
                        {!d.is_active ? (
                          <View className="rounded-full border border-iron-hairline px-2.5 py-0.5">
                            <Text className="font-mono text-[10px] text-chalk-2 uppercase" style={{ letterSpacing: 1.2 }}>inactive</Text>
                          </View>
                        ) : null}
                        {d.device_type === 'watch' ? (
                          <View className="rounded-full border border-iron-hairline px-2.5 py-0.5">
                            <Text className="font-mono text-[10px] text-chalk-2 uppercase" style={{ letterSpacing: 1.2 }}>Watch</Text>
                          </View>
                        ) : null}
                      </View>
                      {d.device_type === 'watch' && d.is_active ? (
                        <Text className="text-[11px] text-chalk-2 mt-0.5">
                          Enable Broadcast HR on your watch before class.
                        </Text>
                      ) : null}
                      <Text className="font-mono text-xs text-chalk-2 mt-0.5" numberOfLines={1}>
                        {desc.label}{d.manufacturer ? ` · ${d.manufacturer}` : ''}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => handleDelete(d.id)}
                      className="rounded p-1.5 active:bg-iron-surface"
                    >
                      <Ionicons name="trash-outline" size={14} color="#FF4E42" />
                    </Pressable>
                  </View>
                )
              })}
            </View>
          )}

          {adding && (
            <AddDeviceForm
              onCancel={() => { setAdding(false); setPrefill(null) }}
              onSubmit={handleAdd}
              prefill={prefill}
            />
          )}
        </View>
        ) : null}

        {/* Help card */}
        <Card className="mt-6">
          <Text className="text-sm font-display text-chalk">Finding your strap's ID</Text>
          <Text className="mt-2 text-sm text-chalk-2">
            The easiest way is <Text className="font-body-semibold text-chalk">Scan</Text> — wear your strap in the studio and pick it from the list. To add one manually:
          </Text>
          <Text className="mt-2 text-sm text-chalk-2">
            • <Text className="font-body-semibold text-chalk">Bluetooth</Text>: use your strap's MAC address — Polar Flow or the Wahoo app → Devices, or printed on the unit. Any BLE scanner app (LightBlue, nRF Connect) also shows it.
          </Text>
          <Text className="mt-1.5 text-sm text-chalk-2">
            • <Text className="font-body-semibold text-chalk">ANT+</Text>: use your strap's ANT+ device number — usually shown in your watch or training app when it pairs the sensor. Scan is much easier for ANT+.
          </Text>
        </Card>
      </ScrollView>

      {/* Scan modal */}
      {scanning && (
        <ScanModal
          onClose={() => setScanning(false)}
          onPick={(picked) => {
            setScanning(false)
            setPrefill(picked)
            setAdding(true)
          }}
        />
      )}
    </SafeAreaView>
  )
}
