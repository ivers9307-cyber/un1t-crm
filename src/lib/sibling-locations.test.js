// ORGSCOPE.1 — the organisation boundary for "this person's shifts at other
// studios" reads.

import { describe, it, expect } from 'vitest'
import { siblingLocationIds } from './sibling-locations.js'
import { fakeDb, queriesOf, resolveLocations } from './time-off.test-helpers.js'

// Two organisations. loc-a1 + loc-a2 share org-a; loc-b1 is alone in org-b.
const ORGS = { 'loc-a1': 'org-a', 'loc-a2': 'org-a', 'loc-b1': 'org-b' }

// resolveLocations honours the filters the helper sends, so a dropped filter
// shows up as a wrong answer rather than passing on a canned one.
function locationsDb({ orgErr = null, siblingsErr = null } = {}) {
  return fakeDb((q) => {
    if (q.table !== 'locations') throw new Error(`unexpected table ${q.table}`)
    const single = q.terminal === 'single' || q.terminal === 'maybeSingle'
    if (single && orgErr) return { data: null, error: orgErr }
    if (!single && siblingsErr) return { data: null, error: siblingsErr }
    return resolveLocations(q, ORGS)
  })
}

describe('siblingLocationIds', () => {
  it('returns the other studios of the same organisation, never another organisation\'s', async () => {
    const { ids, error } = await siblingLocationIds(locationsDb(), 'loc-a1')
    expect(error).toBeNull()
    expect(ids).toEqual(['loc-a2'])
  })

  it('a studio alone in its organisation has no siblings', async () => {
    const { ids, error } = await siblingLocationIds(locationsDb(), 'loc-b1')
    expect(error).toBeNull()
    expect(ids).toEqual([])
  })

  it('asks for the organisation by id and excludes the studio itself', async () => {
    const db = locationsDb()
    await siblingLocationIds(db, 'loc-a1')
    const [orgRead, siblingRead] = queriesOf(db, 'locations')
    expect(orgRead.eq).toEqual({ id: 'loc-a1' })
    expect(siblingRead.eq).toEqual({ organization_id: 'org-a' })
    expect(siblingRead.calls).toContainEqual(['neq', 'id', 'loc-a1'])
  })

  it('an unreadable studio is an error with no ids, and the sibling read is never sent', async () => {
    const db = locationsDb({ orgErr: { message: 'down' } })
    const { ids, error } = await siblingLocationIds(db, 'loc-a1')
    expect(ids).toEqual([])
    expect(error.message).toBe('down')
    expect(queriesOf(db, 'locations')).toHaveLength(1)
  })

  it('a studio that does not exist is an error, not "no siblings"', async () => {
    const { ids, error } = await siblingLocationIds(locationsDb(), 'loc-nope')
    expect(ids).toEqual([])
    expect(error).toBeTruthy()
  })

  it('an unreadable sibling list is an error with no ids', async () => {
    const { ids, error } = await siblingLocationIds(locationsDb({ siblingsErr: { message: 'boom' } }), 'loc-a1')
    expect(ids).toEqual([])
    expect(error.message).toBe('boom')
  })

  it('a client that throws is returned as an error, never thrown', async () => {
    const db = { from() { throw new Error('client exploded') } }
    const { ids, error } = await siblingLocationIds(db, 'loc-a1')
    expect(ids).toEqual([])
    expect(error.message).toBe('client exploded')
  })

  it('no location id is an error without a query', async () => {
    const db = locationsDb()
    const { ids, error } = await siblingLocationIds(db, null)
    expect(ids).toEqual([])
    expect(error).toBeTruthy()
    expect(db.queries).toHaveLength(0)
  })
})
