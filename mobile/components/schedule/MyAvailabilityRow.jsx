// mobile/components/schedule/MyAvailabilityRow.jsx
// AVAIL.2 — "My availability" on the Schedule tab (Me view): opens the form
// where a coach says when they can't work. Every role; no gate of its own
// (the Schedule tab is the gate). Words from lib/availability-form.js.

import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { AVAILABILITY_ROW } from '../../lib/availability-form'

export default function MyAvailabilityRow({ onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={AVAILABILITY_ROW.title}
      accessibilityHint={AVAILABILITY_ROW.subtitle}
      className="mt-3 flex-row items-center bg-un1t-surface border border-un1t-border rounded-2xl p-4 active:opacity-70"
    >
      <Ionicons name="time-outline" size={20} color="#111827" />
      <View className="flex-1 ml-3">
        <Text className="text-sm font-semibold text-un1t-text">{AVAILABILITY_ROW.title}</Text>
        <Text className="text-xs text-un1t-subtle mt-0.5">{AVAILABILITY_ROW.subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
    </Pressable>
  )
}
