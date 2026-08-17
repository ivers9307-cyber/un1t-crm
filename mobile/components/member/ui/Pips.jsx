import { View } from 'react-native'

// Discrete progress (Afterglow spec §2.4.5): pips, not bars. `filled` is an
// array of colours (one per earned unit, in that unit's zone colour);
// remaining slots render as hairline ghosts.
export default function Pips({ slots, filled = [], className = '' }) {
  return (
    <View className={`flex-row gap-1.5 ${className}`}>
      {Array.from({ length: slots }, (_, i) => (
        <View
          key={i}
          className="flex-1 h-2 rounded-full"
          style={{ backgroundColor: filled[i] || '#2A2A31', maxWidth: 40 }}
        />
      ))}
    </View>
  )
}
