import { View } from 'react-native'

// Tick-mark measurement rule (Afterglow spec §2.4.5) — gym-floor line
// markings as UI furniture. Every 5th tick is tall.
export default function TickRule({ count = 36, className = '' }) {
  return (
    <View className={`flex-row items-end justify-between h-2 ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} className="w-px bg-iron-hairline" style={{ height: i % 5 === 0 ? 8 : 4 }} />
      ))}
    </View>
  )
}
