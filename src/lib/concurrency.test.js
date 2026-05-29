import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from './concurrency.js'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10)
    expect(out.map((r) => r.value)).toEqual([10, 20, 30, 40])
    expect(out.every((r) => r.ok)).toBe(true)
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active++
      peak = Math.max(peak, active)
      await tick()
      active--
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1) // actually ran in parallel
  })

  it('captures per-item errors without rejecting the batch', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    expect(out[0]).toEqual({ ok: true, value: 1 })
    expect(out[1].ok).toBe(false)
    expect(out[1].error.message).toBe('boom')
    expect(out[2]).toEqual({ ok: true, value: 3 })
  })

  it('empty input → empty results', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })

  it('clamps a silly limit to at least 1', async () => {
    const out = await mapWithConcurrency([1, 2], 0, async (n) => n)
    expect(out.map((r) => r.value)).toEqual([1, 2])
  })

  it('processes every item exactly once', async () => {
    const seen = []
    await mapWithConcurrency([10, 20, 30, 40, 50], 2, async (n) => { seen.push(n) })
    expect(seen.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50])
  })
})
