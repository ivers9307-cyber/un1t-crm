// HOST-EMAILS.2 — copySubject: the shared subject transform for a duplicated
// or reminder draft. Lives here (not in a route module) because Next route
// files may only export HTTP handlers.

import { describe, it, expect } from 'vitest'
import { copySubject, HOST_CAMPAIGN_LIST_COLUMNS } from './host-campaign-draft.js'

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
