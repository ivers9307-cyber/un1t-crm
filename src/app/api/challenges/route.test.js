import { describe, it, expect } from 'vitest'
import { CreateSchema } from './route'

// FLAGSHIP.A1 — is_flagship on the challenge create schema.
// A flagship challenge is always an individual challenge; the flag defaults
// false and is carried into the insert (body.is_flagship) by the POST handler.
describe('challenges CreateSchema.is_flagship', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    name: 'June Transformation',
    mode: 'individual',
    metric: 'classes',
    starts_on: '2026-07-01',
    ends_on: '2026-07-31',
  }

  it('defaults is_flagship to false when omitted', () => {
    const parsed = CreateSchema.parse({ ...base })
    expect(parsed.is_flagship).toBe(false)
  })

  it('accepts is_flagship=true on an individual challenge', () => {
    const parsed = CreateSchema.parse({ ...base, mode: 'individual', is_flagship: true })
    expect(parsed.is_flagship).toBe(true)
  })

  it('accepts is_flagship=false on a collective challenge', () => {
    const parsed = CreateSchema.parse({
      ...base, mode: 'collective', target: 10000, is_flagship: false,
    })
    expect(parsed.is_flagship).toBe(false)
  })

  it('rejects a flagship + collective challenge', () => {
    expect(() =>
      CreateSchema.parse({ ...base, mode: 'collective', target: 10000, is_flagship: true }),
    ).toThrow()
  })

  it('rejects a non-boolean is_flagship', () => {
    expect(() => CreateSchema.parse({ ...base, is_flagship: 'yes' })).toThrow()
  })

  it('still enforces the collective-target and date refines alongside the flag', () => {
    // collective with no target -> rejected regardless of flag
    expect(() => CreateSchema.parse({ ...base, mode: 'collective' })).toThrow()
    // ends before starts -> rejected
    expect(() =>
      CreateSchema.parse({ ...base, starts_on: '2026-07-31', ends_on: '2026-07-01' }),
    ).toThrow()
  })
})
