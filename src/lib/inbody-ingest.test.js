// Tests for src/lib/inbody-ingest.js (P1-10).
//
// Key behaviours:
//
//   1. Idempotency / dedup — re-ingesting the same scan (same phone + datetime)
//      MUST NOT create a duplicate row. The upsert MUST use the right conflict
//      target and NOT fall back to a plain insert.
//
//   2. Contact attribution — a scan correctly maps to the right contact when a
//      phone matches exactly one contact.
//
//   3. Ambiguous match — if multiple contacts share the same last-9 phone
//      digits, contactId is null (safe fallback).
//
//   4. No matching contact — contactId is null; the scan is still stored.
//
//   5. Bad input — missing phone or unparseable datetime → ok:false, no DB call.
//
// We mock only `createServerClient` (via the module alias @/lib/supabase) so
// the ingest + phone-normalisation logic runs as written.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/body-metrics', () => ({ applyWeightObservation: vi.fn().mockResolvedValue(true) }))

import { ingestScan, matchContactId } from './inbody-ingest.js'
import { applyWeightObservation } from '@/lib/body-metrics'

// ─── DB mock builder ──────────────────────────────────────────────────────────

/**
 * Build a minimal Supabase mock that:
 *  - returns `contacts` for the contacts lookup
 *  - captures upserts on inbody_scans
 *
 * `contacts` is a list of { id, phone, wa_phone } rows that will be returned
 * by the contacts query regardless of the filter (we test the normalisation
 * logic, not PostgREST filtering).
 */
// mig 871's generated column, in JS: last nine digits, NULL under nine.
function phone9Generated(phone) {
  const d = String(phone ?? '').replace(/[^0-9]/g, '')
  return d.length >= 9 ? d.slice(-9) : null
}

function makeDb({ contacts = [], upsertError = null, locationOrg = 'org-1', scans = [] } = {}) {
  const upserted = []
  const contactFilters = []

  return {
    from(table) {
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: (col, val) => {
              contactFilters.push([col, val])
              return {
                or: () => ({
                  limit: () => Promise.resolve({ data: contacts, error: null }),
                }),
              }
            },
          }),
        }
      }
      if (table === 'locations') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: locationOrg === undefined ? null : { organization_id: locationOrg }, error: null }) }),
          }),
        }
      }
      if (table === 'inbody_scans') {
        return {
          // scanExists: .select('id').eq(...).eq(...).eq(...).limit(1)
          select: () => {
            const filters = []
            const q = {
              eq: (col, val) => { filters.push([col, val]); return q },
              limit: () => Promise.resolve({
                data: scans.filter((r) => filters.every(([c, v]) => r[c] === v)).map((r) => ({ id: r.id })),
                error: null,
              }),
            }
            return q
          },
          upsert(row, opts) {
            upserted.push({ row, opts })
            if (upsertError) return Promise.resolve({ error: upsertError })
            // Model the conflict target the way Postgres does: a matching row
            // is updated in place, anything else is a new row.
            const withKey = { ...row, matched_phone9: phone9Generated(row.matched_phone) }
            const keys = String(opts?.onConflict || 'id').split(',')
            const hit = scans.find((r) => keys.every((k) => r[k] != null && r[k] === withKey[k]))
            if (hit) Object.assign(hit, withKey)
            else scans.push({ id: `scan-${scans.length + 1}`, ...withKey })
            return Promise.resolve({ error: null })
          },
        }
      }
      return {}
    },
    _upserted: upserted,
    _scans: scans,
    _contactFilters: contactFilters,
  }
}

// A realistic raw InBody payload subset (the fields parseFullInBodyData maps).
const rawScan = {
  Weight: 82.4,
  PercentBodyFat: 18.2,
  SkeletalMuscleMass: 38.1,
  BMI: 25.1,
}

// ─── matchContactId ───────────────────────────────────────────────────────────

describe('matchContactId', () => {
  it('returns contactId when exactly one contact matches the last-9 digits', async () => {
    // Phone stored as '+353851234567', InBody sends '0851234567'.
    // normalisePhone9 of both → '851234567'.
    const db = makeDb({
      contacts: [{ id: 'c-42', phone: '+353851234567', wa_phone: null }],
    })
    const id = await matchContactId(db, '0851234567', 'org-1')
    expect(id).toBe('c-42')
  })

  it('returns null when no contacts match', async () => {
    const db = makeDb({ contacts: [] })
    const id = await matchContactId(db, '0851234567', 'org-1')
    expect(id).toBeNull()
  })

  it('returns null (not a guess) when two contacts share the same last-9 digits', async () => {
    // Two distinct contacts happen to share the same last 9 digits
    // (different country prefixes). We must not pick one at random.
    const db = makeDb({
      contacts: [
        { id: 'c-1', phone: '+353851234567', wa_phone: null },
        { id: 'c-2', phone: '+44851234567', wa_phone: null },
      ],
    })
    const id = await matchContactId(db, '0851234567', 'org-1')
    expect(id).toBeNull()
  })

  it('returns null for a blank/null phone', async () => {
    const db = makeDb({ contacts: [] })
    expect(await matchContactId(db, null)).toBeNull()
    expect(await matchContactId(db, '')).toBeNull()
  })

  it('matches via wa_phone when the primary phone does not carry the digit tail', async () => {
    const db = makeDb({
      contacts: [{ id: 'c-99', phone: null, wa_phone: '+353851234567' }],
    })
    const id = await matchContactId(db, '0851234567', 'org-1')
    expect(id).toBe('c-99')
  })
})

// ─── ingestScan ───────────────────────────────────────────────────────────────

describe('ingestScan — idempotency + attribution', () => {
  it('upserts on the natural key (location_id,matched_phone9,scanned_at)', async () => {
    const db = makeDb({
      contacts: [{ id: 'c-1', phone: '+353851234567', wa_phone: null }],
    })
    const result = await ingestScan(db, {
      telHp: '0851234567',
      testDatetime: '20260115120000',
      raw: rawScan,
      locationId: 'loc-1',
    })
    expect(result.ok).toBe(true)
    expect(db._upserted).toHaveLength(1)
    const { opts } = db._upserted[0]
    // INBODYDEDUPE.1: the conflict target MUST be mig 871's unique index. The
    // old (source,external_id) target keyed on the phone as spelled, so one
    // scan arriving as 0851234567 and +353851234567 made two rows.
    expect(opts.onConflict).toBe('location_id,matched_phone9,scanned_at')
    expect(opts.ignoreDuplicates).toBeFalsy()
  })

  it('assigns the right contactId when a phone matches', async () => {
    const db = makeDb({
      contacts: [{ id: 'c-1', phone: '+353851234567', wa_phone: null }],
    })
    const result = await ingestScan(db, {
      telHp: '0851234567',
      testDatetime: '20260115120000',
      raw: rawScan,
      locationId: 'loc-1',
    })
    expect(result.ok).toBe(true)
    expect(result.linked).toBe(true)
    expect(result.contactId).toBe('c-1')
    const { row } = db._upserted[0]
    expect(row.contact_id).toBe('c-1')
  })

  it('stores the scan with null contact_id when no phone match — no data loss', async () => {
    // A scan with no matching contact must still land in inbody_scans so
    // it can be linked later (manual or via a backfill). Dropping it
    // silently would lose body-composition data permanently.
    const db = makeDb({ contacts: [] })
    const result = await ingestScan(db, {
      telHp: '0851234567',
      testDatetime: '20260115130000',
      raw: rawScan,
      locationId: 'loc-1',
    })
    expect(result.ok).toBe(true)
    expect(result.linked).toBe(false)
    expect(result.contactId).toBeNull()
    expect(db._upserted).toHaveLength(1)
    expect(db._upserted[0].row.contact_id).toBeNull()
  })

  it('re-ingesting the same telHp+testDatetime produces the same external_id (idempotency key)', async () => {
    const db1 = makeDb({ contacts: [{ id: 'c-1', phone: '+353851234567', wa_phone: null }] })
    const db2 = makeDb({ contacts: [{ id: 'c-1', phone: '+353851234567', wa_phone: null }] })

    const args = { telHp: '0851234567', testDatetime: '20260115120000', raw: rawScan, locationId: 'loc-1' }
    const r1 = await ingestScan(db1, args)
    const r2 = await ingestScan(db2, args)

    // Both produce the same external_id so the DB upsert is a no-op on repeat.
    const extId1 = db1._upserted[0].row.external_id
    const extId2 = db2._upserted[0].row.external_id
    expect(extId1).toBe(extId2)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })

  it('rejects a scan with a missing phone (bad_input)', async () => {
    const db = makeDb({ contacts: [] })
    const result = await ingestScan(db, {
      telHp: null,
      testDatetime: '20260115120000',
      raw: rawScan,
      locationId: 'loc-1',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bad_input')
    // Must not have attempted a DB write
    expect(db._upserted).toHaveLength(0)
  })

  it('rejects a scan with an unparseable testDatetime (bad_input)', async () => {
    const db = makeDb({ contacts: [] })
    const result = await ingestScan(db, {
      telHp: '0851234567',
      testDatetime: 'not-a-date',
      raw: rawScan,
      locationId: 'loc-1',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bad_input')
    expect(db._upserted).toHaveLength(0)
  })

  it('surfaces ok:false with reason=upsert_failed when the DB rejects', async () => {
    const db = makeDb({
      contacts: [{ id: 'c-1', phone: '+353851234567', wa_phone: null }],
      upsertError: { message: 'unique_violation' },
    })
    const result = await ingestScan(db, {
      telHp: '0851234567',
      testDatetime: '20260115120000',
      raw: rawScan,
      locationId: 'loc-1',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('upsert_failed')
    expect(result.error).toMatch(/unique_violation/)
  })

  it('stores the parsed measurement fields alongside the raw payload', async () => {
    const db = makeDb({ contacts: [] })
    await ingestScan(db, {
      telHp: '0851234567',
      testDatetime: '20260115140000',
      raw: rawScan,
      locationId: 'loc-1',
    })
    const { row } = db._upserted[0]
    // parseFullInBodyData should have mapped 'Weight' → weight_kg etc.
    expect(typeof row.weight_kg).toBe('number')
    expect(row.weight_kg).toBeCloseTo(82.4)
    // The raw payload is also preserved for future re-mapping.
    expect(row.raw).toEqual(rawScan)
  })

  it('includes the source constant ("lookinbody") on every row', async () => {
    const db = makeDb({ contacts: [] })
    await ingestScan(db, {
      telHp: '0851234567',
      testDatetime: '20260115150000',
      raw: rawScan,
      locationId: 'loc-1',
    })
    expect(db._upserted[0].row.source).toBe('lookinbody')
  })
})

// ─── ingestScan — canonical weight feed ──────────────────────────────────────

describe('ingestScan — canonical weight feed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls applyWeightObservation with inbody source when a scan with weight matches a contact', async () => {
    const db = makeDb({
      contacts: [{ id: 'c-42', phone: '+353851234567', wa_phone: null }],
    })
    await ingestScan(db, {
      telHp: '0851234567',
      testDatetime: '20260115120000',
      raw: rawScan,
      locationId: 'loc-1',
    })
    expect(applyWeightObservation).toHaveBeenCalledOnce()
    const args = applyWeightObservation.mock.calls[0][1]
    expect(args.contactId).toBe('c-42')
    expect(args.weightKg).toBeCloseTo(82.4)
    expect(args.source).toBe('inbody')
    expect(typeof args.observedAt).toBe('string')
  })

  it('does NOT call applyWeightObservation when there is no matched contact', async () => {
    const db = makeDb({ contacts: [] })
    await ingestScan(db, {
      telHp: '0851234567',
      testDatetime: '20260115130000',
      raw: rawScan,
      locationId: 'loc-1',
    })
    expect(applyWeightObservation).not.toHaveBeenCalled()
  })
})

// INBODYSCOPE.1 — October audit A03: matching stays inside the organisation
// that owns the scanning studio.
describe('InBody matching is scoped to the scanning studio\'s organisation', () => {
  beforeEach(() => vi.clearAllMocks())
  it('filters contacts by the organisation', async () => {
    const db = makeDb({ contacts: [{ id: 'c1', phone: '+353851234567', wa_phone: null }] })
    expect(await matchContactId(db, '0851234567', 'org-1')).toBe('c1')
    expect(db._contactFilters).toContainEqual(['organization_id', 'org-1'])
  })

  it('no organisation means no match (and no contact read)', async () => {
    const db = makeDb({ contacts: [{ id: 'c1', phone: '+353851234567', wa_phone: null }] })
    expect(await matchContactId(db, '0851234567', null)).toBeNull()
    expect(db._contactFilters).toHaveLength(0)
  })

  it('a scan from a studio with no organisation is stored unlinked and writes no weight', async () => {
    const db = makeDb({ contacts: [{ id: 'c1', phone: '+353851234567', wa_phone: null }], locationOrg: null })
    const r = await ingestScan(db, { telHp: '0851234567', testDatetime: '20260115120000', raw: rawScan, locationId: 'loc-x' })
    expect(r).toMatchObject({ ok: true, linked: false, contactId: null })
    expect(db._upserted[0].row.contact_id).toBeNull()
    expect(applyWeightObservation).not.toHaveBeenCalled()
  })

  it('a scan with no studio at all has no key, so it is refused and nothing is written', async () => {
    // INBODYDEDUPE.1: location_id is NOT NULL and part of the scan's key; the
    // insert could never have landed, and now it is not attempted.
    const db = makeDb({ contacts: [{ id: 'c1', phone: '+353851234567', wa_phone: null }] })
    const r = await ingestScan(db, { telHp: '0851234567', testDatetime: '20260115120000', raw: rawScan, locationId: null })
    expect(r).toEqual({ ok: false, reason: 'bad_input' })
    expect(db._upserted).toHaveLength(0)
    expect(db._contactFilters).toHaveLength(0)
  })
})
