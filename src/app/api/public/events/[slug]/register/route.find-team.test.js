// FINDTEAM.3 — the register route accepts `find_team: true`: a solo entrant is
// stored as a team of one flagged looking_for_team, takes no team slot in a
// `teams`-capacity wave, and the option is refused on events that don't offer it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb, eqOf } from '@/lib/event-waitlist.test-helpers'

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
let db
let race
let countInWave = 0
let waveRegs = []
let ownSolos = []
let teamReg = null
let takenNames = new Set()
let payment = null
let placedIntoCount = 0
let placedIntoErr = null
let teamRegCount = 0
let regInsertErr = null
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/race-payments', () => ({
  createRacePayment: vi.fn(async () => ({ payment: { id: 'p1', status: 'pending' }, checkout: { free: false, token: 'tok', url: 'https://pay.test/x' } })),
  refreshRacePaymentFromProvider: vi.fn(),
}))
vi.mock('@/lib/race-confirmations', () => ({ sendRaceConfirmations: vi.fn() }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn(async () => 'c1') }))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForRaceRegistered: vi.fn() }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn() }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTags: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/member-validation', async (importOriginal) => ({
  ...(await importOriginal()),
  validateTeamRoster: vi.fn(async ({ members }) => members.map((m) => ({ name: m.name, email: m.email, is_member: false, member_contact_id: null, status: 'not_found' }))),
}))
vi.mock('@/lib/location-branding', () => ({ getLocationOrgBrandName: vi.fn(async () => 'UN1T') }))
vi.mock('@/lib/event-waitlist', () => ({
  claimWaitlistOnRegistration: vi.fn(async () => ({ claimed: false, reason: 'invalid_token' })),
  claimWaitlistByEmail: vi.fn(async () => ({ claimed: false, reason: 'not_on_list' })),
}))

const { POST } = await import('./route.js')

const RACE = { id: 'e1', location_id: 'L1', name: 'Hatch Relay', slug: 'hatch-oct18-1100', race_date: '2026-10-18', kind: 'race', capacity_mode: 'teams',
  allowed_team_sizes: [2, 4], find_team: { enabled: true }, registration_opens_at: null, registration_closes_at: null, active: true, status: 'published',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 2000, members_only: false, payment_currency: 'EUR',
  create_in_glofox: false, host_id: null, waves: [{ id: W1, start_time: '11:00:00', capacity: 10, label: null }] }

const isHeadCount = (q) => q.table === 'race_registrations' && q.ops.some((o) => o[0] === 'select' && o[2]?.head)
const isPlacedIntoCount = (q) => isHeadCount(q) && eqOf(q, 'placed_into_registration_id') !== undefined
const isTeamRegCount = (q) => isHeadCount(q) && eqOf(q, 'team_id') !== undefined

function registerDb(override) {
  return fakeDb((q) => {
    const answered = override?.(q)
    if (answered) return answered
    if (q.table === 'race_events') return { data: race, error: null }
    if (q.table === 'teams') {
      if (q.action === 'select') return { data: { id: 't1' }, error: null }
      if (q.action === 'insert') {
        if (takenNames.has(q.payload.name)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
        return { data: { id: 't-new' }, error: null }
      }
      return { data: null, error: null }
    }
    if (q.table === 'race_payments') return { data: payment, error: null }
    if (q.table === 'race_registrations') {
      if (q.action === 'insert') return regInsertErr ? { data: null, error: regInsertErr } : { data: { id: 'reg1', registered_at: '2026-10-09T12:00:00Z', wave_id: W1, contact_id: 'c1' }, error: null }
      if (isPlacedIntoCount(q)) return { data: null, count: placedIntoCount, error: placedIntoErr }
      if (isTeamRegCount(q)) return { data: null, count: teamRegCount, error: null }
      if (q.action === 'select' && eqOf(q, 'looking_for_team') === true) return { data: ownSolos, error: null }
      if (q.action === 'select' && eqOf(q, 'team_id')) return { data: teamReg, error: null }
      if (isHeadCount(q)) return { data: null, count: countInWave, error: null }
      if (q.action === 'select' && q.ops.some((o) => o[0] === 'in')) return { data: waveRegs, error: null }
      return { data: null, error: null }
    }
    return { data: null, error: null }
  })
}

const SOLO = { find_team: true, wave_id: W1, captain_name: 'Sarah Byrne', captain_email: 'sarah@example.test', captain_phone: '0870000000' }
const TEAM = { team_name: 'The Crushers', team_size: 2, wave_id: W1, captain_name: 'Ann Example', captain_email: 'ann@example.test', captain_phone: '0870000000', members: [{ name: 'Dan Walsh', email: null }] }
const post = (body) => POST(
  new Request('https://crm.test/api/public/events/hatch-oct18-1100/register', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'hatch-oct18-1100' }) },
)
const q = (table, action) => db.queries.filter((x) => x.table === table && x.action === action)

beforeEach(() => {
  vi.clearAllMocks()
  race = RACE
  countInWave = 0
  waveRegs = []
  ownSolos = []
  teamReg = null
  takenNames = new Set()
  payment = null
  placedIntoCount = 0
  placedIntoErr = null
  teamRegCount = 0
  regInsertErr = null
  db = registerDb()
})

// FINDTEAM.9 — the solo's team row is discarded on every refusal after its
// insert, once a count proves no registration points at it.
const teamDeletes = () => q('teams', 'delete')
const expectSoloTeamDiscarded = (teamId = 't-new') => {
  const dels = teamDeletes()
  expect(dels).toHaveLength(1)
  expect(eqOf(dels[0], 'id')).toBe(teamId)
  const count = db.queries.find(isTeamRegCount)
  expect(eqOf(count, 'team_id')).toBe(teamId)
  expect(db.queries.indexOf(count)).toBeLessThan(db.queries.indexOf(dels[0]))
}

describe('register route: find_team', () => {
  it('accepts a solo with no team_name or team_size and stores a team of one flagged looking_for_team', async () => {
    const res = await post(SOLO)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.team_name).toBe('Sarah Byrne (looking for a team)')
    // sizes [2,4] do not apply to a solo; FINDTEAM.8: a fresh team row, never a lookup by name
    expect(q('teams', 'select')).toHaveLength(0)
    expect(q('teams', 'update')).toHaveLength(0)
    expect(q('teams', 'insert')[0].payload).toMatchObject({ name: 'Sarah Byrne (looking for a team)', size: 1, captain_contact_id: 'c1', location_id: 'L1' })
    expect(q('race_registrations', 'insert')[0].payload).toMatchObject({ looking_for_team: true, team_id: 't-new', wave_id: W1 })
  })

  it('ignores a team_name / team_size sent alongside find_team', async () => {
    const res = await post({ ...SOLO, team_name: 'Sneaky', team_size: 4 })
    expect(res.status).toBe(200)
    expect((await res.json()).data.team_name).toBe('Sarah Byrne (looking for a team)')
    expect(q('teams', 'insert')[0].payload).toMatchObject({ size: 1 })
  })

  it('refuses a solo that names extra members', async () => {
    const res = await post({ ...SOLO, members: [{ name: 'Dan Walsh', email: null }] })
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(q('race_registrations', 'insert')).toHaveLength(0)
  })

  it('refuses find_team on a non-race event with find_team_unavailable', async () => {
    race = { ...RACE, kind: 'workshop' }
    const res = await post(SOLO)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('find_team_unavailable')
    expect(q('race_registrations', 'insert')).toHaveLength(0)
  })

  it('refuses find_team on an event that has not switched it on with find_team_disabled', async () => {
    race = { ...RACE, find_team: null }
    const res = await post(SOLO)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('find_team_disabled')
    race = { ...RACE, find_team: { enabled: false } }
    expect((await post(SOLO)).status).toBe(400)
    expect(q('race_registrations', 'insert')).toHaveLength(0)
  })

  it('still requires wave_id for a solo', async () => {
    const { wave_id: _w, ...noWave } = SOLO
    const res = await post(noWave)
    expect(res.status).toBe(400)
    expect(q('race_registrations', 'insert')).toHaveLength(0)
  })

  it('a full teams-mode wave still accepts a solo, and the solo never reads the team count', async () => {
    countInWave = 10
    const res = await post(SOLO)
    expect(res.status).toBe(200)
    expect(db.queries.some(isHeadCount)).toBe(false)
  })

  it('a non-solo registration counts confirmed TEAMS only: the count carries looking_for_team = false', async () => {
    const res = await post(TEAM)
    expect(res.status).toBe(200)
    const counts = db.queries.filter(isHeadCount)
    expect(counts).toHaveLength(1)
    expect(counts[0].ops).toContainEqual(['eq', 'looking_for_team', false])
    expect(counts[0].ops).toContainEqual(['eq', 'status', 'confirmed'])
    expect(q('race_registrations', 'insert')[0].payload).toMatchObject({ looking_for_team: false })
  })

  it('a full teams-mode wave still refuses a real team', async () => {
    countInWave = 10
    const res = await post(TEAM)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('wave_full')
  })

  it('people mode checks a solo as one person: full refuses, room accepts', async () => {
    race = { ...RACE, capacity_mode: 'people' }
    waveRegs = [{ status: 'confirmed', team: { size: 10 } }]
    const full = await post(SOLO)
    expect(full.status).toBe(409)
    expect((await full.json()).code).toBe('wave_full')
    waveRegs = [{ status: 'confirmed', team: { size: 9 } }]
    db = registerDb()
    expect((await post(SOLO)).status).toBe(200)
  })

  // FINDTEAM.8 (C1) — a solo is deduped by person, never by team name.
  describe('dedupe by person (C1)', () => {
    it('a second solo with the same name gets their own suffixed team and never touches the first', async () => {
      takenNames = new Set(['Sarah Byrne (looking for a team)'])
      const res = await post(SOLO)
      expect(res.status).toBe(200)
      expect((await res.json()).data.team_name).toBe('Sarah Byrne (looking for a team) 2')
      const inserts = q('teams', 'insert')
      expect(inserts.map((x) => x.payload.name)).toEqual(['Sarah Byrne (looking for a team)', 'Sarah Byrne (looking for a team) 2'])
      expect(q('race_registrations', 'delete')).toHaveLength(0)
      expect(q('race_payments', 'select')).toHaveLength(0)
      expect(q('race_registrations', 'insert')[0].payload).toMatchObject({ team_id: 't-new', looking_for_team: true })
      // the person check is keyed on the contact, not the team
      const own = q('race_registrations', 'select').find((x) => eqOf(x, 'looking_for_team') === true)
      expect(eqOf(own, 'contact_id')).toBe('c1')
      expect(own.ops).toContainEqual(['in', 'status', ['pending_payment', 'confirmed', 'placed']])
    })

    it('gives up with a 500 after 20 taken names', async () => {
      takenNames = new Set(['Sarah Byrne (looking for a team)', ...Array.from({ length: 19 }, (_, i) => `Sarah Byrne (looking for a team) ${i + 2}`)])
      const res = await post(SOLO)
      expect(res.status).toBe(500)
      expect(q('teams', 'insert')).toHaveLength(20)
      expect(q('race_registrations', 'insert')).toHaveLength(0)
    })

    it('a solo re-registering while placed is refused 409 already_registered, nothing deleted', async () => {
      ownSolos = [{ id: 'solo1', status: 'placed', active_payment_id: 'p0', team_id: 't-old', team: { name: 'Sarah Byrne (looking for a team)' } }]
      const res = await post(SOLO)
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('already_registered')
      expect(q('race_registrations', 'delete')).toHaveLength(0)
      expect(q('teams', 'insert')).toHaveLength(0)
    })

    it('a solo re-registering while confirmed is refused 409', async () => {
      ownSolos = [{ id: 'solo1', status: 'confirmed', active_payment_id: null, team_id: 't-old', team: { name: 'x' } }]
      expect((await post(SOLO)).status).toBe(409)
      expect(q('race_registrations', 'delete')).toHaveLength(0)
    })

    it("resumes this person's own live checkout", async () => {
      ownSolos = [{ id: 'solo1', status: 'pending_payment', active_payment_id: 'p0', team_id: 't-old', team: { name: 'Sarah Byrne (looking for a team) 2' } }]
      payment = { id: 'p0', status: 'pending' }
      const { refreshRacePaymentFromProvider } = await import('@/lib/race-payments')
      refreshRacePaymentFromProvider.mockResolvedValueOnce({ id: 'p0', status: 'pending' })
      const res = await post(SOLO)
      const json = await res.json()
      expect(res.status).toBe(200)
      expect(json.data).toMatchObject({ registration_id: 'solo1', team_id: 't-old', team_name: 'Sarah Byrne (looking for a team) 2', payment: { id: 'p0', resumed: true } })
      expect(q('race_registrations', 'delete')).toHaveLength(0)
      expect(q('teams', 'insert')).toHaveLength(0)
    })

    it("clears this person's own stale pending row and its team row, then books afresh", async () => {
      ownSolos = [{ id: 'solo1', status: 'pending_payment', active_payment_id: 'p0', team_id: 't-old', team: { name: 'x' } }]
      payment = { id: 'p0', status: 'abandoned' }
      const res = await post(SOLO)
      expect(res.status).toBe(200)
      const dels = q('race_registrations', 'delete')
      expect(dels).toHaveLength(1)
      expect(eqOf(dels[0], 'id')).toBe('solo1')
      expect(eqOf(dels[0], 'contact_id')).toBe('c1')
      expect(q('race_registrations', 'insert')).toHaveLength(1)
      // FINDTEAM.9 — the stale row's team goes with it, after the registration
      expect(db.queries.indexOf(dels[0])).toBeLessThan(db.queries.indexOf(teamDeletes()[0]))
      expectSoloTeamDiscarded('t-old')
    })

    it("keeps a stale row's team when another registration still points at it (a pre-FINDTEAM.8 shared row)", async () => {
      ownSolos = [{ id: 'solo1', status: 'pending_payment', active_payment_id: 'p0', team_id: 't-old', team: { name: 'x' } }]
      payment = { id: 'p0', status: 'abandoned' }
      teamRegCount = 1
      expect((await post(SOLO)).status).toBe(200)
      expect(q('race_registrations', 'delete')).toHaveLength(1)
      expect(teamDeletes()).toHaveLength(0)
    })

    it('a failed person check is a 500, never a booking', async () => {
      db = fakeDb((x) => {
        if (x.table === 'race_events') return { data: race, error: null }
        if (x.table === 'race_registrations' && eqOf(x, 'looking_for_team') === true) return { data: null, error: { message: 'boom' } }
        return { data: null, error: null }
      })
      expect((await post(SOLO)).status).toBe(500)
      expect(q('race_registrations', 'insert')).toHaveLength(0)
    })

    it('prices the solo for one person', async () => {
      const { createRacePayment } = await import('@/lib/race-payments')
      await post(SOLO)
      expect(createRacePayment).toHaveBeenCalledTimes(1)
      expect(createRacePayment.mock.calls[0][0].pricing).toMatchObject({ total_cents: 2000, non_member_count: 1 })
    })
  })

  it("a captain re-registering a team whose registration is placed is refused 409, nothing deleted", async () => {
    teamReg = { id: 'r9', status: 'placed', active_payment_id: null }
    const res = await post(TEAM)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('already_registered')
    expect(q('race_registrations', 'delete')).toHaveLength(0)
    expect(q('race_registrations', 'insert')).toHaveLength(0)
  })

  // FINDTEAM.9 — a stale-looking team entry that solos were placed into is as
  // final as a confirmed one: never stale-deleted by a captain's re-book.
  describe('captain re-book of a team entry solos were placed into (FINDTEAM.9)', () => {
    const STALE = { id: 'r9', status: 'cancelled', active_payment_id: null }

    it('is refused 409 already_registered, nothing deleted or inserted', async () => {
      teamReg = STALE
      placedIntoCount = 1
      const res = await post(TEAM)
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('already_registered')
      expect(q('race_registrations', 'delete')).toHaveLength(0)
      expect(q('race_registrations', 'insert')).toHaveLength(0)
      const count = db.queries.find(isPlacedIntoCount)
      expect(eqOf(count, 'placed_into_registration_id')).toBe('r9')
    })

    it('an unreadable placed count is a 500, nothing deleted', async () => {
      teamReg = STALE
      placedIntoErr = { message: 'boom' }
      expect((await post(TEAM)).status).toBe(500)
      expect(q('race_registrations', 'delete')).toHaveLength(0)
      expect(q('race_registrations', 'insert')).toHaveLength(0)
    })

    it('a stale entry nobody was placed into is still cleared and re-booked', async () => {
      teamReg = STALE
      expect((await post(TEAM)).status).toBe(200)
      const dels = q('race_registrations', 'delete')
      expect(dels).toHaveLength(1)
      expect(eqOf(dels[0], 'id')).toBe('r9')
      expect(q('race_registrations', 'insert')).toHaveLength(1)
      // a real team's row is keyed by name and lives across events: never discarded
      expect(teamDeletes()).toHaveLength(0)
    })
  })

  // FINDTEAM.9 — every refusal after the solo's team insert discards that team
  // row again, so failed or abandoned attempts never use up the 20 suffixes.
  describe('solo team rows do not accumulate (FINDTEAM.9)', () => {
    it('a booked solo keeps its team row', async () => {
      expect((await post(SOLO)).status).toBe(200)
      expect(q('teams', 'insert')).toHaveLength(1)
      expect(teamDeletes()).toHaveLength(0)
    })

    it('members_only refusal (403) discards the team row', async () => {
      race = { ...RACE, members_only: true }
      const res = await post(SOLO)
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('members_only_unverified')
      expect(q('teams', 'insert')).toHaveLength(1)
      expect(q('race_registrations', 'insert')).toHaveLength(0)
      expectSoloTeamDiscarded()
    })

    it('invalid promo refusal (400) discards the team row', async () => {
      const res = await post({ ...SOLO, promo_code: 'NOPE' })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('invalid_promo_code')
      expect(q('race_registrations', 'insert')).toHaveLength(0)
      expectSoloTeamDiscarded()
    })

    it('a failed registration insert (500) discards the team row', async () => {
      regInsertErr = { code: 'XX000', message: 'db down' }
      expect((await post(SOLO)).status).toBe(500)
      expectSoloTeamDiscarded()
    })

    it('a duplicate registration insert (409) discards the team row', async () => {
      regInsertErr = { code: '23505', message: 'duplicate key value violates unique constraint' }
      const res = await post(SOLO)
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('already_registered')
      expectSoloTeamDiscarded()
    })

    it('a payment init failure (502) rolls the registration back, then discards the team row', async () => {
      const { createRacePayment } = await import('@/lib/race-payments')
      createRacePayment.mockRejectedValueOnce(new Error('provider down'))
      const res = await post(SOLO)
      expect(res.status).toBe(502)
      expect((await res.json()).code).toBe('payment_init_failed')
      const regDel = q('race_registrations', 'delete')
      expect(regDel).toHaveLength(1)
      expect(eqOf(regDel[0], 'id')).toBe('reg1')
      expectSoloTeamDiscarded()
      expect(db.queries.indexOf(regDel[0])).toBeLessThan(db.queries.indexOf(teamDeletes()[0]))
    })

    it('never deletes a team row a registration still points at', async () => {
      teamRegCount = 1
      expect((await post({ ...SOLO, promo_code: 'NOPE' })).status).toBe(400)
      expect(db.queries.filter(isTeamRegCount)).toHaveLength(1)
      expect(teamDeletes()).toHaveLength(0)
    })

    it('a failed team delete still answers the refusal (best effort, logged)', async () => {
      db = registerDb((x) => (x.table === 'teams' && x.action === 'delete' ? { data: null, error: { message: 'locked' } } : undefined))
      const res = await post({ ...SOLO, promo_code: 'NOPE' })
      expect(res.status).toBe(400)
      const { logWarn } = await import('@/lib/log')
      expect(logWarn).toHaveBeenCalledWith('race-register', 'solo team row not discarded', expect.objectContaining({ teamId: 't-new' }))
    })

    it('the orphan count stays bounded across repeated failures: every insert is matched by a delete', async () => {
      for (let i = 0; i < 5; i++) {
        expect((await post({ ...SOLO, promo_code: 'NOPE' })).status).toBe(400)
      }
      expect(q('teams', 'insert')).toHaveLength(5)
      expect(teamDeletes()).toHaveLength(5)
      expect(teamDeletes().every((d) => eqOf(d, 'id') === 't-new')).toBe(true)
      expect(q('teams', 'insert').length - teamDeletes().length).toBe(0)
      // a later solo with that name still finds the first name free: no suffix needed
      race = { ...RACE }
      const res = await post(SOLO)
      expect(res.status).toBe(200)
      expect((await res.json()).data.team_name).toBe('Sarah Byrne (looking for a team)')
    })
  })
})
