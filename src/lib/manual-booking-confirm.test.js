import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn(async () => ({ ok: true })), getLocationInboxReplyTo: vi.fn(async () => 'hatchstreet@example.test') }))
vi.mock('@/lib/transactional-consent', async (importOriginal) => ({
  ...(await importOriginal()),
  loadTransactionalConsent: vi.fn(async () => ({ contact: { id: 'c1', email_status: 'active', contact_preferences: { email_administrative: true } }, unreadable: false })),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Hatch Street', shortName: 'UN1T', locationName: 'Hatch Street' })) }))

import { sendTransactionalEmail, getLocationInboxReplyTo } from '@/lib/postmark'
import { loadTransactionalConsent } from '@/lib/transactional-consent'
import { getLocationBranding } from '@/lib/location-branding'
import {
  sendManualBookingConfirmEmail,
  manualConfirmEmailFromBlocks,
  formatClassTime,
  confirmEmailHtml,
  DEFAULT_MANUAL_CONFIRM_EMAIL,
} from './manual-booking-confirm'

// All names and addresses are synthetic.
const contact = { id: 'c1', first_name: 'Sam', name: 'Sam Byrne', email: 'sam@example.com' }
const args = {
  locationId: 'L1', contact, className: 'DUO - STRENGTH',
  startsAt: '2026-10-05T05:00:00.000Z', // 06:00 Dublin (summer time)
  blocks: [{ type: 'class_funnel' }],
  studioName: 'UN1T Hatch Street', address: 'Vault 8, Hatch Street Upper, Dublin 2',
}

beforeEach(() => vi.clearAllMocks())

describe('formatClassTime', () => {
  it('renders the Dublin wall clock with the day', () => {
    expect(formatClassTime('2026-10-05T05:00:00.000Z')).toBe('Monday 5 October at 06:00')
    expect(formatClassTime('2026-10-27T17:30:00.000Z')).toBe('Tuesday 27 October at 17:30') // GMT after the clocks go back
  })
  it('is blank for an unreadable time', () => {
    expect(formatClassTime(null)).toBe('')
    expect(formatClassTime('soon')).toBe('')
  })
})

describe('manualConfirmEmailFromBlocks', () => {
  it('uses the defaults when the block has no copy, or the copy is blank', () => {
    expect(manualConfirmEmailFromBlocks(null)).toEqual({ subject: DEFAULT_MANUAL_CONFIRM_EMAIL.subject, body: DEFAULT_MANUAL_CONFIRM_EMAIL.body })
    expect(manualConfirmEmailFromBlocks([{ type: 'class_funnel', confirm_email_subject: '  ', confirm_email_body: '' }]))
      .toEqual({ subject: DEFAULT_MANUAL_CONFIRM_EMAIL.subject, body: DEFAULT_MANUAL_CONFIRM_EMAIL.body })
  })
  it("prefers the operator's copy", () => {
    expect(manualConfirmEmailFromBlocks([{ type: 'hero' }, { type: 'class_funnel', confirm_email_subject: 'See you {first_name}', confirm_email_body: 'Booked: {class_name}' }]))
      .toEqual({ subject: 'See you {first_name}', body: 'Booked: {class_name}' })
  })
  it('the defaults carry no em-dashes and every placeholder it promises', () => {
    const all = `${DEFAULT_MANUAL_CONFIRM_EMAIL.subject}\n${DEFAULT_MANUAL_CONFIRM_EMAIL.body}`
    expect(all).not.toMatch(/—/)
    for (const k of ['first_name', 'class_name', 'class_time', 'studio_name', 'address']) expect(all).toContain(`{${k}}`)
  })
})

describe('confirmEmailHtml', () => {
  it('escapes markup and keeps line breaks', () => {
    expect(confirmEmailHtml('a <b> & c\nd')).toContain('a &lt;b&gt; &amp; c<br>d')
  })
})

describe('sendManualBookingConfirmEmail', () => {
  it('sends the rendered default email through the transactional sender, logged against the contact and location', async () => {
    const r = await sendManualBookingConfirmEmail({}, args)
    expect(r).toEqual({ sent: true, channel: 'email' })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    const call = sendTransactionalEmail.mock.calls[0][0]
    expect(call).toMatchObject({ to: 'sam@example.com', contactId: 'c1', locationId: 'L1', tag: 'class_booking_confirmation', subject: 'You are booked in at UN1T Hatch Street', replyTo: 'hatchstreet@example.test' })
    expect(call.htmlBody).toContain('Hi Sam,')
    expect(call.htmlBody).toContain('DUO - STRENGTH on Monday 5 October at 06:00 at UN1T Hatch Street')
    expect(call.htmlBody).toContain('Vault 8, Hatch Street Upper, Dublin 2')
    expect(call.htmlBody).not.toMatch(/\{[a-z_]+\}/)
  })

  it('a studio with no inbox address sends with no Reply-To rather than failing', async () => {
    getLocationInboxReplyTo.mockResolvedValueOnce(null)
    expect(await sendManualBookingConfirmEmail({}, args)).toEqual({ sent: true, channel: 'email' })
    expect(sendTransactionalEmail.mock.calls[0][0].replyTo).toBeUndefined()
  })

  it("uses the operator's copy when the block has it, and strips em-dashes", async () => {
    await sendManualBookingConfirmEmail({}, { ...args, blocks: [{ type: 'class_funnel', confirm_email_subject: '{class_name} — booked', confirm_email_body: 'Hi {first_name}. {class_time}. {address}' }] })
    const call = sendTransactionalEmail.mock.calls[0][0]
    expect(call.subject).toBe('DUO - STRENGTH, booked')
    expect(call.htmlBody).toContain('Hi Sam. Monday 5 October at 06:00. Vault 8, Hatch Street Upper, Dublin 2')
  })

  it('greets "there" when the contact has no first name', async () => {
    await sendManualBookingConfirmEmail({}, { ...args, contact: { id: 'c1', email: 'x@example.com' } })
    expect(sendTransactionalEmail.mock.calls[0][0].htmlBody).toContain('Hi there,')
  })

  it('no email address → nothing sent, reason no_email', async () => {
    expect(await sendManualBookingConfirmEmail({}, { ...args, contact: { id: 'c1', email: '  ' } })).toEqual({ sent: false, channel: 'email', reason: 'no_email' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('a bounced address or an administrative opt-out → nothing sent, reason email_blocked', async () => {
    loadTransactionalConsent.mockResolvedValueOnce({ contact: { id: 'c1', email_status: 'bounced' }, unreadable: false })
    expect(await sendManualBookingConfirmEmail({}, args)).toEqual({ sent: false, channel: 'email', reason: 'email_blocked' })
    loadTransactionalConsent.mockResolvedValueOnce({ contact: { id: 'c1', email_status: 'active', contact_preferences: { email_administrative: false } }, unreadable: false })
    expect(await sendManualBookingConfirmEmail({}, args)).toEqual({ sent: false, channel: 'email', reason: 'email_blocked' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('an unreadable consent row is not "no opt-out": nothing sent, reason consent_unreadable', async () => {
    loadTransactionalConsent.mockResolvedValueOnce({ contact: null, unreadable: true })
    expect(await sendManualBookingConfirmEmail({}, args)).toEqual({ sent: false, channel: 'email', reason: 'consent_unreadable' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('W1.S1a: a missing studio name resolves the location name, never a fixed gym', async () => {
    await sendManualBookingConfirmEmail({}, { ...args, studioName: '' })
    expect(getLocationBranding).toHaveBeenCalledWith({}, 'L1')
    expect(sendTransactionalEmail.mock.calls[0][0].subject).toBe('You are booked in at Hatch Street')
  })

  it('W1.S1a: a studio name in hand is used as is, with no lookup', async () => {
    await sendManualBookingConfirmEmail({}, args)
    expect(getLocationBranding).not.toHaveBeenCalled()
  })

  it('a sender failure never throws: reason send_error', async () => {
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark down'))
    expect(await sendManualBookingConfirmEmail({}, args)).toEqual({ sent: false, channel: 'email', reason: 'send_error' })
  })
})
