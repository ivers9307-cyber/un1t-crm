// mobile/components/ChoiceCard.jsx
// Extracted from the Studio hub (HOME-LOC.6) — now shared by the hub, the
// new Home tiles, and the manual controls launcher.
import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function ChoiceCard({ icon, tint, title, subtitle, onPress }) {
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
