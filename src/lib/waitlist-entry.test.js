// WAITLIST.4 — the shared waitlist-entry placement, and the re-signup bump.
//
// Two live public forms (the website lead capture and /start's class booking)
// had grown an identical 20-line block for this. The interesting half is the
// bump: on a MANUAL board a second submission moves the existing deal back to
// the entry column, and on a DERIVED board it must still do nothing at all,
// because the classifier owns placement there and would revert it on the next
// pass. Stillorgan runs a derived board, so the derived cases below are what
// pin "nothing changes for Stillorgan".

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { placeWaitlistEntry } from './waitlist-entry.js'

// Fake db in the deal-lookup.test.js style: every read chain ends in .limit(),
// which resolves the rows for the table the chain started from. Writes are
// recorded rather than resolved against state — what matters here is WHICH
// write happened, and with what.
function fakeDb({ pipelines = [], deals = [], stages = [], errors = {} } = {}) {
  const rows = { pipelines, deals, pipeline_stages: stages }
  const calls = { inserted: [], updated: [] }
  return {
    calls,
    from(table) {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => Promise.resolve({ data: rows[table] || [], error: errors[table] || null }),
        insert: (row) => {
          calls.inserted.push({ table, row })
          return Promise.resolve({ data: null, error: errors.insert || null })
        },
        update: (patch) => ({
          eq: (col, val) => {
            calls.updated.push({ table, patch, col, val })
            return Promise.resolve({ data: null, error: errors.update || null })
          },
        }),
      }
      return q
    },
  }
}

const ENTRY = { id: 'stage-entry', slug: 'waitlist_new_enquiry' }
const ARGS = { contactId: 'c-1', locationId: 'loc-1', title: 'Ada' }

describe('placeWaitlistEntry — no open deal on the board', () => {
  it('creates the deal in the entry column on a manual board', async () => {
    const db = fakeDb({
      pipelines: [{ id: 'p-manual', mode: 'manual' }],
      deals: [],
      stages: [ENTRY],
    })
    await placeWaitlistEntry(db, ARGS)
    expect(db.calls.updated).toHaveLength(0)
    expect(db.calls.inserted).toHaveLength(1)
    expect(db.calls.inserted[0].row).toEqual({
      title: 'Ada',
      contact_id: 'c-1',
      stage_id: 'stage-entry',
      location_id: 'loc-1',
      pipeline_id: 'p-manual',
      status: 'open',
    })
  })

  it('creates the deal in the entry column on a derived board too', async () => {
    const db = fakeDb({
      pipelines: [{ id: 'p-derived', mode: 'derived' }],
      deals: [],
      stages: [ENTRY],
    })
    await placeWaitlistEntry(db, ARGS)
    expect(db.calls.updated).toHaveLength(0)
    expect(db.calls.inserted).toHaveLength(1)
    // pipeline_id is the line PIPELINES.5 added: without it the nightly
    // orchestrator's `.in('pipeline_id', …)` never matches the row and opens
    // a second deal for this contact every night.
    expect(db.calls.inserted[0].row.pipeline_id).toBe('p-derived')
    expect(db.calls.inserted[0].row.stage_id).toBe('stage-entry')
  })

  it('writes nothing when the board has no live entry column', async () => {
    const db = fakeDb({ pipelines: [{ id: 'p-manual', mode: 'manual' }], deals: [], stages: [] })
    await placeWaitlistEntry(db, ARGS)
    expect(db.calls.inserted).toHaveLength(0)
    expect(db.calls.updated).toHaveLength(0)
  })
})

describe('placeWaitlistEntry — the re-signup bump', () => {
  it('bumps an existing deal back to the entry column on a manual board', async () => {
    const db = fakeDb({
      pipelines: [{ id: 'p-manual', mode: 'manual' }],
      deals: [{ id: 'd-1', stage_id: 'stage-not-interested', pipeline_id: 'p-manual' }],
      stages: [ENTRY],
    })
    await placeWaitlistEntry(db, ARGS)
    expect(db.calls.inserted).toHaveLength(0)
    expect(db.calls.updated).toEqual([{
      table: 'deals',
      patch: { stage_id: 'stage-entry' },
      col: 'id',
      val: 'd-1',
    }])
  })

  it('leaves an existing deal alone on a derived board', async () => {
    const db = fakeDb({
      pipelines: [{ id: 'p-derived', mode: 'derived' }],
      deals: [{ id: 'd-1', stage_id: 'stage-cold', pipeline_id: 'p-derived' }],
      stages: [ENTRY],
    })
    await placeWaitlistEntry(db, ARGS)
    expect(db.calls.inserted).toHaveLength(0)
    expect(db.calls.updated).toHaveLength(0)
  })

  it('does not write when the deal already sits in the entry column', async () => {
    const db = fakeDb({
      pipelines: [{ id: 'p-manual', mode: 'manual' }],
      deals: [{ id: 'd-1', stage_id: 'stage-entry', pipeline_id: 'p-manual' }],
      stages: [ENTRY],
    })
    await placeWaitlistEntry(db, ARGS)
    expect(db.calls.inserted).toHaveLength(0)
    expect(db.calls.updated).toHaveLength(0)
  })

  it('does not read the entry column at all on a derived board with a deal', async () => {
    // Cheap proof the derived path exits before the stage lookup: a board
    // whose stage read would throw still completes.
    const db = fakeDb({
      pipelines: [{ id: 'p-derived', mode: 'derived' }],
      deals: [{ id: 'd-1', stage_id: 'stage-cold', pipeline_id: 'p-derived' }],
    })
    const guarded = {
      calls: db.calls,
      from: (table) => {
        if (table === 'pipeline_stages') throw new Error('entry column must not be read here')
        return db.from(table)
      },
    }
    await placeWaitlistEntry(guarded, ARGS)
    expect(db.calls.updated).toHaveLength(0)
  })
})

describe('placeWaitlistEntry — nothing to place onto', () => {
  it('does nothing when the location has no enabled primary board', async () => {
    const db = fakeDb({ pipelines: [], deals: [], stages: [ENTRY] })
    await placeWaitlistEntry(db, ARGS)
    expect(db.calls.inserted).toHaveLength(0)
    expect(db.calls.updated).toHaveLength(0)
  })

  it('does nothing without a contact or a location', async () => {
    const db = fakeDb({ pipelines: [{ id: 'p-manual', mode: 'manual' }], stages: [ENTRY] })
    await placeWaitlistEntry(db, { contactId: null, locationId: 'loc-1', title: 'Ada' })
    await placeWaitlistEntry(db, { contactId: 'c-1', locationId: null, title: 'Ada' })
    expect(db.calls.inserted).toHaveLength(0)
    expect(db.calls.updated).toHaveLength(0)
  })
})

describe('placeWaitlistEntry — best-effort', () => {
  it('swallows a failed insert rather than costing the lead capture', async () => {
    const db = fakeDb({
      pipelines: [{ id: 'p-manual', mode: 'manual' }],
      deals: [],
      stages: [ENTRY],
      errors: { insert: { message: 'boom' } },
    })
    await expect(placeWaitlistEntry(db, ARGS)).resolves.toBeUndefined()
  })

  it('swallows a failed bump', async () => {
    const db = fakeDb({
      pipelines: [{ id: 'p-manual', mode: 'manual' }],
      deals: [{ id: 'd-1', stage_id: 'stage-cold', pipeline_id: 'p-manual' }],
      stages: [ENTRY],
      errors: { update: { message: 'boom' } },
    })
    await expect(placeWaitlistEntry(db, ARGS)).resolves.toBeUndefined()
  })

  it('swallows a db that throws outright', async () => {
    const db = { from: () => { throw new Error('down') } }
    await expect(placeWaitlistEntry(db, ARGS)).resolves.toBeUndefined()
  })
})
