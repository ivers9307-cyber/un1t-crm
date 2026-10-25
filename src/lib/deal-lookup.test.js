// PIPELINES.5 — a contact with two open deals must not 500 the public
// waitlist form. `.maybeSingle()` errors on a second row, and that route is
// the live website lead capture.

import { describe, it, expect } from 'vitest'
import { findOpenDealForPipeline } from './deal-lookup.js'

const fakeDb = (rows) => ({
  from: () => {
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => Promise.resolve({ data: rows, error: null }),
    }
    return q
  },
})

describe('findOpenDealForPipeline', () => {
  it('returns the deal on the requested pipeline', async () => {
    const db = fakeDb([{ id: 'd-2', stage_id: 's-2', pipeline_id: 'p-2' }])
    expect(await findOpenDealForPipeline(db, 'c-1', 'p-2')).toEqual({
      id: 'd-2', stage_id: 's-2', pipeline_id: 'p-2',
    })
  })

  it('returns null when the contact has no deal on that pipeline', async () => {
    expect(await findOpenDealForPipeline(fakeDb([]), 'c-1', 'p-9')).toBeNull()
  })

  it('does not throw when the contact has several open deals', async () => {
    const db = fakeDb([{ id: 'd-1', pipeline_id: 'p-1' }])
    await expect(findOpenDealForPipeline(db, 'c-1', 'p-1')).resolves.toBeTruthy()
  })

  it('returns null on a query error rather than throwing', async () => {
    const db = { from: () => { const q = { select: () => q, eq: () => q, order: () => q, limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }; return q } }
    expect(await findOpenDealForPipeline(db, 'c-1', 'p-1')).toBeNull()
  })

  it('returns null when any argument is missing', async () => {
    expect(await findOpenDealForPipeline(null, 'c-1', 'p-1')).toBeNull()
    expect(await findOpenDealForPipeline(fakeDb([]), null, 'p-1')).toBeNull()
    expect(await findOpenDealForPipeline(fakeDb([]), 'c-1', null)).toBeNull()
  })
})
