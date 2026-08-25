import { View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { segmentAngles, arcPath } from 'shared/ring-geometry'

// The Week Ring (Afterglow spec §2.4.3): one segment per slot; `filled` is an
// array of colours (that session's hardest-zone colour), remaining segments
// are hairline ghosts. size/stroke in px.
export default function WeekRing({ slots, filled = [], size = 108, stroke = 9, children }) {
  const r = (size - stroke) / 2
  const c = size / 2
  const segs = segmentAngles(slots, { gapDeg: slots > 1 ? 5 : 0 })
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        {segs.map((s, i) => (
          <Path
            key={i}
            d={arcPath(c, c, r, s.startDeg, s.endDeg)}
            stroke={filled[i] || '#2A2A31'}
            strokeWidth={stroke}
            // butt caps, not round: round caps extend strokeWidth/2 past each
            // endpoint, which swallows the 5° gaps and merges the segments
            // into a continuous ring (review finding).
            strokeLinecap="butt"
            fill="none"
          />
        ))}
      </Svg>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} className="items-center justify-center">
        {children}
      </View>
    </View>
  )
}
