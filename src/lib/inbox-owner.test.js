// INBOXASSIGN.1 — client-side owner helpers.
import { describe, it, expect } from 'vitest'
import { matchesOwnerFilter, ownerShortLabel, ownerSentence, assignEndpoint } from './inbox-owner'

describe('inbox-owner', () => {
  const mine = { assigned_to: 'me' }
  const theirs = { assigned_to: 'alex', assignee_name: 'Alex Example' }
  const none = { assigned_to: null }
  it('filters', () => {
    expect([mine, theirs, none].filter(r => matchesOwnerFilter(r, 'mine', 'me'))).toEqual([mine])
    expect([mine, theirs, none].filter(r => matchesOwnerFilter(r, 'unassigned', 'me'))).toEqual([none])
    expect([mine, theirs, none].filter(r => matchesOwnerFilter(r, 'any', 'me'))).toHaveLength(3)
    // No viewer id: "mine" matches nothing rather than everything unowned.
    expect(matchesOwnerFilter(none, 'mine', null)).toBe(false)
  })
  it('labels', () => {
    expect(ownerShortLabel(mine, 'me')).toBe('You')
    expect(ownerShortLabel(theirs, 'me')).toBe('Alex')
    expect(ownerShortLabel({ assigned_to: 'x' }, 'me')).toBe('Assigned')
    expect(ownerShortLabel(none, 'me')).toBe(null)
    expect(ownerSentence({ assignedTo: null })).toBe('Unassigned')
    expect(ownerSentence({ assignedTo: 'me', viewerId: 'me' })).toBe('Assigned to you')
    expect(ownerSentence({ assignedTo: 'alex', assigneeName: 'Alex Example', viewerId: 'me' })).toBe('Assigned to Alex Example')
  })
  it('routes per channel, null for an unknown one', () => {
    expect(assignEndpoint('whatsapp', 'c1')).toBe('/api/whatsapp/conversations/c1/assign')
    expect(assignEndpoint('instagram', 'c1')).toBe('/api/instagram/conversations/c1/assign')
    expect(assignEndpoint('mail', 'c1')).toBe('/api/email/mail/c1/assign')
    expect(assignEndpoint('sms', 'c1')).toBe(null)
  })
})
