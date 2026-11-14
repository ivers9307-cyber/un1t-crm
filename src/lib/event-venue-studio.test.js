import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

import { listVenueStudios, judgeVenueStudio, judgeVenueStudioForEventLocation } from './event-venue-studio'

const ORG = '11111111-1111-4111-8111-111111111111'
const HATCH = { id: 'hatch', name: 'UN1T Hatch Street', address: ' Vault 8, Hatch Street Upper ', is_host_anchor: false }
const ANCHOR = { id: 'anchor', name: 'Pride Training Club (host events)', address: 'x', is_host_anchor: true }
const NO_ADDRESS = { id: 'test', name: 'Test Studio', address: null, is_host_anchor: false }

function makeDb({ rows = [], error = null, eventLocation = { organization_id: ORG } } = {}) {
  const calls = []
  const self = {
    then: (ok, err) => Promise.resolve({ data: error ? null : rows, error }).then(ok, err),
    // The event's own location row (judgeVenueStudioForEventLocation).
    maybeSingle: () => Promise.resolve({ data: error ? null : eventLocation, error }),
  }
  for (const m of ['select', 'eq', 'order', 'limit']) self[m] = (...a) => { calls.push([m, a]); return self }
  return { calls, from: (t) => { calls.push(['from', [t]]); return self } }
}

describe('listVenueStudios', () => {
  it('lists the organisation’s active studios that have an address, never a host anchor', async () => {
    const db = makeDb({ rows: [HATCH, ANCHOR, NO_ADDRESS] })
    expect(await listVenueStudios(db, ORG)).toEqual([{ id: 'hatch', name: 'UN1T Hatch Street', address: 'Vault 8, Hatch Street Upper' }])
    expect(db.calls).toContainEqual(['eq', ['organization_id', ORG]])
    expect(db.calls).toContainEqual(['eq', ['active', true]])
  })

  it('answers nothing with no organisation or a failed read', async () => {
    expect(await listVenueStudios(makeDb({ rows: [HATCH] }), null)).toEqual([])
    expect(await listVenueStudios(makeDb({ error: { message: 'pg down' } }), ORG)).toEqual([])
  })
})

describe('judgeVenueStudio', () => {
  it('passes "somewhere else" without a read', async () => {
    const db = makeDb({ rows: [HATCH] })
    expect(await judgeVenueStudio(db, { organizationId: ORG, venueLocationId: null })).toEqual({ ok: true, venueLocationId: null })
    expect(db.calls).toEqual([])
  })

  it('accepts one of the organisation’s studios', async () => {
    expect(await judgeVenueStudio(makeDb({ rows: [HATCH, ANCHOR] }), { organizationId: ORG, venueLocationId: 'hatch' })).toEqual({ ok: true, venueLocationId: 'hatch' })
  })

  it('refuses an anchor, a studio outside the list, and any id when the list cannot be read', async () => {
    const refused = { ok: false, error: 'invalid_venue_studio' }
    expect(await judgeVenueStudio(makeDb({ rows: [HATCH, ANCHOR] }), { organizationId: ORG, venueLocationId: 'anchor' })).toEqual(refused)
    expect(await judgeVenueStudio(makeDb({ rows: [HATCH] }), { organizationId: ORG, venueLocationId: 'other-org-studio' })).toEqual(refused)
    expect(await judgeVenueStudio(makeDb({ error: { message: 'pg down' } }), { organizationId: ORG, venueLocationId: 'hatch' })).toEqual(refused)
  })
})

describe('judgeVenueStudioForEventLocation — the staff form (SHELLYEVENTS.2)', () => {
  it('accepts a studio of the event location’s organisation, address or not', async () => {
    const db = makeDb({ rows: [HATCH, NO_ADDRESS, ANCHOR] })
    expect(await judgeVenueStudioForEventLocation(db, { eventLocationId: 'ev-loc', venueLocationId: 'test' })).toEqual({ ok: true, venueLocationId: 'test' })
    expect(db.calls).toContainEqual(['eq', ['organization_id', ORG]])
  })

  it('refuses an anchor, an unknown studio and an unreadable event location', async () => {
    const refused = { ok: false, error: 'invalid_venue_studio' }
    expect(await judgeVenueStudioForEventLocation(makeDb({ rows: [HATCH, ANCHOR] }), { eventLocationId: 'ev-loc', venueLocationId: 'anchor' })).toEqual(refused)
    expect(await judgeVenueStudioForEventLocation(makeDb({ rows: [HATCH] }), { eventLocationId: 'ev-loc', venueLocationId: 'elsewhere' })).toEqual(refused)
    expect(await judgeVenueStudioForEventLocation(makeDb({ rows: [HATCH], eventLocation: null }), { eventLocationId: 'ev-loc', venueLocationId: 'hatch' })).toEqual(refused)
  })

  it('passes "no studio" without a read', async () => {
    const db = makeDb({ rows: [HATCH] })
    expect(await judgeVenueStudioForEventLocation(db, { eventLocationId: 'ev-loc', venueLocationId: null })).toEqual({ ok: true, venueLocationId: null })
    expect(db.calls).toEqual([])
  })
})
