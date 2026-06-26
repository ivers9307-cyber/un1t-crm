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

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { ingestScan, matchContactId } from './inbody-ingest.js'

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
function makeDb({ contacts = [], upsertError = null } = {}) {
  const upserted = []

  return {
    from(table) {
      if (table === 'contacts') {
        return {
          select: () => ({
            or: () => ({
              limit: () => Promise.resolve({ data: contacts, error: null }),
            }),
          }),
        }
      }
      if (table === 'inbody_scans') {
        return {
          upsert(row, opts) {
            upserted.push({ row, opts })
            return Promise.resolve({ error: upsertError })
          },
        }
      }
      return {}
    },
    _upserted: upserted,
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
    const id = await matchContactId(db, '0851234567')
    expect(id).toBe('c-42')
  })

  it('returns null when no contacts match', async () => {
    const db = makeDb({ contacts: [] })
    const id = await matchContactId(db, '0851234567')
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
    const id = await matchContactId(db, '0851234567')
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
    const id = await matchContactId(db, '0851234567')
    expect(id).toBe('c-99')
  })
})

// ─── ingestScan ───────────────────────────────────────────────────────────────

describe('ingestScan — idempotency + attribution', () => {
  it('upserts with the correct conflict target (source,external_id)', async () => {
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
    // The conflict target MUST be 'source,external_id' — anything else
    // (e.g. just 'external_id') silently allows cross-source dupes.
    expect(opts.onConflict).toBe('source,external_id')
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
