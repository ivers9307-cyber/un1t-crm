// CARDLENS-M.3 — the grey studio pill on a contact's threads, bookings and
// timeline rows. Renders nothing without a name (a one-studio person, or a
// server older than this app): see mobile/lib/contact-platform-cards.js.
import { View, Text } from 'react-native'

export default function StudioTag({ name }) {
  if (!name) return null
  return (
    <View className="rounded-full px-1.5 py-0.5 bg-gray-500/10" accessibilityLabel={`Studio: ${name}`}>
      <Text className="text-[10px] font-medium text-gray-700">{name}</Text>
    </View>
  )
}
