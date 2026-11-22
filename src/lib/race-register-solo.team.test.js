// EVENTTEAM.1 + TEAMNAMES.1 — Mia's solo booking door picks its team row like
// the public route: a team row per event, a returning person keeps their name,
// another entry's team is never taken over, and the person's own team already
// entered here is refused before its roster is touched.
import { describe, it, expect, vi } from 'vitest'
import { fakeDb, eqOf } from './event-waitlist.test-helpers'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('./member-validation', async (importOriginal) => ({
  ...(await importOriginal()),
  validateTeamRoster: vi.fn(async ({ members }) => members.map((m) => ({ name: m.name, email: m.email, is_member: false, member_contact_id: null, status: 'not_found' }))),
}))
vi.mock('./race-payments', () => ({ createRacePayment: vi.fn(async () => ({ payment: { id: 'p1' }, checkout: { free: true } })) }))
vi.mock('./race-confirmations', () => ({ sendRaceConfirmations: vi.fn() }))

const { registerSoloEventEntry } = await import('./race-register-solo.js')

const race = {
  id: 'e2', location_id: 'L1', name: 'Mobility', slug: 'mob', race_date: '2026-12-05', kind: 'workshop', capacity_mode: 'people',
  active: true, status: 'published', registration_opens_at: null, registration_closes_at: null,
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 0, members_only: false, payment_currency: 'EUR',
  waves: [{ id: 'w1', start_time: '10:00:00', capacity: null, label: null }],
  pricing_tiers: [],
}
const contact = { id: 'c1', name: 'Aoife Byrne', email: 'aoife@example.test', phone: '+3531' }

// hereTeam: the "Aoife Byrne" row at THIS event (e2), if any; entered: it has an entry here.
function db({ hereTeam = null, entered = false } = {}) {
  return fakeDb((q) => {
    if (q.table === 'race_registrations' && q.action === 'insert') return { data: { id: 'r1', registered_at: '2026-11-15T12:00:00Z' }, error: null }
    if (q.table === 'race_registrations' && eqOf(q, 'team_id')) return { data: entered ? [{ id: 'r-here' }] : [], error: null }
    if (q.table === 'race_registrations') return { data: [], error: null }
    if (q.table === 'teams' && q.action === 'select') {
      const atThisEvent = eqOf(q, 'race_event_id') === 'e2' && eqOf(q, 'name') === 'Aoife Byrne'
      return { data: atThisEvent ? hereTeam : null, error: null }
    }
    if (q.table === 'teams' && q.action === 'insert') return { data: { id: 't-new' }, error: null }
    return { data: null, error: null }
  })
}
const rosterWrites = (d, id) => d.queries.filter((q) => q.table === 'team_members' && q.action !== 'select' && (eqOf(q, 'team_id') === id || q.payload?.team_id === id))

describe('registerSoloEventEntry — the team row', () => {
  it("a returning person keeps their name: a fresh row of this event's own", async () => {
    const d = db()
    expect(await registerSoloEventEntry(d, { race, waveId: null, contact })).toMatchObject({ ok: true })
    const ins = d.queries.find((q) => q.table === 'teams' && q.action === 'insert')
    expect(ins.payload).toEqual({ location_id: 'L1', race_event_id: 'e2', name: 'Aoife Byrne', size: 1, captain_contact_id: 'c1' })
  })

  it("never takes over another person's same-named team at this event", async () => {
    const d = db({ hereTeam: { id: 't-other', captain_contact_id: 'c-other' } })
    expect(await registerSoloEventEntry(d, { race, waveId: null, contact })).toMatchObject({ ok: true })
    expect(d.queries.find((q) => q.table === 'teams' && q.action === 'insert').payload.name).toBe('Aoife Byrne 2')
    expect(rosterWrites(d, 't-other')).toHaveLength(0)
    expect(d.queries.some((q) => q.table === 'teams' && q.action === 'update' && eqOf(q, 'id') === 't-other')).toBe(false)
  })

  it('their own team already entered here is refused before its roster is touched', async () => {
    const d = db({ hereTeam: { id: 't-own', captain_contact_id: 'c1' }, entered: true })
    expect(await registerSoloEventEntry(d, { race, waveId: null, contact })).toEqual({ ok: false, reason: 'already_registered' })
    expect(rosterWrites(d, 't-own')).toHaveLength(0)
    expect(d.queries.some((q) => q.table === 'race_registrations' && q.action === 'insert')).toBe(false)
  })

  it('their own team here with no entry is reused', async () => {
    const d = db({ hereTeam: { id: 't-own', captain_contact_id: 'c1' } })
    expect(await registerSoloEventEntry(d, { race, waveId: null, contact })).toMatchObject({ ok: true })
    expect(d.queries.some((q) => q.table === 'teams' && q.action === 'insert')).toBe(false)
    expect(d.queries.find((q) => q.table === 'race_registrations' && q.action === 'insert').payload.team_id).toBe('t-own')
  })
})
