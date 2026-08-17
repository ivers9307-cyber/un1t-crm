import { describe, it, expect } from 'vitest'
import { segmentAngles, arcPath } from './ring-geometry'

describe('segmentAngles', () => {
  it('divides the circle into n segments with fixed gaps, starting at 12 oclock', () => {
    const segs = segmentAngles(4, { gapDeg: 4 })
    expect(segs).toHaveLength(4)
    expect(segs[0].startDeg).toBe(-90)
    const span = segs[0].endDeg - segs[0].startDeg
    expect(span).toBeCloseTo((360 - 4 * 4) / 4)
    // next segment starts one gap after the previous ends
    expect(segs[1].startDeg).toBeCloseTo(segs[0].endDeg + 4)
    // last segment ends one gap short of the full circle
    expect(segs[3].endDeg).toBeCloseTo(270 - 4)
  })
  it('handles a single segment and rejects nonsense', () => {
    expect(segmentAngles(1, { gapDeg: 4 })[0].endDeg).toBeCloseTo(-90 + 356)
    expect(segmentAngles(0)).toEqual([])
  })
})

describe('arcPath', () => {
  it('emits an SVG arc between the two angles on the given radius', () => {
    const d = arcPath(50, 50, 40, -90, 0)
    // starts at 12 o'clock (50, 10), sweeps to 3 o'clock (90, 50)
    expect(d).toMatch(/^M 50\.0+ 10\.0+ A 40 40 0 0 1 90\.0+ 50\.0+$/)
  })
})
