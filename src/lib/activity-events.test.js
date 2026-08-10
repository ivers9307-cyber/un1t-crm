// Activity event-writer tests. The helpers are best-effort and
// fire-and-forget, so the contract worth testing is mostly:
//   - we insert a row when something changed
//   - we don't insert a row when nothing changed (no-op guard)
//   - we render the subject sensibly
//   - we don't throw on Supabase errors (best-effort promise)
//
// DEAD-DOCSTRING.1 — the logPipelineEvent block is gone with the function.
// It was the only caller in the repo, which is what made the function's
// "called from PUT /api/contacts/[id]" docstring a lie: the tests were
// keeping a dead writer looking alive.

import { describe, it, expect, vi } from 'vitest'
import { logPipelineDismissal } from './activity-events'

function mockDb({ insertResolves = { error: null }, insertThrows = false } = {}) {
  const insertSpy = vi.fn(() => {
    if (insertThrows) return Promise.reject(new Error('boom'))
    return Promise.resolve(insertResolves)
  })
  const fromSpy = vi.fn(() => ({ insert: insertSpy }))
  return { db: { from: fromSpy }, fromSpy, insertSpy }
}

describe('logPipelineDismissal', () => {
  it('inserts an attributed Cold-dismissal event (cold: true)', async () => {
    const { db, fromSpy, insertSpy } = mockDb()
    await logPipelineDismissal(db, {
      contactId: 'c1', locationId: 'loc1', cold: true, actorName: 'Sarah Coach',
    })
    expect(fromSpy).toHaveBeenCalledWith('activities')
    const inserted = insertSpy.mock.calls[0][0]
    expect(inserted).toMatchObject({
      contact_id: 'c1',
      location_id: 'loc1',
      kind: 'event',
      type: 'pipeline',
      done: true,
    })
    expect(inserted.subject).toBe('Moved to Cold by Sarah Coach')
  })

  it('inserts an attributed restore event (cold: false)', async () => {
    const { db, insertSpy } = mockDb()
    await logPipelineDismissal(db, {
      contactId: 'c1', locationId: 'loc1', cold: false, actorName: 'Sarah Coach',
    })
    expect(insertSpy.mock.calls[0][0].subject).toBe('Returned to pipeline by Sarah Coach')
  })

  it('falls back to "Unknown staff" when actorName is missing', async () => {
    const { db, insertSpy } = mockDb()
    await logPipelineDismissal(db, {
      contactId: 'c1', locationId: 'loc1', cold: true, actorName: null,
    })
    expect(insertSpy.mock.calls[0][0].subject).toBe('Moved to Cold by Unknown staff')
  })

  it('no-ops when contactId or locationId is missing', async () => {
    const { db, insertSpy } = mockDb()
    await logPipelineDismissal(db, { contactId: null, locationId: 'loc1', cold: true, actorName: 'X' })
    await logPipelineDismissal(db, { contactId: 'c1', locationId: null, cold: true, actorName: 'X' })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('swallows insert errors (best-effort, never throws)', async () => {
    const { db } = mockDb({ insertThrows: true })
    await expect(
      logPipelineDismissal(db, {
        contactId: 'c1', locationId: 'loc1', cold: true, actorName: 'X',
      })
    ).resolves.toBeUndefined()
  })
})
