// Tests for the pure mailbox routing + visibility rules.
// No DB, no env — the route owns the queries, these own the decisions.

import { describe, it, expect } from 'vitest'
import {
  resolveMailboxByRecipient,
  visibleMailboxes,
  orderMailboxTabs,
  hasAnyMailboxAccess,
} from './email-mailboxes'

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const STILL = 'a0000000-0000-0000-0000-000000000001'

const accounts = { id: 'm1', location_id: HATCH, address: 'accounts@hatchstreetfitness.com', label: 'Accounts', is_default: true,  active: true }
const sales    = { id: 'm2', location_id: HATCH, address: 'sales@hatchstreetfitness.com',    label: 'Sales',    is_default: false, active: true }
const retired  = { id: 'm3', location_id: HATCH, address: 'old@hatchstreetfitness.com',      label: 'Old',      is_default: false, active: false }
const stillo   = { id: 'm4', location_id: STILL, address: 'stillorgan@un1t.com',             label: 'Studio',   is_default: true,  active: true }
const ALL = [accounts, sales, retired, stillo]

describe('resolveMailboxByRecipient', () => {
  it('matches a delivered-to address to its mailbox', () => {
    expect(resolveMailboxByRecipient(ALL, ['accounts@hatchstreetfitness.com'])).toBe(accounts)
  })

  it('matches case-insensitively', () => {
    expect(resolveMailboxByRecipient(ALL, ['ACCounts@HatchStreetFitness.COM'])).toBe(accounts)
  })

  it('picks the matching address out of several recipients', () => {
    expect(resolveMailboxByRecipient(ALL, ['someone@example.com', 'sales@hatchstreetfitness.com']))
      .toBe(sales)
  })

  it('returns NULL rather than guessing when nothing matches', () => {
    // This is the death of the "oldest active location" fallback. An unmatched
    // recipient must dead-letter, not silently file into another studio.
    expect(resolveMailboxByRecipient(ALL, ['mailbox+samplehash@inbound.postmarkapp.com']))
      .toBeNull()
  })

  it('does not route to an inactive mailbox', () => {
    expect(resolveMailboxByRecipient(ALL, ['old@hatchstreetfitness.com'])).toBeNull()
  })

  it('tolerates junk input', () => {
    expect(resolveMailboxByRecipient(null, ['a@b.com'])).toBeNull()
    expect(resolveMailboxByRecipient(ALL, null)).toBeNull()
    expect(resolveMailboxByRecipient(ALL, [])).toBeNull()
    expect(resolveMailboxByRecipient(ALL, [null, '', 'not-an-address'])).toBeNull()
  })

  it('never crosses locations — a Hatch address never resolves to Stillorgan', () => {
    const m = resolveMailboxByRecipient(ALL, ['accounts@hatchstreetfitness.com'])
    expect(m.location_id).toBe(HATCH)
  })

  it('is invariant under mailbox row order — recipient precedence decides', () => {
    const both = ['accounts@hatchstreetfitness.com', 'stillorgan@un1t.com']
    expect(resolveMailboxByRecipient([accounts, stillo], both)).toBe(accounts)
    expect(resolveMailboxByRecipient([stillo, accounts], both)).toBe(accounts)
  })
})

describe('visibleMailboxes', () => {
  const atHatch = [accounts, sales, retired]

  it('shows an elevated user every active mailbox, no grants needed', () => {
    expect(visibleMailboxes(atHatch, { isElevated: true, grantedMailboxIds: [] }))
      .toEqual([accounts, sales])
  })

  it('shows a granted user only their mailboxes', () => {
    expect(visibleMailboxes(atHatch, { isElevated: false, grantedMailboxIds: ['m2'] }))
      .toEqual([sales])
  })

  it('shows nothing to an ungranted, unelevated user', () => {
    expect(visibleMailboxes(atHatch, { isElevated: false, grantedMailboxIds: [] }))
      .toEqual([])
  })

  it('hides inactive mailboxes even from an elevated user', () => {
    const seen = visibleMailboxes(atHatch, { isElevated: true, grantedMailboxIds: ['m3'] })
    expect(seen.find(m => m.id === 'm3')).toBeUndefined()
  })

  it('hides an inactive mailbox even from someone holding a grant for it', () => {
    expect(visibleMailboxes([retired], { isElevated: false, grantedMailboxIds: ['m3'] }))
      .toEqual([])
  })

  it('ignores a grant for a mailbox not in the list', () => {
    expect(visibleMailboxes(atHatch, { isElevated: false, grantedMailboxIds: ['m4'] }))
      .toEqual([])
  })

  it('tolerates junk input', () => {
    expect(visibleMailboxes(null, { isElevated: true, grantedMailboxIds: [] })).toEqual([])
    expect(visibleMailboxes(atHatch, {})).toEqual([])
  })
})

describe('orderMailboxTabs', () => {
  it('puts the default mailbox first even when it sorts last alphabetically', () => {
    // accounts is is_default: true in the shared fixture — a non-default copy
    // here keeps this test to a single default, so the assertion is actually
    // about default-first, not two defaults settling by label.
    const zebraDefault = { id: 'm9', label: 'Zebra', is_default: true, active: true, address: 'z@x.com' }
    const nonDefaultAccounts = { ...accounts, is_default: false }
    expect(orderMailboxTabs([sales, zebraDefault, nonDefaultAccounts]).map(m => m.label))
      .toEqual(['Zebra', 'Accounts', 'Sales'])
  })

  it('falls back to address when labels collide, so order is total', () => {
    const a = { id: 'a', label: 'Same', is_default: false, active: true, address: 'b@x.com' }
    const b = { id: 'b', label: 'Same', is_default: false, active: true, address: 'a@x.com' }
    expect(orderMailboxTabs([a, b]).map(m => m.id)).toEqual(['b', 'a'])
  })

  it('does not mutate its input', () => {
    const input = [sales, accounts]
    orderMailboxTabs(input)
    expect(input.map(m => m.id)).toEqual(['m2', 'm1'])
  })

  it('tolerates junk input', () => {
    expect(orderMailboxTabs(null)).toEqual([])
  })
})

describe('hasAnyMailboxAccess', () => {
  it('is true for an elevated user with at least one active mailbox', () => {
    expect(hasAnyMailboxAccess([accounts], { isElevated: true, grantedMailboxIds: [] })).toBe(true)
  })

  it('is FALSE for an elevated user at a studio with no mailboxes', () => {
    // The feature permission alone must not surface an empty inbox.
    expect(hasAnyMailboxAccess([], { isElevated: true, grantedMailboxIds: [] })).toBe(false)
  })

  it('is true for a granted user', () => {
    expect(hasAnyMailboxAccess([accounts, sales], { isElevated: false, grantedMailboxIds: ['m2'] })).toBe(true)
  })

  it('is false for an ungranted user', () => {
    expect(hasAnyMailboxAccess([accounts, sales], { isElevated: false, grantedMailboxIds: [] })).toBe(false)
  })
})
