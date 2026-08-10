// EMAILREP.1 — contacts.email_status is address-bound reputation, and
// nothing reset it when the address changed. A contact whose typo'd
// address hard-bounced stayed unmailable forever on the corrected one.
//
// The decision is pure so it can be folded into the caller's existing
// update; these tests pin the two things that make it safe:
//   • it fires ONLY on a real address change (not a casing re-save, not
//     an update that doesn't touch email);
//   • it clears ONLY the address-bound reputation states, and clears
//     reputation ONLY — never consent.

import { describe, it, expect } from 'vitest'
import { emailStatusResetForAddressChange, ADDRESS_BOUND_EMAIL_STATUSES } from './email-reputation.js'

describe('emailStatusResetForAddressChange', () => {
  it('clears a bounce when the address is actually corrected', () => {
    expect(emailStatusResetForAddressChange({
      oldEmail: 'typo@gmial.com', newEmail: 'real@gmail.com', currentStatus: 'bounced',
    })).toBe('active')
  })

  it('clears a complaint when the address is replaced', () => {
    expect(emailStatusResetForAddressChange({
      oldEmail: 'old@x.com', newEmail: 'new@x.com', currentStatus: 'complained',
    })).toBe('active')
  })

  it('leaves the bounce alone when the update does not touch email', () => {
    expect(emailStatusResetForAddressChange({
      oldEmail: 'a@x.com', newEmail: undefined, currentStatus: 'bounced',
    })).toBeNull()
  })

  it('leaves the bounce alone when the same address is re-saved', () => {
    expect(emailStatusResetForAddressChange({
      oldEmail: 'a@x.com', newEmail: 'a@x.com', currentStatus: 'bounced',
    })).toBeNull()
  })

  // Contacts are stored mixed-case (the .ilike invariant), so a re-save
  // that only changes casing or adds whitespace is the SAME mailbox —
  // treating it as a change would hand every operator a one-click
  // bounce-eraser.
  it('treats a casing / whitespace-only difference as the same address', () => {
    expect(emailStatusResetForAddressChange({
      oldEmail: 'Ann@X.com', newEmail: '  ann@x.com ', currentStatus: 'bounced',
    })).toBeNull()
  })

  it('does not rewrite a healthy row', () => {
    for (const status of ['active', null, undefined]) {
      expect(emailStatusResetForAddressChange({
        oldEmail: 'a@x.com', newEmail: 'b@x.com', currentStatus: status,
      })).toBeNull()
    }
  })

  it('leaves an unrecognised status alone rather than guessing', () => {
    expect(emailStatusResetForAddressChange({
      oldEmail: 'a@x.com', newEmail: 'b@x.com', currentStatus: 'something_new',
    })).toBeNull()
  })

  it('fires when an address is added to a contact that had none', () => {
    // Reachable via merge / import: the row carries a bounce from an
    // address that has since been blanked.
    expect(emailStatusResetForAddressChange({
      oldEmail: null, newEmail: 'a@x.com', currentStatus: 'bounced',
    })).toBe('active')
  })

  it('fires when the address is cleared (null is still not the bounced one)', () => {
    expect(emailStatusResetForAddressChange({
      oldEmail: 'a@x.com', newEmail: null, currentStatus: 'bounced',
    })).toBe('active')
  })

  it('the address-bound status list matches what the send paths block on', () => {
    expect([...ADDRESS_BOUND_EMAIL_STATUSES]).toEqual(['bounced', 'complained'])
    expect(Object.isFrozen(ADDRESS_BOUND_EMAIL_STATUSES)).toBe(true)
  })

  // The one thing this must never do. Marketing needs per-location
  // consent + email_suppressed_at IS NULL on top of email_status, and
  // the hard-bounce handler revokes email_marketing at the same moment
  // it stamps 'bounced'. Returning a bare 'active' for email_status is
  // the whole contract — no consent field is in the return value, so a
  // caller folding it into an update cannot re-subscribe anyone.
  it('returns only an email_status value — never a consent flag', () => {
    const out = emailStatusResetForAddressChange({
      oldEmail: 'a@x.com', newEmail: 'b@x.com', currentStatus: 'bounced',
    })
    expect(out).toBe('active')
    expect(typeof out).toBe('string')
  })
})
