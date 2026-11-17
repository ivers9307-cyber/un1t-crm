import { describe, it, expect } from 'vitest'
import {
  normaliseManualTag, manualTagProblem, applyManualTagChange, textArrayLiteral, machineTagChips,
  MAX_TAGS_PER_CONTACT,
} from './contact-manual-tags.js'
import { canBulkTagAt } from './contact-bulk-tag-gate.js'

describe('normaliseManualTag / manualTagProblem', () => {
  it('trims and collapses whitespace, keeps case', () => {
    expect(normaliseManualTag('  VIP   Lead ')).toBe('VIP Lead')
    expect(normaliseManualTag(null)).toBe('')
  })
  it('refuses empty and over-long tags', () => {
    expect(manualTagProblem('')).toMatch(/Type a tag/)
    expect(manualTagProblem('x'.repeat(65))).toMatch(/64/)
    expect(manualTagProblem('ok')).toBeNull()
  })
})

describe('applyManualTagChange', () => {
  it('add is idempotent', () => {
    expect(applyManualTagChange(['a'], 'a', 'add')).toEqual({ changed: false, next: ['a'] })
    expect(applyManualTagChange(null, 'a', 'add')).toEqual({ changed: true, next: ['a'] })
  })
  it('remove of an absent tag is a no-op', () => {
    expect(applyManualTagChange(['a'], 'b', 'remove')).toEqual({ changed: false, next: ['a'] })
    expect(applyManualTagChange(['a', 'b'], 'a', 'remove')).toEqual({ changed: true, next: ['b'] })
  })
  it('refuses a 51st tag', () => {
    const full = Array.from({ length: MAX_TAGS_PER_CONTACT }, (_, i) => `t${i}`)
    expect(applyManualTagChange(full, 'new', 'add')).toMatchObject({ changed: false, tooMany: true })
  })
})

describe('textArrayLiteral', () => {
  it('quotes every element so commas, braces and quotes cannot reshape it', () => {
    expect(textArrayLiteral([])).toBe('{}')
    expect(textArrayLiteral(['a', 'b,c', 'say "hi"', 'back\\slash', '{x}'])).toBe('{"a","b,c","say \\"hi\\"","back\\\\slash","{x}"}')
  })
})

describe('machineTagChips', () => {
  it('one chip per tag, only visible rows, sorted, with a description', () => {
    const rows = [
      { tag: 'race_completed', location_id: 'l1', added_at: '2026-01-01' },
      { tag: 'race_completed', location_id: 'l1', added_at: '2026-03-01' },
      { tag: 'lapsed_payer', location_id: 'other', added_at: '2026-02-01' },
      { tag: 'anywhere', location_id: null, added_at: '2026-02-01' },
    ]
    const chips = machineTagChips(rows, {
      visible: (r) => !r.location_id || r.location_id === 'l1',
      describe: (t) => `about ${t}`,
    })
    expect(chips).toEqual([
      { tag: 'anywhere', addedAt: '2026-02-01', description: 'about anywhere' },
      { tag: 'race_completed', addedAt: '2026-03-01', description: 'about race_completed' },
    ])
  })
})

describe('canBulkTagAt', () => {
  const manager = (perms = {}) => ({
    role: 'manager',
    locations: [{ id: 'l1', role: 'manager' }],
    rolesByLocation: { l1: 'manager' },
    assignmentsByLocation: { l1: { role: 'manager', permissions: perms } },
  })
  it('manager with Contacts at the studio may', () => {
    expect(canBulkTagAt(manager(), 'l1')).toBe(true)
  })
  it('manager without Contacts there may not', () => {
    expect(canBulkTagAt(manager({ contacts: false }), 'l1')).toBe(false)
  })
  it('a non-member, and a plain staff member, may not', () => {
    expect(canBulkTagAt(manager(), 'l2')).toBe(false)
    const staff = { role: 'staff', locations: [{ id: 'l1', role: 'staff' }], rolesByLocation: { l1: 'staff' }, assignmentsByLocation: { l1: { role: 'staff', permissions: { contacts: true } } } }
    expect(canBulkTagAt(staff, 'l1')).toBe(false)
  })
  it('a master may', () => {
    expect(canBulkTagAt({ isMaster: true, role: 'master', locations: [] }, 'l1')).toBe(true)
  })
})
