import { View, Text } from 'react-native'
import Svg, { Polyline } from 'react-native-svg'
import Glow from './Glow'

// Every screen opens with a poster header (Afterglow spec §2.5): mono eyebrow
// over an Archivo Expanded title in chalk, the member's last real HR trace
// ghosted behind at 8% opacity, and THE one glow in the accent colour.
// `tracePoints` is the "x,y x,y ..." polyline string (or null to omit).
export default function PosterHeader({ eyebrow, title, accent, tracePoints = null }) {
  return (
    <View className="pt-3 pb-4">
      <Glow color={accent} />
      {tracePoints ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 8, left: 0, right: 0, opacity: 0.08 }}>
          <Svg viewBox="0 0 320 110" width="100%" height={96}>
            <Polyline points={tracePoints} fill="none" stroke="#F1EEE7" strokeWidth={2} />
          </Svg>
        </View>
      ) : null}
      <Text className="font-mono uppercase text-[10px] text-chalk-2" style={{ letterSpacing: 2.2 }}>{eyebrow}</Text>
      <Text className="font-display-bold text-chalk text-[26px] mt-1.5">{title}</Text>
    </View>
  )
}
