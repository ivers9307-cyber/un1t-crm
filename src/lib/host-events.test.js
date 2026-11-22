import { describe, it, expect } from 'vitest'
import {
  eventIsPublic,
  hostEventDefaults,
  HOST_PUBLISHABLE_STATUSES,
  HOST_EVENT_STATUSES,
  HOST_EVENT_KINDS,
  HostEventSchema,
} from './host-events'
import { ensureAnchorLocation, resolveMasterLocationId, resolveMasterLocationIdStrict } from './host-events'
import { studioUseGrew, studioHoursGrowth, studioChangesFromInput, STUDIO_USE_REASONS } from './host-events'

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

// HOSTAUTOPUB.1 — no approval step and no re-review.
describe('HOSTAUTOPUB.1 — publishing with no review', () => {
  it('a host publishes from draft, and from rows left rejected or pending_review', () => {
    expect(HOST_PUBLISHABLE_STATUSES).toEqual(['draft', 'rejected', 'pending_review'])
    expect(HOST_PUBLISHABLE_STATUSES).not.toContain('published')
  })
  it('keeps the four statuses valid (old rows stay readable; no migration)', () => {
    expect(HOST_EVENT_STATUSES).toEqual(['draft', 'pending_review', 'published', 'rejected'])
  })
  it('the re-review rule is gone from the module', async () => {
    const mod = await import('./host-events')
    for (const name of ['computeEditTransition', 'reReviewReasons', 'editChangesFromInput', 'RE_REVIEW_REASONS']) {
      expect(mod[name], name).toBeUndefined()
    }
  })
  it('public visibility is unchanged: published AND active only', () => {
    expect(eventIsPublic({ status: 'published', active: true })).toBe(true)
    expect(eventIsPublic({ status: 'published', active: false })).toBe(false)
    expect(eventIsPublic({ status: 'pending_review', active: true })).toBe(false)
    expect(eventIsPublic({ status: 'draft', active: true })).toBe(false)
  })
})

describe('HOSTSTUDIONOTICE.1 — studioUseGrew (a notice, never a check)', () => {
  const HATCH = 'aaaaaaaa-0000-4000-8000-000000000001'
  const STILL = 'aaaaaaaa-0000-4000-8000-000000000002'
  const linked = { venue_location_id: HATCH, duration_minutes: null, waves: [{ start_time: '10:00:00' }, { start_time: '12:00:00' }] }
  const same = (over = {}) => ({ venue_location_id: HATCH, session_times: ['10:00', '12:00'], duration_minutes: null, ...over })

  it('reasons come in one order', () => {
    expect(STUDIO_USE_REASONS).toEqual(['studio', 'studio_hours'])
  })
  it('linking an unlinked event to a studio is a studio change', () => {
    expect(studioUseGrew({ venue_location_id: null, waves: [{ start_time: '10:00' }] }, { venue_location_id: HATCH, session_times: ['10:00'], duration_minutes: null })).toEqual(['studio'])
  })
  it('moving to a different studio is a studio change', () => {
    expect(studioUseGrew(linked, same({ venue_location_id: STILL }))).toContain('studio')
  })
  it('moving OUT of a studio never counts, whatever else changes', () => {
    expect(studioUseGrew(linked, same({ venue_location_id: null, session_times: ['06:00', '23:00'], duration_minutes: 600 }))).toEqual([])
  })
  it('a body without the studio key judges no studio change but still the hours', () => {
    expect(studioUseGrew(linked, { session_times: ['10:00', '12:00'], duration_minutes: null })).toEqual([])
    expect(studioUseGrew(linked, { session_times: ['10:00', '14:00'], duration_minutes: null })).toEqual(['studio_hours'])
  })
  it('a session later than the last, or earlier than the first, grows the hours', () => {
    expect(studioHoursGrowth(linked, same({ session_times: ['10:00', '12:00', '18:30'] }))).toEqual({ earlier: null, later: '18:30', longerHoldMinutes: null })
    expect(studioHoursGrowth(linked, same({ session_times: ['07:00', '10:00', '12:00'] }))).toEqual({ earlier: '07:00', later: null, longerHoldMinutes: null })
    expect(studioUseGrew(linked, same({ session_times: ['07:00', '10:00', '12:00'] }))).toEqual(['studio_hours'])
  })
  it('an existing session re-timed outside the hours counts too', () => {
    expect(studioUseGrew(linked, same({ session_times: ['10:00', '15:00'] }))).toEqual(['studio_hours'])
  })
  it('a session inside the current hours, or a removed one, does not count', () => {
    expect(studioUseGrew(linked, same({ session_times: ['10:00', '11:00', '12:00'] }))).toEqual([])
    expect(studioUseGrew(linked, same({ session_times: ['10:00'] }))).toEqual([])
  })
  it('a longer hold counts; a shorter duration or one under the hold does not', () => {
    expect(studioHoursGrowth(linked, same({ duration_minutes: 180 })).longerHoldMinutes).toBe(180)
    expect(studioUseGrew(linked, same({ duration_minutes: 90 }))).toEqual([]) // under the 2 h default hold
    expect(studioUseGrew({ ...linked, duration_minutes: 240 }, same({ duration_minutes: 180 }))).toEqual([])
  })
  it("measures the hold against the studio's own setting", () => {
    expect(studioUseGrew(linked, same({ duration_minutes: 180 }), { studioHoldMinutes: 240 })).toEqual([])
    expect(studioUseGrew(linked, same({ duration_minutes: 300 }), { studioHoldMinutes: 240 })).toEqual(['studio_hours'])
  })
  it('an unlinked event that stays unlinked never counts', () => {
    expect(studioUseGrew({ venue_location_id: null, waves: [{ start_time: '10:00' }] }, { venue_location_id: null, session_times: ['06:00'], duration_minutes: 600 })).toEqual([])
  })
  it('studioChangesFromInput carries every session time, the studio only when sent, and always the duration', () => {
    expect(studioChangesFromInput({ sessions: [{ id: 'w', start_time: '10:00' }, { start_time: '18:00' }] }))
      .toEqual({ session_times: ['10:00', '18:00'], duration_minutes: null })
    expect(studioChangesFromInput({ sessions: [], venue_location_id: null, duration_minutes: 60 }))
      .toEqual({ venue_location_id: null, session_times: [], duration_minutes: 60 })
  })
})
