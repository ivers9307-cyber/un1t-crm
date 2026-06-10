import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { collectZodErrors } from './form-validation.js'

const Schema = z.object({
  name: z.string().min(1, 'Name is required'),
  age: z.number().int().min(0, 'Age must be ≥ 0'),
})

describe('collectZodErrors', () => {
  it('returns an empty object when the values are valid', () => {
    expect(collectZodErrors(Schema, { name: 'Ada', age: 30 })).toEqual({})
  })
  it('maps each failing field to its first message, keyed by dotted path', () => {
    const errs = collectZodErrors(Schema, { name: '', age: -1 })
    expect(errs.name).toBe('Name is required')
    expect(errs.age).toBe('Age must be ≥ 0')
  })
  it('keeps only the first error per field', () => {
    const S = z.object({ x: z.string().min(3, 'too short').regex(/^a/, 'must start with a') })
    const errs = collectZodErrors(S, { x: '' })
    expect(Object.keys(errs)).toEqual(['x'])
  })
  it('handles nested paths with a dotted key', () => {
    const S = z.object({ profile: z.object({ email: z.string().email('bad email') }) })
    const errs = collectZodErrors(S, { profile: { email: 'nope' } })
    expect(errs['profile.email']).toBe('bad email')
  })
})
