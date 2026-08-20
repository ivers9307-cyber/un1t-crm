// SENDER-REGISTRY.1 — two defects in one chain.
//
// D3a: the terminal fallback in getLocationSenderId is 'CCFautos' — CCF Autos
//      being a SEPARATE BUSINESS in this estate, not a neutral default. Any
//      event whose location and org both lack a sender texted a gym customer
//      from a used-car dealership's sender.
// D3b: the ORG-default lookup read only the LEGACY `locations` column, while
//      every real send overlays `channel_connections` first. Today mig 419
//      mirrors the two, so nothing diverges. The day a sender is configured
//      registry-only, the org lookup finds nothing and D3a fires.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const overlayConnectionsMany = vi.fn(async (_db, rows) => rows)
vi.mock('@/lib/connection-registry', () => ({
  overlayConnectionsMany: (...a) => overlayConnectionsMany(...a),
}))

import { getOrgDefaultSenderId, getOrgDefaultSender, resolveTenantSmsSender, getLocationSenderId } from './twilio'

// A locations query whose LEGACY sender column is empty for every row — the
// registry-primary world.
function legacyEmptyDb(rows) {
  const b = {
    from: () => b,
    select: () => b,
    eq: () => b,
    not: () => b,
    order: () => b,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return b
}

// A locations query that FAILS, as distinct from one that returns nothing.
function erroringDb() {
  const b = {
    from: () => b, select: () => b, eq: () => b, not: () => b, order: () => b,
    limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
  }
  return b
}

beforeEach(() => {
  vi.clearAllMocks()
  overlayConnectionsMany.mockImplementation(async (_db, rows) => rows)
  delete process.env.TWILIO_FROM
})

describe('getOrgDefaultSenderId consults the connections registry', () => {
  it('finds a sender that exists ONLY as a registry row', async () => {
    // Legacy column null on both locations; the registry carries the sender.
    const db = legacyEmptyDb([
      { id: 'L1', twilio_alpha_sender_id: null, created_at: '2026-01-01' },
      { id: 'L2', twilio_alpha_sender_id: null, created_at: '2026-02-01' },
    ])
    overlayConnectionsMany.mockImplementation(async (_db, rows) =>
      rows.map((r) => (r.id === 'L1' ? { ...r, twilio_alpha_sender_id: 'UN1T Dub' } : r)))

    expect(await getOrgDefaultSenderId(db, 'org1')).toBe('UN1T Dub')
    expect(overlayConnectionsMany).toHaveBeenCalledWith(db, expect.any(Array), ['twilio_sender'])
  })

  it('keeps taking the OLDEST location that has a sender', async () => {
    const db = legacyEmptyDb([
      { id: 'L1', twilio_alpha_sender_id: null, created_at: '2026-01-01' },
      { id: 'L2', twilio_alpha_sender_id: 'UN1THATCH', created_at: '2026-02-01' },
      { id: 'L3', twilio_alpha_sender_id: 'LATER', created_at: '2026-03-01' },
    ])
    expect(await getOrgDefaultSenderId(db, 'org1')).toBe('UN1THATCH')
  })

  it('still returns null when neither legacy nor registry has one (never guesses)', async () => {
    const db = legacyEmptyDb([{ id: 'L1', twilio_alpha_sender_id: null, created_at: '2026-01-01' }])
    expect(await getOrgDefaultSenderId(db, 'org1')).toBeNull()
  })

  it('returns null on a query error', async () => {
    expect(await getOrgDefaultSenderId(erroringDb(), 'org1')).toBeNull()
  })
})

describe('getOrgDefaultSender separates "not set" from "could not read"', () => {
  // Collapsing the two produced an operator-facing 409 that was simply false —
  // "Set one in Location Settings" is useless advice when the sender is already
  // set and the READ failed — and, on the unattended race-confirmation leg, a
  // permanent skip on a path that never retries.
  it('reports unreadable on a query error', async () => {
    expect(await getOrgDefaultSender(erroringDb(), 'org1')).toEqual({ senderId: null, unreadable: true })
  })

  it('reports NOT unreadable when the org genuinely has no sender', async () => {
    const db = legacyEmptyDb([{ id: 'L1', twilio_alpha_sender_id: null, created_at: '2026-01-01' }])
    expect(await getOrgDefaultSender(db, 'org1')).toEqual({ senderId: null, unreadable: false })
  })

  it('reports NOT unreadable when the org has no locations at all', async () => {
    expect(await getOrgDefaultSender(legacyEmptyDb([]), 'org1')).toEqual({ senderId: null, unreadable: false })
  })
})

describe('resolveTenantSmsSender refuses the cross-brand terminal', () => {
  it("reports source 'none' when nothing tenant-scoped is configured", async () => {
    const db = legacyEmptyDb([{ id: 'L1', twilio_alpha_sender_id: null, created_at: '2026-01-01' }])
    const loc = { id: 'ANCHOR', twilio_alpha_sender_id: null, organization_id: 'org1' }

    const out = await resolveTenantSmsSender(db, loc)

    expect(out.source).toBe('none')
    expect(out.senderId).toBeNull()
    // THE MIS-SEND THIS PREVENTS: had the caller gone ahead and sent, this is
    // the sender a UN1T gym customer would have seen on the payment link.
    expect(getLocationSenderId(out.location)).toBe('CCFautos')
  })

  it("reports source 'location' without querying when the location has its own", async () => {
    const throwingDb = { from() { throw new Error('should not query') } }
    const loc = { id: 'L', twilio_alpha_sender_id: 'UN1THATCH', organization_id: 'org1' }
    await expect(resolveTenantSmsSender(throwingDb, loc)).resolves.toEqual({
      location: loc, senderId: 'UN1THATCH', source: 'location',
    })
  })

  it("reports source 'org' and applies the org sender to a senderless location", async () => {
    const db = legacyEmptyDb([{ id: 'L1', twilio_alpha_sender_id: 'UN1T Dub', created_at: '2026-01-01' }])
    const loc = { id: 'ANCHOR', twilio_alpha_sender_id: null, organization_id: 'org1' }

    const out = await resolveTenantSmsSender(db, loc)

    expect(out.source).toBe('org')
    expect(getLocationSenderId(out.location)).toBe('UN1T Dub')
  })

  it("reports 'none' for a location with no organisation, without querying", async () => {
    const throwingDb = { from() { throw new Error('should not query') } }
    const out = await resolveTenantSmsSender(throwingDb, { id: 'L', twilio_alpha_sender_id: null })
    expect(out.source).toBe('none')
  })

  it("reports 'unreadable' — NOT 'none' — when the org lookup fails", async () => {
    // Same refusal to send (the fallback is still another brand), but the
    // caller can now say something true about why.
    const loc = { id: 'ANCHOR', twilio_alpha_sender_id: null, organization_id: 'org1' }
    const out = await resolveTenantSmsSender(erroringDb(), loc)
    expect(out.source).toBe('unreadable')
    expect(out.senderId).toBeNull()
  })

  it('tolerates a null location', async () => {
    await expect(resolveTenantSmsSender(null, null)).resolves.toEqual({
      location: null, senderId: null, source: 'none',
    })
  })
})
