// UN1TWRITE.21 — the two customer emails of the un1t.online funnel: the
// account explanation (a new account was made for them) and the trial-used
// email (no booking; here are the options). Operator-editable, consent-gated.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn(async () => ({})), getLocationInboxReplyTo: vi.fn(async () => 'hatch-inbox@example.test') }))
vi.mock('@/lib/transactional-consent', () => ({
  loadTransactionalConsent: vi.fn(async () => ({ contact: {}, unreadable: false })),
  transactionalEmailSuppression: vi.fn(() => null),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ locationName: 'Brand Studio', companyName: null })) }))
vi.mock('./un1t-online-trial-used', async (o) => ({ ...(await o()), trialUsedOptionsText: vi.fn(async () => null) }))

import { sendUn1tAccountEmail, sendUn1tTrialUsedEmail } from './un1t-online-funnel-emails'
import { DEFAULT_FUNNEL_EMAIL_COPY } from './un1t-online-funnel-copy'
import { trialUsedHandoff } from './un1t-online-trial-used'
import { trialUsedOptionsText } from './un1t-online-trial-used'
import { sendTransactionalEmail } from '@/lib/postmark'
import { loadTransactionalConsent, transactionalEmailSuppression } from '@/lib/transactional-consent'

const contact = { id: 'c-1', email: 'jane@example.test', first_name: 'Jane', name: 'Jane Doe' }
const base = { locationId: 'loc-1', contact, className: 'RALLY', startsAt: '2026-10-20T17:00:00.000Z', studioName: 'Hatch Street', zone: 'Europe/Dublin' }
const CAPACITY = /spot|capacity|space|place|seat|full|remaining/i
const sent = () => sendTransactionalEmail.mock.calls.at(-1)[0]

beforeEach(() => vi.clearAllMocks())

describe('defaults', () => {
  it('carry no em-dash and no capacity', () => {
    for (const [k, v] of Object.entries(DEFAULT_FUNNEL_EMAIL_COPY)) {
      expect(v, k).not.toMatch(/[—–]/)
      expect(v, k).not.toMatch(CAPACITY)
    }
  })
})

describe('sendUn1tAccountEmail', () => {
  it('renders every placeholder and goes through the transactional consent gate', async () => {
    const r = await sendUn1tAccountEmail({}, { ...base, blocks: [], address: '12 Hatch Street, Dublin 2.' })
    expect(r).toEqual({ sent: true, channel: 'email' })
    expect(loadTransactionalConsent).toHaveBeenCalledWith({}, 'c-1')
    const e = sent()
    expect(e.subject).toBe('You are booked in at Hatch Street')
    expect(e.htmlBody).toContain('Hi Jane, you are booked in for RALLY on Tuesday 20 October at 18:00 at Hatch Street. 12 Hatch Street, Dublin 2.')
    expect(e.htmlBody).toContain('un1t.online app')
    expect(e.htmlBody).not.toMatch(/\{[a-z_]+\}/)
    expect(e).toMatchObject({ to: 'jane@example.test', contactId: 'c-1', locationId: 'loc-1' })
  })

  it('a blocked address or unreadable consent sends nothing and says why', async () => {
    transactionalEmailSuppression.mockReturnValueOnce('bounced')
    expect(await sendUn1tAccountEmail({}, { ...base, blocks: [] })).toEqual({ sent: false, channel: 'email', reason: 'email_blocked' })
    loadTransactionalConsent.mockResolvedValueOnce({ contact: null, unreadable: true })
    expect(await sendUn1tAccountEmail({}, { ...base, blocks: [] })).toEqual({ sent: false, channel: 'email', reason: 'consent_unreadable' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it("operator copy from the block overrides each default", async () => {
    await sendUn1tAccountEmail({}, { ...base, blocks: [{ type: 'class_funnel', account_email_subject: 'Welcome, {first_name}', account_email_body: 'See you at {studio_name} — soon.' }] })
    expect(sent().subject).toBe('Welcome, Jane')
    expect(sent().htmlBody).toContain('See you at Hatch Street, soon.')
  })
})

describe('sendUn1tTrialUsedEmail', () => {
  it('sets the studio inbox Reply-To and contains no URL', async () => {
    await sendUn1tTrialUsedEmail({}, { ...base, blocks: [], options: 'Ten pack, EUR 90\nMonthly, EUR 120' })
    const e = sent()
    expect(e.replyTo).toBe('hatch-inbox@example.test')
    expect(e.subject).toBe('About your class at Hatch Street')
    expect(e.htmlBody).toContain('already had the free trial at Hatch Street')
    expect(e.htmlBody).toContain('Ten pack, EUR 90')
    expect(e.htmlBody).not.toMatch(/https?:\/\//)
  })

  it("an empty offer list renders 'a class pack or a membership'", async () => {
    await sendUn1tTrialUsedEmail({}, { ...base, blocks: [], options: null })
    expect(sent().htmlBody).toContain('To book it you can pick one of these: a class pack or a membership')
  })

  it("operator copy from the block overrides each default", async () => {
    await sendUn1tTrialUsedEmail({}, { ...base, blocks: [{ type: 'class_funnel', trial_used_email_subject: 'Hi {first_name}', trial_used_email_body: 'Options: {options}' }], options: null })
    expect(sent().subject).toBe('Hi Jane')
    expect(sent().htmlBody).toContain('Options: a class pack or a membership')
  })
})

describe('the E seam', () => {
  it('a request with no Flow thread, contact or studio is not handed off', async () => {
    expect(await trialUsedHandoff({}, { request: {}, contact, locationId: 'loc-1' })).toEqual({ handled: false })
  })

  it("the trial-used email asks the seam for the studio's offer list", async () => {
    trialUsedOptionsText.mockResolvedValueOnce('Ten pack, EUR 90')
    await sendUn1tTrialUsedEmail({}, { ...base, blocks: [] })
    expect(trialUsedOptionsText).toHaveBeenCalledWith({}, 'loc-1')
    expect(sent().htmlBody).toContain('Ten pack, EUR 90')
  })
})

describe('fallbacks', () => {
  it('a blank studio name reads the studio\'s own name; an address without a stop gets one; no double spaces', async () => {
    await sendUn1tAccountEmail({}, { ...base, studioName: '', blocks: [], address: '1 Hatch St, Dublin 2' })
    expect(sent().subject).toBe('You are booked in at Brand Studio')
    expect(sent().htmlBody).toContain('1 Hatch St, Dublin 2. We have set up')
    await sendUn1tAccountEmail({}, { ...base, blocks: [], address: null })
    expect(sent().htmlBody).not.toMatch(/ {2}/)
  })
})
