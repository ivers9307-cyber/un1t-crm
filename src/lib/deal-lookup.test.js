// PIPELINES.5 — a contact with two open deals must not 500 the public
// waitlist form. `.maybeSingle()` errors on a second row, and that route is
// the live website lead capture.

import { describe, it, expect } from 'vitest'
import { findOpenDealForPipeline, findOpenDealAtLocation } from './deal-lookup.js'

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


// PIPE3.7 — the contact's newest open deal on ANY board at the studio: a deal
// follows the person across boards, so the webhook path must find it wherever it sits.
describe('findOpenDealAtLocation', () => {
  it('returns the newest open deal at the location with its board', async () => {
    const db = fakeDb([{ id: 'd-2', stage_id: 's-2', pipeline_id: 'p-paid' }])
    expect(await findOpenDealAtLocation(db, 'c-1', 'loc-1')).toEqual({ id: 'd-2', stage_id: 's-2', pipeline_id: 'p-paid' })
  })
  it('filters on contact, location and status open, newest first, one row', async () => {
    const calls = []
    const q = {
      select: (c) => { calls.push(['select', c]); return q },
      eq: (c, v) => { calls.push(['eq', c, v]); return q },
      order: (c, o) => { calls.push(['order', c, o]); return q },
      limit: (n) => { calls.push(['limit', n]); return Promise.resolve({ data: [], error: null }) },
    }
    await findOpenDealAtLocation({ from: (t) => { calls.push(['from', t]); return q } }, 'c-1', 'loc-1')
    expect(calls).toEqual([
      ['from', 'deals'], ['select', 'id, stage_id, pipeline_id'],
      ['eq', 'contact_id', 'c-1'], ['eq', 'location_id', 'loc-1'], ['eq', 'status', 'open'],
      ['order', 'created_at', { ascending: false }], ['limit', 1],
    ])
  })
  it('returns null on no row, on a query error and on a missing argument', async () => {
    expect(await findOpenDealAtLocation(fakeDb([]), 'c-1', 'loc-1')).toBeNull()
    const db = { from: () => { const q = { select: () => q, eq: () => q, order: () => q, limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }; return q } }
    expect(await findOpenDealAtLocation(db, 'c-1', 'loc-1')).toBeNull()
    expect(await findOpenDealAtLocation(fakeDb([{ id: 'd' }]), null, 'loc-1')).toBeNull()
  })
})
