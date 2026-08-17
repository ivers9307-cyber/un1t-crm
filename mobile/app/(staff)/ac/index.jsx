// MOBILE-AC.1 — standalone Air conditioning screen.
//
// MOBILE-AC.2: the unified device list (Sensibo + LG ThinQ, grouped) now lives
// in components/AcDeviceList.jsx, shared with the Studio Management tab. This
// route is kept for deep-links / back-compat + the permission gate; the list
// itself is the shared component.

import { View, Text, Pressable, ScrollView } from 'react-native'
import { useRouter } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import AcDeviceList from '../../../components/AcDeviceList'

export default function AcScreen() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()

  // Permission gate — defence in depth. The link won't show unless permitted,
  // but a hand-typed deep-link bypass would otherwise reach the page.
  if (!canMobile(profile, 'studio_management', activeLocation)) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
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
      <AcDeviceList locationId={activeLocation?.id} />
    </ScrollView>
  )
}
