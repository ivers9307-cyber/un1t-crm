// HOST-EMAILS.2 — copySubject: the shared subject transform for a duplicated
// or reminder draft. Lives here (not in a route module) because Next route
// files may only export HTTP handlers.

import { describe, it, expect } from 'vitest'
import { copySubject, HOST_CAMPAIGN_LIST_COLUMNS, assertAudienceEventOwned, reminderParentProblem } from './host-campaign-draft.js'

describe('copySubject', () => {
  it('prefixes with "Copy of " by default', () => {
    expect(copySubject('Race week')).toBe('Copy of Race week')
  })

  it('caps the result at 200 chars (the column limit)', () => {
    const long = copySubject('x'.repeat(300))
    expect(long.length).toBe(200)
  })

  it('accepts a custom prefix (the reminder draft uses "Reminder: ")', () => {
    expect(copySubject('Race week', 'Reminder: ')).toBe('Reminder: Race week')
  })

  it('treats a null/undefined subject as empty, never throwing', () => {
    expect(copySubject(null)).toBe('Copy of ')
    expect(copySubject(undefined)).toBe('Copy of ')
  })
})

describe('HOST_CAMPAIGN_LIST_COLUMNS', () => {
  it('carries audience_campaign_id (HOST-EMAILS.2)', () => {
    expect(HOST_CAMPAIGN_LIST_COLUMNS).toContain('audience_campaign_id')
  })
})

describe('assertAudienceEventOwned', () => {
  // Chainable fake matching .from().select().eq().eq().maybeSingle().
  function makeDb(result) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve(result),
    }
    return { from: () => chain }
  }

  it('returns null (no error) when the event is found and owned', async () => {
    const db = makeDb({ data: { id: 'evt-1' }, error: null })
    expect(await assertAudienceEventOwned(db, 'host-1', 'evt-1')).toBeNull()
  })

  it("returns 'Event not found' when the read succeeds with no row", async () => {
    const db = makeDb({ data: null, error: null })
    expect(await assertAudienceEventOwned(db, 'host-1', 'evt-1')).toBe('Event not found')
  })

  // Review fix: the read used to discard `error`, so a failed query (not
  // "no rows") was indistinguishable from a genuinely missing/unowned event
  // and reported the same 'Event not found' 404 — a distinct sentinel lets
  // callers tell "no such event" from "the check itself failed".
  it("returns 'Could not check the event.' on a db error, distinct from 'Event not found'", async () => {
    const db = makeDb({ data: null, error: { message: 'kaboom' } })
    expect(await assertAudienceEventOwned(db, 'host-1', 'evt-1')).toBe('Could not check the event.')
  })

  it('short-circuits to null with no audienceEventId, never touching the db', async () => {
    const db = { from: () => { throw new Error('should not be called') } }
    expect(await assertAudienceEventOwned(db, 'host-1', null)).toBeNull()
  })
})

describe('reminderParentProblem', () => {
  it('a sent marketing email can have a reminder', () => {
    expect(reminderParentProblem({ status: 'sent', email_type: 'marketing' })).toBeNull()
  })
  it('anything not sent cannot', () => {
    for (const status of ['draft', 'scheduled', 'sending', 'failed']) {
      expect(reminderParentProblem({ status, email_type: 'marketing' })).toBe('Only a sent email can have a reminder.')
    }
    expect(reminderParentProblem(null)).toBe('Only a sent email can have a reminder.')
  })
  it('a utility email cannot: it is not open-tracked', () => {
    expect(reminderParentProblem({ status: 'sent', email_type: 'utility' })).toMatch(/utility emails/)
  })
})
