// C122 WABROADCASTKILL.1 — which studios the broadcast cron may send at:
// tier 1 of resolvePermission (isFeatureEnabledAtLocation, the per-key
// toggle AND the bundles), nothing re-derived. Fictional ids.
import { describe, it, expect } from 'vitest'
import { whatsappEnabledLocationIds, notEnabledLocationFilter } from './whatsapp-broadcast-feature-gate.js'

const A = 'a0000000-0000-4000-8000-00000000000a'
const B = 'b0000000-0000-4000-8000-00000000000b'
const C = 'c0000000-0000-4000-8000-00000000000c'

describe('whatsappEnabledLocationIds', () => {
  it('keeps studios where the feature is on or unset, drops an explicit off', () => {
    expect(whatsappEnabledLocationIds([
      { id: A, features: { whatsapp: true } },
      { id: B, features: { whatsapp: false } },
      { id: C, features: {} },
    ])).toEqual([A, C])
  })
  it('a studio whose owning bundles are both off is off', () => {
    expect(whatsappEnabledLocationIds([
      { id: A, features: { bundle_messaging: false, bundle_marketing: false } },
      { id: B, features: { bundle_messaging: false } },
    ])).toEqual([B])
  })
  it('null features is the unset state (on), a row with no id is dropped', () => {
    expect(whatsappEnabledLocationIds([{ id: A, features: null }, { features: {} }, null])).toEqual([A])
  })
  it('no rows, no studios', () => {
    expect(whatsappEnabledLocationIds(null)).toEqual([])
    expect(whatsappEnabledLocationIds([])).toEqual([])
  })
})

describe('notEnabledLocationFilter', () => {
  it('rows with no studio or a studio outside the enabled set', () => {
    expect(notEnabledLocationFilter([A, C])).toBe(`location_id.is.null,location_id.not.in.(${A},${C})`)
  })
  it('no enabled studio: every row (no filter)', () => {
    expect(notEnabledLocationFilter([])).toBeNull()
  })
})
