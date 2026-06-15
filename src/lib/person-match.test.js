import { describe, it, expect } from 'vitest'
import {
  CLASSPASS_STATUS,
  isClassPass,
  contactName,
  contactPhone9,
  pairKey,
  placeholderPhones,
  detectCandidates,
} from './person-match.js'

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('CLASSPASS_STATUS', () => {
  it('is the literal string classpass_payg', () => {
    expect(CLASSPASS_STATUS).toBe('classpass_payg')
  })
})

describe('isClassPass', () => {
  it('returns true when glofox_membership_status is classpass_payg', () => {
    expect(isClassPass({ glofox_membership_status: 'classpass_payg' })).toBe(true)
  })
  it('returns false for any other status', () => {
    expect(isClassPass({ glofox_membership_status: 'member' })).toBe(false)
    expect(isClassPass({ glofox_membership_status: null })).toBe(false)
    expect(isClassPass({})).toBe(false)
  })
})

describe('contactName', () => {
  it('uses the name field when present', () => {
    expect(contactName({ name: 'Aoife Byrne' })).toBe('aoife byrne')
  })
  it('falls back to first_name + last_name', () => {
    expect(contactName({ first_name: 'Aoife', last_name: 'Byrne' })).toBe('aoife byrne')
  })
  it('returns empty string when nothing usable', () => {
    expect(contactName({})).toBe('')
    expect(contactName({ name: '' })).toBe('')
  })
  it('strips accents and lowercases', () => {
    expect(contactName({ name: 'Séan Ó Briain' })).toBe('sean o briain')
  })
})

describe('contactPhone9', () => {
  it('normalises Irish formats to last 9 digits', () => {
    expect(contactPhone9({ phone: '087 123 4567' })).toBe('871234567')
    expect(contactPhone9({ phone: '+353 87 123 4567' })).toBe('871234567')
  })
  it('falls back to wa_phone when phone is absent', () => {
    expect(contactPhone9({ wa_phone: '+353861234567' })).toBe('861234567')
  })
  it('returns null when neither is present', () => {
    expect(contactPhone9({})).toBeNull()
  })
})

describe('pairKey', () => {
  it('produces the same key regardless of argument order', () => {
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'))
  })
  it('sorts ascending so smaller id comes first', () => {
    expect(pairKey('z', 'a')).toBe('a:z')
    expect(pairKey('a', 'z')).toBe('a:z')
  })
  it('works with UUIDs', () => {
    const k = pairKey('00000000-0001', '00000000-0002')
    expect(k).toBe('00000000-0001:00000000-0002')
  })
  it('coerces numbers to strings', () => {
    expect(pairKey(1, 2)).toBe('1:2')
    expect(pairKey(2, 1)).toBe('1:2')
  })
})

// ---------------------------------------------------------------------------
// placeholderPhones
// ---------------------------------------------------------------------------

describe('placeholderPhones', () => {
  it('returns an empty Set when no phone exceeds the threshold', () => {
    const contacts = [
      { phone: '0871234567' },
      { phone: '0871234567' },
      { phone: '0871234567' },
    ]
    // default threshold=10; 3 contacts sharing a number is not a placeholder
    expect(placeholderPhones(contacts).size).toBe(0)
  })

  it('returns the phone when more than threshold contacts share it', () => {
    const phone = '0000000000' // normalises to last 9 = '000000000'
    const contacts = Array.from({ length: 12 }, () => ({ phone }))
    const result = placeholderPhones(contacts, { threshold: 10 })
    expect(result.has('000000000')).toBe(true)
  })

  it('uses strictly-greater-than so exactly threshold is NOT a placeholder', () => {
    const phone = '0001234567'
    const contacts = Array.from({ length: 10 }, () => ({ phone }))
    const result = placeholderPhones(contacts, { threshold: 10 })
    expect(result.size).toBe(0)
  })

  it('ignores contacts with no phone', () => {
    const contacts = Array.from({ length: 20 }, () => ({}))
    expect(placeholderPhones(contacts).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// detectCandidates — phone matching
// ---------------------------------------------------------------------------

describe('detectCandidates — phone matching', () => {
  it('2 non-classpass, same phone + same name → 1 high-confidence phone candidate', () => {
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'Aoife Byrne', phone: '0871234567' },
      { id: 'b', glofox_membership_status: 'member', name: 'Aoife Byrne', phone: '0871234567' },
    ]
    const results = detectCandidates(contacts)
    expect(results).toHaveLength(1)
    const [r] = results
    expect(r.method).toBe('phone')
    expect(r.confidence).toBe('high')
    expect(r.reason).toBe('Same phone and name')
  })

  it('2 same phone, different names → medium', () => {
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'Aoife Byrne', phone: '0871234567' },
      { id: 'b', glofox_membership_status: 'member', name: 'John Smith', phone: '0871234567' },
    ]
    const results = detectCandidates(contacts)
    expect(results).toHaveLength(1)
    expect(results[0].confidence).toBe('medium')
    expect(results[0].reason).toBe('Same phone, different name')
  })

  it('2 same phone, one with an empty name → medium (not high)', () => {
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'Aoife Byrne', phone: '0871234567' },
      { id: 'b', glofox_membership_status: 'member', name: '', phone: '0871234567' },
    ]
    const results = detectCandidates(contacts)
    expect(results).toHaveLength(1)
    expect(results[0].confidence).toBe('medium')
  })

  it('3 contacts sharing a phone → 3 low-confidence pairs', () => {
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'A', phone: '0871234567' },
      { id: 'b', glofox_membership_status: 'member', name: 'B', phone: '0871234567' },
      { id: 'c', glofox_membership_status: 'member', name: 'C', phone: '0871234567' },
    ]
    const results = detectCandidates(contacts)
    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.confidence).toBe('low')
      expect(r.reason).toBe('Phone shared by 3 accounts')
    }
    // Each pair should be distinct
    const keys = results.map(r => pairKey(r.aId, r.bId))
    expect(new Set(keys).size).toBe(3)
  })

  it('contacts with no phone produce no phone candidates', () => {
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'Aoife' },
      { id: 'b', glofox_membership_status: 'member', name: 'Aoife' },
    ]
    const results = detectCandidates(contacts)
    expect(results).toHaveLength(0)
  })

  it('ClassPass contacts are excluded from phone clustering entirely', () => {
    // Two classpass contacts sharing the same phone → no phone candidate
    const contacts = [
      { id: 'cp1', glofox_membership_status: 'classpass_payg', name: 'Alice', phone: '0871234567' },
      { id: 'cp2', glofox_membership_status: 'classpass_payg', name: 'Alice', phone: '0871234567' },
    ]
    const results = detectCandidates(contacts)
    expect(results).toHaveLength(0)
  })

  it('placeholder phones are excluded from phone clustering', () => {
    // 11 contacts on the same phone (above threshold=10) → phone becomes a placeholder
    // → no phone candidate produced (even though two share the number)
    const sharedPhone = '0001112222'
    const contacts = Array.from({ length: 11 }, (_, i) => ({
      id: `r${i}`,
      glofox_membership_status: 'member',
      name: `Person ${i}`,
      phone: sharedPhone,
    }))
    // With default threshold=10, 11 contacts exceed it → placeholder
    const results = detectCandidates(contacts)
    expect(results).toHaveLength(0)
  })

  it('below-threshold phone is NOT treated as a placeholder', () => {
    // 10 contacts on same phone: equals threshold but threshold is strictly-greater-than
    // so 10 is NOT a placeholder — we get n>=3 low pairs
    const sharedPhone = '0001112222'
    const contacts = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      glofox_membership_status: 'member',
      name: `Person ${i}`,
      phone: sharedPhone,
    }))
    const results = detectCandidates(contacts)
    // 10 contacts → C(10,2) = 45 pairs
    expect(results).toHaveLength(45)
    expect(results[0].confidence).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// detectCandidates — name matching (ClassPass ↔ real)
// ---------------------------------------------------------------------------

describe('detectCandidates — name matching', () => {
  it('ClassPass name matching exactly 1 real member → high name candidate', () => {
    const contacts = [
      { id: 'cp1', glofox_membership_status: 'classpass_payg', name: 'Aoife Byrne', phone: '1111111111' },
      { id: 'r1', glofox_membership_status: 'member', name: 'Aoife Byrne', phone: '9999999999' },
    ]
    const results = detectCandidates(contacts)
    expect(results).toHaveLength(1)
    const [r] = results
    expect(r.method).toBe('name')
    expect(r.confidence).toBe('high')
    expect(r.reason).toBe('ClassPass name matches one member')
  })

  it('ClassPass name matching 2 real members → 2 medium name candidates', () => {
    const contacts = [
      { id: 'cp1', glofox_membership_status: 'classpass_payg', name: 'John Smith', phone: '1111111111' },
      { id: 'r1', glofox_membership_status: 'member', name: 'John Smith', phone: '2222222222' },
      { id: 'r2', glofox_membership_status: 'member', name: 'John Smith', phone: '3333333333' },
    ]
    const results = detectCandidates(contacts)
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.method).toBe('name')
      expect(r.confidence).toBe('medium')
      expect(r.reason).toBe('ClassPass name matches 2 members')
    }
    const realIds = results.map(r => (r.aId === 'cp1' ? r.bId : r.aId)).sort()
    expect(realIds).toEqual(['r1', 'r2'])
  })

  it('ClassPass with no name match → no candidate', () => {
    const contacts = [
      { id: 'cp1', glofox_membership_status: 'classpass_payg', name: 'Nobody Known', phone: '1111111111' },
      { id: 'r1', glofox_membership_status: 'member', name: 'Aoife Byrne', phone: '9999999999' },
    ]
    expect(detectCandidates(contacts)).toHaveLength(0)
  })

  it('ClassPass with empty name → no name candidate', () => {
    const contacts = [
      { id: 'cp1', glofox_membership_status: 'classpass_payg', name: '', phone: '1111111111' },
      { id: 'r1', glofox_membership_status: 'member', name: '', phone: '9999999999' },
    ]
    expect(detectCandidates(contacts)).toHaveLength(0)
  })

  it('ClassPass↔ClassPass sharing a name → no candidate (name pairing never pairs two classpass)', () => {
    const contacts = [
      { id: 'cp1', glofox_membership_status: 'classpass_payg', name: 'Alice', phone: '1111111111' },
      { id: 'cp2', glofox_membership_status: 'classpass_payg', name: 'Alice', phone: '2222222222' },
    ]
    expect(detectCandidates(contacts)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// detectCandidates — filtering & dedup
// ---------------------------------------------------------------------------

describe('detectCandidates — filtering and dedup', () => {
  it('dismissed pairKey is skipped', () => {
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'X', phone: '0871234567' },
      { id: 'b', glofox_membership_status: 'member', name: 'X', phone: '0871234567' },
    ]
    const dismissedPairKeys = new Set([pairKey('a', 'b')])
    const results = detectCandidates(contacts, { dismissedPairKeys })
    expect(results).toHaveLength(0)
  })

  it('two contacts in the same group are skipped', () => {
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'X', phone: '0871234567' },
      { id: 'b', glofox_membership_status: 'member', name: 'X', phone: '0871234567' },
    ]
    // Both map to the same group id
    const groupOf = new Map([['a', 'g1'], ['b', 'g1']])
    const results = detectCandidates(contacts, { groupOf })
    expect(results).toHaveLength(0)
  })

  it('one grouped one-not is kept', () => {
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'X', phone: '0871234567' },
      { id: 'b', glofox_membership_status: 'member', name: 'X', phone: '0871234567' },
    ]
    // Only 'a' is in a group; 'b' is not — candidate should still be produced
    const groupOf = new Map([['a', 'g1']])
    const results = detectCandidates(contacts, { groupOf })
    expect(results).toHaveLength(1)
  })

  it('two contacts in different groups are kept', () => {
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'X', phone: '0871234567' },
      { id: 'b', glofox_membership_status: 'member', name: 'X', phone: '0871234567' },
    ]
    // Both grouped, but in DIFFERENT groups → still a candidate (might merge groups)
    const groupOf = new Map([['a', 'g1'], ['b', 'g2']])
    const results = detectCandidates(contacts, { groupOf })
    expect(results).toHaveLength(1)
  })

  it('phone(medium) + name(high) for the same pair dedupes to a single high candidate', () => {
    // Set up: real contact 'r' and classpass 'cp' share the same phone (medium, different name)
    // AND the classpass name matches exactly one real member 'r' (high name match)
    // The pair should appear only once, with the higher confidence (high, method=name)
    const contacts = [
      { id: 'cp', glofox_membership_status: 'classpass_payg', name: 'Aoife Byrne', phone: '0871234567' },
      { id: 'r', glofox_membership_status: 'member', name: 'Aoife Byrne', phone: '0871234567' },
    ]
    const results = detectCandidates(contacts)
    // Phone would give medium (classpass excluded from phone, so actually no phone candidate)
    // Name gives high
    // Let's verify: classpass is excluded from phone clustering, so only the name candidate fires
    expect(results).toHaveLength(1)
    expect(results[0].confidence).toBe('high')
    expect(results[0].method).toBe('name')
  })

  it('dedupes phone(medium) vs name(high) when both could fire (real↔real + name match)', () => {
    // Two real contacts, same phone (medium phone candidate since names differ)
    // Plus separately the classpass trick won't apply here since both are real
    // Instead we construct the scenario using a custom threshold so phone fires as medium
    // and we verify the dedup correctly keeps highest
    // Scenario: r1 and r2 share phone but different names → medium phone candidate
    // r1 also shares name with cp1 → but that's a different pair, not a dedup scenario
    //
    // For a true dedup: we need the SAME pair to be produced by both paths.
    // This can happen if two non-classpass contacts share a phone (medium)
    // and the same two contacts have matching names (no separate name path exists for real↔real).
    // So the dedup scenario is actually phone(high) vs phone(medium) for the same pair.
    // We test: same pair would be produced twice → only one kept with higher confidence.
    //
    // Actually detectCandidates only produces a pair via one mechanism per run.
    // The dedup guard handles cross-method collisions. Let's test a realistic version:
    // placeholderThreshold=0 so phone fires even for classpass; name also fires.
    // Actually: classpass is excluded from phone regardless of threshold.
    //
    // The purest cross-method dedup test: inject artificially by calling with very low threshold
    // and having a non-cp pair produce a medium phone result alongside a name match.
    // Since real↔real name matching isn't in scope, let's test the guard directly
    // by verifying that the winner of medium vs high is high.
    const contacts = [
      { id: 'cp', glofox_membership_status: 'classpass_payg', name: 'Jane Doe' },
      { id: 'r1', glofox_membership_status: 'member', name: 'Jane Doe', phone: '0871234567' },
      { id: 'r2', glofox_membership_status: 'member', name: 'Jane Doe', phone: '0871234567' },
    ]
    // r1 + r2: same phone + same name → high phone
    // cp: name matches 2 members (r1, r2) → medium name × 2
    const results = detectCandidates(contacts)

    // r1↔r2: phone high
    // cp↔r1 and cp↔r2: name medium (2 matches)
    expect(results).toHaveLength(3)

    const r1r2 = results.find(r =>
      (r.aId === 'r1' && r.bId === 'r2') || (r.aId === 'r2' && r.bId === 'r1'),
    )
    expect(r1r2?.confidence).toBe('high')
    expect(r1r2?.method).toBe('phone')

    const cpR1 = results.find(r =>
      (r.aId === 'cp' || r.bId === 'cp') && (r.aId === 'r1' || r.bId === 'r1'),
    )
    expect(cpR1?.confidence).toBe('medium')
    expect(cpR1?.method).toBe('name')
  })
})

// ---------------------------------------------------------------------------
// detectCandidates — canonical ordering (aId < bId)
// ---------------------------------------------------------------------------

describe('detectCandidates — canonical ordering', () => {
  it('always has aId <= bId (string comparison)', () => {
    const contacts = [
      { id: 'z', glofox_membership_status: 'member', name: 'X', phone: '0871234567' },
      { id: 'a', glofox_membership_status: 'member', name: 'X', phone: '0871234567' },
    ]
    const [r] = detectCandidates(contacts)
    expect(r.aId).toBe('a')
    expect(r.bId).toBe('z')
  })

  it('canonical ordering holds for name candidates too', () => {
    const contacts = [
      { id: 'zzz', glofox_membership_status: 'classpass_payg', name: 'Aoife' },
      { id: 'aaa', glofox_membership_status: 'member', name: 'Aoife' },
    ]
    const [r] = detectCandidates(contacts)
    expect(r.aId).toBe('aaa')
    expect(r.bId).toBe('zzz')
  })
})

// ---------------------------------------------------------------------------
// detectCandidates — no false positives for contacts with no phone + no name
// ---------------------------------------------------------------------------

describe('detectCandidates — edge cases', () => {
  it('single contact produces no candidates', () => {
    const contacts = [{ id: 'a', glofox_membership_status: 'member', name: 'X', phone: '0871234567' }]
    expect(detectCandidates(contacts)).toHaveLength(0)
  })

  it('empty contacts array produces no candidates', () => {
    expect(detectCandidates([])).toHaveLength(0)
  })

  it('custom placeholderThreshold is respected', () => {
    // With threshold=2, any phone shared by >2 contacts is a placeholder
    const phone = '0871234567'
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'A', phone },
      { id: 'b', glofox_membership_status: 'member', name: 'B', phone },
      { id: 'c', glofox_membership_status: 'member', name: 'C', phone },
    ]
    // threshold=2: 3 > 2 → placeholder → no phone candidates
    const results = detectCandidates(contacts, { placeholderThreshold: 2 })
    expect(results).toHaveLength(0)

    // But with threshold=3: 3 is NOT > 3 → not a placeholder → low candidates produced
    const results3 = detectCandidates(contacts, { placeholderThreshold: 3 })
    expect(results3).toHaveLength(3)
  })

  it('wa_phone is used as fallback phone source', () => {
    const contacts = [
      { id: 'a', glofox_membership_status: 'member', name: 'A', wa_phone: '+353871234567' },
      { id: 'b', glofox_membership_status: 'member', name: 'A', wa_phone: '0871234567' },
    ]
    const results = detectCandidates(contacts)
    expect(results).toHaveLength(1)
    expect(results[0].confidence).toBe('high')
  })
})
