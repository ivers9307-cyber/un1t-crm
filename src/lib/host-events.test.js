import { describe, it, expect } from 'vitest'
import {
  eventIsPublic,
  hostEventDefaults,
  computeEditTransition,
  deriveSlug,
  HOST_EVENT_KINDS,
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
  it('draft/rejected edits never trigger re-review and keep their status', () => {
    expect(computeEditTransition({ status: 'draft', non_member_fee_cents: 2500 }, { non_member_fee_cents: 9999 })).toEqual({ status: 'draft', reReview: false })
    expect(computeEditTransition({ status: 'rejected', non_member_fee_cents: 2500 }, { non_member_fee_cents: 9999 })).toEqual({ status: 'rejected', reReview: false })
  })
})

describe('deriveSlug', () => {
  it('slugifies a name', () => {
    expect(deriveSlug('Summer Throwdown 2026!')).toBe('summer-throwdown-2026')
  })
  it('falls back to a non-empty slug', () => {
    expect(deriveSlug('###')).toBe('event')
    expect(deriveSlug('')).toBe('event')
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
