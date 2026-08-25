// EVENT-CHECKIN.D — in-app QR scanner for event check-in. A general scanner:
// each attendee's QR self-contains its event (parseCheckinQr → {eventId,token}),
// so one screen handles the whole race day. The signed token is re-verified
// server-side (POST /api/events/[id]/checkin/scan). Reuses the `races` perm.
//
// expo-camera is a NATIVE module → this screen ships only in a native build,
// NOT over OTA. The manual roster (races/checkin/[id]) is always the fallback.
import { useState, useCallback, useEffect, useRef } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import BackHeaderLeft from '../../../components/BackHeaderLeft'
import { parseCheckinQr } from '../../../lib/event-checkin-qr'
import { scanCheckin } from '../../../lib/event-checkin-api'

export default function MobileCheckinScanner() {
  const router = useRouter()
  const { profile, activeLocation } = useAuth()
  const canView = canMobile(profile, 'races', activeLocation)

  const [permission, requestPermission] = useCameraPermissions()
  const [locked, setLocked] = useState(false) // pause scanning while a result shows
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // { ok, name? , msg? }
  const askedRef = useRef(false)

  // Ask for camera access once on mount if we can.
  useEffect(() => {
    if (!askedRef.current && permission && !permission.granted && permission.canAskAgain) {
      askedRef.current = true
      requestPermission()
    }
  }, [permission, requestPermission])

  const handleScan = useCallback(async ({ data }) => {
    setLocked(true)
    const parsed = parseCheckinQr(data)
    if (!parsed) {
      setResult({ ok: false, msg: 'That’s not a UN1T check-in code.' })
      return
    }
    setBusy(true)
    const res = await scanCheckin(parsed.eventId, { token: parsed.token, locationId: activeLocation?.id })
    setBusy(false)
    setResult(res.success === false
      ? { ok: false, msg: res.error || 'Check-in failed.' }
      : { ok: true, name: res.data?.name || 'Checked in' })
  }, [activeLocation?.id])

  function scanNext() { setResult(null); setLocked(false) }

  return (
    <View className="flex-1 bg-black">
      <Stack.Screen options={{ title: 'Scan check-in', headerLeft: () => <BackHeaderLeft label="Back" fallbackHref="/races" /> }} />

      {!canView ? (
        <View className="flex-1 items-center justify-center px-6 bg-un1t-bg">
          <Ionicons name="lock-closed-outline" size={28} color="#94A3B8" />
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Check-in is manager+ and only where events are enabled.</Text>
        </View>
      ) : !permission ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator color="#FFFFFF" /></View>
      ) : !permission.granted ? (
        <View className="flex-1 items-center justify-center px-6 bg-un1t-bg">
          <Ionicons name="camera-outline" size={32} color="#94A3B8" />
          <Text className="text-base font-semibold text-un1t-text mt-3">Camera access needed</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1 mb-5">
            {permission.canAskAgain
              ? 'Allow camera access to scan attendee check-in codes.'
              : 'Enable camera access for Repset in Settings to scan check-in codes.'}
          </Text>
          {permission.canAskAgain && (
            <Pressable onPress={requestPermission} className="bg-blue-600 rounded-xl px-5 py-2.5 active:opacity-80">
              <Text className="text-white text-sm font-semibold">Allow camera</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <View className="flex-1">
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={locked ? undefined : handleScan}
          />

          {/* Aiming guide */}
          {!result && (
            <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
              <View className="w-60 h-60 rounded-3xl border-2 border-white/80" />
              <Text className="text-white text-sm mt-5 px-8 text-center">Point at an attendee’s check-in QR</Text>
            </View>
          )}

          {/* Result / busy overlay */}
          {(result || busy) && (
            <View className="absolute inset-0 items-center justify-center bg-black/70 px-8">
              {busy ? (
                <>
                  <ActivityIndicator color="#FFFFFF" />
                  <Text className="text-white text-base mt-3">Checking in…</Text>
                </>
              ) : (
                <View className="items-center">
                  <View className={`w-16 h-16 rounded-full items-center justify-center ${result.ok ? 'bg-green-600' : 'bg-red-600'}`}>
                    <Ionicons name={result.ok ? 'checkmark' : 'close'} size={36} color="#FFFFFF" />
                  </View>
                  <Text className="text-white text-xl font-bold mt-4 text-center">
                    {result.ok ? result.name : 'Not checked in'}
                  </Text>
                  <Text className="text-white/80 text-sm mt-1 text-center">
                    {result.ok ? 'Checked in ✓' : result.msg}
                  </Text>
                  <Pressable onPress={scanNext} className="bg-white rounded-xl px-6 py-3 mt-6 active:opacity-80">
                    <Text className="text-black text-base font-semibold">Scan next</Text>
                  </Pressable>
                  <Pressable onPress={() => router.back()} className="px-6 py-3 mt-1 active:opacity-60">
                    <Text className="text-white/70 text-sm">Done</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  )
}
