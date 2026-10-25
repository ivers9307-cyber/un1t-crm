// WIDGET.1 (Phase 2, Task 5) — mint/revoke screen for the iOS home-screen
// widget's per-device credential. The ONLY place that mints one: a staff
// member opens this screen, mints a token scoped to a studio, and it is
// stored in the App Group so the widget extension can read it. A staff
// member who works multiple studios mints once per studio (switch the pill,
// mint again) — see mobile/lib/widget-bridge.js's header for why the store
// is a small array keyed by location_id rather than one credential total.
//
// Every DECISION here (who may mint where, mint vs re-mint, which stored
// credentials are stale) lives in mobile/lib/widget-tokens.js, tested there
// — this file is deliberately a thin renderer (no RN component test runner
// exists in this repo).
//
// Gate + location resolution mirror doors/sonos exactly: ?loc= override →
// detected → activeLocation, rendered as a LocationPill so what you see is
// what you mint for. The gate itself (canManageWidgets) composes the SAME
// two keys /api/widget/devices already composes (studio_management,
// device_control) rather than inventing a third — see that route's header
// comment and mobile/app/(staff)/(tabs)/studio.jsx's identical composite
// gate.

import { useState, useCallback, useEffect } from 'react'
import {
  View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, RefreshControl, Alert,
} from 'react-native'
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as Device from 'expo-device'
import { useAuth } from '../../../lib/auth-context'
import { usePhysicalLocation } from '../../../lib/use-physical-location'
import { resolveControlLocation } from '../../../lib/control-location'
import {
  canManageWidgets, widgetEligibleLocations, defaultDeviceLabel,
  findStoredCredential, reconcileStoredWidgets,
} from '../../../lib/widget-tokens'
import { listWidgetTokens, mintWidgetToken, revokeWidgetToken } from '../../../lib/widget-tokens-api'
import {
  storeWidgetCredential, listStoredStudios, removeWidgetCredential, reloadWidgets,
} from '../../../lib/widget-bridge'
import LocationPill from '../../../components/LocationPill'

export default function WidgetsScreen() {
  const { profile, activeLocation, locations } = useAuth()
  const router = useRouter()
  const params = useLocalSearchParams()
  const phys = usePhysicalLocation()
  const overrideId = typeof params.loc === 'string' ? params.loc : null
  const { location: controlLocation, source } = resolveControlLocation({
    overrideId,
    physical: phys,
    activeLocation,
    locations,
  })
  const locationId = controlLocation?.id
  const allowed = canManageWidgets(profile, controlLocation)
  const pickable = widgetEligibleLocations(profile, locations)
  const detecting = phys.status === 'loading' && !overrideId

  const [storedStudios, setStoredStudios] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [deviceLabel, setDeviceLabel] = useState('')
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState(null)
  const [revokingId, setRevokingId] = useState(null)
  const [revokeError, setRevokeError] = useState(null)

  // Default the label field once from the device's own name — the user can
  // still edit or clear it before minting.
  useEffect(() => {
    setDeviceLabel(defaultDeviceLabel(Device.deviceName))
  }, [])

  // Not location-scoped: a stored credential belongs to whichever studio it
  // names, and the App Group + the profile's live token list both cover
  // EVERY studio the user has minted for, not just the one currently
  // pilled. So this loads once per focus, independent of `locationId`.
  const load = useCallback(async (isActive) => {
    const local = listStoredStudios()
    const res = await listWidgetTokens()
    if (!isActive()) return
    if (!res.success) {
      // A transport blip (api()'s own envelope) keeps whatever was locally
      // stored painted rather than wiping a working list because the
      // network hiccuped; a real server error is surfaced.
      setStoredStudios(local)
      setLoadError(res.transport ? null : (res.error || 'Could not load your widget credentials'))
      return
    }
    setLoadError(null)
    const { live, stale } = reconcileStoredWidgets(res.data?.tokens || [], local)
    if (stale.length > 0) {
      // A token revoked from the CRM staff page is gone from the server's
      // live list but was still sitting in the App Group — drop it here so
      // the widget stops trying a credential the server will keep refusing.
      stale.forEach((s) => removeWidgetCredential(s.locationId))
      reloadWidgets()
    }
    setStoredStudios(live)
  }, [])

  useFocusEffect(useCallback(() => {
    let active = true
    setLoading(true)
    load(() => active).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [load]))

  function onRefresh() {
    setRefreshing(true)
    load(() => true).finally(() => setRefreshing(false))
  }

  const existing = findStoredCredential(storedStudios, locationId)

  async function handleMint() {
    if (!locationId || minting) return
    setMinting(true)
    setMintError(null)
    const label = deviceLabel.trim()
    const res = await mintWidgetToken(locationId, label || undefined)
    if (!res.success) {
      setMinting(false)
      setMintError(res.error || 'Could not mint a widget credential')
      return
    }
    // 🔴 The plaintext is in `res.data.token` exactly once — the server only
    // ever kept its hash. If storing it locally throws, it is gone for
    // good; that must be told to the user explicitly, not swallowed.
    const { id, token } = res.data
    try {
      storeWidgetCredential({
        locationId,
        locationName: controlLocation?.name || 'This studio',
        tokenId: id,
        token,
        deviceLabel: label || null,
      })
    } catch (_e) {
      setMinting(false)
      // Best-effort: the token this device could not keep is unusable to
      // it, so don't leave it live server-side as a phantom credential
      // nobody can present. A failure here changes nothing the user sees.
      revokeWidgetToken(id).catch((e) => {
        // Log, never swallow: the flow must not fail, but an orphaned live
        // credential that nobody knows about is worse than a noisy one. It
        // stays visible and revocable on the CRM staff card either way.
        console.warn('[widgets] could not revoke the unstorable token', id, e?.message)
      })
      Alert.alert(
        'Could not save this credential',
        'The widget credential was created but this device could not store it. It cannot be recovered — try minting again.',
      )
      return
    }
    // Re-minting for a studio that already had a credential: the OLD
    // server-side token is now unreferenced locally (storeWidgetCredential
    // already replaced its App Group entry) — revoke it too, best-effort,
    // so it doesn't linger as an orphaned live credential.
    if (existing && existing.tokenId !== id) {
      revokeWidgetToken(existing.tokenId).catch((e) => {
        console.warn('[widgets] could not revoke the superseded token', existing.tokenId, e?.message)
      })
    }
    reloadWidgets()
    setMinting(false)
    await load(() => true)
    Alert.alert('Widget credential minted', `${controlLocation?.name || 'This studio'} is ready on your home-screen widget.`)
  }

  function confirmRevoke(cred) {
    Alert.alert(
      'Remove this widget credential?',
      `${cred.locationName || 'This studio'} will stop working in any placed widget until you mint a new one.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => handleRevoke(cred) },
      ],
    )
  }

  async function handleRevoke(cred) {
    setRevokingId(cred.tokenId)
    setRevokeError(null)
    const res = await revokeWidgetToken(cred.tokenId)
    setRevokingId(null)
    if (!res.success) {
      // Server-first: a failed revoke must NOT remove the credential
      // locally, or the phone forgets a token that still works server-side.
      setRevokeError(res.error || 'Could not remove that credential')
      return
    }
    removeWidgetCredential(cred.locationId)
    reloadWidgets()
    setStoredStudios((prev) => prev.filter((s) => s.tokenId !== cred.tokenId))
  }

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
          Widgets aren&apos;t available for your role at this location — they mirror the doors, AC, music and
          smart-plug controls, so this needs Studio Management or Device Control there.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
    >
      <LocationPill
        location={controlLocation}
        source={source}
        pickable={pickable}
        onPick={(id) => router.setParams({ loc: id })}
        detecting={detecting}
      />
      <Text className="text-sm text-un1t-subtle mb-4">
        Mint a credential for the home-screen widget at {controlLocation?.name || 'this studio'}. Add one widget per
        studio you work — pick the studio above, then mint.
      </Text>

      {/* ── Mint ─────────────────────────────────────────────────────── */}
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-4">
        <View className="flex-row items-center mb-3">
          <Ionicons name="apps-outline" size={18} color="#F59E0B" />
          <Text className="text-xs font-bold text-un1t-text uppercase tracking-wider ml-2">
            {existing ? 'Re-mint for this studio' : 'Mint for this studio'}
          </Text>
        </View>
        {existing && (
          <Text className="text-xs text-un1t-subtle mb-3">
            Already set up{existing.deviceLabel ? ` as "${existing.deviceLabel}"` : ''}. Minting again replaces it —
            the old credential is revoked.
          </Text>
        )}
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">
          Device label (optional)
        </Text>
        <TextInput
          value={deviceLabel}
          onChangeText={setDeviceLabel}
          placeholder="e.g. Richard's iPhone"
          placeholderTextColor="#475569"
          maxLength={60}
          className="bg-un1t-bg border border-un1t-border rounded-xl px-4 py-3 text-base text-un1t-text mb-3"
        />
        {mintError && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-sm text-red-700">{mintError}</Text>
          </View>
        )}
        <Pressable
          onPress={handleMint}
          disabled={minting || !locationId}
          className="flex-row items-center justify-center bg-un1t-accent rounded-xl py-3.5 active:opacity-80"
          style={minting || !locationId ? { opacity: 0.6 } : undefined}
        >
          {minting
            ? <ActivityIndicator color="#FFFFFF" />
            : <Text className="text-base font-semibold text-un1t-bg">{existing ? 'Re-mint credential' : 'Mint credential'}</Text>}
        </Pressable>
      </View>

      {/* ── Currently stored ─────────────────────────────────────────── */}
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
        <View className="flex-row items-center mb-3">
          <Ionicons name="key-outline" size={18} color="#94A3B8" />
          <Text className="text-xs font-bold text-un1t-text uppercase tracking-wider ml-2">On this device</Text>
        </View>
        {loading ? (
          <ActivityIndicator color="#94A3B8" />
        ) : loadError ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
            <Text className="text-sm text-red-700">{loadError}</Text>
          </View>
        ) : storedStudios.length === 0 ? (
          <Text className="text-sm text-un1t-subtle">No widget credentials stored on this device yet.</Text>
        ) : (
          storedStudios.map((cred, i) => (
            <StoredCredentialRow
              key={cred.tokenId}
              cred={cred}
              isLast={i === storedStudios.length - 1}
              busy={revokingId === cred.tokenId}
              onRevoke={() => confirmRevoke(cred)}
            />
          ))
        )}
        {revokeError && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mt-3">
            <Text className="text-sm text-red-700">{revokeError}</Text>
          </View>
        )}
      </View>
    </ScrollView>
  )
}

function StoredCredentialRow({ cred, isLast, busy, onRevoke }) {
  return (
    <View className={`flex-row items-center py-3.5 ${!isLast ? 'border-b border-un1t-border' : ''}`}>
      <View className="flex-1 mr-3">
        <Text className="text-base font-semibold text-un1t-text">{cred.locationName || 'Studio'}</Text>
        {cred.deviceLabel && <Text className="text-xs text-un1t-subtle mt-0.5">{cred.deviceLabel}</Text>}
      </View>
      {busy ? (
        <ActivityIndicator color="#94A3B8" />
      ) : (
        <Pressable onPress={onRevoke} hitSlop={8} className="active:opacity-70">
          <Text className="text-sm text-red-500 font-medium">Remove</Text>
        </Pressable>
      )}
    </View>
  )
}
