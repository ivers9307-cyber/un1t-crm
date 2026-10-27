import { describe, it, expect, vi } from 'vitest'

vi.mock('./contact-studios-display.js', () => ({ loadContactStudios: vi.fn() }))
vi.mock('./membership/source.js', () => ({ membershipSourceState: vi.fn() }))

import { shapePhoneContactExtras, loadPhoneContactExtras } from './contact-phone-extras.js'
import { loadContactStudios } from './contact-studios-display.js'
import { membershipSourceState } from './membership/source.js'

const STILL = { location_id: 's', location: { name: 'UN1T Stillorgan', membership_source: 'glofox' } }
const HATCH = { location_id: 'h', location: { name: 'UN1T Hatch Street', membership_source: 'un1t_online' } }

describe('shapePhoneContactExtras', () => {
  it('a Hatch-only un1t.online member: no Glofox card, no tags', () => {
    const out = shapePhoneContactExtras({ contact: { location_id: 'h' }, studioRows: [HATCH], primarySource: 'un1t_online' })
    expect(out).toEqual({ glofox_card: { mode: 'hidden', studio_name: null }, studio_tags: {} })
  })

  it('a Stillorgan Glofox member who also trains at Hatch: the card names Stillorgan, both studios tag', () => {
    const out = shapePhoneContactExtras({
      contact: { location_id: 'h', glofox_member_id: 'g1' },
      studioRows: [HATCH, STILL],
      primarySource: 'un1t_online',
    })
    expect(out.glofox_card).toEqual({ mode: 'linked', studio_name: 'UN1T Stillorgan' })
    expect(out.studio_tags).toEqual({ h: 'Hatch Street', s: 'Stillorgan' })
  })

  it('an unlinked Stillorgan lead: pushable, named after the primary', () => {
    const out = shapePhoneContactExtras({ contact: { location_id: 's' }, studioRows: [STILL], primarySource: 'glofox' })
    expect(out.glofox_card).toEqual({ mode: 'pushable', studio_name: 'UN1T Stillorgan' })
  })

  it('an unreadable source keeps the card (the pre-CARDLENS behaviour), with no name to give', () => {
    const out = shapePhoneContactExtras({ contact: { location_id: 'x' }, studioRows: [], primarySource: null })
    expect(out.glofox_card).toEqual({ mode: 'pushable', studio_name: null })
  })
})

describe('loadPhoneContactExtras', () => {
  it('a failed studios read and an unknown source answer the old screen, never throw', async () => {
    loadContactStudios.mockRejectedValue(new Error('boom'))
    membershipSourceState.mockResolvedValue({ source: null, state: 'unknown' })
    const out = await loadPhoneContactExtras({}, { id: 'c', location_id: 'h' })
    expect(out).toEqual({ glofox_card: { mode: 'pushable', studio_name: null }, studio_tags: {} })
  })

  it('reads the primary studio source and the contact studios', async () => {
    loadContactStudios.mockResolvedValue({ rows: [HATCH], error: null })
    membershipSourceState.mockResolvedValue({ source: 'un1t_online', state: 'configured' })
    const out = await loadPhoneContactExtras({}, { id: 'c', location_id: 'h' })
    expect(loadContactStudios).toHaveBeenCalledWith({}, 'c', { primaryLocationId: 'h' })
    expect(out.glofox_card.mode).toBe('hidden')
  })
})
