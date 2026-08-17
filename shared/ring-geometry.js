// Segment math for the Afterglow Week Ring (spec §2.4.3): progress rings as
// discrete per-session segments. Pure geometry so it can be vitest-covered —
// the RN component (mobile/components/ui/WeekRing.jsx) only maps these to
// <Path> elements. Angles in degrees; -90 = 12 o'clock; sweep clockwise.
export function segmentAngles(count, { gapDeg = 4, fromDeg = -90 } = {}) {
  const n = Math.max(0, Math.floor(count))
  if (n === 0) return []
  const span = (360 - n * gapDeg) / n
  return Array.from({ length: n }, (_, i) => {
    const startDeg = fromDeg + i * (span + gapDeg)
    return { startDeg, endDeg: startDeg + span }
  })
}

export function arcPath(cx, cy, r, startDeg, endDeg) {
  const pt = (deg) => {
    const rad = (deg * Math.PI) / 180
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
  }
  const [x1, y1] = pt(startDeg)
  const [x2, y2] = pt(endDeg)
  const large = endDeg - startDeg > 180 ? 1 : 0
  const f = (v) => v.toFixed(4)
  return `M ${f(x1)} ${f(y1)} A ${r} ${r} 0 ${large} 1 ${f(x2)} ${f(y2)}`
}
