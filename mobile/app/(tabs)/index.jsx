// Home tab. Shows a greeting + active location + a list of "what you
// can do" cards based on the user's mobile feature flags. If no
// features are enabled, shows a friendly empty state explaining the
// admin needs to enable mobile features.
//
// This is also where we'd surface a digest later — upcoming shift,
// pending swaps to respond to, new leads, etc. For Phase 1 it's just
// a navigation menu.

import { View, Text, ScrollView, Pressable } from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile, hasAnyMobileFeature } from '../../lib/permissions'

function HomeCard({ icon, title, subtitle, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 flex-row items-center mb-3 active:opacity-70"
    >
      <View className="w-10 h-10 rounded-full bg-un1t-gray/40 items-center justify-center mr-3">
        <Ionicons name={icon} size={20} color="#111827" />
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-un1t-white">{title}</Text>
        {subtitle ? (
          <Text className="text-sm text-un1t-light">{subtitle}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
    </Pressable>
  )
}

export default function Home() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()

  if (!profile) return null

  const firstName = profile.full_name?.split(' ')[0] || 'there'

  return (
    <ScrollView className="flex-1 bg-un1t-black" contentContainerClassName="p-6">
      <Text className="text-3xl font-bold text-un1t-white mb-1">Hi {firstName}</Text>
      <Text className="text-base text-un1t-light mb-6">
        {activeLocation
          ? `${activeLocation.name} · ${roleLabel(profile.role)}`
          : roleLabel(profile.role)}
      </Text>

      {!hasAnyMobileFeature(profile) ? (
        <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5">
          <Text className="text-base font-semibold text-un1t-white mb-1">
            Mobile features off
          </Text>
          <Text className="text-sm text-un1t-light">
            An admin hasn&apos;t enabled any mobile features for your account
            yet. Ask the gym manager to turn on Schedule, Pipeline, or
            WhatsApp from your profile in the web app.
          </Text>
        </View>
      ) : (
        <>
          {canMobile(profile, 'schedule') && (
            <HomeCard
              icon="calendar-outline"
              title="Schedule"
              subtitle="Your shifts, time off, swap requests"
              onPress={() => router.push('/(tabs)/schedule')}
            />
          )}
          {canMobile(profile, 'pipeline') && (
            <HomeCard
              icon="trending-up-outline"
              title="Pipeline"
              subtitle="Deals, contacts, and follow-ups"
              onPress={() => router.push('/(tabs)/pipeline')}
            />
          )}
          {canMobile(profile, 'whatsapp') && (
            <HomeCard
              icon="chatbubble-outline"
              title="WhatsApp inbox"
              subtitle="Reply to leads on the go"
              onPress={() => router.push('/(tabs)/whatsapp')}
            />
          )}
        </>
      )}
    </ScrollView>
  )
}

function roleLabel(role) {
  switch (role) {
    case 'owner':      return 'Owner'
    case 'manager':    return 'Manager'
    case 'head_coach': return 'Head Coach'
    case 'staff':      return 'Staff'
    default:           return ''
  }
}
