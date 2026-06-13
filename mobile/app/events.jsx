// EVENTS-HUB.1 — the Events landing screen on mobile.
//
// One "Events" tile in More opens this. It nests the two event-side
// surfaces (Orders revenue ledger + trackside Race control) and routes
// by access level — the same flow as the Accounting / Reports hubs:
//   • exactly one surface → that screen directly. The More tile routes
//     single-surface users straight to their one surface, so the hub is
//     normally only reached with both; it self-redirects defensively if
//     deep-linked with a single surface.
//   • both surfaces → a chooser of cards.

import { View, Text, Pressable, ScrollView } from 'react-native'
import { useRouter, Redirect, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../lib/auth-context'
import { canMobile } from '../lib/permissions'
import { eventsLanding, EVENTS_ROUTES } from '../lib/events-hub'
import BackHeaderLeft from '../components/BackHeaderLeft'

function ChoiceCard({ icon, title, subtitle, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 flex-row items-center active:opacity-70"
    >
      <View className="w-12 h-12 rounded-full bg-un1t-border/40 items-center justify-center mr-4">
        <Ionicons name={icon} size={24} color="#111827" />
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-un1t-text">{title}</Text>
        <Text className="text-sm text-un1t-subtle mt-0.5">{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
    </Pressable>
  )
}

export default function EventsHub() {
  const router = useRouter()
  const { profile, activeLocation } = useAuth()

  const canOrders = canMobile(profile, 'orders', activeLocation)
  const canRaceControl = canMobile(profile, 'races', activeLocation)
  const landing = eventsLanding({ canOrders, canRaceControl })

  if (!profile) return null

  // Single-surface users skip the chooser; the degenerate no-surface
  // case bounces home (the tile is gated so it shouldn't get here).
  if (landing && landing !== 'chooser') return <Redirect href={EVENTS_ROUTES[landing]} />
  if (!landing) return <Redirect href="/(tabs)/more" />

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerClassName="p-4">
      <Stack.Screen
        options={{
          title: 'Events',
          headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" />,
        }}
      />
      <Text className="text-sm text-un1t-subtle mb-3">What would you like to view?</Text>
      <View className="gap-3">
        {canOrders && (
          <ChoiceCard
            icon="cash-outline"
            title="Orders"
            subtitle="Revenue across race signups & car deposits"
            onPress={() => router.push('/orders')}
          />
        )}
        {canRaceControl && (
          <ChoiceCard
            icon="flag-outline"
            title="Race control"
            subtitle="Trackside start / finish / reset on race day"
            onPress={() => router.push('/races')}
          />
        )}
      </View>
    </ScrollView>
  )
}
