import { describe, it, expect } from 'vitest'
import { resolveReplyAudience, PARTICIPANT_SCAN_LIMIT } from './_helpers'

const M = (over = {}) => ({
  from_email: 'member@x.com', to_emails: ['us@ours.com'], cc_emails: [],
  is_internal_note: false, forwarded_message_id: null,
  created_at: '2026-08-01T00:00:00Z', ...over,
})

describe('resolveReplyAudience', () => {
  it('derives the union and flags nothing when under the cap', () => {
    const out = resolveReplyAudience({
      messages: [M(), M({ from_email: 'colleague@x.com', created_at: '2026-08-02T00:00:00Z' })],
      ticket: { requester_email: 'member@x.com', excluded_participants: [] },
      ownAddresses: ['us@ours.com'],
    })
    expect(out.to).toEqual(['colleague@x.com', 'member@x.com'])
    expect(out.over_cap).toBe(false)
    expect(out.mode).toBe('reply_all')
  })

  it('falls back to the requester when there is no usable correspondence', () => {
    const out = resolveReplyAudience({
      messages: [M({ is_internal_note: true })],
      ticket: { requester_email: 'member@x.com', excluded_participants: [] },
      ownAddresses: ['us@ours.com'],
    })
    expect(out.to).toEqual(['member@x.com'])
  })

  // The fallback must NOT resurrect someone the operator removed, or the
  // removal appears to work and then silently undoes itself on the next send.
  it('does not resurrect an excluded requester through the fallback', () => {
    const out = resolveReplyAudience({
      messages: [M({ is_internal_note: true })],
      ticket: { requester_email: 'member@x.com', excluded_participants: ['member@x.com'] },
      ownAddresses: ['us@ours.com'],
    })
    expect(out.to).toEqual([])
    expect(out.empty).toBe(true)
  })

  it('flags over_cap rather than truncating', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      M({ from_email: `p${i}@x.com`, created_at: `2026-08-01T00:00:${String(i).padStart(2, '0')}Z` }))
    const out = resolveReplyAudience({
      messages: many,
      ticket: { requester_email: 'p0@x.com', excluded_participants: [] },
      ownAddresses: ['us@ours.com'],
    })
    expect(out.over_cap).toBe(true)
    expect(out.to.length).toBe(30)
  })

  it('scans far more than the old 10-row recipient window', () => {
    expect(PARTICIPANT_SCAN_LIMIT).toBeGreaterThanOrEqual(500)
  })
})
