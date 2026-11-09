import { describe, it, expect } from 'vitest'
import {
  eventIsPublic,
  hostEventDefaults,
  computeEditTransition,
  reReviewReasons,
  editChangesFromInput,
  RE_REVIEW_REASONS,
  RE_REVIEW_REASON_LABEL,
  HOST_EVENT_KINDS,
  HostEventSchema,
} from './host-events'
import { ensureAnchorLocation, resolveMasterLocationId, resolveMasterLocationIdStrict } from './host-events'

function fakeDb() {
  const calls = { inserted: null, updatedHost: null }
  return {
    calls,
    from(table) {
      if (table === 'locations') {
        return {
          // ensureAnchorLocation first probes for an existing unlinked anchor
          // (.select().eq().eq().maybeSingle()) → none here, so it falls through
          // to the insert path exercised by the "creates a hidden anchor" test.
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
          insert: (row) => ({ select: () => ({ single: async () => { calls.inserted = row; return { data: { id: 'loc-new' }, error: null } } }) }),
        }
      }
      if (table === 'event_hosts') {
        return { update: (patch) => ({ eq: async () => { calls.updatedHost = patch; return { error: null } } }) }
      }
      throw new Error('unexpected table ' + table)
    },
  }
}

describe('eventIsPublic', () => {
  it('is public only when active AND status=published', () => {
    expect(eventIsPublic({ active: true, status: 'published' })).toBe(true)
    expect(eventIsPublic({ active: false, status: 'published' })).toBe(false)
    expect(eventIsPublic({ active: true, status: 'draft' })).toBe(false)
    expect(eventIsPublic({ active: true, status: 'pending_review' })).toBe(false)
    expect(eventIsPublic({ active: true, status: 'rejected' })).toBe(false)
  })
  it('treats a missing status as not public (defensive)', () => {
    expect(eventIsPublic({ active: true })).toBe(false)
    expect(eventIsPublic(null)).toBe(false)
  })
})

describe('hostEventDefaults', () => {
  it('forces safe UN1T-only fields off', () => {
    const d = hostEventDefaults()
    expect(d).toMatchObject({
      member_pricing_enabled: false,
      members_only: false,
      member_fee_cents: null,
      shared: false,
      create_in_glofox: false,
      staff_required: 0,
      payment_currency: 'EUR',
      capacity_mode: 'people',
    })
  })
})

describe('computeEditTransition', () => {
  const published = { status: 'published', race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }] }
  it('keeps published + no re-review for a cosmetic-only edit', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }], description: 'new copy' })
    expect(t).toEqual({ status: 'published', reReview: false })
  })
  it('re-reviews when price changes on a published event', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-01', non_member_fee_cents: 3000, waves: [{ id: 'w1', start_time: '10:00' }] })
    expect(t).toEqual({ status: 'pending_review', reReview: true })
  })
  it('re-reviews when date changes on a published event', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-08', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }] })
    expect(t).toEqual({ status: 'pending_review', reReview: true })
  })
  it('re-reviews when a wave start_time changes on a published event', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '11:00' }] })
    expect(t).toEqual({ status: 'pending_review', reReview: true })
  })
  // HOSTSERIES.1 — only an EXISTING session's time change re-reviews; adding
  // or removing a session is additive and harms no booking.
  it('adding a session to a published event keeps it published', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }, { start_time: '14:00' }] })
    expect(t).toEqual({ status: 'published', reReview: false })
  })
  it('removing a session from a published event keeps it published', () => {
    const two = { ...published, waves: [{ id: 'w1', start_time: '10:00' }, { id: 'w2', start_time: '14:00' }] }
    const t = computeEditTransition(two, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }] })
    expect(t).toEqual({ status: 'published', reReview: false })
  })
  it('changing one existing session among several re-reviews', () => {
    const two = { ...published, waves: [{ id: 'w1', start_time: '10:00' }, { id: 'w2', start_time: '14:00' }] }
    const t = computeEditTransition(two, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }, { id: 'w2', start_time: '15:00' }] })
    expect(t).toEqual({ status: 'pending_review', reReview: true })
  })
  // TIERS.1 — a tier change is a price change.
  it('re-reviews when the pricing tiers change, not when they are the same list', () => {
    const tiers = [{ id: 'a', name: 'Early', price_cents: 2500, capacity: 20 }]
    const withTiers = { ...published, pricing_tiers: tiers }
    const same = computeEditTransition(withTiers, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }], pricing_tiers: [{ ...tiers[0] }] })
    expect(same).toEqual({ status: 'published', reReview: false })
    const changed = computeEditTransition(withTiers, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }], pricing_tiers: [{ ...tiers[0], price_cents: 2000 }] })
    expect(changed).toEqual({ status: 'pending_review', reReview: true })
    const cleared = computeEditTransition(withTiers, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }], pricing_tiers: null })
    expect(cleared).toEqual({ status: 'pending_review', reReview: true })
  })
  it('the same tiers in jsonb\'s key order are not a change', () => {
    const fromDb = [{ id: 'a', name: 'Early', ends_at: null, capacity: 20, starts_at: null, min_people: null, price_cents: 2500 }]
    const fromForm = [{ id: 'a', name: 'Early', price_cents: 2500, capacity: 20, starts_at: null, ends_at: null, min_people: null }]
    const t = computeEditTransition({ ...published, pricing_tiers: fromDb }, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }], pricing_tiers: fromForm })
    expect(t).toEqual({ status: 'published', reReview: false })
  })
  // QUESTIONS.1 — a questions change is not price or time: never a re-review.
  it('changing the registration questions never re-reviews', () => {
    const t = computeEditTransition({ ...published, registration_questions: null }, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }], registration_questions: [{ id: 'q-1', label: 'Size', type: 'text', required: false, per: 'entry' }] })
    expect(t).toEqual({ status: 'published', reReview: false })
  })
  it('draft/rejected edits never trigger re-review and keep their status', () => {
    expect(computeEditTransition({ status: 'draft', non_member_fee_cents: 2500 }, { non_member_fee_cents: 9999 })).toEqual({ status: 'draft', reReview: false })
    expect(computeEditTransition({ status: 'rejected', non_member_fee_cents: 2500 }, { non_member_fee_cents: 9999 })).toEqual({ status: 'rejected', reReview: false })
  })
})

describe('HOST_EVENT_KINDS', () => {
  it('excludes lead_gen (UN1T-only)', () => {
    expect(HOST_EVENT_KINDS).not.toContain('lead_gen')
    expect(HOST_EVENT_KINDS).toContain('workshop')
  })
})

describe('ensureAnchorLocation', () => {
  it('returns the existing anchor without creating one', async () => {
    const db = fakeDb()
    const id = await ensureAnchorLocation(db, { id: 'h1', name: 'Acme', organization_id: 'org1', anchor_location_id: 'loc-existing' })
    expect(id).toBe('loc-existing')
    expect(db.calls.inserted).toBe(null)
  })
  it('creates a hidden anchor location + links it when none exists', async () => {
    const db = fakeDb()
    const id = await ensureAnchorLocation(db, { id: 'h1', name: 'Acme', organization_id: 'org1', anchor_location_id: null })
    expect(id).toBe('loc-new')
    expect(db.calls.inserted).toMatchObject({ organization_id: 'org1', is_host_anchor: true, active: true, slug: 'host-h1' })
    expect(db.calls.inserted.name).toContain('Acme')
    expect(db.calls.updatedHost).toEqual({ anchor_location_id: 'loc-new' })
  })

  it('self-heals a first-create race: insert loses the UNIQUE slug → re-selects the winner', async () => {
    // Simulate two concurrent first-creates: this run misses the initial SELECT
    // (probe → null) but its INSERT trips the UNIQUE slug the winner already
    // holds. The re-select then finds the winner's row instead of throwing.
    const calls = { updatedHost: null, reselects: 0 }
    let probed = false
    const db = {
      calls,
      from(table) {
        if (table === 'locations') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => {
              if (!probed) { probed = true; return { data: null, error: null } } // initial probe: none
              calls.reselects++
              return { data: { id: 'loc-winner' }, error: null } // re-select after the failed insert
            } }) }) }),
            insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }) }) }),
          }
        }
        if (table === 'event_hosts') {
          return { update: (patch) => ({ eq: async () => { calls.updatedHost = patch; return { error: null } } }) }
        }
        throw new Error('unexpected table ' + table)
      },
    }
    const id = await ensureAnchorLocation(db, { id: 'h1', name: 'Acme', organization_id: 'org1', anchor_location_id: null })
    expect(id).toBe('loc-winner')
    expect(calls.reselects).toBe(1)
    expect(calls.updatedHost).toEqual({ anchor_location_id: 'loc-winner' })
  })
})

describe('resolveMasterLocationId', () => {
  function orgDb(row) {
    return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) }) }) }
  }
  it('returns the org master location when set', async () => {
    expect(await resolveMasterLocationId(orgDb({ master_location_id: 'master-1' }), { organization_id: 'org-1', anchor_location_id: 'anchor-1' })).toBe('master-1')
  })
  it('falls back to the host anchor location when unset', async () => {
    expect(await resolveMasterLocationId(orgDb({ master_location_id: null }), { organization_id: 'org-1', anchor_location_id: 'anchor-1' })).toBe('anchor-1')
  })
  it('falls back on db error and on missing org id', async () => {
    const throwing = { from: () => { throw new Error('boom') } }
    expect(await resolveMasterLocationId(throwing, { organization_id: 'org-1', anchor_location_id: 'anchor-1' })).toBe('anchor-1')
    expect(await resolveMasterLocationId(orgDb({}), { anchor_location_id: 'anchor-1' })).toBe('anchor-1')
  })

  // ── BAREWRITE.1 follow-up — the middle hop of the event-sender chain ──────
  // This function discarded the read's `error` and folded the failure into the
  // anchor fallback. That is right for HOST-MASTER.1 contact homing and WRONG
  // for sender selection: the anchor has no Twilio/email identity, so the
  // fail-open IS the wrong-brand send that resolveEventCommsLocation exists to
  // prevent. Hardening only the reads either side of it left the hole open.
  const erroringDb = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }) }) }) }),
  }

  it('the fail-open variant still swallows a read error (contact homing is unchanged)', async () => {
    expect(await resolveMasterLocationId(erroringDb, { organization_id: 'org-1', anchor_location_id: 'anchor-1' })).toBe('anchor-1')
  })

  it('the STRICT variant throws on a read error instead of returning the anchor', async () => {
    await expect(
      resolveMasterLocationIdStrict(erroringDb, { organization_id: 'org-1', anchor_location_id: 'anchor-1' }),
    ).rejects.toThrow(/organizations read failed/)
  })

  it('the STRICT variant agrees with the fail-open one on every non-error path', async () => {
    expect(await resolveMasterLocationIdStrict(orgDb({ master_location_id: 'master-1' }), { organization_id: 'org-1', anchor_location_id: 'anchor-1' })).toBe('master-1')
    expect(await resolveMasterLocationIdStrict(orgDb({ master_location_id: null }), { organization_id: 'org-1', anchor_location_id: 'anchor-1' })).toBe('anchor-1')
    expect(await resolveMasterLocationIdStrict(orgDb({}), { anchor_location_id: 'anchor-1' })).toBe('anchor-1')
  })
})

// HOSTSERIES.1 — sessions[] replaces the single session_* fields.
describe('HostEventSchema sessions', () => {
  const base = {
    kind: 'workshop', name: 'Mobility', race_date: '2026-12-05', allowed_team_sizes: [1, 2],
    ticket_price_cents: 2500, venue_name: 'Studio 1',
  }
  const two = [{ start_time: '10:00', capacity: 20 }, { start_time: '14:00', label: 'Afternoon', capacity: 15 }]
  it('accepts two sessions and reports them in order', () => {
    const r = HostEventSchema.safeParse({ ...base, sessions: two })
    expect(r.success).toBe(true)
    expect(r.data.sessions.map((s) => s.start_time)).toEqual(['10:00', '14:00'])
  })
  it('accepts a session with an id (an existing wave being edited)', () => {
    const r = HostEventSchema.safeParse({ ...base, sessions: [{ id: 'f0000000-0000-4000-8000-0000000000f1', start_time: '10:00', capacity: 20 }] })
    expect(r.success).toBe(true)
  })
  it('rejects no sessions and more than twelve', () => {
    expect(HostEventSchema.safeParse({ ...base, sessions: [] }).success).toBe(false)
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ start_time: `${String(6 + i).padStart(2, '0')}:00`, capacity: 5 }))
    expect(HostEventSchema.safeParse({ ...base, sessions: thirteen }).success).toBe(false)
  })
  it('rejects two sessions at the same start time, on the sessions path', () => {
    const r = HostEventSchema.safeParse({ ...base, sessions: [{ start_time: '10:00', capacity: 20 }, { start_time: '10:00', capacity: 5 }] })
    expect(r.success).toBe(false)
    expect(r.error.issues.some((i) => i.path.join('.') === 'sessions' && /own start time/.test(i.message))).toBe(true)
  })
  it('rejects the retired single-session keys (strict)', () => {
    const r = HostEventSchema.safeParse({ ...base, sessions: two, session_start_time: '10:00' })
    expect(r.success).toBe(false)
  })
  it('accepts pricing_tiers and rejects a malformed tier', () => {
    const ok = HostEventSchema.safeParse({ ...base, sessions: two, pricing_tiers: [{ id: 'a', name: 'Early bird', price_cents: 2500, capacity: 20 }] })
    expect(ok.success).toBe(true)
    expect(HostEventSchema.safeParse({ ...base, sessions: two, pricing_tiers: null }).success).toBe(true)
    expect(HostEventSchema.safeParse({ ...base, sessions: two, pricing_tiers: [{ id: 'a', name: '', price_cents: -1 }] }).success).toBe(false)
  })
  it('accepts registration_questions and rejects a malformed one', () => {
    expect(HostEventSchema.safeParse({ ...base, sessions: two, registration_questions: [{ id: 'q-1', label: 'Size', type: 'choice', options: ['S', 'M'], required: true, per: 'person' }] }).success).toBe(true)
    expect(HostEventSchema.safeParse({ ...base, sessions: two, registration_questions: null }).success).toBe(true)
    expect(HostEventSchema.safeParse({ ...base, sessions: two, registration_questions: [{ id: 'q-1', label: 'Size', type: 'choice', options: ['S'] }] }).success).toBe(false)
  })
  it('accepts duration_minutes within 5..1440, nullable', () => {
    expect(HostEventSchema.safeParse({ ...base, sessions: two, duration_minutes: 90 }).success).toBe(true)
    expect(HostEventSchema.safeParse({ ...base, sessions: two, duration_minutes: null }).success).toBe(true)
    expect(HostEventSchema.safeParse({ ...base, sessions: two, duration_minutes: 2 }).success).toBe(false)
  })
  it('accepts an optional nullable series_id', () => {
    expect(HostEventSchema.safeParse({ ...base, sessions: two, series_id: null }).success).toBe(true)
    expect(HostEventSchema.safeParse({ ...base, sessions: two, series_id: 'd0000000-0000-4000-8000-0000000000d1' }).success).toBe(true)
  })
})

describe('reReviewReasons', () => {
  const tiersA = [{ label: 'Early', price_cents: 2000, ends_at: '2026-08-01T10:00:00.000Z' }]
  const tiersB = [{ label: 'Early', price_cents: 2200, ends_at: '2026-08-01T10:00:00.000Z' }]
  const published = { status: 'published', race_date: '2026-09-01', non_member_fee_cents: 2500, pricing_tiers: tiersA, waves: [{ id: 'w1', start_time: '10:00:00' }] }
  const same = { race_date: '2026-09-01', non_member_fee_cents: 2500, pricing_tiers: tiersA, waves: [{ id: 'w1', start_time: '10:00' }] }
  const cases = [
    ['date', { ...same, race_date: '2026-09-08' }],
    ['price', { ...same, non_member_fee_cents: 3000 }],
    ['tiers', { ...same, pricing_tiers: tiersB }],
    ['session_time', { ...same, waves: [{ id: 'w1', start_time: '11:00' }] }],
  ]
  const quiet = [
    ['cosmetic', { ...same, description: 'new copy' }],
    ['added session', { ...same, waves: [...same.waves, { start_time: '14:00' }] }],
    ['removed session', { ...same, waves: [] }],
  ]

  it('returns each reason alone for each of the four edits', () => {
    for (const [reason, changes] of cases) expect(reReviewReasons(published, changes)).toEqual([reason])
  })
  it('returns every reason in RE_REVIEW_REASONS order when all four change', () => {
    const all = { race_date: '2026-09-08', non_member_fee_cents: 3000, pricing_tiers: tiersB, waves: [{ id: 'w1', start_time: '11:00' }] }
    expect(reReviewReasons(published, all)).toEqual(['date', 'price', 'tiers', 'session_time'])
    expect(reReviewReasons(published, all)).toEqual(RE_REVIEW_REASONS)
  })
  it('returns [] for a cosmetic edit, an added session and a removed session', () => {
    for (const [, changes] of quiet) expect(reReviewReasons(published, changes)).toEqual([])
  })
  it('returns [] for any edit to a draft, in-review or rejected event', () => {
    for (const status of ['draft', 'pending_review', 'rejected']) {
      for (const [, changes] of cases) expect(reReviewReasons({ ...published, status }, changes)).toEqual([])
    }
  })
  it('agrees with computeEditTransition on every case above', () => {
    for (const [, changes] of [...cases, ...quiet]) {
      expect(computeEditTransition(published, changes).reReview).toBe(reReviewReasons(published, changes).length > 0)
    }
  })
  it('has a label for every reason and no label without a reason', () => {
    expect(Object.keys(RE_REVIEW_REASON_LABEL).sort()).toEqual([...RE_REVIEW_REASONS].sort())
    expect(RE_REVIEW_REASON_LABEL.session_time).toBe("an existing session's start time")
  })
})

describe('editChangesFromInput', () => {
  it('maps a validated body to the DB-column shape the transition compares', () => {
    const input = {
      race_date: '2026-09-01',
      ticket_price_cents: 2500,
      pricing_tiers: undefined,
      sessions: [{ id: 'w1', start_time: '10:00', capacity: 5 }, { start_time: '14:00', capacity: 5 }],
      description: 'ignored',
    }
    expect(editChangesFromInput(input)).toEqual({
      race_date: '2026-09-01',
      non_member_fee_cents: 2500,
      pricing_tiers: null,
      waves: [{ id: 'w1', start_time: '10:00' }],
    })
  })
  it('tolerates a body with no sessions array', () => {
    expect(editChangesFromInput({ race_date: '2026-09-01', ticket_price_cents: 0 }).waves).toEqual([])
  })
})
