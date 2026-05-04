// Tests for the pure helpers in contact-merge.js. The DB-touching
// functions (getContactImpact, mergeContacts) are tested at the
// route level + manual smoke; the field-resolution + tag-union
// logic is the riskiest piece operators will be relying on so it
// gets dedicated unit coverage here.

import { describe, it, expect } from 'vitest'
import { pickMergedFields, mergeTagArrays } from './contact-merge.js'

describe('pickMergedFields — survivor wins, loser fills empty', () => {
  it('survivor non-empty value wins over loser', () => {
    const r = pickMergedFields(
      { name: 'Alice', email: 'a@x.com' },
      { name: 'Alicia', email: 'b@y.com' },
    )
    expect(r.name).toBe('Alice')
    expect(r.email).toBe('a@x.com')
  })

  it('loser fills survivor empty string', () => {
    const r = pickMergedFields(
      { phone: '' },
      { phone: '+353871234567' },
    )
    expect(r.phone).toBe('+353871234567')
  })

  it('loser fills survivor null', () => {
    const r = pickMergedFields(
      { glofox_member_id: null },
      { glofox_member_id: 'GFX123' },
    )
    expect(r.glofox_member_id).toBe('GFX123')
  })

  it('loser fills survivor missing key', () => {
    const r = pickMergedFields(
      { name: 'Alice' },
      { lead_source: 'website' },
    )
    expect(r.lead_source).toBe('website')
  })

  it('loser fills survivor whitespace-only string', () => {
    const r = pickMergedFields(
      { last_name: '   ' },
      { last_name: 'Smith' },
    )
    expect(r.last_name).toBe('Smith')
  })

  it('both empty leaves the field empty (survivor wins, even when both empty)', () => {
    const r = pickMergedFields(
      { phone: null },
      { phone: '' },
    )
    expect(r.phone).toBe(null)
  })

  it('numeric zero is NOT treated as empty (trial_credits_remaining=0)', () => {
    // Edge case: a contact who's used up their trial credits has 0
    // — that's a meaningful value, not a missing one.
    const r = pickMergedFields(
      { trial_credits_remaining: 0 },
      { trial_credits_remaining: 3 },
    )
    expect(r.trial_credits_remaining).toBe(0)
  })

  it('keeps the OLDER created_at — lead-age math survives merge', () => {
    const r = pickMergedFields(
      { created_at: '2026-05-01T00:00:00Z' },
      { created_at: '2024-01-15T00:00:00Z' },
    )
    expect(r.created_at).toBe('2024-01-15T00:00:00Z')
  })

  it('keeps survivor created_at when loser is newer', () => {
    const r = pickMergedFields(
      { created_at: '2024-01-15T00:00:00Z' },
      { created_at: '2026-05-01T00:00:00Z' },
    )
    // pickMergedFields only writes created_at when loser is older;
    // otherwise it's not in the returned object at all (so the
    // existing survivor value stays untouched on UPDATE).
    expect(r.created_at).toBeUndefined()
  })
})

describe('mergeTagArrays — union, deduped, trims preserved order', () => {
  it('unions both arrays', () => {
    expect(mergeTagArrays(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('survives one or both nulls', () => {
    expect(mergeTagArrays(null, ['a'])).toEqual(['a'])
    expect(mergeTagArrays(['a'], null)).toEqual(['a'])
    expect(mergeTagArrays(null, null)).toEqual([])
  })

  it('trims whitespace and dedupes case-sensitively', () => {
    // Operators sometimes type tags with stray spaces; we trim. But
    // case is intentional ("VIP" ≠ "vip") so we don't lower-case.
    expect(mergeTagArrays(['  vip  ', 'engaged'], ['vip', 'VIP'])).toEqual(['vip', 'engaged', 'VIP'])
  })

  it('drops empty + whitespace-only entries', () => {
    expect(mergeTagArrays(['', '   ', 'real'], ['', null, 'other'])).toEqual(['real', 'other'])
  })

  it('drops non-string entries defensively', () => {
    expect(mergeTagArrays(['a', 5, { foo: 1 }], ['b'])).toEqual(['a', 'b'])
  })

  it('preserves survivor-first order', () => {
    // Important for the operator's mental model — their own tags
    // stay at the head of the list; loser's tags appended after.
    expect(mergeTagArrays(['a', 'b'], ['c', 'a', 'd'])).toEqual(['a', 'b', 'c', 'd'])
  })
})
