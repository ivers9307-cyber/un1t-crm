// src/lib/zoom/sync-runs.test.js
import { describe, it, expect } from 'vitest'
import { outcomePatch, PRUNE_DAYS } from './sync-runs'

describe('outcomePatch', () => {
  it('maps a clean run', () => {
    const p = outcomePatch({
      ok: true, counts: { creates: 3, updates: 1, deletes: 0 }, enqueued: 4,
      guardTripped: false, ownedInZoom: 199, stats: { scanned: 10 },
    })
    expect(p).toMatchObject({
      creates: 3, updates: 1, deletes: 0, enqueued: 4,
      guard_tripped: false, owned_in_zoom: 199, stats: { scanned: 10 }, error: null,
    })
    expect(p.finished_at).toBeTypeOf('string')
  })

  it('carries the guard verdict and its sample when tripped', () => {
    const p = outcomePatch({
      ok: false, counts: { creates: 0, updates: 0, deletes: 0 }, enqueued: 0,
      guardTripped: true,
      guard: { threshold: 20, attempted: 400, sample: ['+353871111111', '+353872222222'] },
    })
    expect(p.guard_tripped).toBe(true)
    expect(p.guard_threshold).toBe(20)
    expect(p.guard_attempted).toBe(400)
    expect(p.guard_sample).toEqual(['+353871111111', '+353872222222'])
  })

  it('records an error result', () => {
    const p = outcomePatch({ ok: false, error: 'zoom down' })
    expect(p.error).toBe('zoom down')
    expect(p.creates).toBeNull()
  })

  it('records an unconfigured skip as a finished run, not a failure', () => {
    const p = outcomePatch({ skipped: 'unconfigured' })
    expect(p.error).toBeNull()
    expect(p.finished_at).toBeTypeOf('string')
  })

  it('prunes at 90 days', () => {
    expect(PRUNE_DAYS).toBe(90)
  })
})
