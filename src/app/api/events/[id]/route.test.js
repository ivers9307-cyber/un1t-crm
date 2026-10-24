import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ updates: [] }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1', role: 'admin', activeLocation: { id: 'loc-1' } })),
  assertLocationAccessOr404: vi.fn(() => null),
  hasRoleAtLocation: vi.fn(() => true),
  hasRoleAtAnyLocation: vi.fn(() => true),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => true),
  hasPermissionForLocation: vi.fn(() => true),
}))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table !== 'race_events') throw new Error(`unexpected table ${table}`)
      // select/eq/single chain resolving to the existing row; update() records its payload.
      const chain = { select: () => chain, eq: () => chain, single: () => chain, then: (r) => r({ data: { id: 'ev-1', location_id: 'loc-1', host_id: null }, error: null }) }
      return { ...chain, update: (payload) => { mocks.updates.push(payload); return { eq: async () => ({ error: null }) } } }
    },
  }),
}))

import { UpdateSchema, PUT } from './route'

const putReq = (body) => new Request('http://x/api/events/ev-1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const ctx = { params: Promise.resolve({ id: 'ev-1' }) }

describe('PUT /api/events/[id] — CHARITY.9 charity day', () => {
  beforeEach(() => { mocks.updates.length = 0 })

  it('400s invalid charity settings before any write', async () => {
    const res = await PUT(putReq({ charity: { min_cents: 900, max_cents: 100 } }), ctx)
    expect(res.status).toBe(400)
    expect(mocks.updates).toHaveLength(0)
  })

  it('writes charity_enabled and charity to race_events', async () => {
    const charity = { name: 'MS Ireland', presets_cents: [1000, 2500], match_multiplier: 2 }
    const res = await PUT(putReq({ charity_enabled: true, charity }), ctx)
    expect(res.status).toBe(200)
    expect(mocks.updates).toHaveLength(1)
    expect(mocks.updates[0].charity_enabled).toBe(true)
    expect(mocks.updates[0].charity).toEqual(charity)
  })
})

// EVENTS-EMAILCFG.1 — per-event email config on the events update schema.
// Every field is optional (omit = leave untouched) and nullable (null =
// clear back to the default copy/look). template pointers are uuidLike.
describe('events UpdateSchema email config', () => {
  it('parses clean with no email fields set', () => {
    const parsed = UpdateSchema.parse({ name: 'Renamed event' })
    expect(parsed.confirmation_email_subject).toBeUndefined()
    expect(parsed.reminder_email_template_id).toBeUndefined()
  })

  it('accepts subject/intro edits and template pointers', () => {
    const parsed = UpdateSchema.parse({
      confirmation_email_subject: 'Welcome {{team_name}}',
      confirmation_email_intro: 'Doors open at {{when}}.',
      reminder_email_subject: 'See you at {{event_name}}',
      reminder_email_intro: 'Reminder for {{team_name}}.',
      confirmation_email_template_id: '22222222-2222-2222-2222-222222222222',
      reminder_email_template_id: '33333333-3333-3333-3333-333333333333',
    })
    expect(parsed.confirmation_email_template_id).toBe('22222222-2222-2222-2222-222222222222')
    expect(parsed.reminder_email_subject).toContain('event_name')
  })

  it('accepts null to clear copy + template pointers', () => {
    const parsed = UpdateSchema.parse({
      confirmation_email_intro: null,
      reminder_email_intro: null,
      confirmation_email_template_id: null,
      reminder_email_template_id: null,
    })
    expect(parsed.confirmation_email_intro).toBeNull()
    expect(parsed.confirmation_email_template_id).toBeNull()
  })

  it('rejects a non-uuid template pointer', () => {
    expect(() =>
      UpdateSchema.parse({ reminder_email_template_id: 'nope' }),
    ).toThrow()
  })

  it('rejects copy over the max length', () => {
    expect(() =>
      UpdateSchema.parse({ reminder_email_intro: 'y'.repeat(4001) }),
    ).toThrow()
  })
})

// EVENTS-SMS-TOGGLE (mig 552) was retired with the SMS channel
// (TWILIO-RETIRE.1): the flag is no longer on the schema, so a stale client
// that still sends it is stripped, never written.
describe('events UpdateSchema — the retired SMS confirmation toggle', () => {
  it('strips confirmation_sms_enabled', () => {
    expect(UpdateSchema.parse({ confirmation_sms_enabled: true }).confirmation_sms_enabled).toBeUndefined()
  })
})

describe('events UpdateSchema sending_location_id', () => {
  it('parses clean when omitted', () => {
    expect(UpdateSchema.parse({ name: 'x' }).sending_location_id).toBeUndefined()
  })
  it('accepts a uuid and null', () => {
    expect(UpdateSchema.parse({ sending_location_id: '22222222-2222-2222-2222-222222222222' }).sending_location_id)
      .toBe('22222222-2222-2222-2222-222222222222')
    expect(UpdateSchema.parse({ sending_location_id: null }).sending_location_id).toBeNull()
  })
  it('rejects a non-uuid', () => {
    expect(() => UpdateSchema.parse({ sending_location_id: 'nope' })).toThrow()
  })
})

describe('events UpdateSchema — EVENT-MOVE.1 moved-email copy', () => {
  it('accepts, clears and bounds the two fields', () => {
    expect(UpdateSchema.parse({ moved_email_subject: 'New date for {{event_name}}' }).moved_email_subject).toContain('event_name')
    expect(UpdateSchema.parse({ moved_email_intro: null }).moved_email_intro).toBeNull()
    expect(() => UpdateSchema.parse({ moved_email_intro: 'y'.repeat(4001) })).toThrow()
  })
})

describe('events UpdateSchema — EVENT-MOVE.5 price-difference email copy', () => {
  it('accepts, clears and bounds the two fields', () => {
    expect(UpdateSchema.parse({ gap_email_subject: 'Pay {{difference}} for {{event_name}}' }).gap_email_subject).toContain('difference')
    expect(UpdateSchema.parse({ gap_email_intro: null }).gap_email_intro).toBeNull()
    expect(() => UpdateSchema.parse({ gap_email_intro: 'y'.repeat(4001) })).toThrow()
  })
})

describe('events UpdateSchema — EVENT-WAITLIST.1 waitlist offer email copy', () => {
  it('accepts, clears and bounds the two fields', () => {
    expect(UpdateSchema.parse({ waitlist_email_subject: 'A spot at {{event_name}}' }).waitlist_email_subject).toContain('event_name')
    expect(UpdateSchema.parse({ waitlist_email_intro: 'Book here: {{claim_url}}' }).waitlist_email_intro).toContain('claim_url')
    expect(UpdateSchema.parse({ waitlist_email_intro: null }).waitlist_email_intro).toBeNull()
    expect(() => UpdateSchema.parse({ waitlist_email_intro: 'y'.repeat(4001) })).toThrow()
  })
})

describe('events UpdateSchema — CHARITY.9 charity day', () => {
  it('accepts the switch and a valid settings object', () => {
    const parsed = UpdateSchema.parse({ charity_enabled: true, charity: { name: 'MS Ireland', presets_cents: [1000, 2500], match_multiplier: 2 } })
    expect(parsed.charity_enabled).toBe(true)
    expect(parsed.charity.presets_cents).toEqual([1000, 2500])
  })
  it('accepts null to clear the settings and omits cleanly', () => {
    expect(UpdateSchema.parse({ charity: null }).charity).toBeNull()
    expect(UpdateSchema.parse({ name: 'x' }).charity).toBeUndefined()
  })
  it('rejects min above max and a non-boolean switch', () => {
    expect(() => UpdateSchema.parse({ charity: { min_cents: 900, max_cents: 100 } })).toThrow()
    expect(() => UpdateSchema.parse({ charity_enabled: 'yes' })).toThrow()
  })
})
