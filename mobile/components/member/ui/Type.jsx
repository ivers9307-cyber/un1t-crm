import { Text, View } from 'react-native'

// The two-tier numeral rule (Afterglow spec §2.3) as components.
// EARNED numbers (effort points, streaks, tier progress, PBs) are set big in
// the display face; TELEMETRY numbers (bpm, minutes, timestamps) are always
// mono with an uppercase unit tag in the active accent colour. If a number
// came from your body, it looks like it came off a monitor.

export function EarnedNumber({ children, size = 34, color = '#F1EEE7', className = '' }) {
  return (
    <Text className={`font-display-bold ${className}`} style={{ fontSize: size, lineHeight: size * 1.02, color }}>
      {children}
    </Text>
  )
}

// <Telemetry value="152" unit="AVG BPM" accent="#FFA928" />
export function Telemetry({ value, unit, accent = '#727170', size = 12, className = '' }) {
  return (
    <View className={`flex-row items-baseline gap-1 ${className}`}>
      <Text className="font-mono text-chalk" style={{ fontSize: size }}>{value}</Text>
      {unit ? (
        <Text className="font-mono uppercase" style={{ fontSize: size * 0.72, letterSpacing: 0.8, color: accent }}>
          {unit}
        </Text>
      ) : null}
    </View>
  )
}
