import { describe, it, expect } from 'vitest'
import {
  validateStructure, buildTimeline, computeEffectiveElapsedMs,
  resolveTimerState, applySkip, nextRunState, TIMER_SEGMENT_TYPES,
} from './class-timer'

// A template: 2s prep, then 2 rounds of (3s work, 1s rest), then 2s cool.
const STRUCTURE = [
  { kind: 'segment', label: 'Prep', type: 'prep', seconds: 2 },
  { kind: 'round', count: 2, segments: [
    { label: 'Work', type: 'work', seconds: 3 },
    { label: 'Rest', type: 'rest', seconds: 1 },
  ] },
  { kind: 'segment', label: 'Cool', type: 'prep', seconds: 2 },
]

describe('class-timer: validateStructure', () => {
  it('accepts a valid structure', () => {
    expect(validateStructure(STRUCTURE).ok).toBe(true)
  })
  it('rejects empty / non-array', () => {
    expect(validateStructure([]).ok).toBe(false)
    expect(validateStructure(null).ok).toBe(false)
  })
  it('rejects a bad segment type / seconds', () => {
    expect(validateStructure([{ kind: 'segment', label: 'x', type: 'nope', seconds: 5 }]).ok).toBe(false)
    expect(validateStructure([{ kind: 'segment', label: 'x', type: 'work', seconds: 0 }]).ok).toBe(false)
    expect(validateStructure([{ kind: 'segment', label: 'x', type: 'work', seconds: 99999 }]).ok).toBe(false)
  })
  it('rejects a round with bad count / no segments', () => {
    expect(validateStructure([{ kind: 'round', count: 0, segments: [{ label: 'w', type: 'work', seconds: 5 }] }]).ok).toBe(false)
    expect(validateStructure([{ kind: 'round', count: 2, segments: [] }]).ok).toBe(false)
  })
  it('exposes the segment types', () => {
    expect(TIMER_SEGMENT_TYPES).toContain('work')
    expect(TIMER_SEGMENT_TYPES).toContain('rest')
  })
})

describe('class-timer: buildTimeline', () => {
  it('expands rounds into a flat step list with offsets', () => {
    const { steps, totalMs } = buildTimeline(STRUCTURE)
    // prep, (work,rest)x2, cool = 6 steps
    expect(steps.map((s) => s.label)).toEqual(['Prep', 'Work', 'Rest', 'Work', 'Rest', 'Cool'])
    expect(totalMs).toBe((2 + (3 + 1) * 2 + 2) * 1000) // 12s
    expect(steps[0]).toMatchObject({ index: 0, startMs: 0, endMs: 2000, roundIndex: null, roundCount: null })
    expect(steps[1]).toMatchObject({ label: 'Work', startMs: 2000, endMs: 5000, roundIndex: 1, roundCount: 2 })
    expect(steps[3]).toMatchObject({ label: 'Work', roundIndex: 2, roundCount: 2 })
    expect(steps[5]).toMatchObject({ label: 'Cool', startMs: 10000, endMs: 12000 })
  })
})

describe('class-timer: computeEffectiveElapsedMs', () => {
  const started = Date.parse('2026-06-18T18:00:00Z')
  it('running: elapsed = now - started (+offset, -pausedAccum)', () => {
    const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: null }
    expect(computeEffectiveElapsedMs(run, started + 4000)).toBe(4000)
  })
  it('paused: freezes at the pause point', () => {
    const run = { status: 'paused', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: new Date(started + 3000).toISOString() }
    expect(computeEffectiveElapsedMs(run, started + 9999)).toBe(3000)
  })
  it('subtracts accumulated pause + adds skip offset', () => {
    const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 1000, elapsed_offset_ms: 2000, paused_at: null }
    expect(computeEffectiveElapsedMs(run, started + 4000)).toBe(4000 - 1000 + 2000)
  })
  it('never negative', () => {
    const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: -9999, paused_at: null }
    expect(computeEffectiveElapsedMs(run, started + 1000)).toBe(0)
  })
})

describe('class-timer: resolveTimerState', () => {
  const tl = buildTimeline(STRUCTURE)
  it('locates the current step mid-work', () => {
    const s = resolveTimerState(tl, 3000) // 1s into the first Work (2000..5000)
    expect(s.currentStep.label).toBe('Work')
    expect(s.segmentRemainingMs).toBe(2000)
    expect(s.roundIndex).toBe(1)
    expect(s.nextStep.label).toBe('Rest')
    expect(s.finished).toBe(false)
    expect(s.totalRemainingMs).toBe(9000)
  })
  it('clamps past the end to finished', () => {
    const s = resolveTimerState(tl, 99999)
    expect(s.finished).toBe(true)
    expect(s.totalRemainingMs).toBe(0)
  })
})

describe('class-timer: applySkip', () => {
  const tl = buildTimeline(STRUCTURE)
  const started = Date.parse('2026-06-18T18:00:00Z')
  const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: null }
  it('skip next jumps to the next segment boundary', () => {
    // at 3000ms (mid first Work, ends 5000) → next offset lands effective at 5000
    const off = applySkip(run, tl, 'next', started + 3000)
    expect(computeEffectiveElapsedMs({ ...run, elapsed_offset_ms: off }, started + 3000)).toBe(5000)
  })
  it('skip prev restarts the current segment', () => {
    const off = applySkip(run, tl, 'prev', started + 3500) // mid first Work (starts 2000)
    expect(computeEffectiveElapsedMs({ ...run, elapsed_offset_ms: off }, started + 3500)).toBe(2000)
  })
})

describe('class-timer: nextRunState', () => {
  const started = Date.parse('2026-06-18T18:00:00Z')
  it('pause sets status + paused_at', () => {
    const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: null }
    const patch = nextRunState(run, 'pause', started + 3000, {})
    expect(patch).toMatchObject({ status: 'paused', paused_at: new Date(started + 3000).toISOString() })
  })
  it('resume accumulates pause + clears paused_at', () => {
    const run = { status: 'paused', started_at: new Date(started).toISOString(), paused_accum_ms: 500, elapsed_offset_ms: 0, paused_at: new Date(started + 3000).toISOString() }
    const patch = nextRunState(run, 'resume', started + 5000, {})
    expect(patch).toMatchObject({ status: 'running', paused_at: null, paused_accum_ms: 500 + 2000 })
  })
  it('stop sets stopped; pause-when-paused is a no-op ({})', () => {
    const run = { status: 'paused', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: new Date(started + 1000).toISOString() }
    expect(nextRunState(run, 'stop', started + 9000, {})).toMatchObject({ status: 'stopped' })
    expect(nextRunState(run, 'pause', started + 9000, {})).toEqual({})
  })
  it('skip returns an elapsed_offset_ms patch', () => {
    const tl = buildTimeline(STRUCTURE)
    const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: null }
    const patch = nextRunState(run, 'skip', started + 3000, { direction: 'next', timeline: tl })
    expect(patch).toHaveProperty('elapsed_offset_ms')
    expect(computeEffectiveElapsedMs({ ...run, ...patch }, started + 3000)).toBe(5000)
  })
})
