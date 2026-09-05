// MAIL-FOLLOWUPS.1 — the tested unit behind the contact card's Email tab on
// WEB, mirroring mobile/lib/mail-sender.test.js (MOBILE-MAILPARITY.1), whose
// review found the race this file exists to pin: the web ContactComposer was
// byte-identical to the OLD phone code, so a Send click that beat the mailbox
// list went out as the COMPANY sender — the very bug PROFILE-MAIL.1 fixed,
// made timing-dependent — and every list failure (transport, 500, non-JSON)
// collapsed to [] → company, with a footer confidently claiming the studio
// had no accounts.
//
// THE PROPERTIES:
//   1. A usable studio account → the send IS a Mail compose (mailbox_id, the
//      contact's address as the one recipient, the MAILBOX'S studio).
//   2. No account ([]) or no address → the company path, exactly as before.
//   3. A mailbox id not in the visible list never goes on the wire.
//   4. The footer states the path truthfully — never one while doing the other.
//   5. A list NOT YET ANSWERED is `awaiting`, not company: the composer
//      disables Send on it. Only when nothing is awaited (no contact studio
//      or address, so the list is never asked for) does null mean company.
//   6. A list that FAILED to load is `unavailable`: still the company path
//      (never block the operator on a blip) but the footer names the failure.

import { describe, it, expect } from 'vitest'
import {
  resolveContactEmailSend, contactEmailFooter, mailboxesFromListResponse, defaultMailboxId,
  COMPANY_SENDER_FOOTER, AWAITING_SENDER_FOOTER, UNAVAILABLE_SENDER_FOOTER, MAILBOXES_UNAVAILABLE,
} from './contact-composer-send'

const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = 'a0000000-0000-0000-0000-000000000002'

/** One mailbox row as GET /api/email/mail serves it. */
function box(over = {}) {
  return {
    id: 'mb-1',
    address: 'hello@un1tdublin.com',
    label: 'Front desk',
    is_default: false,
    location_id: STILL,
    ...over,
  }
}

const contact = { contactEmail: 'sarah@example.com', contactLocationId: STILL }

describe('resolveContactEmailSend — the Mail path when an account exists', () => {
  it('composes from the chosen mailbox, to the contact, at the mailbox’s studio', () => {
    expect(resolveContactEmailSend({ mailboxes: [box()], mailboxId: 'mb-1', ...contact })).toEqual({
      path: 'mail',
      mailboxId: 'mb-1',
      to: ['sarah@example.com'],
      locationId: STILL,
    })
  })

  it('the request location is the MAILBOX’s studio, not the contact’s', () => {
    const out = resolveContactEmailSend({
      mailboxes: [box({ id: 'mb-h', location_id: HATCH })], mailboxId: 'mb-h', ...contact,
    })
    expect(out.locationId).toBe(HATCH)
  })

  it('falls back to the contact’s studio when the mailbox row carries no location stamp', () => {
    const out = resolveContactEmailSend({
      mailboxes: [box({ location_id: undefined })], mailboxId: 'mb-1', ...contact,
    })
    expect(out.locationId).toBe(STILL)
  })
})

describe('resolveContactEmailSend — the company path, exactly as before', () => {
  it('null with nothing to await (no contact studio, or no address) → company', () => {
    expect(resolveContactEmailSend({ mailboxes: null, mailboxId: null, contactEmail: 'sarah@example.com', contactLocationId: null }))
      .toEqual({ path: 'company' })
    expect(resolveContactEmailSend({ mailboxes: null, mailboxId: null, contactEmail: null, contactLocationId: STILL }))
      .toEqual({ path: 'company' })
  })

  it('the list FAILED to load → company, marked unavailable — never blocked on a blip', () => {
    expect(resolveContactEmailSend({ mailboxes: MAILBOXES_UNAVAILABLE, mailboxId: null, ...contact }))
      .toEqual({ path: 'company', reason: 'unavailable' })
  })

  it('no usable account ([]) → company', () => {
    expect(resolveContactEmailSend({ mailboxes: [], mailboxId: null, ...contact })).toEqual({ path: 'company' })
  })

  it('no contact address → company even with an account', () => {
    expect(resolveContactEmailSend({ mailboxes: [box()], mailboxId: 'mb-1', contactEmail: null, contactLocationId: STILL }))
      .toEqual({ path: 'company' })
    expect(resolveContactEmailSend({ mailboxes: [box()], mailboxId: 'mb-1', contactEmail: '', contactLocationId: STILL }))
      .toEqual({ path: 'company' })
  })

  it('a mailbox id outside the visible list never goes on the wire', () => {
    expect(resolveContactEmailSend({ mailboxes: [box()], mailboxId: 'mb-stale', ...contact })).toEqual({ path: 'company' })
  })
})

describe('resolveContactEmailSend — awaiting: the list is asked for and not yet answered', () => {
  it('null with a contact studio AND address → awaiting, never company (the fast-click race)', () => {
    expect(resolveContactEmailSend({ mailboxes: null, mailboxId: null, ...contact })).toEqual({ path: 'awaiting' })
  })

  it('undefined reads as null — a composer that has not set state yet is still awaiting', () => {
    expect(resolveContactEmailSend({ mailboxes: undefined, mailboxId: null, ...contact })).toEqual({ path: 'awaiting' })
  })
})

describe('mailboxesFromListResponse — the fetch answer → the composer’s mailbox state', () => {
  it('a 2xx success envelope is the array, null-tolerant on the field', () => {
    expect(mailboxesFromListResponse({ ok: true, json: { success: true, data: { mailboxes: [box()] } } })).toEqual([box()])
    expect(mailboxesFromListResponse({ ok: true, json: { success: true, data: {} } })).toEqual([])
    expect(mailboxesFromListResponse({ ok: true, json: { success: true, data: { mailboxes: null } } })).toEqual([])
  })

  it('an empty successful list is GENUINELY none — [], not unavailable', () => {
    expect(mailboxesFromListResponse({ ok: true, json: { success: true, data: { mailboxes: [] } } })).toEqual([])
  })

  it('a non-2xx, a success:false envelope, a non-JSON body, or no answer → unavailable, never a silent []', () => {
    expect(mailboxesFromListResponse({ ok: false, json: { success: false, error: 'no' } })).toBe(MAILBOXES_UNAVAILABLE)
    expect(mailboxesFromListResponse({ ok: false, json: null })).toBe(MAILBOXES_UNAVAILABLE)
    expect(mailboxesFromListResponse({ ok: true, json: { success: false, error: 'boom' } })).toBe(MAILBOXES_UNAVAILABLE)
    expect(mailboxesFromListResponse({ ok: true, json: null })).toBe(MAILBOXES_UNAVAILABLE)
    expect(mailboxesFromListResponse(undefined)).toBe(MAILBOXES_UNAVAILABLE)
    expect(mailboxesFromListResponse(null)).toBe(MAILBOXES_UNAVAILABLE)
  })

  it('unavailable is not an array — nothing downstream may .map or .find it', () => {
    expect(Array.isArray(MAILBOXES_UNAVAILABLE)).toBe(false)
  })
})

describe('defaultMailboxId — the starred account, else the first', () => {
  it('is_default wins over list order', () => {
    expect(defaultMailboxId([box({ id: 'a' }), box({ id: 'b', is_default: true })])).toBe('b')
  })
  it('the first visible account when none is starred; null on an empty or non-list', () => {
    expect(defaultMailboxId([box({ id: 'a' }), box({ id: 'b' })])).toBe('a')
    expect(defaultMailboxId([])).toBeNull()
    expect(defaultMailboxId(MAILBOXES_UNAVAILABLE)).toBeNull()
    expect(defaultMailboxId(null)).toBeNull()
  })
})

describe('contactEmailFooter — says which path the send will take', () => {
  it('names the address the member will hear from on the Mail path', () => {
    expect(contactEmailFooter({ mailboxes: [box()], mailboxId: 'mb-1', ...contact })).toBe('hello@un1tdublin.com')
  })

  it('falls back to the label when a mailbox has no address', () => {
    expect(contactEmailFooter({ mailboxes: [box({ address: null })], mailboxId: 'mb-1', ...contact })).toBe('Front desk')
  })

  it('never names an address while the send would go company', () => {
    expect(contactEmailFooter({ mailboxes: [box()], mailboxId: 'mb-1', contactEmail: null, contactLocationId: STILL }))
      .toBe(COMPANY_SENDER_FOOTER)
  })

  it('company wording when the list is empty, the id is stale, or there was never anything to await', () => {
    expect(contactEmailFooter({ mailboxes: [], mailboxId: null })).toBe(COMPANY_SENDER_FOOTER)
    expect(contactEmailFooter({ mailboxes: [box()], mailboxId: 'mb-stale' })).toBe(COMPANY_SENDER_FOOTER)
    expect(contactEmailFooter({ mailboxes: null, mailboxId: null })).toBe(COMPANY_SENDER_FOOTER)
    expect(contactEmailFooter({ mailboxes: null, mailboxId: null, contactEmail: 'sarah@example.com' })).toBe(COMPANY_SENDER_FOOTER)
    expect(COMPANY_SENDER_FOOTER).toBe('Sent from the company address')
  })

  it('"Checking studio accounts…" while the list is asked for and unanswered — Send is disabled on this', () => {
    expect(contactEmailFooter({ mailboxes: null, mailboxId: null, ...contact })).toBe(AWAITING_SENDER_FOOTER)
    expect(AWAITING_SENDER_FOOTER).toBe('Checking studio accounts…')
  })

  it('names the failure when the list could not load, and says what will happen instead', () => {
    expect(contactEmailFooter({ mailboxes: MAILBOXES_UNAVAILABLE, mailboxId: null, ...contact })).toBe(UNAVAILABLE_SENDER_FOOTER)
    expect(UNAVAILABLE_SENDER_FOOTER).toBe('Couldn’t load studio accounts — will send from the company address')
  })

  it('footer and send agree on every input — the one claim this file exists to pin', () => {
    const cases = [
      { mailboxes: null, mailboxId: null, ...contact },
      { mailboxes: undefined, mailboxId: null, ...contact },
      { mailboxes: null, mailboxId: null, contactEmail: 'sarah@example.com', contactLocationId: null },
      { mailboxes: MAILBOXES_UNAVAILABLE, mailboxId: null, ...contact },
      { mailboxes: [], mailboxId: null, ...contact },
      { mailboxes: [box()], mailboxId: 'mb-1', ...contact },
      { mailboxes: [box()], mailboxId: 'mb-stale', ...contact },
      { mailboxes: [box()], mailboxId: 'mb-1', contactEmail: null, contactLocationId: STILL },
    ]
    for (const c of cases) {
      const send = resolveContactEmailSend(c)
      const footer = contactEmailFooter(c)
      if (send.path === 'mail') expect(footer).toBe('hello@un1tdublin.com')
      else if (send.path === 'awaiting') expect(footer).toBe(AWAITING_SENDER_FOOTER)
      else {
        expect(send.path).toBe('company')
        expect(footer).toBe(send.reason === 'unavailable' ? UNAVAILABLE_SENDER_FOOTER : COMPANY_SENDER_FOOTER)
      }
    }
  })
})
