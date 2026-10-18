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

// A staff viewer assigned to `locs`, holding Contacts (web and phone) at each
// except the `noContacts` ones, where both toggles are off.
const viewerAt = (locs, noContacts = []) => ({
  id: 'u1',
  role: 'staff',
  locations: locs.map((id) => ({ id, role: 'staff' })),
  assignmentsByLocation: Object.fromEntries(locs.map((id) => [id, {
    role: 'staff',
    permissions: noContacts.includes(id)
      ? { contacts: false, mobile: { contacts: false } }
      : { contacts: true, mobile: { contacts: true } },
  }])),
})
const viewer = (...locs) => viewerAt(locs)

// `clientLocs` are the un1t_clients rows the db holds for the contact.
// `honourIn: false` simulates a query that ignored its own .in() filter, to
// show the assertLocationAccess check holds on its own.
function makeDb({ clientLocs = [], honourIn = true } = {}) {
  const calls = { clients: [], locations: [], tables: [] }
  return {
    calls,
    from(table) {
      calls.tables.push(table)
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

const data = (over = {}) => ({ subscriptions: [], transactions: [], invoices: [], pastDues: [], ...over })
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
    const spies = seam({ [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDues: [pastDue()], transactions: [{ at: '2026-10-01T00:00:00Z', productTitle: 'Monthly', amountCents: 8900, currency: 'EUR', refunded: false }] }) })) } })
    const out = await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)
    expect(out.overdue).toBe(true)
    expect(out.arrearsCentsByCurrency).toEqual({ EUR: 8900 })
    expect(out.studios).toHaveLength(1)
    expect(out.studios[0]).toMatchObject({ locationId: HATCH, locationName: 'UN1T Hatch Street' })
    expect(out.studios[0].transactions).toHaveLength(1)
    expect(spies[HATCH]).toHaveBeenCalledWith(expect.anything(), HATCH, [CONTACT], expect.objectContaining({ limit: 10 }))
  })

  it('null amount: overdue true, arrearsCentsByCurrency empty', async () => {
    seam({ [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDues: [pastDue({ amountCents: null, currency: null })] }) })) } })
    const out = await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)
    expect(out.overdue).toBe(true)
    expect(out.arrearsCentsByCurrency).toEqual({})
  })

  it('two studios both overdue: amounts sum per currency', async () => {
    seam({
      [STILL]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDues: [pastDue({ amountCents: 1000 })] }) })) },
      [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDues: [pastDue({ amountCents: 2500 })] }) })) },
    })
    const out = await loadUn1tBilling(makeDb({ clientLocs: [STILL, HATCH] }), viewer(STILL, HATCH), CONTACT)
    expect(out.studios.map((s) => s.locationId).sort()).toEqual([STILL, HATCH].sort())
    expect(out.arrearsCentsByCurrency).toEqual({ EUR: 3500 })
  })

  describe('several overdue subscriptions at one studio', () => {
    const load = async (rows) => {
      seam({ [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDues: rows }) })) } })
      return loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)
    }

    it('two overdue subscriptions in EUR are summed, and the studio keeps both rows', async () => {
      const out = await load([
        pastDue({ since: '2026-09-20T09:00:00Z', amountCents: 4000 }),
        pastDue({ since: '2026-10-03T09:00:00Z', amountCents: 8900 }),
      ])
      expect(out.overdue).toBe(true)
      expect(out.arrearsCentsByCurrency).toEqual({ EUR: 12900 })
      expect(out.studios[0].pastDues).toHaveLength(2)
    })

    it('EUR plus GBP: only EUR in arrearsCentsByCurrency.EUR, GBP kept separate', async () => {
      const out = await load([
        pastDue({ amountCents: 4000 }),
        pastDue({ amountCents: 7000, currency: 'GBP' }),
      ])
      expect(out.arrearsCentsByCurrency).toEqual({ EUR: 4000, GBP: 7000 })
      expect(mergeArrearsCents(0, out)).toBe(4000)
    })

    it('a null amount still makes the member overdue but adds nothing', async () => {
      const out = await load([
        pastDue({ amountCents: null, currency: null }),
        pastDue({ amountCents: 4000 }),
      ])
      expect(out.overdue).toBe(true)
      expect(out.arrearsCentsByCurrency).toEqual({ EUR: 4000 })
      const only = await load([pastDue({ amountCents: null, currency: null })])
      expect(only.overdue).toBe(true)
      expect(only.arrearsCentsByCurrency).toEqual({})
    })

    it('the header chip names the studio\'s earliest since across its rows', async () => {
      const out = await load([
        pastDue({ since: '2026-10-09T09:00:00Z' }),
        pastDue({ since: '2026-09-20T09:00:00Z' }),
      ])
      expect(un1tHeaderRisk(out).title).toBe('Payment overdue on un1t.online at UN1T Hatch Street since 20 Sept 2026')
    })

    it('an empty pastDues is not overdue', async () => {
      const out = await load([])
      expect(out.overdue).toBe(false)
      expect(out.arrearsCentsByCurrency).toEqual({})
    })
  })

  describe('Review Focus 4: cross-studio scoping', () => {
    it('Stillorgan-only viewer of a dual-studio member: no Hatch studio returned', async () => {
      const spies = seam({
        [STILL]: { paymentsFor: vi.fn(async () => ({ success: true, data: data() })) },
        [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDues: [pastDue()] }) })) },
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
        [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDues: [pastDue()] }) })) },
      })
      const out = await loadUn1tBilling(makeDb({ clientLocs: [STILL, HATCH], honourIn: false }), viewer(STILL), CONTACT)
      expect(out.studios.map((s) => s.locationId)).toEqual([STILL])
      expect(out.overdue).toBe(false)
      expect(spies[HATCH]).toBeUndefined()
      expect(membershipReadsFor).not.toHaveBeenCalledWith(expect.anything(), HATCH)
    })

    it('a viewer of only the studio the client row is at gets that studio (the contact\'s owner is never consulted)', async () => {
      seam({ [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDues: [pastDue()] }) })) } })
      const db = makeDb({ clientLocs: [HATCH] })
      const out = await loadUn1tBilling(db, viewer(HATCH), CONTACT)
      expect(out.studios.map((s) => s.locationId)).toEqual([HATCH])
      expect(out.overdue).toBe(true)
      expect(db.calls.tables.sort()).toEqual(['locations', 'un1t_clients'])
    })

    it('location access without Contacts at that studio: no card, nothing read for it', async () => {
      const spies = seam({
        [STILL]: { paymentsFor: vi.fn(async () => ({ success: true, data: data() })) },
        [HATCH]: { paymentsFor: vi.fn(async () => ({ success: true, data: data({ pastDues: [pastDue()] }) })) },
      })
      const db = makeDb({ clientLocs: [STILL, HATCH] })
      const out = await loadUn1tBilling(db, viewerAt([STILL, HATCH], [HATCH]), CONTACT)
      expect(out.studios.map((s) => s.locationId)).toEqual([STILL])
      expect(out.overdue).toBe(false)
      expect(out.arrearsCentsByCurrency).toEqual({})
      expect(spies[HATCH]).toBeUndefined()
      expect(membershipReadsFor).not.toHaveBeenCalledWith(expect.anything(), HATCH)
      expect(db.calls.clients[0].location_id).toEqual([STILL])
    })

    it('Contacts off everywhere: nothing is queried', async () => {
      const db = makeDb({ clientLocs: [HATCH] })
      const out = await loadUn1tBilling(db, viewerAt([HATCH], [HATCH]), CONTACT)
      expect(out).toEqual({ studios: [], overdue: false, arrearsCentsByCurrency: {} })
      expect(db.calls.tables).toEqual([])
      expect(membershipReadsFor).not.toHaveBeenCalled()
    })

    it('Contacts on the phone only (web off) still counts, as in canViewContact', async () => {
      seam({ [HATCH]: {} })
      const user = viewerAt([HATCH])
      user.assignmentsByLocation[HATCH].permissions = { contacts: false, mobile: { contacts: true } }
      const out = await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), user, CONTACT)
      expect(out.studios.map((s) => s.locationId)).toEqual([HATCH])
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

  it('a studio whose source is not un1t.online, or not configured, or whose adapter lacks paymentsFor, is skipped and never read', async () => {
    const answer = { success: true, data: { pastDues: [pastDue()] } }
    const glofoxSpy = vi.fn(async () => answer)
    membershipReadsFor.mockResolvedValue({ source: 'glofox', state: 'configured', capabilities: { invoices: true }, reads: { paymentsFor: glofoxSpy } })
    expect((await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)).studios).toEqual([])
    expect(glofoxSpy).not.toHaveBeenCalled()

    const unconfiguredSpy = vi.fn(async () => answer)
    membershipReadsFor.mockResolvedValue({ source: 'un1t_online', state: 'unconfigured', capabilities: { invoices: true }, reads: { paymentsFor: unconfiguredSpy } })
    expect((await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)).studios).toEqual([])
    expect(unconfiguredSpy).not.toHaveBeenCalled()

    membershipReadsFor.mockResolvedValue({ source: 'un1t_online', state: 'configured', capabilities: { invoices: true }, reads: {} })
    expect((await loadUn1tBilling(makeDb({ clientLocs: [HATCH] }), viewer(HATCH), CONTACT)).studios).toEqual([])
    // skipped cleanly: not by a swallowed TypeError
    expect(logWarn).not.toHaveBeenCalled()
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
    expect(logWarn).toHaveBeenCalledWith('un1t-billing', 'load failed', { contactId: CONTACT })
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
      studios: [{ locationId: HATCH, locationName: 'UN1T Hatch Street', pastDues: [pastDue()] }],
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
        { locationId: STILL, locationName: 'Studio One', pastDues: [pastDue({ since: '2026-10-09T09:00:00Z' })] },
        { locationId: HATCH, locationName: 'Studio Two', pastDues: [pastDue({ since: '2026-10-02T09:00:00Z' })] },
      ],
    })
    expect(risk.title).toBe('Payment overdue on un1t.online at Studio Two since 2 Oct 2026')
  })

  it('earliest since across a studio\'s several rows, and across studios', () => {
    const risk = un1tHeaderRisk({
      overdue: true,
      studios: [
        { locationId: STILL, locationName: 'Studio One', pastDues: [pastDue({ since: '2026-10-09T09:00:00Z' }), pastDue({ since: '2026-10-04T09:00:00Z' })] },
        { locationId: HATCH, locationName: 'Studio Two', pastDues: [pastDue({ since: '2026-10-06T09:00:00Z' })] },
      ],
    })
    expect(risk.title).toBe('Payment overdue on un1t.online at Studio One since 4 Oct 2026')
  })

  it('no since: the title says only where', () => {
    const risk = un1tHeaderRisk({ overdue: true, studios: [{ locationId: HATCH, locationName: 'Studio Two', pastDues: [pastDue({ since: null })] }] })
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
