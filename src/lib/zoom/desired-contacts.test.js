import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildDesiredContacts, pickWinner } from './desired-contacts'

/**
 * Minimal stub of the two supabase-js builder chains buildDesiredContacts uses:
 *
 *   locations → .select('id').eq('organization_id', …)
 *   contacts  → .select(cols).in('location_id', […]).order('id').range(a, b)
 *
 * The contacts chain applies the `.in()` filter for real rather than ignoring
 * it, so the ZOOMSYNC.2 organisation boundary is exercised by every case in
 * this file instead of only the ones that name it — and an implementation that
 * drops the filter cannot pass, because `.select()` here exposes no `.order()`.
 * Rows are served in 1000-row pages so the .range() paging path stays covered.
 */
function stubDb(rows, { locations = [{ id: 'loc-un1t' }] } = {}) {
  return {
    from: (table) => {
      if (table === 'locations') {
        return { select: () => ({ eq: () => Promise.resolve({ data: locations, error: null }) }) }
      }
      return {
        select: () => ({
          in: (_col, ids) => ({
            order: () => ({
              range: (from, to) => {
                // `IN` never matches NULL — the reason unlocated contacts drop
                // out without needing a rule of their own.
                const scoped = rows.filter((r) => r.location_id != null && ids.includes(r.location_id))
                return Promise.resolve({ data: scoped.slice(from, to + 1), error: null })
              },
            }),
          }),
        }),
      }
    },
  }
}

const row = (over = {}) => ({
  id: 'c1', first_name: 'Aoife', last_name: 'Ryan', phone: '+353871111111',
  lead_source: 'walk-in', created_at: '2025-01-01T00:00:00Z',
  location_id: 'loc-un1t', ...over,
})

const ORIGINAL_ORG = process.env.ZOOM_SYNC_ORGANIZATION_ID
beforeEach(() => { process.env.ZOOM_SYNC_ORGANIZATION_ID = 'org-un1t' })
afterEach(() => {
  if (ORIGINAL_ORG === undefined) delete process.env.ZOOM_SYNC_ORGANIZATION_ID
  else process.env.ZOOM_SYNC_ORGANIZATION_ID = ORIGINAL_ORG
})

describe('organisation boundary (ZOOMSYNC.2)', () => {
  // The whole point: `contacts` is shared across tenants, the Zoom directory
  // is not. A CCF Autos customer must never reach a UN1T handset.
  it('never includes a contact from another organisation', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'ours', phone: '+353871111111', location_id: 'loc-un1t' }),
      row({ id: 'theirs', phone: '+353872222222', location_id: 'loc-ccf-autos' }),
    ]))
    expect(res.ok).toBe(true)
    expect([...res.desired.keys()]).toEqual(['+353871111111'])
  })

  it('excludes a contact with no location at all', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'ours', phone: '+353871111111' }),
      row({ id: 'orphan', phone: '+353872222222', location_id: null }),
    ]))
    expect([...res.desired.keys()]).toEqual(['+353871111111'])
  })

  it('includes every location in the organisation, not just the first', async () => {
    const res = await buildDesiredContacts(stubDb(
      [
        row({ id: 'stillorgan', phone: '+353871111111', location_id: 'loc-un1t' }),
        row({ id: 'hatch-st', phone: '+353872222222', location_id: 'loc-hatch' }),
      ],
      { locations: [{ id: 'loc-un1t' }, { id: 'loc-hatch' }] },
    ))
    expect(res.desired.size).toBe(2)
    expect(res.stats.orgLocations).toBe(2)
  })

  // Fail closed. An empty desired Map reads to diffContacts() as "delete
  // everything" — the deletion guard is the backstop, not the boundary.
  it('aborts rather than returning an empty map when the org id is unset', async () => {
    delete process.env.ZOOM_SYNC_ORGANIZATION_ID
    const res = await buildDesiredContacts(stubDb([row()]))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/ZOOM_SYNC_ORGANIZATION_ID/)
    expect(res.desired).toBeUndefined()
  })

  it('aborts when the organisation resolves to no locations', async () => {
    const res = await buildDesiredContacts(stubDb([row()], { locations: [] }))
    expect(res.ok).toBe(false)
    expect(res.desired).toBeUndefined()
  })
})

describe('pickWinner', () => {
  it('prefers the earliest created_at', () => {
    const a = row({ id: 'a', created_at: '2025-06-01T00:00:00Z', first_name: 'New' })
    const b = row({ id: 'b', created_at: '2024-01-01T00:00:00Z', first_name: 'Old' })
    expect(pickWinner(a, b).first_name).toBe('Old')
    expect(pickWinner(b, a).first_name).toBe('Old')
  })

  it('breaks a created_at tie on id, deterministically either way round', () => {
    const a = row({ id: 'aaa', created_at: '2025-01-01T00:00:00Z' })
    const b = row({ id: 'bbb', created_at: '2025-01-01T00:00:00Z' })
    expect(pickWinner(a, b).id).toBe('aaa')
    expect(pickWinner(b, a).id).toBe('aaa')
  })

  // Date.parse('1970-01-01T00:00:00Z') === 0, and 0 is falsy in JS. A naive
  // `Date.parse(x) || FALLBACK` guard would treat a genuinely-valid,
  // legitimately-oldest-possible timestamp the same as an unparseable one —
  // exactly backwards under "oldest wins". `contacts.created_at` is a
  // nullable timestamptz; a bad backfill or import could plausibly leave a
  // row sitting at the epoch, and that row must still win as oldest.
  it('treats the Unix epoch as a real date, not a parse failure', () => {
    const epoch = row({ id: 'epoch', created_at: '1970-01-01T00:00:00Z', first_name: 'Epoch' })
    const recent = row({ id: 'recent', created_at: '2025-06-01T00:00:00Z', first_name: 'Recent' })
    expect(pickWinner(epoch, recent).id).toBe('epoch')
    expect(pickWinner(recent, epoch).id).toBe('epoch')
  })

  // The counterpart case: a genuinely unparseable/missing created_at must
  // NOT win "oldest" against a real date — there is no evidence it is old,
  // so it falls to the back rather than defaulting to the front.
  it('does not let an unparseable or missing created_at win as oldest', () => {
    const bad = row({ id: 'bad', created_at: 'not-a-date' })
    const missing = row({ id: 'missing', created_at: null })
    const real = row({ id: 'real', created_at: '2025-06-01T00:00:00Z' })
    expect(pickWinner(bad, real).id).toBe('real')
    expect(pickWinner(real, bad).id).toBe('real')
    expect(pickWinner(missing, real).id).toBe('real')
    expect(pickWinner(real, missing).id).toBe('real')
  })
})

describe('buildDesiredContacts', () => {
  it('excludes ClassPass rows', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', phone: '+353871111111' }),
      row({ id: 'b', phone: '+353872222222', lead_source: 'classpass' }),
      row({ id: 'c', phone: '+353873333333', lead_source: 'ClassPass' }),
    ]))
    expect(res.ok).toBe(true)
    expect([...res.desired.keys()]).toEqual(['+353871111111'])
    expect(res.stats.excludedClassPass).toBe(2)
  })

  it('collapses a shared number to the oldest profile name', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'new', first_name: 'Sarah', last_name: 'Doyle', phone: '0871234567', created_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'old', first_name: 'Sarah', last_name: 'Kelly',  phone: '+353871234567', created_at: '2023-01-01T00:00:00Z' }),
    ]))
    expect(res.desired.size).toBe(1)
    expect(res.desired.get('+353871234567')).toEqual({ name: 'Sarah Kelly', contactId: 'old' })
    expect(res.stats.collapsed).toBe(1)
  })

  it('drops unnormalisable numbers and counts them', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', phone: '+353871111111' }),
      row({ id: 'b', phone: '12345' }),
    ]))
    expect(res.desired.size).toBe(1)
    expect(res.stats.rejected).toBe(1)
  })

  // ZOOMSYNC.4 — the numbers that read as phone numbers, passed
  // normaliseForZoom, and were enqueued nightly for Zoom to 400 forever.
  describe('numbers Zoom will not accept', () => {
    it.each([
      ['+87654567890', 'no such country code'],
      ['+800860588525', 'a UIFN service number'],
      ['+35382247706573', 'too many digits for Ireland'],
      ['+35386921983289', 'too many digits for Ireland'],
    ])('keeps %s out of the desired state (%s)', async (phone) => {
      const res = await buildDesiredContacts(stubDb([
        row({ id: 'good', phone: '+353871111111' }),
        row({ id: 'bad', phone }),
      ]))
      expect([...res.desired.keys()]).toEqual(['+353871111111'])
      expect(res.stats.invalidE164).toBe(1)
      // Counted apart from `rejected`: unparseable is a data-entry problem,
      // this is a number that looked fine right up until Zoom refused it.
      expect(res.stats.rejected).toBe(0)
    })

    it('returns them as `invalid` so the reconcile can protect the key', async () => {
      // The trap: a key that merely disappears from desired reads to
      // diffContacts as a delete against a live directory entry.
      const res = await buildDesiredContacts(stubDb([row({ id: 'bad', phone: '+87654567890' })]))
      expect(res.invalid).toEqual(new Set(['+87654567890']))
    })

    it('keys `invalid` by the number that WOULD have been published', async () => {
      // Not the raw CRM string — the reconcile matches against what Zoom
      // holds, which is normaliseForZoom's output.
      const res = await buildDesiredContacts(stubDb([row({ id: 'bad', phone: '00 44 (0) 7502 871075' })]))
      expect(res.invalid).toEqual(new Set(['+4407502871075']))
    })

    it('leaves the ordinary Irish and British numbers alone', async () => {
      const res = await buildDesiredContacts(stubDb([
        row({ id: 'a', phone: '+353871111111' }),
        row({ id: 'b', phone: '087 111 2222' }),
        row({ id: 'c', phone: '07700900123' }),
        row({ id: 'd', phone: '+3531000450010' }),
      ]))
      expect(res.desired.size).toBe(4)
      expect(res.stats.invalidE164).toBe(0)
      expect(res.invalid.size).toBe(0)
    })
  })

  it('skips a row with no usable name rather than pushing a blank', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', first_name: '  ', last_name: null, phone: '+353871111111' }),
    ]))
    expect(res.desired.size).toBe(0)
    expect(res.stats.noName).toBe(1)
  })

  it('trims a single-name contact cleanly', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', first_name: 'Cher', last_name: null, phone: '+353871111111' }),
    ]))
    expect(res.desired.get('+353871111111').name).toBe('Cher')
  })

  it('pages past the 1000-row select cap', async () => {
    const many = Array.from({ length: 2300 }, (_, i) =>
      row({ id: `c${i}`, phone: `+35387${String(i).padStart(7, '0')}` }))
    const res = await buildDesiredContacts(stubDb(many))
    expect(res.desired.size).toBe(2300)
  })

  // The exact-multiple-of-PAGE_SIZE boundary: a naive off-by-one in the
  // paging loop (e.g. breaking on page.length <= PAGE_SIZE, or never issuing
  // the trailing empty-page request) either drops the last page or spins.
  // 2000 = 2 * PAGE_SIZE exactly.
  it('terminates cleanly when the row count is an exact multiple of the page size', async () => {
    const exact = Array.from({ length: 2000 }, (_, i) =>
      row({ id: `c${i}`, phone: `+35387${String(i).padStart(7, '0')}` }))
    const res = await buildDesiredContacts(stubDb(exact))
    expect(res.desired.size).toBe(2000)
    expect(res.stats.scanned).toBe(2000)
  })
})

describe('buildDesiredContacts — collect mode', () => {
  it('returns nothing extra when collectRejects is off', async () => {
    const res = await buildDesiredContacts(stubDb([row({ id: 'a', phone: '12345' })]))
    expect(res.rejects).toBeUndefined()
    expect(res.stats.rejected).toBe(1)
  })

  it('collects each rejection with a reason code', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'ok', phone: '+353871111111' }),
      row({ id: 'nophone', phone: null }),
      row({ id: 'junk', phone: 'boothjody@gmail.com' }),
      row({ id: 'noname', first_name: '  ', last_name: null, phone: '+353872222222' }),
    ]), { collectRejects: true })

    const byId = Object.fromEntries(res.rejects.map((r) => [r.id, r]))
    expect(byId.nophone.reason).toBe('no_phone')
    expect(byId.junk.reason).toBe('unparseable')
    expect(byId.noname.reason).toBe('no_name')
    expect(byId.ok).toBeUndefined()
  })

  it('gives an unusable number its own reason and a specific detail', async () => {
    // The operator has to FIX these in the CRM, so "invalid" alone is not
    // actionable — which rule it broke is the correction.
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'cc', phone: '+87654567890' }),
      row({ id: 'len', phone: '+35382247706573' }),
      row({ id: 'svc', phone: '+800860588525' }),
    ]), { collectRejects: true })

    const byId = Object.fromEntries(res.rejects.map((r) => [r.id, r]))
    expect(byId.cc).toMatchObject({ reason: 'invalid_e164', detail: 'unassigned_country_code' })
    expect(byId.len).toMatchObject({ reason: 'invalid_e164', detail: 'national_length' })
    expect(byId.svc).toMatchObject({ reason: 'invalid_e164', detail: 'service_number' })
  })

  it('carries the name and raw value so the report is readable', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'j', first_name: 'Aoife', last_name: 'Ryan', phone: '085143”754' }),
    ]), { collectRejects: true })
    expect(res.rejects[0]).toMatchObject({ id: 'j', name: 'Aoife Ryan', phone: '085143”754', reason: 'unparseable' })
  })

  // The test that keeps the report honest. If these ever disagree, the report
  // is lying about the sync's own behaviour.
  it('collect mode produces exactly the counts that counting mode reports', async () => {
    const rows = [
      row({ id: 'a', phone: '+353871111111' }),
      row({ id: 'b', phone: null }),
      row({ id: 'c', phone: '12345' }),
      row({ id: 'd', phone: '6978291516' }),
      row({ id: 'e', first_name: '', last_name: '', phone: '+353873333333' }),
      row({ id: 'f', phone: '+353874444444', lead_source: 'classpass' }),
    ]
    const counted = await buildDesiredContacts(stubDb(rows))
    const collected = await buildDesiredContacts(stubDb(rows), { collectRejects: true })

    expect(collected.stats).toEqual(counted.stats)
    expect(collected.rejects.filter((r) => r.reason === 'no_phone').length
      + collected.rejects.filter((r) => r.reason === 'unparseable').length)
      .toBe(counted.stats.rejected)
    expect(collected.rejects.filter((r) => r.reason === 'no_name').length)
      .toBe(counted.stats.noName)
  })
})
