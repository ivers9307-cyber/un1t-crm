// UN1TDUN.1 — the shared dunning pieces are platform-aware: a run whose
// metadata.payment says platform 'un1t_online' is judged against the
// un1t.online mirror, never Glofox (even for a contact who also holds a
// Glofox member id), and its email wording names the un1t.online app.
// Glofox runs are covered, unchanged, by dunning-payment.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  getGlofoxInvoicePaymentLink: vi.fn(),
  getGlofoxOverdueInvoices: vi.fn(),
  GLOFOX_OVERDUE_INVOICES_PAGE_CAP: 20,
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/sequences/enrollment-status', () => ({ setEnrollmentStatus: vi.fn() }))
vi.mock('@/lib/un1t-dunning', () => ({ un1tDunningPresendGate: vi.fn(async () => ({ proceed: false, reason: 'invoice no longer overdue' })) }))

const { glofoxCredentialsForLocation, getGlofoxOverdueInvoices } = await import('@/lib/glofox')
const { un1tDunningPresendGate } = await import('@/lib/un1t-dunning')
const { dunningPresendGate, paymentCtaHtml } = await import('./dunning-payment.js')

const UN1T_PAYMENT = { invoice_id: 'in_123', link: 'https://hatch.example.test/pay-link/tok', link_suffix: 'tok', amount: '€189', platform: 'un1t_online' }
const enrollment = (over = {}) => ({ id: 'e1', contact_id: 'c1', source_type: 'invoice_past_due', metadata: { payment: UN1T_PAYMENT }, ...over })
const contact = { id: 'c1', glofox_member_id: 'gf-member' }
const sequence = { id: 's1', location_id: 'loc-hatch' }

beforeEach(() => { vi.clearAllMocks() })

describe('dunningPresendGate on a un1t.online run', () => {
  it('goes to the un1t gate and never to Glofox, even with a Glofox member id on the contact', async () => {
    const db = {}
    const ctx = { enrollment: enrollment(), contact, sequence }
    expect(await dunningPresendGate(db, ctx)).toEqual({ proceed: false, reason: 'invoice no longer overdue' })
    expect(un1tDunningPresendGate).toHaveBeenCalledWith(db, ctx)
    expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
    expect(getGlofoxOverdueInvoices).not.toHaveBeenCalled()
  })

  it('a non-dunning enrolment proceeds without any read', async () => {
    expect(await dunningPresendGate({}, { enrollment: enrollment({ source_type: 'manual' }), contact, sequence })).toEqual({ proceed: true })
    expect(un1tDunningPresendGate).not.toHaveBeenCalled()
  })

  it('no invoice on the run: proceeds without any read', async () => {
    const e = enrollment({ metadata: { payment: { ...UN1T_PAYMENT, invoice_id: null } } })
    expect(await dunningPresendGate({}, { enrollment: e, contact, sequence })).toEqual({ proceed: true })
    expect(un1tDunningPresendGate).not.toHaveBeenCalled()
  })

  it('a throwing un1t gate fails open', async () => {
    un1tDunningPresendGate.mockRejectedValueOnce(new Error('boom'))
    expect(await dunningPresendGate({}, { enrollment: enrollment(), contact, sequence })).toEqual({ proceed: true })
  })
})

describe('paymentCtaHtml on a un1t.online run', () => {
  it('names the un1t.online app, with or without a link', () => {
    expect(paymentCtaHtml(UN1T_PAYMENT)).toBe('<a href="https://hatch.example.test/pay-link/tok">pay it now</a>, it takes a few seconds, or update your card in the un1t.online app')
    expect(paymentCtaHtml({ ...UN1T_PAYMENT, link: null })).toBe('update your card in the un1t.online app')
  })
})
