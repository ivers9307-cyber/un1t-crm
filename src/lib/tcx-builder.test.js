import { describe, it, expect } from 'vitest'
import { buildTcx } from './tcx-builder.js'

describe('buildTcx', () => {
  const session = {
    started_at: '2026-05-08T18:00:00Z',
    ended_at:   '2026-05-08T18:45:00Z',
    avg_hr_bpm: 145,
    peak_hr_bpm: 178,
  }
  const samples = [
    { recorded_at: '2026-05-08T18:00:00Z', bpm: 90 },
    { recorded_at: '2026-05-08T18:00:01Z', bpm: 105 },
    { recorded_at: '2026-05-08T18:00:02Z', bpm: 120 },
  ]

  it('emits an XML declaration and root element', () => {
    const xml = buildTcx({ session, samples })
    expect(xml).toMatch(/^<\?xml version="1\.0"/)
    expect(xml).toContain('<TrainingCenterDatabase')
  })

  it('contains Avg and Max HR when provided', () => {
    const xml = buildTcx({ session, samples })
    expect(xml).toContain('<AverageHeartRateBpm><Value>145</Value>')
    expect(xml).toContain('<MaximumHeartRateBpm><Value>178</Value>')
  })

  it('emits one Trackpoint per sample with Time + HeartRateBpm', () => {
    const xml = buildTcx({ session, samples })
    const tpCount = (xml.match(/<Trackpoint>/g) || []).length
    expect(tpCount).toBe(3)
    expect(xml).toContain('<HeartRateBpm><Value>120</Value>')
  })

  it('clamps absurd BPM values into [30, 240]', () => {
    const xml = buildTcx({
      session,
      samples: [{ recorded_at: '2026-05-08T18:00:00Z', bpm: 999 }],
    })
    expect(xml).toContain('<HeartRateBpm><Value>240</Value>')
  })

  it('escapes XML metacharacters in the title', () => {
    const xml = buildTcx({ session, samples, title: 'My <ride> & "fun"' })
    expect(xml).toContain('My &lt;ride&gt; &amp; &quot;fun&quot;')
  })

  it('omits Avg/Max when not present', () => {
    const xml = buildTcx({
      session: { ...session, avg_hr_bpm: null, peak_hr_bpm: null },
      samples,
    })
    expect(xml).not.toContain('AverageHeartRateBpm')
    expect(xml).not.toContain('MaximumHeartRateBpm')
  })

  it('computes TotalTimeSeconds from start/end span', () => {
    const xml = buildTcx({ session, samples })
    expect(xml).toMatch(/<TotalTimeSeconds>2700<\/TotalTimeSeconds>/)
  })
})
