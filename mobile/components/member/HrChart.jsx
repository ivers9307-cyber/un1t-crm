// HR over time chart — react-native-svg port of src/app/sessions/[id]/page.jsx HrChart.
// Same maths verbatim; viewBox 700×180 scales to full width.
//
// Afterglow opt-ins (default props = the original look, so existing callers
// are pixel-identical): `stroke` recolours the trace, `glow` adds the
// triple-stroke fake glow (spec §2.5 — no blur filters), `darkBands` swaps
// the zone bands to the dark-canvas palette at a lower opacity.

import { View } from 'react-native'
import Svg, { Rect, Polyline } from 'react-native-svg'
import { zoneColorDark } from 'shared/zone-colors'

export default function HrChart({ samples, maxHr, stroke = '#FFFFFF', glow = false, darkBands = false }) {
  const W = 700, H = 180, PAD = 12
  const t0 = new Date(samples[0].recorded_at).getTime()
  const t1 = new Date(samples[samples.length - 1].recorded_at).getTime()
  const tSpan = Math.max(1, t1 - t0)
  const yMin = 50
  const yMax = Math.max((maxHr || 0) + 10, 180)
  const ySpan = yMax - yMin

  const pts = samples.map((s) => {
    const x = PAD + ((new Date(s.recorded_at).getTime() - t0) / tSpan) * (W - 2 * PAD)
    const y = H - PAD - ((Math.max(yMin, Math.min(yMax, s.bpm)) - yMin) / ySpan) * (H - 2 * PAD)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  const bands = [
    { from: 0,    to: 0.60, color: '#9CA3AF' },
    { from: 0.60, to: 0.70, color: '#3B82F6' },
    { from: 0.70, to: 0.80, color: '#10B981' },
    { from: 0.80, to: 0.90, color: '#F59E0B' },
    { from: 0.90, to: 1.10, color: '#EF4444' },
  ].map((b, i) => {
    const yTop = H - PAD - ((Math.max(yMin, Math.min(yMax, b.to   * (maxHr || 0))) - yMin) / ySpan) * (H - 2 * PAD)
    const yBot = H - PAD - ((Math.max(yMin, Math.min(yMax, b.from * (maxHr || 0))) - yMin) / ySpan) * (H - 2 * PAD)
    const color = darkBands ? zoneColorDark(i + 1) || b.color : b.color
    return { ...b, color, y: Math.min(yTop, yBot), height: Math.abs(yBot - yTop) }
  })

  return (
    <View className="mt-3 rounded-lg overflow-hidden">
      <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height={176}>
        {bands.map((b, i) => (
          <Rect key={i} x={PAD} y={b.y} width={W - 2 * PAD} height={b.height} fill={b.color} fillOpacity={darkBands ? 0.07 : 0.12} />
        ))}
        {glow ? (
          <>
            <Polyline points={pts} fill="none" stroke={stroke} strokeWidth={7} strokeOpacity={0.14} strokeLinecap="round" strokeLinejoin="round" />
            <Polyline points={pts} fill="none" stroke={stroke} strokeWidth={3.5} strokeOpacity={0.35} strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : null}
        <Polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </View>
  )
}
