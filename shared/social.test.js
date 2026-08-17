import { describe, it, expect } from 'vitest'
import { friendshipPairKey, friendStatusFor, mergeFeed, reactionSummary, rankSuggestions, REACTIONS } from './social.js'

describe('friendshipPairKey', () => {
  it('is order-independent', () => {
    expect(friendshipPairKey('a', 'b')).toBe(friendshipPairKey('b', 'a'))
  })
})

describe('friendStatusFor', () => {
  const me = 'me'
  it('accepted → friends', () => {
    expect(friendStatusFor({ requester_contact_id: 'x', addressee_contact_id: me, status: 'accepted' }, me)).toBe('friends')
  })
  it('pending where I am addressee → incoming', () => {
    expect(friendStatusFor({ requester_contact_id: 'x', addressee_contact_id: me, status: 'pending' }, me)).toBe('incoming')
  })
  it('pending where I am requester → outgoing', () => {
    expect(friendStatusFor({ requester_contact_id: me, addressee_contact_id: 'x', status: 'pending' }, me)).toBe('outgoing')
  })
  it('blocked → blocked', () => {
    expect(friendStatusFor({ requester_contact_id: me, addressee_contact_id: 'x', status: 'blocked' }, me)).toBe('blocked')
  })
})

describe('mergeFeed', () => {
  it('sorts by ts desc, stable, mixed types, empty safe', () => {
    expect(mergeFeed([])).toEqual([])
    const out = mergeFeed([
      { type: 'session', ts: 100 }, { type: 'achievement', ts: 300 }, { type: 'tier_up', ts: 200 },
    ])
    expect(out.map((i) => i.ts)).toEqual([300, 200, 100])
  })
})

describe('reactionSummary', () => {
  it('counts per type, total, and mine', () => {
    const rows = [
      { reactor_contact_id: 'me', reaction: 'fire' },
      { reactor_contact_id: 'x', reaction: 'fire' },
      { reactor_contact_id: 'y', reaction: 'clap' },
    ]
    const s = reactionSummary(rows, 'me')
    expect(s.counts.fire).toBe(2)
    expect(s.counts.clap).toBe(1)
    expect(s.total).toBe(3)
    expect(s.mine).toBe('fire')
  })
  it('empty → zeros, mine null', () => {
    const s = reactionSummary([], 'me')
    expect(s.total).toBe(0); expect(s.mine).toBeNull()
  })
})

describe('rankSuggestions', () => {
  it('desc by sharedClasses, name tie-break', () => {
    const out = rankSuggestions([
      { contactId: 'a', name: 'Zoe', sharedClasses: 2 },
      { contactId: 'b', name: 'Amy', sharedClasses: 5 },
      { contactId: 'c', name: 'Bob', sharedClasses: 2 },
    ])
    expect(out.map((r) => r.contactId)).toEqual(['b', 'c', 'a'])
  })
})

describe('REACTIONS', () => {
  it('has the 4 keys with emoji + label', () => {
    expect(REACTIONS.map((r) => r.key)).toEqual(['strong', 'fire', 'clap', 'wow'])
    REACTIONS.forEach((r) => { expect(r.emoji).toBeTruthy(); expect(r.label).toBeTruthy() })
  })
})
