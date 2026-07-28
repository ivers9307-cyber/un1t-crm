// Activity event-writer tests. The helpers are best-effort and
// fire-and-forget, so the contract worth testing is mostly:
//   - we insert a row when something changed
//   - we don't insert a row when nothing changed (no-op guard)
//   - we render the subject sensibly
//   - we don't throw on Supabase errors (best-effort promise)

import { describe, it, expect, vi } from 'vitest'
import { logPipelineEvent, logPipelineDismissal } from './activity-events'

function mockDb({ insertResolves = { error: null }, insertThrows = false } = {}) {
  const insertSpy = vi.fn(() => {
    if (insertThrows) return Promise.reject(new Error('boom'))
    return Promise.resolve(insertResolves)
  })
  const fromSpy = vi.fn(() => ({ insert: insertSpy }))
  return { db: { from: fromSpy }, fromSpy, insertSpy }
}

describe('logPipelineEvent', () => {
  it('inserts a kind=event activity on stage change', async () => {
    const { db, fromSpy, insertSpy } = mockDb()
    await logPipelineEvent(db, {
      contactId: 'c1',
      locationId: 'loc1',
      oldStatus: 'active_trial',
      newStatus: 'member',
    })
    expect(fromSpy).toHaveBeenCalledWith('activities')
    expect(insertSpy).toHaveBeenCalledTimes(1)
    const inserted = insertSpy.mock.calls[0][0]
    expect(inserted).toMatchObject({
      contact_id: 'c1',
      location_id: 'loc1',
      kind: 'event',
      type: 'pipeline',
    })
    expect(inserted.subject).toContain('Active Trial')
    expect(inserted.subject).toContain('Member')
    expect(inserted.subject).toContain('→')
  })

  it('no-ops when oldStatus equals newStatus', async () => {
    const { db, insertSpy } = mockDb()
    await logPipelineEvent(db, {
      contactId: 'c1', locationId: 'loc1',
      oldStatus: 'member', newStatus: 'member',
    })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('no-ops when contactId is missing', async () => {
    const { db, insertSpy } = mockDb()
    await logPipelineEvent(db, {
      contactId: null, locationId: 'loc1',
      oldStatus: 'active_trial', newStatus: 'member',
    })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('no-ops when locationId is missing (can\'t scope without it)', async () => {
    const { db, insertSpy } = mockDb()
    await logPipelineEvent(db, {
      contactId: 'c1', locationId: null,
      oldStatus: 'active_trial', newStatus: 'member',
    })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('title-cases unmapped slugs (FUNNEL.1 — historical/retired stages)', async () => {
    const { db, insertSpy } = mockDb()
    await logPipelineEvent(db, {
      contactId: 'c1', locationId: 'loc1',
      oldStatus: 'active_trial', newStatus: 'member',
    })
    const inserted = insertSpy.mock.calls[0][0]
    expect(inserted.subject).toContain('Active Trial')
    expect(inserted.subject).toContain('Member')
  })

  it('swallows insert errors (best-effort, never throws)', async () => {
    const { db } = mockDb({ insertThrows: true })
    // Should not throw — caller doesn't await its own catch.
    await expect(
      logPipelineEvent(db, {
        contactId: 'c1', locationId: 'loc1',
        oldStatus: 'active_trial', newStatus: 'member',
      })
    ).resolves.toBeUndefined()
  })
})

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
