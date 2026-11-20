import { describe, it, expect, vi, beforeEach } from 'vitest'

let consent
const sendTransactionalEmail = vi.fn()
vi.mock('@/lib/transactional-consent', () => ({ checkTransactionalConsent: vi.fn(async () => consent) }))
vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: (...a) => sendTransactionalEmail(...a) }))
vi.mock('@/lib/event-comms-location', () => ({ resolveEventCommsLocation: vi.fn(async () => ({ id: 'L1', name: 'UN1T Stillorgan' })) }))
vi.mock('@/lib/event-email', () => ({
  resolveEventEmail: vi.fn(async ({ defaults }) => ({ subject: defaults.subject, htmlBody: `${defaults.introHtml}${defaults.infoRows}` })),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => null }))

const { sendRaffleTicketsEmail } = await import('./raffle-email.js')

function fakeDb() {
  const updates = []
  const db = {
    updates,
    from(table) {
      return {
        update(fields) {
          const q = { eq: () => q, then: (ok) => { updates.push({ table, fields }); return ok({ error: null }) } }
          return q
        },
      }
    },
  }
  return db
}

const SALE = { id: 's1', raffle_id: 'r1', contact_id: null, buyer_name: 'Sarah Byrne', buyer_email: 'sarah@example.test', quantity: 3, total_cents: 1500, first_ticket: 41, last_ticket: 43 }
const RAFFLE = { id: 'r1', name: 'Charity Day Raffle', currency: 'EUR', email_subject: null, email_intro: null }
const RACE = { id: 'e1', name: 'MS Ireland Charity Day', location_id: 'L1', host_id: null }

beforeEach(() => {
  consent = { allowed: true, reason: null }
  sendTransactionalEmail.mockReset()
})

describe('sendRaffleTicketsEmail', () => {
  it('sends the numbers to the buyer and stamps sent', async () => {
    const db = fakeDb()
    const r = await sendRaffleTicketsEmail({ db, sale: SALE, raffle: RAFFLE, race: RACE, now: () => 'NOW' })
    expect(r.status).toBe('sent')
    const arg = sendTransactionalEmail.mock.calls[0][0]
    expect(arg.to).toBe('sarah@example.test')
    expect(arg.tag).toBe('raffle-tickets')
    expect(arg.contactId).toBeNull()
    expect(arg.htmlBody).toContain('#041–#043')
    expect(arg.subject).toBe('Your raffle tickets for MS Ireland Charity Day')
    expect(db.updates).toEqual([{ table: 'raffle_sales', fields: { email_status: 'sent', email_sent_at: 'NOW' } }])
  })

  it('does not send when consent refuses, and stamps suppressed', async () => {
    consent = { allowed: false, reason: 'bounced' }
    const db = fakeDb()
    const r = await sendRaffleTicketsEmail({ db, sale: { ...SALE, contact_id: 'c1' }, raffle: RAFFLE, race: RACE })
    expect(r.status).toBe('suppressed')
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(db.updates[0].fields).toEqual({ email_status: 'suppressed' })
  })

  it('a send failure is reported, stamped failed, and never thrown', async () => {
    sendTransactionalEmail.mockRejectedValue(new Error('postmark down'))
    const db = fakeDb()
    const r = await sendRaffleTicketsEmail({ db, sale: SALE, raffle: RAFFLE, race: RACE })
    expect(r.status).toBe('failed')
    expect(db.updates[0].fields).toEqual({ email_status: 'failed' })
  })
})
