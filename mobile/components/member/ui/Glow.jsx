import { View } from 'react-native'
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg'

// THE Glow (Afterglow spec §2.4.2): exactly one per screen, top-centre, in the
// earned accent colour. Absolutely positioned behind content; parent needs
// position:relative (RN Views are relative by default).
export default function Glow({ color, height = 260 }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: -60, left: 0, right: 0, height }}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="g" cx="50%" cy="0%" r="75%">
            <Stop offset="0%" stopColor={color} stopOpacity={0.15} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#g)" />
      </Svg>
    </View>
  )
}
