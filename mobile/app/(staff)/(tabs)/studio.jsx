// Studio hub — sub-tiles for the on-site studio features.
//
// STUDIO-HUB.1 split the old single AC + Door scroll into per-feature
// sub-screens reached from here, and added a TV tile (the mobile mirror
// of the web tv_displays feature):
//   • Air conditioning → /ac     (Sensibo gym floor + LG ThinQ units)
//   • Door unlock      → /doors  (UniFi Access)
//   • Class timer      → /timer  (Myzone-style interval timer on the TV)
//   • TV displays      → /tv     (view TVs + current content + clear)
//   • Studio music     → /sonos  (live Sonos control — SONOSMOB.5)
//   • Smart plugs      → /shelly (live on/off for adopted relays — SHELLY-MOB.1)
//
// AC + Door gate on `studio_management` (cross-platform key, mig 093);
// Class timer gates on `class_timer` (CLASS-TIMER-PERM.1 — every role by
// default, so coaches can run the timer without door unlock); TV gates on
// the `tv_displays` mobile permission. Studio music AND Smart plugs gate on
// `device_control` (cross-platform since SONOSMOB.2 — the same key the
// `/api/sonos/*` and `/api/shelly/*` routes enforce), so one grant opens both
// device surfaces and neither offers what its routes would refuse. Reached
// from the Studio tile in More (or the bottom bar if pinned there).

import { View, Text, Pressable, ScrollView } from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'

function ChoiceCard({ icon, tint, title, subtitle, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 flex-row items-center active:opacity-70"
    >
      <View className="w-12 h-12 rounded-full items-center justify-center mr-4" style={{ backgroundColor: `${tint}1A` }}>
        <Ionicons name={icon} size={24} color={tint} />
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-un1t-text">{title}</Text>
        <Text className="text-sm text-un1t-subtle mt-0.5">{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
    </Pressable>
  )
}

export default function StudioHub() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()

  const canStudio = canMobile(profile, 'studio_management', activeLocation)
  const canTimer = canMobile(profile, 'class_timer', activeLocation)
  const canTv = canMobile(profile, 'tv_displays', activeLocation)
  // One key, two device surfaces (SHELLY-MOB.1) — deliberately the same
  // resolution, not two calls that could drift apart.
  const canDevices = canMobile(profile, 'device_control', activeLocation)

  // Defence in depth — the tab/tile won't show without access, but a
  // hand-typed deep link would otherwise reach the hub.
  if (!canStudio && !canTimer && !canTv && !canDevices) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Text className="text-sm text-un1t-subtle text-center">
          Studio features aren&apos;t enabled for your role at this location.
        </Text>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <Text className="text-sm text-un1t-subtle mb-4">
        On-site controls for {activeLocation?.name || 'your active location'}.
      </Text>
      <View className="gap-3">
        {canStudio && (
          <ChoiceCard
            icon="snow-outline"
            tint="#2563EB"
            title="Air conditioning"
            subtitle="Sensibo gym floor + LG ThinQ units"
            onPress={() => router.push('/ac')}
          />
        )}
        {canStudio && (
          <ChoiceCard
            icon="key-outline"
            tint="#A855F7"
            title="Door unlock"
            subtitle="UniFi Access doors"
            onPress={() => router.push('/doors')}
          />
        )}
        {canTimer && (
          <ChoiceCard
            icon="stopwatch-outline"
            tint="#10B981"
            title="Class timer"
            subtitle="Run a Myzone-style interval timer on the TV"
            onPress={() => router.push('/timer')}
          />
        )}
        {canTv && (
          <ChoiceCard
            icon="tv-outline"
            tint="#0EA5E9"
            title="TV displays"
            subtitle="What's on the studio TVs — view & clear"
            onPress={() => router.push('/tv')}
          />
        )}
        {canDevices && (
          <ChoiceCard
            icon="musical-notes-outline"
            tint="#F59E0B"
            title="Studio music"
            subtitle="Play, pause, volume, favourites"
            onPress={() => router.push('/sonos')}
          />
        )}
        {canDevices && (
          <ChoiceCard
            icon="flash-outline"
            tint="#EC4899"
            title="Smart plugs"
            subtitle="Switch an adopted Shelly relay on or off"
            onPress={() => router.push('/shelly')}
          />
        )}
      </View>
    </ScrollView>
  )
}
