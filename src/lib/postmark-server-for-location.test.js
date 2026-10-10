// W1.E4 — which Postmark SERVER a location's mail (and therefore its
// suppressions) lives on. A live tenant_email_domains row for the location's
// org → that org's server token; anything else → null = the global server.
//
// Null is the fail-safe answer on purpose: every caller runs beside a
// customer's opt-out and must never throw, and the global server is where
// every send goes when the resolver cannot find a live tenant row
// (resolveEmailSender's contract). The token itself is a secret — the helper
// returns it to the caller's memory and nowhere else.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/plans', () => ({ getLocationPlan: vi.fn() }))

import { _resetTenantEmailCache } from './tenant-email.js'
import { serverTokenForLocation, listLiveTenantServers, hostServerToken } from './postmark-server-for-location.js'

const LOC = 'a0000000-0000-0000-0000-000000000001'

// Thenable fake db. handler(table, ops) → { data } | { data, error }.
// `ops.calls` records the chain so a handler can honour .eq('status','live').
function makeDb(handler) {
  let fromCount = 0
  return {
    fromCount: () => fromCount,
    from(table) {
      fromCount++
      const ops = { table, calls: [] }
      const run = () => Promise.resolve(handler(table, ops))
      const builder = new Proxy({}, {
        get(_, prop) {
          if (prop === 'then') { const p = run(); return p.then.bind(p) }
          if (prop === 'maybeSingle' || prop === 'single') return () => run()
          return (...args) => { ops.calls.push({ prop, args }); return builder }
        },
      })
      return builder
    },
  }
}

const filtersLive = (ops) => ops.calls.some(c => c.prop === 'eq' && c.args[0] === 'status' && c.args[1] === 'live')

/** A db whose location belongs to org-1 and whose tenant row has `status`. */
function dbWithTenantRow(status, token = 'srv-tok') {
  return makeDb((table, ops) => {
    if (table === 'locations') return { data: { organization_id: 'org-1' }, error: null }
    if (table === 'tenant_email_domains') {
      const row = { postmark_server_token: token, from_email: 'hi@mail.gymx.com', from_name: 'GymX', status }
      // PostgREST would apply the status filter; the double does too.
      return { data: filtersLive(ops) && status !== 'live' ? null : row, error: null }
    }
    return { data: null, error: null }
  })
}

beforeEach(() => {
  _resetTenantEmailCache()
  vi.clearAllMocks()
})

describe('serverTokenForLocation', () => {
  it('returns the org server token for a LIVE row', async () => {
    expect(await serverTokenForLocation(dbWithTenantRow('live'), LOC)).toBe('srv-tok')
  })

  it('returns null when the org has no tenant row', async () => {
    const db = makeDb((table) => (table === 'locations' ? { data: { organization_id: 'org-1' }, error: null } : { data: null, error: null }))
    expect(await serverTokenForLocation(db, LOC)).toBeNull()
  })

  it('returns null when the row is not live (pending / verifying / failed / disabled)', async () => {
    for (const status of ['pending', 'verifying', 'failed', 'disabled']) {
      _resetTenantEmailCache()
      expect(await serverTokenForLocation(dbWithTenantRow(status), LOC)).toBeNull()
    }
  })

  it('returns null when the live row has no token', async () => {
    expect(await serverTokenForLocation(dbWithTenantRow('live', null), LOC)).toBeNull()
  })

  it('returns null on a locations read error', async () => {
    const db = makeDb(() => ({ data: null, error: { message: 'boom' } }))
    expect(await serverTokenForLocation(db, LOC)).toBeNull()
  })

  it('returns null on a tenant_email_domains read error', async () => {
    const db = makeDb((table) => (table === 'locations'
      ? { data: { organization_id: 'org-1' }, error: null }
      : { data: null, error: { message: 'boom' } }))
    expect(await serverTokenForLocation(db, LOC)).toBeNull()
  })

  it('returns null when the db throws outright — never throws itself', async () => {
    const db = { from: () => { throw new Error('exploded') } }
    await expect(serverTokenForLocation(db, LOC)).resolves.toBeNull()
  })

  it('returns null with no db or no locationId, without touching the db', async () => {
    const db = dbWithTenantRow('live')
    expect(await serverTokenForLocation(null, LOC)).toBeNull()
    expect(await serverTokenForLocation(db, null)).toBeNull()
    expect(await serverTokenForLocation(db, undefined)).toBeNull()
    expect(db.fromCount()).toBe(0)
  })

  it('caches per location for 60 s (shares tenant-email\'s cache)', async () => {
    const db = dbWithTenantRow('live')
    expect(await serverTokenForLocation(db, LOC)).toBe('srv-tok')
    const after = db.fromCount()
    expect(await serverTokenForLocation(db, LOC)).toBe('srv-tok')
    expect(db.fromCount()).toBe(after)
  })
})

describe('listLiveTenantServers', () => {
  it('returns one entry per LIVE row that has a token', async () => {
    const db = makeDb((table, ops) => {
      expect(table).toBe('tenant_email_domains')
      expect(filtersLive(ops)).toBe(true)
      return {
        data: [
          { organization_id: 'org-1', postmark_server_token: 'tok-1' },
          { organization_id: 'org-2', postmark_server_token: null },
          { organization_id: 'org-3', postmark_server_token: 'tok-3' },
        ],
        error: null,
      }
    })
    expect(await listLiveTenantServers(db)).toEqual({
      servers: [
        { organizationId: 'org-1', serverToken: 'tok-1' },
        { organizationId: 'org-3', serverToken: 'tok-3' },
      ],
      error: null,
    })
  })

  it('returns an empty list with no live rows', async () => {
    const db = makeDb(() => ({ data: [], error: null }))
    expect(await listLiveTenantServers(db)).toEqual({ servers: [], error: null })
  })

  it('reports a read error rather than an empty list — a dead read is not "no tenants"', async () => {
    const db = makeDb(() => ({ data: null, error: { message: 'boom' } }))
    const out = await listLiveTenantServers(db)
    expect(out.servers).toEqual([])
    expect(out.error).toContain('boom')
  })

  it('never throws', async () => {
    const db = { from: () => { throw new Error('exploded') } }
    const out = await listLiveTenantServers(db)
    expect(out.servers).toEqual([])
    expect(out.error).toContain('exploded')
  })
})

// Host mail rides the GLOBAL server today: host-campaign-queue.js passes no
// locationId to sendEmail and the host's stream (postmark_stream_id) exists
// only there. Resolving a host's suppression to its org's tenant server would
// 422 on a missing stream and silently never land. hostServerToken is the one
// place that reading lives, so the flip happens once, in the PR that moves
// host sends.
describe('hostServerToken', () => {
  const host = { id: 'h-1', anchor_location_id: 'loc-a', organization_id: 'org-1', postmark_stream_id: 'colm-events' }

  it('returns null (the global server) for every host today, even one whose org has a LIVE tenant server', async () => {
    const db = dbWithTenantRow('live')
    expect(await hostServerToken(db, host)).toBeNull()
    expect(db.fromCount()).toBe(0)
  })

  it('returns null for a missing host or db, without throwing', async () => {
    await expect(hostServerToken(null, host)).resolves.toBeNull()
    await expect(hostServerToken(dbWithTenantRow('live'), null)).resolves.toBeNull()
  })
})
