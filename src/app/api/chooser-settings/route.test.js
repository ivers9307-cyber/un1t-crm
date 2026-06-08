import { describe, it, expect } from 'vitest'
import { TileSchema } from './route'

describe('chooser-settings TileSchema.publish_state', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    public_path: 'hatch-street',
  }

  it('accepts each valid publish_state', () => {
    for (const s of ['live', 'coming_soon', 'hidden']) {
      expect(() => TileSchema.parse({ ...base, publish_state: s })).not.toThrow()
    }
  })

  it('rejects an invalid publish_state', () => {
    expect(() => TileSchema.parse({ ...base, publish_state: 'bogus' })).toThrow()
  })

  it('allows publish_state to be omitted (back-compat)', () => {
    expect(() => TileSchema.parse({ ...base })).not.toThrow()
  })
})
