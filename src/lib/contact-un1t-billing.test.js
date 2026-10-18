// HATCHPIPE.2 (Task 12) — the contact page's un1t.online billing loader.
// Review Focus 4 is the point of most of these: a studio the viewer cannot see
// must never be read, and its billing must never reach the page.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/membership/reads', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, membershipReadsFor: vi.fn() }
})

import { logWarn } from '@/lib/log'
import { membershipReadsFor } from '@/lib/membership/reads'
import { loadUn1tBilling, un1tHeaderRisk, mergeArrearsCents } from './contact-un1t-billing'

const CONTACT = 'c0000000-0000-4000-8000-000000000001'
const STILL = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'
const NAMES = { [STILL]: 'Studio One', [HATCH]: 'UN1T Hatch Street' }

const viewer = (...locs) => ({ id: 'u1', locations: locs.map((id) => ({ id })) })

// `clientLocs` are the un1t_clients rows the db holds for the contact.
// `honourIn: false` simulates a query that ignored its own .in() filter, to
// show the assertLocationAccess check holds on its own.
function makeDb({ clientLocs = [], honourIn = true } = {}) {
  const calls = { clients: [], locations: [] }
  return {
    calls,
    from(table) {
      const filters = {}
      const b = {
        select: () => b,
        eq: (c, v) => { filters[c] = v; return b },
        in: (c, v) => { filters[c] = v; return b },
        then(resolve) {
          if (table === 'un1t_clients') {
            calls.clients.push(filters)
            const rows = clientLocs
              .filter((l) => !honourIn || !filters.location_id || filters.location_id.includes(l))
              .map((location_id) => ({ location_id }))
            return Promise.resolve({ data: rows, error: null }).then(resolve)
          }
          if (table === 'locations') {
            calls.locations.push(filters)
            return Promise.resolve({ data: (filters.id || []).map((id) => ({ id, name: NAMES[id] })), error: null }).then(resolve)
          }
          return Promise.resolve({ data: null, error: new Error(`unexpected table ${table}`) }).then(resolve)
        },
      }
      return b
    },
  }
}

const data = (over = {}) => ({ subscriptions: [], transactions: [], invoices: [], pastDue: null, ...over })
const pastDue = (over = {}) => ({ since: '2026-10-03T09:00:00Z', amountCents: 8900, currency: 'EUR', productTitle: 'Monthly', ...over })

// One adapter per location; `paymentsFor` is the spy the tests look at.
function seam(perLoc) {
  const spies = {}
  membershipReadsFor.mockImplementation(async (_db, loc) => {
    const cfg = perLoc[loc]
    if (!cfg) return { source: 'glofox', state: 'configured', reads: {}, capabilities: {} }
    spies[loc] = cfg.paymentsFor || vi.fn(async () => ({ success: true, data: data() }))
    return {
      source: 'un1t_online',
      state: 'configured',
      capabilities: { invoices: true, ...(cfg.capabilities || {}) },
      reads: { paymentsFor: spies[loc] },
    }
  })
  return spies
}

beforeEach(() => vi.clearAllMocks())

describe('loadUn1tBilling', () => {
  it('Hatch member past due: overdue true, EUR amount summed, studio listed', async () => {
    const spies = seam({ [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDue: pastDue(), transactions: [{ at: '2026-10-01T00:00:00Z', productTitle: 'Monthly', amountCents: 8900, currency: 'EUR', refunded: false }] }) })) } })
    const out = await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)
    expect(out.overdue).toBe(true)
    expect(out.arrearsCentsByCurrency).toEqual({ EUR: 8900 })
    expect(out.studios).toHaveLength(1)
    expect(out.studios[0]).toMatchObject({ locationId: HATCH, locationName: 'UN1T Hatch Street' })
    expect(out.studios[0].transactions).toHaveLength(1)
    expect(spies[HATCH]).toHaveBeenCalledWith(expect.anything(), HATCH, [CONTACT], expect.objectContaining({ limit: 10 }))
  })

  it('null amount: overdue true, arrearsCentsByCurrency empty', async () => {
    seam({ [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDue: pastDue({ amountCents: null, currency: null }) }) })) } })
    const out = await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)
    expect(out.overdue).toBe(true)
    expect(out.arrearsCentsByCurrency).toEqual({})
  })

  it('two studios both overdue: amounts sum per currency', async () => {
    seam({
      [STILL]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDue: pastDue({ amountCents: 1000 }) }) })) },
      [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDue: pastDue({ amountCents: 2500 }) }) })) },
    })
    const out = await loadUn1tBilling(makeDb({ clientLocs: [STILL, HATCH] }), viewer(STILL, HATCH), CONTACT)
    expect(out.studios.map((s) => s.locationId).sort()).toEqual([STILL, HATCH].sort())
    expect(out.arrearsCentsByCurrency).toEqual({ EUR: 3500 })
  })

  describe('Review Focus 4: cross-studio scoping', () => {
    it('Stillorgan-only viewer of a dual-studio member: no Hatch studio returned', async () => {
      const spies = seam({
        [STILL]: { paymentsFor: vi.fn(async () => ({ success: true, data: data() })) },
        [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDue: pastDue() }) })) },
      })
      const db = makeDb({ clientLocs: [STILL, HATCH] })
      const out = await loadUn1tBilling(db, viewer(STILL), CONTACT)
      expect(out.studios.map((s) => s.locationId)).toEqual([STILL])
      // Hatch's overdue must not leak into the flag or the amount either.
      expect(out.overdue).toBe(false)
      expect(out.arrearsCentsByCurrency).toEqual({})
      expect(spies[HATCH]).toBeUndefined()
      expect(membershipReadsFor).not.toHaveBeenCalledWith(expect.anything(), HATCH)
      expect(db.calls.clients[0].location_id).toEqual([STILL])
      expect(db.calls.locations[0].id).toEqual([STILL])
    })

    it('holds even when the client-row query ignores its own location filter', async () => {
      const spies = seam({
        [STILL]: {},
        [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDue: pastDue() }) })) },
      })
      const out = await loadUn1tBilling(makeDb({ clientLocs: [STILL, HATCH], honourIn: false }), viewer(STILL), CONTACT)
      expect(out.studios.map((s) => s.locationId)).toEqual([STILL])
      expect(out.overdue).toBe(false)
      expect(spies[HATCH]).toBeUndefined()
      expect(membershipReadsFor).not.toHaveBeenCalledWith(expect.anything(), HATCH)
    })

    it('Hatch-only viewer of a Stillorgan-owned Hatch member: Hatch studio returned', async () => {
      seam({ [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDue: pastDue() }) })) } })
      // The contact is owned elsewhere; only the un1t_clients row ties it to Hatch.
      const out = await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)
      expect(out.studios.map((s) => s.locationId)).toEqual([HATCH])
      expect(out.overdue).toBe(true)
    })

    it('a viewer with no studios reads nothing', async () => {
      const db = makeDb({ clientLocs: [HATCH] })
      const out = await loadUn1tBilling(db, viewer(), CONTACT)
      expect(out).toEqual({ studios: [], overdue: false, arrearsCentsByCurrency: {} })
      expect(db.calls.clients).toHaveLength(0)
      expect(membershipReadsFor).not.toHaveBeenCalled()
    })
  })

  it('capabilities.invoices false (today) → no studios, paymentsFor not called', async () => {
    const spies = seam({ [HATCH]: { capabilities: { invoices: false } } })
    const out = await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)
    expect(out).toEqual({ studios: [], overdue: false, arrearsCentsByCurrency: {} })
    expect(spies[HATCH]).not.toHaveBeenCalled()
  })

  it('a studio whose source is not un1t.online or not configured is skipped', async () => {
    membershipReadsFor.mockResolvedValue({ source: 'glofox', state: 'configured', capabilities: { invoices: true }, reads: { paymentsFor: vi.fn() } })
    expect((await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)).studios).toEqual([])
    membershipReadsFor.mockResolvedValue({ source: 'un1t_online', state: 'unconfigured', capabilities: { invoices: true }, reads: null })
    expect((await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)).studios).toEqual([])
  })

  it('Glofox-only contact (no un1t_clients rows) → empty result, no seam call', async () => {
    const out = await loadUn1tBilling(makeDb({ clientLocs: [] }), viewer(STILL, HATCH), CONTACT)
    expect(out).toEqual({ studios: [], overdue: false, arrearsCentsByCurrency: {} })
    expect(membershipReadsFor).not.toHaveBeenCalled()
  })

  it('paymentsFor failing → that studio dropped, logged, never throws', async () => {
    seam({
      [STILL]: { paymentsFor: vi.fn(async () => ({ success: false, error: 'boom' })) },
      [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data() })) },
    })
    const out = await loadUn1tBilling(makeDb({ clientLocs: [STILL, HATCH] }), viewer(STILL, HATCH), CONTACT)
    expect(out.studios.map((s) => s.locationId)).toEqual([HATCH])
    expect(logWarn).toHaveBeenCalledWith('un1t-billing', expect.any(String), expect.objectContaining({ contactId: CONTACT, locationId: STILL }))
  })

  it('a throwing seam → empty result, logged "load failed"', async () => {
    membershipReadsFor.mockRejectedValue(new Error('down'))
    const out = await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)
    expect(out).toEqual({ studios: [], overdue: false, arrearsCentsByCurrency: {} })
    expect(logWarn).toHaveBeenCalledWith('un1t-billing', 'load failed', expect.objectContaining({ contactId: CONTACT }))
  })

  it('an unreadable un1t_clients read → empty result, logged', async () => {
    const db = { from: () => { const b = { select: () => b, eq: () => b, in: () => b, then: (r) => Promise.resolve({ data: null, error: { message: 'nope' } }).then(r) }; return b } }
    const out = await loadUn1tBilling(db, viewer(HATCH), CONTACT)
    expect(out).toEqual({ studios: [], overdue: false, arrearsCentsByCurrency: {} })
    expect(logWarn).toHaveBeenCalledWith('un1t-billing', 'load failed', expect.objectContaining({ contactId: CONTACT }))
  })
})

describe('un1tHeaderRisk', () => {
  it('title "Payment overdue on un1t.online at UN1T Hatch Street since 3 Oct 2026"', () => {
    const risk = un1tHeaderRisk({
      overdue: true,
      studios: [{ locationId: HATCH, locationName: 'UN1T Hatch Street', pastDue: pastDue() }],
      arrearsCentsByCurrency: { EUR: 8900 },
    })
    expect(risk).toEqual({
      label: 'Payment overdue',
      cls: 'bg-red-50 text-red-700 border-red-200',
      title: 'Payment overdue on un1t.online at UN1T Hatch Street since 3 Oct 2026',
    })
  })

  it('names the studio with the earliest since', () => {
    const risk = un1tHeaderRisk({
      overdue: true,
      studios: [
        { locationId: STILL, locationName: 'Studio One', pastDue: pastDue({ since: '2026-10-09T09:00:00Z' }) },
        { locationId: HATCH, locationName: 'Studio Two', pastDue: pastDue({ since: '2026-10-02T09:00:00Z' }) },
      ],
    })
    expect(risk.title).toBe('Payment overdue on un1t.online at Studio Two since 2 Oct 2026')
  })

  it('no since: the title says only where', () => {
    const risk = un1tHeaderRisk({ overdue: true, studios: [{ locationId: HATCH, locationName: 'Studio Two', pastDue: pastDue({ since: null }) }] })
    expect(risk.title).toBe('Payment overdue on un1t.online at Studio Two')
  })

  it('null when nothing is overdue', () => {
    expect(un1tHeaderRisk({ overdue: false, studios: [], arrearsCentsByCurrency: {} })).toBeNull()
    expect(un1tHeaderRisk(undefined)).toBeNull()
  })
})

describe('mergeArrearsCents', () => {
  it('adds EUR only; a GBP amount is not added', () => {
    expect(mergeArrearsCents(1000, { arrearsCentsByCurrency: { EUR: 500 } })).toBe(1500)
    expect(mergeArrearsCents(1000, { arrearsCentsByCurrency: { GBP: 500 } })).toBe(1000)
    expect(mergeArrearsCents(1000, { arrearsCentsByCurrency: { EUR: 500, GBP: 700 } })).toBe(1500)
  })

  it('leaves the Glofox figure untouched when there is nothing to add', () => {
    expect(mergeArrearsCents(0, { studios: [], arrearsCentsByCurrency: {} })).toBe(0)
    expect(mergeArrearsCents(undefined, undefined)).toBeUndefined()
    expect(mergeArrearsCents(null, { arrearsCentsByCurrency: {} })).toBeNull()
  })

  it('treats an unreadable Glofox figure as 0 when un1t.online adds EUR', () => {
    expect(mergeArrearsCents(undefined, { arrearsCentsByCurrency: { EUR: 500 } })).toBe(500)
  })
})
