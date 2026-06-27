import { describe, it, expect, vi } from 'vitest'
import { shouldApplyWeight, applyWeightObservation, resolveBodyMetrics } from './body-metrics.js'

describe('shouldApplyWeight', () => {
  const now = '2026-06-27T10:00:00Z'
  const old = '2026-06-01T10:00:00Z'
  it('applies when there is no current weight', () => {
    expect(shouldApplyWeight({ weight_kg: null, weight_kg_at: null }, { weightKg: 70, observedAt: now })).toBe(true)
  })
  it('applies a newer observation', () => {
    expect(shouldApplyWeight({ weight_kg: 68, weight_kg_at: old }, { weightKg: 70, observedAt: now })).toBe(true)
  })
  it('applies an equally-timestamped observation (idempotent refresh)', () => {
    expect(shouldApplyWeight({ weight_kg: 68, weight_kg_at: now }, { weightKg: 70, observedAt: now })).toBe(true)
  })
  it('rejects a staler observation', () => {
    expect(shouldApplyWeight({ weight_kg: 70, weight_kg_at: now }, { weightKg: 99, observedAt: old })).toBe(false)
  })
  it('rejects a non-finite incoming weight', () => {
    expect(shouldApplyWeight({ weight_kg: null, weight_kg_at: null }, { weightKg: null, observedAt: now })).toBe(false)
  })
})

describe('applyWeightObservation', () => {
  function makeDb(current) {
    const updates = []
    return {
      _updates: updates,
      from: vi.fn(() => ({
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: current })) })) })),
        update: vi.fn((patch) => { updates.push(patch); return { eq: vi.fn(() => Promise.resolve({ error: null })) } }),
      })),
    }
  }
  it('writes weight + source + timestamp when fresher', async () => {
    const db = makeDb({ weight_kg: 68, weight_kg_at: '2026-06-01T00:00:00Z' })
    const out = await applyWeightObservation(db, { contactId: 'c1', weightKg: 70, source: 'inbody', observedAt: '2026-06-27T00:00:00Z' })
    expect(out).toBe(true)
    expect(db._updates[0]).toMatchObject({ weight_kg: 70, weight_kg_source: 'inbody', weight_kg_at: '2026-06-27T00:00:00Z' })
  })
  it('no-ops on a staler observation', async () => {
    const db = makeDb({ weight_kg: 70, weight_kg_at: '2026-06-27T00:00:00Z' })
    const out = await applyWeightObservation(db, { contactId: 'c1', weightKg: 99, source: 'manual', observedAt: '2026-06-01T00:00:00Z' })
    expect(out).toBe(false)
    expect(db._updates.length).toBe(0)
  })
})

describe('resolveBodyMetrics', () => {
  it('returns dob/age/gender/weightKg for the contact', async () => {
    const db = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: { dob: '1990-03-12', gender: 'male', weight_kg: 68 } })) })) })) })) }
    const out = await resolveBodyMetrics(db, 'c1', Date.parse('2026-06-27T00:00:00Z'))
    expect(out).toMatchObject({ gender: 'male', weightKg: 68 })
    expect(out.age).toBeGreaterThan(30)
  })
  it('handles a missing contact', async () => {
    const db = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null })) })) })) })) }
    expect(await resolveBodyMetrics(db, 'c1')).toEqual({ dob: null, age: null, gender: null, weightKg: null })
  })
})
