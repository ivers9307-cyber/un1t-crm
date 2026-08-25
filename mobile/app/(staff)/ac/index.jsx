// MOBILE-AC.1 — standalone Air conditioning screen.
//
// MOBILE-AC.2: the unified device list (Sensibo + LG ThinQ, grouped) now lives
// in components/AcDeviceList.jsx, shared with the Studio Management tab. This
// route is kept for deep-links / back-compat + the permission gate; the list
// itself is the shared component.

import { View, Text, Pressable, ScrollView } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { usePhysicalLocation } from '../../../lib/use-physical-location'
import { resolveControlLocation, pickerLocations } from '../../../lib/control-location'
import AcDeviceList from '../../../components/AcDeviceList'
import LocationPill from '../../../components/LocationPill'

export default function AcScreen() {
  const { profile, activeLocation, locations } = useAuth()
  const router = useRouter()
  const params = useLocalSearchParams()
  const phys = usePhysicalLocation()
  // HOME-LOC.10 — override (this visit's ?loc=) ?? detected ?? activeLocation.
  // The pill below always names what the calls command; both derive from the
  // SAME resolved value, so what you see is what you send.
  const overrideId = typeof params.loc === 'string' ? params.loc : null
  const { location: controlLocation, source } = resolveControlLocation({
    overrideId,
    physical: phys,
    activeLocation,
    locations,
  })
  const locationId = controlLocation?.id
  const pickable = pickerLocations(profile, locations, 'studio_management')
  // HOME-LOC.10b — the screen is usable before the geofence answer lands, on
  // the activeLocation fallback; say so rather than letting an amber "manual"
  // pill flip green mid-reach. An explicit override needs no detection.
  const detecting = phys.status === 'loading' && !overrideId

  // Permission gate — defence in depth. The link won't show unless permitted,
  // but a hand-typed deep-link bypass would otherwise reach the page. The pill
  // renders here too: denied at the RESOLVED studio is not denied everywhere,
  // so this is the escape hatch onto one the user does hold.
  if (!canMobile(profile, 'studio_management', controlLocation)) {
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
          Studio Management isn&apos;t enabled for your role at this location.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerClassName="p-4">
      <LocationPill
        location={controlLocation}
        source={source}
        pickable={pickable}
        onPick={(id) => router.setParams({ loc: id })}
        detecting={detecting}
      />
      {/* AcDeviceList DOES refetch on a locationId change (its load() is keyed
          on the prop and the effect spinners while it re-reads), so the key is
          not the refetch mechanism — it is what makes the flip ATOMIC. Without
          it the previous studio's error strip survives until the new read
          succeeds, and its per-device cards keep polling state fetched for the
          old location, both under the new name on the pill above. */}
      <AcDeviceList key={locationId} locationId={locationId} />
    </ScrollView>
  )
}
