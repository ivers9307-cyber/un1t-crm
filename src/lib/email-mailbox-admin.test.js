// EMAIL-MAILBOX-ADMIN.1 — the pure half of the mailbox/grant editor.
//
// These rules exist to keep four database constraints from reaching an
// operator as a raw 23505/23514, and to keep the ONE piece of the access model
// that has no row — implicit elevation — legible on screen. Both are things a
// route test can only observe indirectly, so they are pinned here.

import { describe, it, expect } from 'vitest'
import {
  MAILBOX_LABEL_MAX,
  normalizeMailboxAddress,
  normalizeMailboxLabel,
  mailboxInputIssues,
  addressTakenMessage,
  mailboxConstraintMessage,
  orderMailboxAdminList,
  isImplicitlyElevated,
  mailboxAccessRows,
  deactivationPatch,
} from './email-mailbox-admin'
import { visibleMailboxes } from './email-mailboxes'

describe('normalizeMailboxAddress', () => {
  it('trims and lowercases so lower(address) uniqueness matches what is shown', () => {
    expect(normalizeMailboxAddress('  Sales@UN1TDublin.com ')).toBe('sales@un1tdublin.com')
  })

  it('collapses blank-ish input to null rather than an empty string', () => {
    expect(normalizeMailboxAddress('   ')).toBeNull()
    expect(normalizeMailboxAddress(null)).toBeNull()
    expect(normalizeMailboxAddress(undefined)).toBeNull()
  })
})

describe('normalizeMailboxLabel', () => {
  it('trims but preserves case — the label is a display name, not a key', () => {
    expect(normalizeMailboxLabel('  Accounts ')).toBe('Accounts')
  })

  it('is null for whitespace only, matching the DB btrim CHECK', () => {
    expect(normalizeMailboxLabel('   ')).toBeNull()
  })
})

describe('mailboxInputIssues', () => {
  it('accepts a well-formed account', () => {
    expect(mailboxInputIssues({ address: 'sales@un1tdublin.com', label: 'Sales' })).toEqual([])
  })

  it('rejects an address with no domain dot — the shape CHECK, restated', () => {
    const issues = mailboxInputIssues({ address: 'sales@localhost', label: 'Sales' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatch(/valid email address/i)
  })

  it('rejects an address with spaces', () => {
    expect(mailboxInputIssues({ address: 'sa les@un1t.ie', label: 'Sales' })).toHaveLength(1)
  })

  it('rejects a whitespace-only label the way btrim does', () => {
    const issues = mailboxInputIssues({ address: 'sales@un1t.ie', label: '   ' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatch(/short label/i)
  })

  it(`rejects a label over ${MAILBOX_LABEL_MAX} characters`, () => {
    const issues = mailboxInputIssues({ address: 'sales@un1t.ie', label: 'x'.repeat(MAILBOX_LABEL_MAX + 1) })
    expect(issues[0]).toMatch(new RegExp(`${MAILBOX_LABEL_MAX} characters`))
  })

  it('accepts a label of exactly the limit, and one that only fits after trimming', () => {
    expect(mailboxInputIssues({ address: 'a@b.ie', label: 'x'.repeat(MAILBOX_LABEL_MAX) })).toEqual([])
    expect(mailboxInputIssues({ address: 'a@b.ie', label: `  ${'x'.repeat(MAILBOX_LABEL_MAX)}  ` })).toEqual([])
  })

  it('reports every problem at once rather than one round-trip each', () => {
    expect(mailboxInputIssues({ address: 'nope', label: '' })).toHaveLength(2)
  })
})

describe('addressTakenMessage', () => {
  const LOC_A = 'loc-a'

  it('points an operator at the deactivated row instead of a second one', () => {
    const msg = addressTakenMessage({
      address: 'accounts@un1t.ie',
      existing: { location_id: LOC_A, label: 'Accounts', active: false },
      locationId: LOC_A,
    })
    expect(msg).toMatch(/deactivated/i)
    expect(msg).toMatch(/Reactivate/i)
  })

  it('says plainly when the address is already live at this studio', () => {
    const msg = addressTakenMessage({
      address: 'accounts@un1t.ie',
      existing: { location_id: LOC_A, label: 'Accounts', active: true },
      locationId: LOC_A,
    })
    expect(msg).toMatch(/already set up at this studio/i)
    expect(msg).not.toMatch(/deactivated/i)
  })

  it('explains the ESTATE-WIDE rule when the clash is at another studio', () => {
    // The confusing case: the operator cannot see the other studio, so
    // "duplicate key" would read as a bug in the form.
    const msg = addressTakenMessage({
      address: 'accounts@un1t.ie',
      existing: { location_id: 'loc-b', label: 'Accounts', active: true },
      locationId: LOC_A,
    })
    expect(msg).toMatch(/another studio/i)
    expect(msg).toMatch(/only one account across the whole estate/i)
  })

  it('names the other studio only when the caller was allowed to be told', () => {
    const args = {
      address: 'accounts@un1t.ie',
      existing: { location_id: 'loc-b', label: 'Accounts', active: true },
      locationId: LOC_A,
    }
    expect(addressTakenMessage(args)).not.toMatch(/Hatch Street/)
    expect(addressTakenMessage({ ...args, otherLocationName: 'Hatch Street' })).toMatch(/Hatch Street/)
  })
})

describe('mailboxConstraintMessage — the race backstop', () => {
  it('translates the global address index', () => {
    const msg = mailboxConstraintMessage({ message: 'duplicate key value violates unique constraint "email_mailboxes_address_uidx"' })
    expect(msg).toMatch(/only one account across the whole estate/i)
  })

  it('translates the one-default-per-location index', () => {
    expect(mailboxConstraintMessage({ message: '… "email_mailboxes_one_default_uidx"' })).toMatch(/already has a default/i)
  })

  it('translates both CHECK constraints', () => {
    expect(mailboxConstraintMessage({ message: 'violates check constraint "email_mailboxes_address_shape"' })).toMatch(/valid email address/i)
    expect(mailboxConstraintMessage({ message: 'violates check constraint "email_mailboxes_label_len"' })).toMatch(/1–40 characters/)
  })

  // MAILBOX-SURFACE.1 — mig 575 names this constraint so there is something to
  // match; the assertion is here so a rename in the migration breaks a test
  // rather than silently downgrading the operator to a raw Postgres string.
  it('translates the surface CHECK', () => {
    expect(mailboxConstraintMessage({ message: 'new row for relation "email_mailboxes" violates check constraint "email_mailboxes_surface_check"' }))
      .toMatch(/Tickets or in Mail/i)
  })

  it('returns null for anything it does not recognise, so the route does not invent a friendly lie', () => {
    expect(mailboxConstraintMessage({ message: 'connection reset' })).toBeNull()
    expect(mailboxConstraintMessage(null)).toBeNull()
    expect(mailboxConstraintMessage({})).toBeNull()
  })
})

describe('orderMailboxAdminList', () => {
  const studio = { id: 'm1', label: 'Studio', address: 'studio@x.ie', is_default: true, active: true }
  const accounts = { id: 'm2', label: 'Accounts', address: 'accounts@x.ie', is_default: false, active: true }
  const sales = { id: 'm3', label: 'Sales', address: 'sales@x.ie', is_default: false, active: true }
  const old = { id: 'm4', label: 'Old', address: 'old@x.ie', is_default: false, active: false }

  it('keeps deactivated accounts (unlike the read path) and parks them last', () => {
    const ordered = orderMailboxAdminList([old, sales, accounts, studio])
    expect(ordered.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    // The inbox's own rule drops it entirely — managing it is what this
    // surface is for.
    expect(visibleMailboxes([old, studio], { isElevated: true }).map(m => m.id)).toEqual(['m1'])
  })

  it('orders each block default-first then label A→Z, same as the tab strip', () => {
    const ordered = orderMailboxAdminList([sales, accounts, studio])
    expect(ordered.map(m => m.label)).toEqual(['Studio', 'Accounts', 'Sales'])
  })

  it('does not mutate its input and tolerates rubbish', () => {
    const input = [sales, studio]
    orderMailboxAdminList(input)
    expect(input.map(m => m.id)).toEqual(['m3', 'm1'])
    expect(orderMailboxAdminList(null)).toEqual([])
  })
})

describe('isImplicitlyElevated', () => {
  it('is true for an owner at this location and for an estate master', () => {
    expect(isImplicitlyElevated({ role: 'owner', profile_role: 'staff' })).toBe(true)
    expect(isImplicitlyElevated({ role: 'staff', profile_role: 'master' })).toBe(true)
  })

  it('is FALSE for a manager — the whole point of the feature', () => {
    // A manager holds `email_inbox` and sees the inbox; that must not make
    // them able to see accounts@ nor to hand it to themselves.
    expect(isImplicitlyElevated({ role: 'manager', profile_role: 'manager' })).toBe(false)
    expect(isImplicitlyElevated({ role: 'head_coach', profile_role: 'staff' })).toBe(false)
    expect(isImplicitlyElevated(null)).toBe(false)
  })
})

describe('mailboxAccessRows', () => {
  const staff = [
    { profile_id: 'p-owner', full_name: 'Olive Owner', email: 'olive@x.ie', role: 'owner', profile_role: 'owner' },
    { profile_id: 'p-mgr', full_name: 'Mo Manager', email: 'mo@x.ie', role: 'manager', profile_role: 'manager' },
    { profile_id: 'p-coach', full_name: 'Ada Coach', email: 'ada@x.ie', role: 'staff', profile_role: 'staff' },
    { profile_id: 'p-zed', full_name: 'Zed Coach', email: 'zed@x.ie', role: 'staff', profile_role: 'staff' },
  ]

  it('tags elevated people implicit even with no grant row anywhere', () => {
    const rows = mailboxAccessRows({ staff, grants: [] })
    expect(rows.find(r => r.profile_id === 'p-owner').access).toBe('implicit')
    expect(rows.find(r => r.profile_id === 'p-mgr').access).toBe('none')
  })

  it('never attributes an implicit viewer to a granter', () => {
    // An owner with a stray historical grant row must still read as implicit
    // and must not show a granted_by — otherwise an operator revokes it,
    // nothing changes, and the screen loses their trust.
    const rows = mailboxAccessRows({
      staff,
      grants: [{ profile_id: 'p-owner', granted_by: 'p-mgr', granted_at: '2026-01-01T00:00:00Z' }],
    })
    const owner = rows.find(r => r.profile_id === 'p-owner')
    expect(owner.access).toBe('implicit')
    expect(owner.granted_by).toBeNull()
    expect(owner.granted_at).toBeNull()
  })

  it('carries the provenance of a real grant through', () => {
    const rows = mailboxAccessRows({
      staff,
      grants: [{ profile_id: 'p-coach', granted_by: 'p-owner', granted_at: '2026-08-07T09:00:00Z' }],
    })
    const coach = rows.find(r => r.profile_id === 'p-coach')
    expect(coach.access).toBe('granted')
    expect(coach.granted_by).toBe('p-owner')
    expect(coach.granted_at).toBe('2026-08-07T09:00:00Z')
  })

  it('sorts implicit, then granted, then everyone else — alphabetically inside each band', () => {
    const rows = mailboxAccessRows({
      staff,
      grants: [{ profile_id: 'p-zed' }],
    })
    expect(rows.map(r => r.profile_id)).toEqual(['p-owner', 'p-zed', 'p-coach', 'p-mgr'])
  })

  it('tolerates a missing roster or missing grants', () => {
    expect(mailboxAccessRows({})).toEqual([])
    expect(mailboxAccessRows({ staff, grants: null }).every(r => r.access !== 'granted')).toBe(true)
  })
})

describe('deactivationPatch', () => {
  it('clears is_default on deactivation so the studio never defaults to a dead address', () => {
    expect(deactivationPatch(false)).toEqual({ active: false, is_default: false })
  })

  it('does not silently restore the default flag on reactivation', () => {
    expect(deactivationPatch(true)).toEqual({ active: true })
  })
})
