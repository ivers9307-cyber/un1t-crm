// mobile/app/(staff)/controls/index.jsx
//
// HOME-LOC.9 — manual "Studio controls" launcher: the offsite/remote entry
// from Home. Renders the same tile list Home shows on-site, but for the
// EXPLICITLY PICKED location (?loc=), labelled manual, and forwards ?loc= to
// every control screen so their pills agree with this screen's header.
//
// Denial branch also renders the pill when the user has ANYTHING pickable
// (even a single location — canPickLocation's escape hatch covers landing
// on a location you don't hold the perm at while you hold it at exactly
// one other) so a user with no controls HERE can still switch to a studio
// they can actually use, rather than dead-ending on a back button.
import { View, Text, ScrollView, Pressable } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { pickerLocations } from '../../../lib/control-location'
import { homeTiles } from '../../../lib/home-logic'
import ChoiceCard from '../../../components/ChoiceCard'
import LocationPill from '../../../components/LocationPill'

export default function ControlsLauncher() {
  const { profile, locations } = useAuth()
  const router = useRouter()
  const params = useLocalSearchParams()
  const locId = typeof params.loc === 'string' ? params.loc : null
  const location = (locations || []).find((l) => l.id === locId) || null
  const pickable = pickerLocations(profile, locations, 'device_control')
  const tiles = homeTiles(profile, location)

  if (!location || tiles.length === 0) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        {pickable.length > 0 && (
          <LocationPill
            location={location}
            source="manual"
            pickable={pickable}
            onPick={(id) => router.setParams({ loc: id })}
            className="self-center mb-4"
          />
        )}
        <Text className="text-sm text-un1t-subtle text-center">
          Studio controls aren&apos;t available{location ? ` for you at ${location.name}` : ' here'}.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <LocationPill
        location={location}
        source="manual"
        pickable={pickable}
        onPick={(id) => router.setParams({ loc: id })}
      />
      <View className="gap-3">
        {tiles.map((t) => (
          <ChoiceCard key={t.key} icon={t.icon} tint={t.tint} title={t.title} subtitle={t.subtitle}
            onPress={() => router.push({ pathname: t.href, params: { loc: location.id } })} />
        ))}
      </View>
    </ScrollView>
  )
}
