// W1 — per-location feature toggles (master only). Flip which features
// are enabled at the ACTIVE studio. Mirrors the web LocationFeatures:
// each toggle PUTs the FULL features blob to /api/locations/[id]/features
// (master-gated server-side via canEditLocationFeatures), optimistic with
// revert-on-failure. After a save it refreshes the auth context so the
// gate change takes effect across the app (tiles/tabs re-derive).
import { useState } from 'react'
import { View, Text, ScrollView, Switch, ActivityIndicator } from 'react-native'
import { Stack } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { api } from '../../lib/api'
import { WEB_PERMISSIONS, MOBILE_PERMISSIONS, isFeatureGatedByLocation } from 'shared/permissions'
import BackHeaderLeft from '../../components/BackHeaderLeft'

// Notification keys are personal prefs, never location-gated — so the
// gateable set is web + mobile permissions minus notify keys.
const WEB = WEB_PERMISSIONS.filter(p => isFeatureGatedByLocation(p.key))
const MOBILE = MOBILE_PERMISSIONS.filter(p => isFeatureGatedByLocation(p.key))

// A feature is ON unless the blob explicitly sets it false (absent = on).
const isOn = (features, key) => (features?.[key]) !== false

function Section({ title, items, features, onToggle, busyKey }) {
  return (
    <View className="mb-5">
      <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">{title}</Text>
      <View className="rounded-2xl border border-un1t-border bg-white overflow-hidden">
        {items.map((p, i) => (
          <View key={p.key} className={`flex-row items-center justify-between px-4 py-3 ${i < items.length - 1 ? 'border-b border-un1t-border' : ''}`}>
            <Text className="text-sm text-un1t-text flex-1 pr-3" numberOfLines={1}>{p.label}</Text>
            {busyKey === p.key ? (
              <ActivityIndicator />
            ) : (
              <Switch
                value={isOn(features, p.key)}
                onValueChange={() => onToggle(p.key)}
                trackColor={{ false: '#E2E5E9', true: '#111827' }}
                thumbColor="#FFFFFF"
                ios_backgroundColor="#E2E5E9"
              />
            )}
          </View>
        ))}
      </View>
    </View>
  )
}

export default function LocationFeaturesScreen() {
  const { profile, activeLocation, refresh } = useAuth()
  const isMaster = !!profile?.isMaster || profile?.role === 'master'

  const [features, setFeatures] = useState(activeLocation?.features || {})
  const [busyKey, setBusyKey] = useState(null)
  const [error, setError] = useState(null)

  async function toggle(key) {
    if (!activeLocation?.id) return
    setBusyKey(key)
    setError(null)
    const prev = features
    const next = { ...features, [key]: !isOn(features, key) }
    setFeatures(next) // optimistic
    const res = await api(`/api/locations/${activeLocation.id}/features`, { method: 'PUT', body: { features: next } })
    setBusyKey(null)
    if (res.success === false) {
      setError(res.error || 'Could not save')
      setFeatures(prev) // revert
      return
    }
    // Propagate the gate change app-wide (tiles/tabs re-derive from the
    // refreshed activeLocation.features).
    refresh?.().catch(() => {})
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Location features', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />

      {!isMaster ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Feature toggles are master-only.</Text>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 pt-4 pb-10">
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}
          <View className="bg-un1t-surface border border-un1t-border rounded-xl p-3 mb-4">
            <Text className="text-xs text-un1t-subtle">
              Toggling off hides a feature for <Text className="text-un1t-text font-semibold">everyone</Text> at {activeLocation?.name || 'this studio'}.
            </Text>
          </View>
          <Section title="Web features" items={WEB} features={features} onToggle={toggle} busyKey={busyKey} />
          <Section title="Mobile features" items={MOBILE} features={features} onToggle={toggle} busyKey={busyKey} />
        </ScrollView>
      )}
    </View>
  )
}
