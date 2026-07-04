// RCOV.P0 — coverage ledger sync test coverage.
//
// The sync makes up to FOUR separate PostgREST calls — never mix row
// shapes in one bulk call (PostgREST rejects heterogeneous keys with
// PGRST102: All object keys must match):
//   1. paginated select of existing non-terminal lines in the window;
//   2. insert-only upsert of NEW keys (ignoreDuplicates:true — a
//      terminal covered/ignored row with the same key is never
//      resurrected);
//   3. last_seen_at refresh for keys seen again this pull;
//   4. covered update for tracked keys that vanished from the
//      unreconciled set.
// Lock those four call shapes here — a regression (e.g. mixing insert
// rows with update rows, or forgetting ignoreDuplicates) is a silent
// PGRST102 or a resurrected terminal row in prod. Also locked: the
// window filters on the existing-select (a dropped filter is the
// mass-cover mechanism), .range() pagination past the 1000-row cap,
// and .in()/bulk-payload chunking at 300 (house cap, cf.
// fetchContactsByIds in src/lib/churn-radar-data.js).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDb = { from: vi.fn() }
vi.mock('@/lib/supabase', () => ({ createServerClient: () => mockDb }))

let coverage

// Chain whose FINAL method resolves; intermediate steps return this.
function chainable(finalValue, terminal) {
  const chain = {}
  for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'update', 'upsert', 'range']) {
    chain[m] = vi.fn().mockReturnThis()
  }
  chain[terminal] = vi.fn().mockResolvedValue(finalValue)
  return chain
}

beforeEach(async () => {
  vi.resetModules()
  mockDb.from.mockReset()
  coverage = await import('./coverage')
})

describe('syncBankLines', () => {
  it('inserts new keys, refreshes seen keys, covers vanished keys', async () => {
    // existing rows in window: key-a (still unreconciled) + key-gone (reconciled since last week)
    const existing = chainable({
      data: [
        { id: 'row-a', xero_line_key: 'key-a', status: 'uncovered' },
        { id: 'row-gone', xero_line_key: 'key-gone', status: 'uncovered' },
      ],
      error: null,
    }, 'range')
    const inserted = chainable({ data: null, error: null }, 'upsert')
    const refreshed = chainable({ data: null, error: null }, 'in')
    const covered = chainable({ data: null, error: null }, 'in')
    mockDb.from
      .mockReturnValueOnce(existing)   // 1. select existing in window
      .mockReturnValueOnce(inserted)   // 2. insert-only upsert of new keys
      .mockReturnValueOnce(refreshed)  // 3. last_seen refresh for seen keys
      .mockReturnValueOnce(covered)    // 4. vanished → covered

    const stats = await coverage.syncBankLines(mockDb, {
      locationId: 'loc-1',
      bankAccountId: 'acct-1',
      bankAccountName: 'Current',
      windowFrom: '2026-04-01',
      windowTo: '2026-07-04',
      lines: [
        { key: 'key-a', date: '2026-06-03', amount: -84.5, description: 'MUSCLEFOOD LTD', reference: 'CARD 1234' },
        { key: 'key-new', date: '2026-07-01', amount: -12, description: 'COFFEE', reference: '' },
      ],
    })

    expect(stats).toEqual({ pulled: 2, new: 1, covered: 1 })
    // 2. only the NEW key is inserted, with status, insert-only semantics
    expect(inserted.upsert).toHaveBeenCalledTimes(1)
    const [insertRows, insertOpts] = inserted.upsert.mock.calls[0]
    expect(insertRows).toHaveLength(1)
    expect(insertRows[0]).toMatchObject({ xero_line_key: 'key-new', status: 'uncovered' })
    expect(insertOpts).toEqual({ onConflict: 'location_id,xero_line_key', ignoreDuplicates: true })
    // 3. seen key gets last_seen refresh, no status in the patch
    expect(refreshed.update).toHaveBeenCalledTimes(1)
    expect(refreshed.update.mock.calls[0][0]).not.toHaveProperty('status')
    expect(refreshed.in).toHaveBeenCalledWith('xero_line_key', ['key-a'])
    // 4. vanished key covered
    expect(covered.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'covered' }))
    expect(covered.in).toHaveBeenCalledWith('id', ['row-gone'])
  })

  it('excludes terminal statuses from the vanish check at query level', async () => {
    const existing = chainable({ data: [], error: null }, 'range')
    mockDb.from.mockReturnValueOnce(existing)

    const stats = await coverage.syncBankLines(mockDb, {
      locationId: 'loc-1', bankAccountId: 'acct-1', bankAccountName: 'Current',
      windowFrom: '2026-04-01', windowTo: '2026-07-04', lines: [],
    })
    expect(stats).toEqual({ pulled: 0, new: 0, covered: 0 })
    // covered/ignored must be excluded WHERE it matters — in the select itself
    expect(existing.in).toHaveBeenCalledWith('status',
      ['uncovered', 'submitted', 'not_found', 'needs_attention'])
    expect(mockDb.from).toHaveBeenCalledTimes(1) // nothing to insert/refresh/cover
  })

  it('passes the window to the existing-select date filters', async () => {
    // A dropped window filter widens the "tracked" set beyond the pull
    // window → step 4 mass-covers everything outside it. Lock the
    // filters to the exact passed bounds.
    const existing = chainable({ data: [], error: null }, 'range')
    mockDb.from.mockReturnValueOnce(existing)

    await coverage.syncBankLines(mockDb, {
      locationId: 'loc-1', bankAccountId: 'acct-1', bankAccountName: 'Current',
      windowFrom: '2026-04-01', windowTo: '2026-07-04', lines: [],
    })
    expect(existing.gte).toHaveBeenCalledWith('line_date', '2026-04-01')
    expect(existing.lte).toHaveBeenCalledWith('line_date', '2026-07-04')
  })

  it('paginates the existing-select past the 1000-row cap and accumulates all pages', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => (
      { id: `row-${i}`, xero_line_key: `key-${i}`, status: 'uncovered' }
    ))
    const page2 = [{ id: 'row-1000', xero_line_key: 'key-1000', status: 'uncovered' }]
    // Default resolution = the short second page; the Once below makes
    // the FIRST .range call return the full page, forcing a second loop.
    const existing = chainable({ data: page2, error: null }, 'range')
    existing.range.mockResolvedValueOnce({ data: page1, error: null })
    const refreshed = chainable({ data: null, error: null }, 'in')
    const covered = chainable({ data: null, error: null }, 'in')
    mockDb.from
      .mockReturnValueOnce(existing)  // select page 1
      .mockReturnValueOnce(existing)  // select page 2 (loop re-enters from())
      .mockReturnValueOnce(refreshed) // refresh chunk 1 (300 keys)
      .mockReturnValueOnce(refreshed) // refresh chunk 2 (201 keys)
      .mockReturnValue(covered)       // cover chunks reuse one chain

    // 501 of the 1001 tracked keys come back (<50% vanish — stays under
    // the covered-ratio circuit-breaker); the other 500 reconciled away.
    const lines = Array.from({ length: 501 }, (_, i) => (
      { key: `key-${i}`, date: '2026-06-01', amount: -1, description: 'X', reference: '' }
    ))
    const stats = await coverage.syncBankLines(mockDb, {
      locationId: 'loc-1', bankAccountId: 'acct-1', bankAccountName: 'Current',
      windowFrom: '2026-04-01', windowTo: '2026-07-04', lines,
    })

    expect(existing.range).toHaveBeenNthCalledWith(1, 0, 999)
    expect(existing.range).toHaveBeenNthCalledWith(2, 1000, 1999)
    // covered = 500 only if BOTH pages were accumulated: key-1000 lives
    // on page 2, and a dropped page shrinks the vanish set to 499.
    expect(stats).toEqual({ pulled: 501, new: 0, covered: 500 })
    const coveredIds = covered.in.mock.calls.flatMap(([, ids]) => ids)
    expect(coveredIds).toHaveLength(500)
  })

  it('chunks the last_seen refresh .in() at 300 keys', async () => {
    const rows = Array.from({ length: 301 }, (_, i) => (
      { id: `row-${i}`, xero_line_key: `key-${i}`, status: 'uncovered' }
    ))
    const existing = chainable({ data: rows, error: null }, 'range')
    const refreshed = chainable({ data: null, error: null }, 'in')
    mockDb.from
      .mockReturnValueOnce(existing)
      .mockReturnValue(refreshed) // every refresh chunk reuses this chain

    // All 301 pulled keys are already tracked → nothing new, nothing
    // vanished; 301 re-seen keys → two refresh chunks (300 + 1).
    const lines = rows.map((r) => (
      { key: r.xero_line_key, date: '2026-06-01', amount: -1, description: 'X', reference: '' }
    ))
    const stats = await coverage.syncBankLines(mockDb, {
      locationId: 'loc-1', bankAccountId: 'acct-1', bankAccountName: 'Current',
      windowFrom: '2026-04-01', windowTo: '2026-07-04', lines,
    })

    expect(stats).toEqual({ pulled: 301, new: 0, covered: 0 })
    expect(refreshed.in).toHaveBeenCalledTimes(2)
    expect(refreshed.in.mock.calls[0][1]).toHaveLength(300)
    expect(refreshed.in.mock.calls[1][1]).toEqual(['key-300'])
  })

  it('trips the covered-ratio circuit-breaker instead of mass-covering on a partial pull', async () => {
    // The orchestrator's zero-rows guard can't catch a PARTIAL parse
    // (header intact, some sections dropped): rows.length > 0, the
    // guard passes, and most tracked lines "vanish". Mass-cover is
    // never a normal weekly delta — the breaker must throw BEFORE the
    // one-way cover update. Steps 1–3 having already run is fine
    // (idempotent; the next good pull heals).
    const rows = Array.from({ length: 20 }, (_, i) => (
      { id: `row-${i}`, xero_line_key: `key-${i}`, status: 'uncovered' }
    ))
    const existing = chainable({ data: rows, error: null }, 'range')
    const refreshed = chainable({ data: null, error: null }, 'in')
    const covered = chainable({ data: null, error: null }, 'in')
    mockDb.from
      .mockReturnValueOnce(existing)  // 1. select existing in window
      .mockReturnValueOnce(refreshed) // 3. refresh for the 3 re-seen keys (no new keys → no insert call)
      .mockReturnValue(covered)       // 4. would be the cover update — must never run

    // Only 3 of the 20 tracked keys came back — 17 (>50%) would vanish.
    const lines = rows.slice(0, 3).map((r) => (
      { key: r.xero_line_key, date: '2026-06-01', amount: -1, description: 'X', reference: '' }
    ))
    const attempt = coverage.syncBankLines(mockDb, {
      locationId: 'loc-1', bankAccountId: 'acct-1', bankAccountName: 'Current',
      windowFrom: '2026-04-01', windowTo: '2026-07-04', lines,
    })
    await expect(attempt).rejects.toThrow(/cover-guard tripped/)
    // The machine contract the refresh route's 409 mapping branches on —
    // pinned on the error OBJECT, not the prose.
    await expect(attempt).rejects.toMatchObject({ code: 'recon_cover_guard' })

    expect(covered.update).not.toHaveBeenCalled()
  })

  it('bypasses the covered-ratio circuit-breaker when acceptMassCover is set (the force escape hatch)', async () => {
    // Same shape as the trip test above (20 tracked, only 3 re-seen —
    // 17 would vanish, well past the >50%-of-≥10 threshold), but this
    // time acceptMassCover:true is set — the documented escape hatch
    // for a legitimate bulk reconcile in Xero. The breaker must not
    // throw, and the cover chain (step 4) must actually run and cover
    // every vanished line.
    const rows = Array.from({ length: 20 }, (_, i) => (
      { id: `row-${i}`, xero_line_key: `key-${i}`, status: 'uncovered' }
    ))
    const existing = chainable({ data: rows, error: null }, 'range')
    const refreshed = chainable({ data: null, error: null }, 'in')
    const covered = chainable({ data: null, error: null }, 'in')
    mockDb.from
      .mockReturnValueOnce(existing)  // 1. select existing in window
      .mockReturnValueOnce(refreshed) // 3. refresh for the 3 re-seen keys (no new keys → no insert call)
      .mockReturnValue(covered)       // 4. the cover update — must actually run this time

    // Only 3 of the 20 tracked keys came back — 17 vanish and get covered.
    const lines = rows.slice(0, 3).map((r) => (
      { key: r.xero_line_key, date: '2026-06-01', amount: -1, description: 'X', reference: '' }
    ))
    const stats = await coverage.syncBankLines(mockDb, {
      locationId: 'loc-1', bankAccountId: 'acct-1', bankAccountName: 'Current',
      windowFrom: '2026-04-01', windowTo: '2026-07-04', lines,
      acceptMassCover: true,
    })

    expect(stats).toEqual({ pulled: 3, new: 0, covered: 17 })
    expect(covered.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'covered' }))
    expect(covered.in).toHaveBeenCalledWith('id', rows.slice(3).map((r) => r.id))
  })

  it('does not trip the breaker below the 10-line floor — small accounts cover normally', async () => {
    // 9 tracked lines all vanishing at once is plausible on a quiet
    // account (a batch reconciled in one sitting); the ≥10 floor keeps
    // the breaker from wedging small accounts.
    const rows = Array.from({ length: 9 }, (_, i) => (
      { id: `row-${i}`, xero_line_key: `key-${i}`, status: 'uncovered' }
    ))
    const existing = chainable({ data: rows, error: null }, 'range')
    const covered = chainable({ data: null, error: null }, 'in')
    mockDb.from
      .mockReturnValueOnce(existing)
      .mockReturnValue(covered) // empty pull → straight to the cover update

    const stats = await coverage.syncBankLines(mockDb, {
      locationId: 'loc-1', bankAccountId: 'acct-1', bankAccountName: 'Current',
      windowFrom: '2026-04-01', windowTo: '2026-07-04', lines: [],
    })

    expect(stats).toEqual({ pulled: 0, new: 0, covered: 9 })
    expect(covered.in).toHaveBeenCalledWith('id', rows.map((r) => r.id))
  })
})
