import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  hasRoleAtLocation: vi.fn(() => true),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => true),
  hasPermissionForLocation: vi.fn(() => true),
}))

import { CreateSchema, GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

// EVENTS-EMAILCFG.1 — per-event email config on the events create schema.
// The confirmation/reminder subject + intro copy and the two full-template
// pointers are all optional + nullable. Behaviour-preserving: an event
// created with none of these set parses clean (all absent → persisted NULL).
describe('events CreateSchema email config', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    name: 'Hyrox Sim',
    race_date: '2026-08-01',
    waves: [{ start_time: '09:00' }],
  }

  it('parses clean with no email config set (behaviour-preserving default)', () => {
    const parsed = CreateSchema.parse({ ...base })
    expect(parsed.confirmation_email_subject).toBeUndefined()
    expect(parsed.confirmation_email_intro).toBeUndefined()
    expect(parsed.reminder_email_subject).toBeUndefined()
    expect(parsed.reminder_email_intro).toBeUndefined()
    expect(parsed.confirmation_email_template_id).toBeUndefined()
    expect(parsed.reminder_email_template_id).toBeUndefined()
  })

  it('accepts subject + intro copy for both emails', () => {
    const parsed = CreateSchema.parse({
      ...base,
      confirmation_email_subject: 'You\'re in, {{team_name}}!',
      confirmation_email_intro: 'See you at {{event_name}} on {{when}}.',
      reminder_email_subject: 'Tomorrow: {{event_name}}',
      reminder_email_intro: 'Final details for {{team_name}}.',
    })
    expect(parsed.confirmation_email_subject).toContain('team_name')
    expect(parsed.reminder_email_intro).toContain('team_name')
  })

  it('accepts null to clear each copy field', () => {
    const parsed = CreateSchema.parse({
      ...base,
      confirmation_email_subject: null,
      confirmation_email_intro: null,
      reminder_email_subject: null,
      reminder_email_intro: null,
    })
    expect(parsed.confirmation_email_intro).toBeNull()
    expect(parsed.reminder_email_subject).toBeNull()
  })

  it('accepts uuid template pointers and null', () => {
    const parsed = CreateSchema.parse({
      ...base,
      confirmation_email_template_id: '11111111-1111-1111-1111-111111111111',
      reminder_email_template_id: null,
    })
    expect(parsed.confirmation_email_template_id).toBe('11111111-1111-1111-1111-111111111111')
    expect(parsed.reminder_email_template_id).toBeNull()
  })

  it('rejects a non-uuid template pointer', () => {
    expect(() =>
      CreateSchema.parse({ ...base, confirmation_email_template_id: 'not-a-uuid' }),
    ).toThrow()
  })

  it('rejects copy that exceeds the max length', () => {
    expect(() =>
      CreateSchema.parse({ ...base, confirmation_email_intro: 'x'.repeat(4001) }),
    ).toThrow()
  })
})

// EVENTS-SMS-TOGGLE (mig 552) was retired with the SMS channel
// (TWILIO-RETIRE.1): the flag is no longer on the schema, so a stale client
// that still sends it is stripped, never written.
describe('events CreateSchema — the retired SMS confirmation toggle', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    name: 'Hyrox Sim',
    race_date: '2026-08-01',
    waves: [{ start_time: '09:00' }],
  }

  it('strips confirmation_sms_enabled', () => {
    expect(CreateSchema.parse({ ...base, confirmation_sms_enabled: true }).confirmation_sms_enabled).toBeUndefined()
  })
})

describe('events CreateSchema sending_location_id', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    name: 'Hyrox Sim', race_date: '2026-08-01', waves: [{ start_time: '09:00' }],
  }
  it('parses clean when omitted', () => {
    expect(CreateSchema.parse({ ...base }).sending_location_id).toBeUndefined()
  })
  it('accepts a uuid and null', () => {
    expect(CreateSchema.parse({ ...base, sending_location_id: '11111111-1111-1111-1111-111111111111' }).sending_location_id)
      .toBe('11111111-1111-1111-1111-111111111111')
    expect(CreateSchema.parse({ ...base, sending_location_id: null }).sending_location_id).toBeNull()
  })
  it('rejects a non-uuid', () => {
    expect(() => CreateSchema.parse({ ...base, sending_location_id: 'nope' })).toThrow()
  })
})

describe('events CreateSchema — EVENT-MOVE.1 moved-email copy', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    name: 'Hyrox Sim',
    race_date: '2026-08-01',
    waves: [{ start_time: '09:00' }],
  }

  it('accepts, clears and bounds the two fields', () => {
    expect(CreateSchema.parse({ ...base, moved_email_subject: 'New date for {{event_name}}' }).moved_email_subject).toContain('event_name')
    expect(CreateSchema.parse({ ...base, moved_email_intro: null }).moved_email_intro).toBeNull()
    expect(CreateSchema.parse({ ...base }).moved_email_subject).toBeUndefined()
    expect(() => CreateSchema.parse({ ...base, moved_email_intro: 'y'.repeat(4001) })).toThrow()
  })

  it('EVENT-MOVE.5: accepts, clears and bounds the two price-difference fields', () => {
    expect(CreateSchema.parse({ ...base, gap_email_subject: 'Pay {{difference}}' }).gap_email_subject).toContain('difference')
    expect(CreateSchema.parse({ ...base, gap_email_intro: null }).gap_email_intro).toBeNull()
    expect(CreateSchema.parse({ ...base }).gap_email_subject).toBeUndefined()
    expect(() => CreateSchema.parse({ ...base, gap_email_intro: 'y'.repeat(4001) })).toThrow()
  })

  it('EVENT-WAITLIST.1: accepts, clears and bounds the two waitlist offer fields', () => {
    expect(CreateSchema.parse({ ...base, waitlist_email_subject: 'A spot at {{event_name}}' }).waitlist_email_subject).toContain('event_name')
    expect(CreateSchema.parse({ ...base, waitlist_email_intro: null }).waitlist_email_intro).toBeNull()
    expect(CreateSchema.parse({ ...base }).waitlist_email_subject).toBeUndefined()
    expect(() => CreateSchema.parse({ ...base, waitlist_email_intro: 'y'.repeat(4001) })).toThrow()
  })
})

// Ids are uuid-shaped: sharedEventsOrFilter refuses anything else.
const STILL = 'aaaaaaaa-0000-0000-0000-000000000001'
const HATCH = 'aaaaaaaa-0000-0000-0000-000000000002'
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000001'

// W0.3 — `shared` means "visible across the OWNING organisation", not every
// tenant. The fake evaluates the exact PostgREST .or() string the route
// sends, so the assertion is on which rows come back, not on the string.
describe('GET /api/events — W0.3 shared events stay inside the owning organisation', () => {
  const ROWS = [
    { id: 'ev-own',            location_id: STILL, shared: false, name: 'Own',            kind: 'race', race_date: '2099-01-01', registrations: [], waves: [] },
    { id: 'ev-sibling-shared', location_id: HATCH, shared: true,  name: 'Sibling shared', kind: 'race', race_date: '2099-01-02', registrations: [], waves: [] },
    { id: 'ev-sibling-private',location_id: HATCH, shared: false, name: 'Sibling private',kind: 'race', race_date: '2099-01-03', registrations: [], waves: [] },
    { id: 'ev-foreign-shared', location_id: OTHER, shared: true,  name: 'Foreign shared', kind: 'race', race_date: '2099-01-04', registrations: [], waves: [] },
  ]

  // Minimal evaluator for the two shapes sharedEventsOrFilter can emit:
  //   location_id.eq.X
  //   location_id.eq.X,and(shared.eq.true,location_id.in.(a,b))
  function matchesOr(orString, row) {
    const own = /^location_id\.eq\.([^,]+)/.exec(orString)
    if (own && row.location_id === own[1]) return true
    const shared = /and\(shared\.eq\.true,location_id\.in\.\(([^)]*)\)\)/.exec(orString)
    return Boolean(shared && row.shared === true && shared[1].split(',').includes(row.location_id))
  }

  function makeDb(locationsHandler) {
    const calls = []
    const from = vi.fn((table) => {
      const ops = []
      const finish = (terminal) => {
        calls.push({ table, ops, terminal })
        if (table === 'locations') return locationsHandler(ops, terminal)
        if (table === 'race_events') {
          if (ops.some(([m]) => m === 'not')) return { data: [], error: null }   // HOST-EDIT.1 pass
          const or = ops.find(([m]) => m === 'or')?.[1]
          return { data: ROWS.filter((r) => matchesOr(or, r)), error: null }
        }
        return { data: null, error: null }
      }
      const b = {}
      for (const m of ['select', 'eq', 'neq', 'or', 'is', 'in', 'not', 'order', 'limit', 'gte']) {
        b[m] = (...args) => { ops.push([m, ...args]); return b }
      }
      b.maybeSingle = async () => finish('maybeSingle')
      b.then = (onFulfilled, onRejected) => Promise.resolve(finish('await')).then(onFulfilled, onRejected)
      return b
    })
    return { from, calls }
  }

  const req = { url: 'http://localhost/api/events' }

  beforeEach(() => {
    vi.clearAllMocks()
    getCurrentUser.mockResolvedValue({
      id: 'u1', role: 'manager',
      activeLocation: { id: STILL, organization_id: 'org-un1t' },
      locations: [{ id: STILL }],
    })
  })

  it('lists own events plus shared events of a sibling location; a foreign org\'s shared event is NOT returned', async () => {
    // The real siblingLocationIds runs against the fake: the active row, then
    // its organisation's other locations.
    const db = makeDb((ops, terminal) => terminal === 'maybeSingle'
      ? { data: { id: STILL, organization_id: 'org-un1t' }, error: null }
      : { data: [{ id: HATCH }], error: null })
    createServerClient.mockReturnValue(db)

    const res = await GET(req)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.map((r) => r.id).sort()).toEqual(['ev-own', 'ev-sibling-shared'])

    const listing = db.calls.find((c) => c.table === 'race_events' && c.ops.some(([m]) => m === 'or'))
    expect(listing.ops).toContainEqual(['or', `location_id.eq.${STILL},and(shared.eq.true,location_id.in.(${STILL},${HATCH}))`])
  })

  it('a sibling-lookup error narrows to own events only (never widens)', async () => {
    const db = makeDb(() => ({ data: null, error: { message: 'boom' } }))
    createServerClient.mockReturnValue(db)

    const res = await GET(req)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.map((r) => r.id)).toEqual(['ev-own'])

    const listing = db.calls.find((c) => c.table === 'race_events' && c.ops.some(([m]) => m === 'or'))
    // orgLocationIdsFor narrows to [locationId] on a lookup error, so the
    // shared half can only re-match the active studio's own rows.
    expect(listing.ops).toContainEqual(['or', `location_id.eq.${STILL},and(shared.eq.true,location_id.in.(${STILL}))`])
  })
})
