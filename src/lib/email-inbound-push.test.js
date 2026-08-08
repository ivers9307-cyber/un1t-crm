// EMAIL-INBOUND-PUSH.1 — staff push on inbound ticket mail (2026-08-08 audit
// P1: the WhatsApp and Instagram webhooks push; email silently didn't).
//
// THE PROPERTY UNDER TEST: the push recipient set is EXACTLY the people who
// could open the ticket — email_inbox at the ticket's location AND a grant on
// the ticket's mailbox (or elevated: master / owner-at-location). A push
// carries the sender's name and the subject line, so over-notifying is the
// same leak the mailbox grant model exists to prevent: a coach with no
// grant on accounts@ must not get billing subjects on their lock screen.
//
// That is also why a FAILED grant lookup drops the push entirely rather than
// degrading to "notify everyone at the location" — fail closed, like the
// route-side gate (loadVisibleMailboxes refuses rather than guessing).
//
// The batching rule: one push per ticket per unseen-burst, not one per
// message. A ticket whose unread_count was already > 0 has an outstanding
// ping nobody has acted on; re-pinging per message is noise. The gate is the
// PRE-increment unread count, which the webhook reads off the ticket row it
// already has — no timers, no extra state.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push', () => ({ sendPush: vi.fn() }))

import { sendPush } from './push'
import {
  shouldPushInboundEmail,
  inboundEmailPushRecipients,
  inboundEmailPushPayload,
  maybeNotifyInboundEmail,
} from './email-inbound-push'

// profile_locations row joined to profiles, the shape the loader selects.
function link(profile_id, role, { active = true, globalRole = null, permissions = null, employment_type = null } = {}) {
  return {
    profile_id,
    role,
    permissions,
    profiles: { id: profile_id, active, role: globalRole || role, employment_type },
  }
}

const MAILBOX = 'mb-accounts'

describe('shouldPushInboundEmail', () => {
  it('pushes for a member email landing on a quiet ticket', () => {
    expect(shouldPushInboundEmail({
      fromEmail: 'member@example.com',
      ownAddresses: ['accounts@hatchstreetfitness.com'],
      preUnreadCount: 0,
    })).toBe(true)
  })

  it('suppresses our own outbound arriving anywhere — case-insensitively', () => {
    // Compose from sales@ TO accounts@ arrives at accounts@'s webhook as
    // "inbound"; pinging staff about our own mail is noise.
    expect(shouldPushInboundEmail({
      fromEmail: 'Sales@HatchStreetFitness.com',
      ownAddresses: ['accounts@hatchstreetfitness.com', 'sales@hatchstreetfitness.com'],
      preUnreadCount: 0,
    })).toBe(false)
  })

  it('suppresses when the ticket already has unseen mail — the batching rule', () => {
    expect(shouldPushInboundEmail({
      fromEmail: 'member@example.com',
      ownAddresses: [],
      preUnreadCount: 2,
    })).toBe(false)
  })

  it('tolerates junk in the own-address list', () => {
    expect(shouldPushInboundEmail({
      fromEmail: 'member@example.com',
      ownAddresses: [null, undefined, '', 'accounts@hatchstreetfitness.com'],
      preUnreadCount: 0,
    })).toBe(true)
  })
})

describe('inboundEmailPushRecipients', () => {
  it('includes an owner with no grant row — elevated, like the read gate', () => {
    const ids = inboundEmailPushRecipients({
      links: [link('u-owner', 'owner')],
      templates: [],
      features: null,
      grantedProfileIds: [],
      mailboxId: MAILBOX,
    })
    expect(ids).toEqual(['u-owner'])
  })

  it('includes a master whose link here is a lowly role — global role wins', () => {
    const ids = inboundEmailPushRecipients({
      links: [link('u-master', 'staff', { globalRole: 'master' })],
      templates: [],
      features: null,
      grantedProfileIds: [],
      mailboxId: MAILBOX,
    })
    expect(ids).toEqual(['u-master'])
  })

  it('includes a granted manager and excludes an ungranted one', () => {
    const ids = inboundEmailPushRecipients({
      links: [link('u-granted', 'manager'), link('u-ungranted', 'manager')],
      templates: [],
      features: null,
      grantedProfileIds: ['u-granted'],
      mailboxId: MAILBOX,
    })
    expect(ids).toEqual(['u-granted'])
  })

  it('excludes a granted staffer whose role default lacks email_inbox — both gate levels apply', () => {
    const ids = inboundEmailPushRecipients({
      links: [link('u-staff', 'staff')],
      templates: [],
      features: null,
      grantedProfileIds: ['u-staff'],
      mailboxId: MAILBOX,
    })
    expect(ids).toEqual([])
  })

  it('includes that staffer once a per-user override grants email_inbox', () => {
    const ids = inboundEmailPushRecipients({
      links: [link('u-staff', 'staff', { permissions: { email_inbox: true } })],
      templates: [],
      features: null,
      grantedProfileIds: ['u-staff'],
      mailboxId: MAILBOX,
    })
    expect(ids).toEqual(['u-staff'])
  })

  it('honours an operator role template that turns email_inbox off', () => {
    const ids = inboundEmailPushRecipients({
      links: [link('u-manager', 'manager'), link('u-owner', 'owner')],
      templates: [{ role: 'manager', employment_type: 'all', permissions: { email_inbox: false } }],
      features: null,
      grantedProfileIds: ['u-manager'],
      mailboxId: MAILBOX,
    })
    expect(ids).toEqual(['u-owner'])
  })

  it('honours the location feature gate — off means nobody, master included', () => {
    const ids = inboundEmailPushRecipients({
      links: [link('u-master', 'owner', { globalRole: 'master' }), link('u-owner', 'owner')],
      templates: [],
      features: { email_inbox: false },
      grantedProfileIds: [],
      mailboxId: MAILBOX,
    })
    expect(ids).toEqual([])
  })

  it('excludes inactive profiles', () => {
    const ids = inboundEmailPushRecipients({
      links: [link('u-gone', 'owner', { active: false })],
      templates: [],
      features: null,
      grantedProfileIds: [],
      mailboxId: MAILBOX,
    })
    expect(ids).toEqual([])
  })

  it('a NULL-mailbox ticket notifies elevated only — no grant can exist for it', () => {
    const ids = inboundEmailPushRecipients({
      links: [link('u-owner', 'owner'), link('u-granted', 'manager')],
      templates: [],
      features: null,
      grantedProfileIds: ['u-granted'], // grant on some other mailbox — irrelevant here
      mailboxId: null,
    })
    expect(ids).toEqual(['u-owner'])
  })

  it('never yields duplicate ids', () => {
    const ids = inboundEmailPushRecipients({
      links: [link('u-owner', 'owner'), link('u-owner', 'owner')],
      templates: [],
      features: null,
      grantedProfileIds: [],
      mailboxId: MAILBOX,
    })
    expect(ids).toEqual(['u-owner'])
  })
})

describe('inboundEmailPushPayload', () => {
  it('titles with the sender, bodies with the subject, routes to the ticket', () => {
    expect(inboundEmailPushPayload({
      ticketId: 't-1',
      requesterName: 'Ada Member',
      fromEmail: 'member@example.com',
      subject: 'Billing question',
      preview: 'My direct debit bounced.',
    })).toEqual({
      title: 'Email · Ada Member',
      body: 'Billing question',
      category: 'email',
      data: { type: 'email_inbound', ticket_id: 't-1' },
    })
  })

  it('falls back to the address, then the preview, then a stock line', () => {
    const p = inboundEmailPushPayload({
      ticketId: 't-1',
      requesterName: null,
      fromEmail: 'member@example.com',
      subject: null,
      preview: 'Just checking in',
    })
    expect(p.title).toBe('Email · member@example.com')
    expect(p.body).toBe('Just checking in')

    const empty = inboundEmailPushPayload({ ticketId: 't-1', requesterName: null, fromEmail: null, subject: null, preview: '' })
    expect(empty.title).toBe('Email · New message')
    expect(empty.body).toBe('New email')
  })

  it('caps the body at 140 characters, like the other inbound channels', () => {
    const p = inboundEmailPushPayload({
      ticketId: 't-1', requesterName: 'A', fromEmail: 'a@b.c',
      subject: 'x'.repeat(200), preview: '',
    })
    expect(p.body).toHaveLength(140)
  })
})

// ── The db-facing wrapper ───────────────────────────────────────────
function fakeDb({ links = [], templates = [], features = null, grants = [], fail = {} } = {}) {
  const queried = []
  const db = {
    queried,
    from(table) {
      queried.push(table)
      const b = { _table: table }
      b.select = () => b
      b.eq = () => b
      b.limit = () => b
      b.maybeSingle = () => Promise.resolve(
        fail[table]
          ? { data: null, error: fail[table] }
          : { data: table === 'locations' ? { features } : null, error: null }
      )
      // supabase-js builders are thenables, not Promises.
      b.then = (res, rej) => {
        const data = {
          profile_locations: links,
          location_role_permissions: templates,
          email_mailbox_access: grants.map(id => ({ profile_id: id })),
        }[table] || []
        const out = fail[table] ? { data: null, error: fail[table] } : { data, error: null }
        return Promise.resolve(out).then(res, rej)
      }
      return b
    },
  }
  return db
}

const BASE = Object.freeze({
  locationId: 'loc-hatch',
  ticketId: 't-1',
  ticketMailboxId: MAILBOX,
  fromEmail: 'member@example.com',
  ownAddresses: ['accounts@hatchstreetfitness.com'],
  requesterName: 'Ada Member',
  subject: 'Billing question',
  preview: 'My direct debit bounced.',
  preUnreadCount: 0,
})

describe('maybeNotifyInboundEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendPush.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
  })

  it('sends to the resolved recipients, location-scoped', async () => {
    const db = fakeDb({
      links: [link('u-owner', 'owner'), link('u-granted', 'manager')],
      grants: ['u-granted'],
    })
    await maybeNotifyInboundEmail(db, BASE)
    expect(sendPush).toHaveBeenCalledTimes(1)
    const [ids, payload, opts] = sendPush.mock.calls[0]
    expect([...ids].sort()).toEqual(['u-granted', 'u-owner'])
    expect(payload).toMatchObject({ category: 'email', data: { type: 'email_inbound', ticket_id: 't-1' } })
    expect(opts).toEqual({ locationId: 'loc-hatch' })
  })

  it('does nothing — not even a query — when the gate says no', async () => {
    const db = fakeDb({ links: [link('u-owner', 'owner')] })
    await maybeNotifyInboundEmail(db, { ...BASE, preUnreadCount: 3 })
    expect(sendPush).not.toHaveBeenCalled()
    expect(db.queried).toEqual([])
  })

  it('fails CLOSED when the grant lookup errors — never guesses who may read accounts@', async () => {
    const db = fakeDb({
      links: [link('u-owner', 'owner'), link('u-granted', 'manager')],
      grants: ['u-granted'],
      fail: { email_mailbox_access: { message: 'boom' } },
    })
    await maybeNotifyInboundEmail(db, BASE)
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('fails closed when the assignment lookup errors', async () => {
    const db = fakeDb({
      links: [link('u-owner', 'owner')],
      fail: { profile_locations: { message: 'boom' } },
    })
    await maybeNotifyInboundEmail(db, BASE)
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('degrades a failed template lookup to code defaults, like resolvePushAllowedIds', async () => {
    const db = fakeDb({
      links: [link('u-granted', 'manager')],
      grants: ['u-granted'],
      fail: { location_role_permissions: { message: 'boom' } },
    })
    await maybeNotifyInboundEmail(db, BASE)
    expect(sendPush).toHaveBeenCalledTimes(1)
  })

  it('skips the send when nobody survives the gates', async () => {
    const db = fakeDb({ links: [link('u-staff', 'staff')], grants: ['u-staff'] })
    await maybeNotifyInboundEmail(db, BASE)
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('never throws — push is subordinate to filing the mail', async () => {
    const db = fakeDb({ links: [link('u-owner', 'owner')] })
    sendPush.mockRejectedValue(new Error('expo down'))
    await expect(maybeNotifyInboundEmail(db, BASE)).resolves.toBeUndefined()
  })
})
