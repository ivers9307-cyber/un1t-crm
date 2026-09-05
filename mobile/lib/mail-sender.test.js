// MOBILE-MAILPARITY.1 — the tested unit behind the contact card's Email
// action. The modal (components/ContactComposeModal.jsx) has no render
// harness, so every branch that decides WHO A CONTACT-CARD EMAIL GOES OUT AS
// lives in the pure helper and is pinned here.
//
// THE PROPERTIES THIS FILE EXISTS FOR (each mirrors the web ContactComposer,
// PROFILE-MAIL.1, which is the reference):
//   1. A usable studio account → the send IS a Mail compose: mailbox_id, the
//      contact's address as the one recipient, the MAILBOX'S studio as the
//      request's location. Never the company sender while an account exists.
//   2. No account, no address, or a list not yet answered → the company path,
//      exactly as before this feature. "Not yet answered" is null, and null
//      must go company: what the footer says at click time is what happens.
//   3. A mailbox id that is NOT in the visible list never goes on the wire —
//      the route would 404 it anyway; here it degrades to the company path
//      rather than a refused send.
//   4. The footer states the path truthfully: the address the member will
//      hear from, or the company wording — never one while doing the other.

import { describe, it, expect } from 'vitest'
import { resolveContactEmailSend, contactEmailFooter, COMPANY_SENDER_FOOTER } from './mail-sender'

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

describe('resolveContactEmailSend — the Mail path when an account exists', () => {
  it('posts a compose from the chosen mailbox, to the contact, at the mailbox’s studio', () => {
    const out = resolveContactEmailSend({
      mailboxes: [box()],
      mailboxId: 'mb-1',
      contactEmail: 'sarah@example.com',
      contactLocationId: STILL,
    })
    expect(out).toEqual({
      path: 'mail',
      mailboxId: 'mb-1',
      to: ['sarah@example.com'],
      locationId: STILL,
    })
  })

  it('the request location is the MAILBOX’s studio, not the contact’s — a Hatch account sends as Hatch', () => {
    const out = resolveContactEmailSend({
      mailboxes: [box({ id: 'mb-h', location_id: HATCH })],
      mailboxId: 'mb-h',
      contactEmail: 'sarah@example.com',
      contactLocationId: STILL,
    })
    expect(out.locationId).toBe(HATCH)
  })

  it('falls back to the contact’s studio when the mailbox row carries no location stamp', () => {
    const out = resolveContactEmailSend({
      mailboxes: [box({ location_id: undefined })],
      mailboxId: 'mb-1',
      contactEmail: 'sarah@example.com',
      contactLocationId: STILL,
    })
    expect(out.locationId).toBe(STILL)
  })
})

describe('resolveContactEmailSend — the company path, exactly as before', () => {
  it('list not yet answered (null) → company; the footer said company, so the send must too', () => {
    expect(resolveContactEmailSend({
      mailboxes: null, mailboxId: null, contactEmail: 'sarah@example.com', contactLocationId: STILL,
    })).toEqual({ path: 'company' })
  })

  it('no usable account ([]) → company', () => {
    expect(resolveContactEmailSend({
      mailboxes: [], mailboxId: null, contactEmail: 'sarah@example.com', contactLocationId: STILL,
    })).toEqual({ path: 'company' })
  })

  it('no contact address → company even with an account (the compose route takes recipients, not a contact id)', () => {
    expect(resolveContactEmailSend({
      mailboxes: [box()], mailboxId: 'mb-1', contactEmail: null, contactLocationId: STILL,
    })).toEqual({ path: 'company' })
    expect(resolveContactEmailSend({
      mailboxes: [box()], mailboxId: 'mb-1', contactEmail: '', contactLocationId: STILL,
    })).toEqual({ path: 'company' })
  })

  it('a mailbox id outside the visible list never goes on the wire', () => {
    expect(resolveContactEmailSend({
      mailboxes: [box()], mailboxId: 'mb-stale', contactEmail: 'sarah@example.com', contactLocationId: STILL,
    })).toEqual({ path: 'company' })
  })
})

describe('contactEmailFooter — says which path the send will take', () => {
  it('names the address the member will hear from on the Mail path', () => {
    expect(contactEmailFooter({ mailboxes: [box()], mailboxId: 'mb-1' })).toBe('hello@un1tdublin.com')
  })

  it('falls back to the label when a mailbox has no address', () => {
    expect(contactEmailFooter({ mailboxes: [box({ address: null })], mailboxId: 'mb-1' })).toBe('Front desk')
  })

  it('company wording while the list is unanswered, empty, or the id is stale', () => {
    expect(contactEmailFooter({ mailboxes: null, mailboxId: null })).toBe(COMPANY_SENDER_FOOTER)
    expect(contactEmailFooter({ mailboxes: [], mailboxId: null })).toBe(COMPANY_SENDER_FOOTER)
    expect(contactEmailFooter({ mailboxes: [box()], mailboxId: 'mb-stale' })).toBe(COMPANY_SENDER_FOOTER)
  })

  it('footer and send agree on every input — the one claim this file exists to pin', () => {
    const cases = [
      { mailboxes: null, mailboxId: null },
      { mailboxes: [], mailboxId: null },
      { mailboxes: [box()], mailboxId: 'mb-1' },
      { mailboxes: [box()], mailboxId: 'mb-stale' },
    ]
    for (const c of cases) {
      const send = resolveContactEmailSend({ ...c, contactEmail: 'sarah@example.com', contactLocationId: STILL })
      const footer = contactEmailFooter(c)
      expect(footer === COMPANY_SENDER_FOOTER).toBe(send.path === 'company')
    }
  })
})
