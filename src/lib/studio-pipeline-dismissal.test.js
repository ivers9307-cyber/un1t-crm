// HATCHCOLD.2 — Cold at a studio that is not the contact's home studio.
// Facts pinned:
//   1. the home studio reads contacts.pipeline_dismissed_at, never the table;
//   2. another studio reads only its own contact_pipeline_dismissals row;
//   3. Cold upserts the (contact, studio) row; Return to pipeline deletes it;
//   4. a failed read is returned as an error, never as "not Cold".
import { describe, it, expect, vi } from 'vitest'
import {
  dismissalAtStudio, writeStudioDismissal, readStudioDismissal, resolveStudioDismissal,
} from './studio-pipeline-dismissal.js'

const HOME = 'loc-stillorgan'
const HATCH = 'loc-hatch'
const contact = { id: 'c1', location_id: HOME, pipeline_dismissed_at: '2026-10-01T00:00:00Z' }

// Records calls; resolves to `answer` wherever the chain is awaited.
function fakeDb(answer = { data: null, error: null }) {
  const calls = []
  const proxy = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(answer).then(res, rej)
      return (...args) => { calls.push([prop, args]); return proxy }
    },
  })
  return { db: { from: (t) => { calls.push(['from', [t]]); return proxy } }, calls }
}

describe('dismissalAtStudio', () => {
  it('home studio → the contacts column', () => {
    expect(dismissalAtStudio(contact, HOME, '2026-10-26T00:00:00Z')).toBe('2026-10-01T00:00:00Z')
  })
  it('another studio → that studio\'s row, never the home column', () => {
    expect(dismissalAtStudio(contact, HATCH, '2026-10-26T00:00:00Z')).toBe('2026-10-26T00:00:00Z')
    expect(dismissalAtStudio(contact, HATCH, null)).toBeNull()
  })
  it('no contact → null', () => {
    expect(dismissalAtStudio(null, HATCH, 'x')).toBeNull()
  })
})

describe('writeStudioDismissal', () => {
  it('Cold upserts the (contact, studio) row', async () => {
    const { db, calls } = fakeDb()
    expect(await writeStudioDismissal(db, { contactId: 'c1', locationId: HATCH, dismissedAt: 'T', userId: 'u1' })).toEqual({ error: null })
    expect(calls).toContainEqual(['from', ['contact_pipeline_dismissals']])
    expect(calls).toContainEqual(['upsert', [
      { contact_id: 'c1', location_id: HATCH, dismissed_at: 'T', dismissed_by: 'u1' },
      { onConflict: 'contact_id,location_id' },
    ]])
  })
  it('Return to pipeline deletes that row only', async () => {
    const { db, calls } = fakeDb()
    await writeStudioDismissal(db, { contactId: 'c1', locationId: HATCH, dismissedAt: null })
    expect(calls.map((c) => c[0])).toEqual(['from', 'delete', 'eq', 'eq'])
    expect(calls).toContainEqual(['eq', ['contact_id', 'c1']])
    expect(calls).toContainEqual(['eq', ['location_id', HATCH]])
  })
  it('a failed write comes back as error', async () => {
    const { db } = fakeDb({ data: null, error: { message: 'boom' } })
    expect(await writeStudioDismissal(db, { contactId: 'c1', locationId: HATCH, dismissedAt: 'T' })).toEqual({ error: { message: 'boom' } })
  })
})

describe('readStudioDismissal / resolveStudioDismissal', () => {
  it('reads the row at that studio', async () => {
    const { db, calls } = fakeDb({ data: { dismissed_at: 'T' }, error: null })
    expect(await readStudioDismissal(db, 'c1', HATCH)).toEqual({ dismissedAt: 'T', error: null })
    expect(calls).toContainEqual(['eq', ['location_id', HATCH]])
  })
  it('a failed read is an error, never "not Cold"', async () => {
    const { db } = fakeDb({ data: null, error: { message: 'down' } })
    expect(await readStudioDismissal(db, 'c1', HATCH)).toEqual({ dismissedAt: null, error: { message: 'down' } })
  })
  it('home studio resolves from the contact with no read', async () => {
    const { db, calls } = fakeDb()
    expect(await resolveStudioDismissal(db, contact, HOME)).toEqual({ dismissedAt: '2026-10-01T00:00:00Z', error: null })
    expect(calls).toEqual([])
  })
  it('another studio resolves from its own row', async () => {
    const { db } = fakeDb({ data: null, error: null })
    expect(await resolveStudioDismissal(db, contact, HATCH)).toEqual({ dismissedAt: null, error: null })
  })
})
