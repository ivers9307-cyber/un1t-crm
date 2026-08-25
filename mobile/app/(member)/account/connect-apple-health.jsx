// Connect Apple Health screen (iOS-only).
//
// DIRECT HealthKit: the device reads workouts + heart rate on-device via
// @kingstinct/react-native-healthkit and uploads them straight to un1t-crm's
// customer-authed ingest endpoint (crm.un1tdublin.com). No Open Wearables relay.
//
//   Connect:  requestAuthorization → record connection (crmApi POST connect)
//             → enable background delivery → initial 30-day backfill sync.
//   Disconnect: stop background delivery + crmApi DELETE connect.
//
// "Connected" is tracked in SecureStore (HealthKit hides read-authorization
// status on iOS for privacy, so a local flag is the reliable signal). The sync
// cursor (latest uploaded workout end-time) is persisted too. Both keys are
// namespaced by contact_id so a shared device never inherits another member's
// connection — see mobile/lib/apple-health-keys.js.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, Pressable, ScrollView, ActivityIndicator, Platform,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as SecureStore from 'expo-secure-store'
import { configureBackgroundTypes, isHealthDataAvailableAsync } from '@kingstinct/react-native-healthkit'
import {
  requestAppleHealthAuthorization,
  enableAppleHealthBackground,
  syncAppleHealth,
} from '../../../lib/member/apple-health-sync'
import { crmApi } from '../../../lib/member/api'
import { setStoredPermsVersion } from '../../../lib/member/apple-health-perms'
import { hkConnectedKey, hkCursorKey, hkPermsVersionKey } from '../../../lib/member/apple-health-keys'
import { useAuth } from '../../../lib/member/contact-context'
import { HEALTHKIT_READ_TYPES_VERSION } from 'shared/apple-health-perms'

export default function ConnectAppleHealth() {
  const router = useRouter()
  const { contact } = useAuth()
  const contactId = contact?.id

  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  // On mount, read the locally-stored connected flag (iOS doesn't expose read
  // authorization status, so this flag is our source of truth). Keyed by the
  // signed-in contact so another member's flag never shows as connected here.
  useEffect(() => {
    if (Platform.OS !== 'ios' || !contactId) return
    SecureStore.getItemAsync(hkConnectedKey(contactId))
      .then((v) => { if (v === 'true') setConnected(true) })
      .catch((e) => console.warn('[connect-apple-health] flag read failed', e))
  }, [contactId])

  const connect = useCallback(async () => {
    setError(null); setNotice(null)
    if (!contactId) { setError('Sign in first.'); return }
    setBusy(true)
    try {
      // 1. Is HealthKit usable on this device at all?
      let available = true
      try { available = await isHealthDataAvailableAsync() } catch { available = true }
      if (!available) {
        setError("Apple Health isn't available on this device.")
        return
      }

      // 2. Request read access. On iOS requestAuthorization RESOLVES even when
      //    the user denies READ (Apple hides read-denial), so a THROW here is a
      //    real failure — almost always a missing HealthKit entitlement in the
      //    build's provisioning profile, not a user denial. Surface the real
      //    message so it's diagnosable on-device.
      try {
        await requestAppleHealthAuthorization()
      } catch (e) {
        const msg = e?.message || String(e)
        setError(
          /entitl|provision|capab|HKNotAuthorized|HKAuthorization/i.test(msg)
            ? `Health access failed — the build is missing the HealthKit capability. (${msg})`
            : `Couldn't request Health access: ${msg}`,
        )
        return
      }

      // 3. Record the connection server-side (consent + connected-state).
      const reg = await crmApi('/api/wearables/apple-health/connect', { method: 'POST' })
      if (reg?.success === false) {
        setError(`Couldn't save the connection: ${reg.error || 'server error'}.`)
        return
      }

      // 4. Enable background delivery so future workouts auto-upload (best-effort).
      try { await enableAppleHealthBackground() } catch (e) { console.warn('[connect-apple-health] background enable failed', e) }

      // 5. Initial backfill (last 30 days). A sync error shouldn't undo the
      //    connection — keep them connected and surface the real reason.
      const prevCursor = (await SecureStore.getItemAsync(hkCursorKey(contactId))) || undefined
      await SecureStore.setItemAsync(hkConnectedKey(contactId), 'true')
      await setStoredPermsVersion(contactId, HEALTHKIT_READ_TYPES_VERSION)
      setConnected(true)
      let res
      try {
        res = await syncAppleHealth({ sinceIso: prevCursor })
      } catch (e) {
        setError(`Connected, but the first sync failed: ${e?.message || e}`)
        return
      }
      if (res?.ok === false) {
        setNotice(`Connected. First sync hit a snag (${res.error || 'unknown'}); it'll retry automatically.`)
        return
      }
      if (res?.cursor) await SecureStore.setItemAsync(hkCursorKey(contactId), res.cursor)
      setNotice(`Apple Health connected.${res?.ingested ? ` Imported ${res.ingested} workout${res.ingested === 1 ? '' : 's'}.` : ''} New workouts sync automatically.`)
    } catch (e) {
      console.warn('[connect-apple-health] connect failed', e)
      setError(`Couldn't connect: ${e?.message || e}`)
    } finally {
      setBusy(false)
    }
  }, [contactId])

  // Diagnostic: force a full 30-day re-scan (ignores the cursor) and surface
  // stage-by-stage counts so we can see exactly where data is/isn't flowing.
  const syncNow = useCallback(async () => {
    setError(null); setNotice(null)
    if (!contactId) { setError('Sign in first.'); return }
    setBusy(true)
    try {
      const res = await syncAppleHealth({ debug: true })
      const d = res?.debug
      const detail = d
        ? `\nWorkouts found: ${d.rawWorkouts} · HR samples: ${d.hrSamples}\nMetrics: ${JSON.stringify(d.metrics)}\nPayload → workouts ${d.payloadWorkouts}, metrics ${d.payloadMetrics}`
        : ''
      if (res?.ok === false) {
        setError(`Sync failed: ${res.error || 'unknown'}.${detail}`)
        return
      }
      if (res?.cursor) await SecureStore.setItemAsync(hkCursorKey(contactId), res.cursor)
      setNotice(`Sync ok — ingested ${res?.ingested ?? 0} workout${(res?.ingested ?? 0) === 1 ? '' : 's'}.${detail}`)
    } catch (e) {
      setError(`Sync threw: ${e?.message || e}`)
    } finally {
      setBusy(false)
    }
  }, [contactId])

  const disconnect = useCallback(async () => {
    setError(null); setNotice(null)
    if (!contactId) { setError('Sign in first.'); return }
    setBusy(true)
    try {
      // Stop background delivery (best-effort) + revoke the connection record.
      try { await configureBackgroundTypes([], 'immediate') } catch (e) { console.warn('[connect-apple-health] background clear failed', e) }
      await crmApi('/api/wearables/apple-health/connect', { method: 'DELETE' })
      await SecureStore.deleteItemAsync(hkConnectedKey(contactId))
      await SecureStore.deleteItemAsync(hkCursorKey(contactId))
      await SecureStore.deleteItemAsync(hkPermsVersionKey(contactId))
      setConnected(false)
      setNotice('Apple Health disconnected.')
    } catch (e) {
      console.warn('[connect-apple-health] disconnect failed', e)
      setError("Couldn't disconnect. Please try again.")
    } finally {
      setBusy(false)
    }
  }, [contactId])

  // iOS-only guard — HealthKit (and the entitlements) are iPhone-only.
  if (Platform.OS !== 'ios') {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
        <ScrollView contentContainerClassName="p-5 pb-24">
          <Pressable onPress={() => router.back()} className="flex-row items-center gap-1 mb-4 self-start active:opacity-60">
            <Ionicons name="chevron-back-outline" size={18} color="#B3B2AC" />
            <Text className="text-sm text-chalk-2">Back</Text>
          </Pressable>
          <View className="mt-24 items-center px-6">
            <Ionicons name="phone-portrait-outline" size={32} color="#B3B2AC" />
            <Text className="mt-4 text-center text-base text-chalk-2">
              Apple Health is available on iPhone only.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24">
        <Pressable onPress={() => router.back()} className="flex-row items-center gap-1 mb-4 self-start active:opacity-60">
          <Ionicons name="chevron-back-outline" size={18} color="#B3B2AC" />
          <Text className="text-sm text-chalk-2">Back</Text>
        </Pressable>

        <View className="flex-row items-center gap-3">
          <View className="h-10 w-10 rounded-full bg-iron-raised items-center justify-center shrink-0">
            <Ionicons name="heart-outline" size={20} color="#FF4E42" />
          </View>
          <View className="flex-1 min-w-0">
            <Text className="text-2xl font-display-bold text-chalk">Apple Health</Text>
            <Text className="mt-0.5 text-sm text-chalk-2">Sync your Apple Watch workouts</Text>
          </View>
        </View>

        <Text className="mt-5 text-sm leading-5 text-chalk-2">
          Connect Apple Health so UN1T can read your workouts and heart rate. We use them to
          score your sessions, track your progress over time, and include you in gym challenges.
        </Text>

        {error ? (
          <View className="mt-4 rounded-xl border border-red-900 bg-red-950 p-3">
            <Text className="text-sm text-red-200">{error}</Text>
          </View>
        ) : null}

        {notice ? (
          <View className="mt-4 rounded-xl border border-emerald-900 bg-emerald-950 p-3 flex-row items-center gap-2">
            <Ionicons name="checkmark-circle-outline" size={16} color="#34D399" />
            <Text className="flex-1 text-sm text-emerald-200">{notice}</Text>
          </View>
        ) : null}

        {connected ? (
          <View className="mt-6 gap-3">
            <View className="rounded-[20px] border border-iron-hairline bg-iron-surface p-5">
              <View className="flex-row items-center gap-2">
                <Ionicons name="checkmark-circle" size={18} color="#34D399" />
                <Text className="text-base font-display text-chalk">Connected</Text>
              </View>
              <Text className="mt-1 text-xs text-chalk-2">
                Your Apple Health workouts and heart rate sync to UN1T automatically.
              </Text>
            </View>

            <Pressable
              onPress={syncNow}
              disabled={busy}
              className="flex-row items-center justify-center gap-2 rounded-xl bg-chalk px-4 py-3 active:opacity-80 disabled:opacity-50"
            >
              {busy ? <ActivityIndicator size="small" color="#131316" /> : <Ionicons name="refresh-outline" size={16} color="#131316" />}
              <Text className="text-sm font-body-semibold text-iron-bg">Sync now</Text>
            </Pressable>

            <Pressable
              onPress={disconnect}
              disabled={busy}
              className="flex-row items-center justify-center gap-2 rounded-xl border border-iron-hairline px-4 py-3 active:bg-iron-raised disabled:opacity-50"
            >
              {busy ? <ActivityIndicator size="small" color="#FF4E42" /> : <Ionicons name="power-outline" size={16} color="#FF4E42" />}
              <Text className="text-sm font-body-medium" style={{ color: '#FF4E42' }}>Disconnect</Text>
            </Pressable>
          </View>
        ) : (
          <View className="mt-6">
            <Pressable
              onPress={connect}
              disabled={busy}
              className="flex-row items-center justify-center gap-2 rounded-xl bg-chalk px-4 py-3.5 active:opacity-80 disabled:opacity-50"
            >
              {busy ? <ActivityIndicator size="small" color="#131316" /> : <Ionicons name="heart" size={16} color="#131316" />}
              <Text className="text-base font-body-semibold text-iron-bg">
                {busy ? 'Connecting…' : 'Connect Apple Health'}
              </Text>
            </Pressable>
            <Text className="mt-3 text-center text-[11px] text-chalk-3">
              You'll be asked to allow Health access. You can disconnect any time.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
