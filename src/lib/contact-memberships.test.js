import { describe, it, expect } from 'vitest'
import { MEMBERSHIP_SOURCE_LABELS } from './contact-memberships'

describe('MEMBERSHIP_SOURCE_LABELS', () => {
  it('labels both un1t.online contact_memberships sources (export import and the 15-minute API sync)', () => {
    expect(MEMBERSHIP_SOURCE_LABELS.un1t_online_export).toBe('un1t.online (import)')
    expect(MEMBERSHIP_SOURCE_LABELS.un1t_online_api).toBe('un1t.online')
  })
})
