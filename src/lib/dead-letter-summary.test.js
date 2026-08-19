// dead-letter-summary — the triage line must describe the envelope, never the
// body. Every email-family payload here carries a body field the summary is
// forbidden to echo (HtmlBody / TextBody / text_body): each case asserts the
// facts appear AND the body text does not.

import { describe, it, expect } from 'vitest'
import { summarizeDeadLetter, providerLabel, DEAD_LETTER_PROVIDER_LABELS } from './dead-letter-summary.js'

describe('providerLabel', () => {
  it('labels every registered provider and falls back to the raw key', () => {
    for (const [key, label] of Object.entries(DEAD_LETTER_PROVIDER_LABELS)) {
      expect(providerLabel(key)).toBe(label)
    }
    expect(providerLabel('some_new_provider')).toBe('some_new_provider')
    expect(providerLabel(null)).toBe('unknown')
  })
})

describe('summarizeDeadLetter — postmark_inbound', () => {
  const payload = {
    MessageID: 'pm-1',
    From: 'Ada Member <member@example.com>',
    FromFull: { Email: 'member@example.com', Name: 'Ada Member' },
    ToFull: [{ Email: 'accounts@hatchstreetfitness.com' }, { Email: 'sales@hatchstreetfitness.com' }],
    Subject: 'Billing question',
    TextBody: 'SECRET BODY my direct debit bounced',
    HtmlBody: '<p>SECRET BODY my direct debit bounced</p>',
  }

  it('summarises the envelope, never the body', () => {
    const s = summarizeDeadLetter({ provider: 'postmark_inbound', payload })
    expect(s).toContain('member@example.com')
    expect(s).toContain('accounts@hatchstreetfitness.com')
    expect(s).toContain('+1 more')
    expect(s).toContain('Billing question')
    expect(s).not.toContain('SECRET BODY')
    expect(s).not.toContain('<p>')
  })

  it('falls back to the raw To/From strings and survives an empty payload', () => {
    const s = summarizeDeadLetter({
      provider: 'postmark_inbound',
      payload: { From: 'x@y.com', To: 'a@b.com, c@d.com', HtmlBody: '<b>no</b>' },
    })
    expect(s).toContain('x@y.com')
    expect(s).toContain('a@b.com')
    expect(s).toContain('+1 more')
    expect(summarizeDeadLetter({ provider: 'postmark_inbound', payload: {} })).toBe('')
    expect(summarizeDeadLetter({ provider: 'postmark_inbound' })).toBe('')
  })
})

describe('summarizeDeadLetter — delivery events', () => {
  it('names the RFC-8058 one-click unsubscribe explicitly', () => {
    const s = summarizeDeadLetter({
      provider: 'postmark_queue',
      event_type: 'SubscriptionChange',
      payload: { RecordType: 'SubscriptionChange', SuppressSending: true, Recipient: 'member@example.com' },
    })
    expect(s).toBe('One-click unsubscribe for member@example.com')
  })

  it('summarises a bounce by recipient (both queue and ingest keys)', () => {
    const payload = { RecordType: 'Bounce', Email: 'gone@example.com', Type: 'HardBounce' }
    expect(summarizeDeadLetter({ provider: 'postmark_queue', payload })).toBe('Bounce for gone@example.com')
    expect(summarizeDeadLetter({ provider: 'postmark', payload })).toBe('Bounce for gone@example.com')
  })
})

describe('summarizeDeadLetter — sent-but-unfiled ticket mail', () => {
  const payload = {
    ticket_id: 'tick-1234',
    postmark_message_id: 'pm-9',
    from_email: 'accounts@hatchstreetfitness.com',
    recipients: { to: ['member@example.com', 'cc@example.com'], cc: [], bcc: [] },
    subject: 'Re: Billing question',
    text_body: 'SECRET SIGNED BODY do not render',
  }

  it.each(['email_ticket_reply', 'email_ticket_compose', 'email_ticket_forward'])(
    '%s: envelope + the not-filed warning, never the signed body',
    (provider) => {
      const s = summarizeDeadLetter({ provider, payload })
      expect(s).toContain('Re: Billing question')
      expect(s).toContain('member@example.com')
      expect(s).toContain('+1 more')
      expect(s).toContain('not filed on ticket tick-1234')
      expect(s).toContain('delivered')
      expect(s).not.toContain('SECRET SIGNED BODY')
    }
  )

  it('still warns when the payload is thin', () => {
    const s = summarizeDeadLetter({ provider: 'email_ticket_reply', payload: {} })
    expect(s).toBe('Delivered, not filed')
  })
})

describe('summarizeDeadLetter — zoom_contact_sync (ZOOMSYNC.4)', () => {
  it('leads with the number, which is the thing to go and fix', () => {
    const s = summarizeDeadLetter({
      provider: 'zoom_contact_sync',
      event_type: 'create',
      payload: { op: 'create', e164: '+87654567890', name: 'Aoife Ryan', contactId: 'c-1' },
    })
    expect(s).toBe('create +87654567890 — contact c-1')
  })

  it('does not echo the member name — the number and the id are enough to act', () => {
    const s = summarizeDeadLetter({
      provider: 'zoom_contact_sync',
      payload: { op: 'update', e164: '+353871111111', name: 'Aoife Ryan', contactId: 'c-2' },
    })
    expect(s).not.toContain('Aoife')
  })

  it('says nothing when the payload carries no number', () => {
    expect(summarizeDeadLetter({ provider: 'zoom_contact_sync', payload: {} })).toBe('')
  })

  it('is labelled for an operator', () => {
    expect(providerLabel('zoom_contact_sync')).toBe('Zoom directory write refused')
  })
})

describe('summarizeDeadLetter — unknown providers', () => {
  it('says nothing rather than echoing arbitrary payload fields', () => {
    expect(summarizeDeadLetter({ provider: 'glofox', payload: { secret_token: 'abc' } })).toBe('')
    expect(summarizeDeadLetter({ provider: 'inbody', payload: { tel_hp: '0851234567' } })).toBe('')
    expect(summarizeDeadLetter(null)).toBe('')
  })
})

describe('summarizeDeadLetter — length cap', () => {
  it('clips runaway fields', () => {
    const s = summarizeDeadLetter({
      provider: 'postmark_inbound',
      payload: { From: 'x@y.com', Subject: 'A'.repeat(500) },
    })
    expect(s.length).toBeLessThan(200)
    expect(s).toContain('…')
  })
})
