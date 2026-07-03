import { describe, it, expect } from 'vitest'
import { PatchSchema } from './route'

// FLAGSHIP.A1 — is_flagship on the challenge edit (PUT) schema.
// The flag is an optional boolean; the flagship-implies-individual rule is
// enforced in the handler against the effective mode (a patch may carry only
// one of mode / is_flagship), so the schema itself just validates the type.
describe('challenges [id] PatchSchema.is_flagship', () => {
  it('accepts is_flagship=true on its own', () => {
    const parsed = PatchSchema.parse({ is_flagship: true })
    expect(parsed.is_flagship).toBe(true)
  })

  it('accepts is_flagship=false on its own', () => {
    const parsed = PatchSchema.parse({ is_flagship: false })
    expect(parsed.is_flagship).toBe(false)
  })

  it('leaves is_flagship undefined when omitted (partial patch)', () => {
    const parsed = PatchSchema.parse({ name: 'Renamed' })
    expect(parsed.is_flagship).toBeUndefined()
  })

  it('rejects a non-boolean is_flagship', () => {
    expect(() => PatchSchema.parse({ is_flagship: 1 })).toThrow()
  })
})
