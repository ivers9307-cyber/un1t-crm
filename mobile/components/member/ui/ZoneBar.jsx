import { View } from 'react-native'
import { zoneBreakdown } from 'shared/heart-rate'
import { zoneColorDark } from 'shared/zone-colors'

// Session zone distribution as gap-separated bands (Afterglow: dark-canvas
// zone palette; falls back to the canonical colour for anything unmapped).
export default function ZoneBar({ zonesSeconds, height = 8, className = '' }) {
  const zones = zoneBreakdown(zonesSeconds)
  return (
    <View className={`flex-row overflow-hidden ${className}`} style={{ height, gap: 2 }}>
      {zones.map((z) => (z.percent > 0 ? (
        <View key={z.id} style={{ flex: z.percent, backgroundColor: zoneColorDark(z.id) || z.color, borderRadius: height / 2 }} />
      ) : null))}
    </View>
  )
}
