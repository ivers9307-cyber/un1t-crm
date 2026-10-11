import { describe, it, expect, vi, beforeEach } from 'vitest'

// W1.L3b — the HOST's review email links land on the tenant host of the
// event's location (the host's anchor); the admin's review-queue email stays
// on the CRM host.
vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.x.com' }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://gym-a.repset.ie') }))

import { assembleHostRecipients, buildReviewedEmail, buildSubmittedEmail, notifyHostEventReviewed, notifyAdminsEventSubmitted } from './host-notifications'
import { sendTransactionalEmail } from '@/lib/postmark'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'

beforeEach(() => { vi.clearAllMocks() })

describe('assembleHostRecipients', () => {
  it('dedupes + lowercases host email and linked logins, skipping empties', () => {
    expect(assembleHostRecipients({ email: 'Host@X.ie' }, [{ email: 'host@x.ie' }, { email: 'B@x.ie' }, { email: null }]))
      .toEqual(['host@x.ie', 'b@x.ie'])
  })
  it('handles missing host email and empty links', () => {
    expect(assembleHostRecipients({ email: null }, [])).toEqual([])
  })
})

describe('buildReviewedEmail', () => {
  const event = { name: 'Summer Throwdown', slug: 'summer-throwdown' }
  it('approved: subject says live + body links the public page', () => {
    const m = buildReviewedEmail({ event, action: 'approve', baseUrl: 'https://crm.x.com' })
    expect(m.subject).toContain('live')
    expect(m.htmlBody).toContain('https://crm.x.com/event/summer-throwdown')
  })
  it('rejected: subject says needs changes + body carries the escaped reason + portal link', () => {
    const m = buildReviewedEmail({ event, action: 'reject', reason: 'Fix <the> date', baseUrl: 'https://crm.x.com' })
    expect(m.subject).toContain('needs changes')
    expect(m.htmlBody).toContain('Fix &lt;the&gt; date')
    expect(m.htmlBody).toContain('https://crm.x.com/host')
  })
})

describe('buildSubmittedEmail', () => {
  it('names the host + event and links the review queue', () => {
    const m = buildSubmittedEmail({ event: { name: 'Gala' }, host: { name: 'Acme' }, appUrl: 'https://crm.x.com' })
    expect(m.subject).toContain('Gala')
    expect(m.htmlBody).toContain('Acme')
    expect(m.htmlBody).toContain('https://crm.x.com/settings/hosts')
  })
})

function fakeDb({ links = [{ email: 'login@x.ie' }], profiles = [{ email: 'admin@x.ie' }] } = {}) {
  return {
    from(table) {
      const b = { select() { return b }, eq() { return b }, in() { return b } }
      const answer = () => {
        if (table === 'host_users') return { data: links, error: null }
        if (table === 'locations') return { data: [{ id: 'L1' }], error: null }
        if (table === 'profile_locations') return { data: [{ profile_id: 'p1' }], error: null }
        if (table === 'profiles') return { data: profiles, error: null }
        return { data: null, error: null }
      }
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  }
}

describe('W1.L3b — notifyHostEventReviewed mints the host-facing links on the tenant host', () => {
  const event = { id: 'e1', name: 'Summer Throwdown', slug: 'summer-throwdown', location_id: 'L1' }
  it("resolves the host's anchor location and links the public page there", async () => {
    const db = fakeDb()
    await notifyHostEventReviewed({ db, event, host: { id: 'h1', email: 'host@x.ie', anchor_location_id: 'L-anchor' }, action: 'approve' })
    expect(resolveCustomerBaseUrl).toHaveBeenCalledWith(db, 'L-anchor')
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2)
    expect(sendTransactionalEmail.mock.calls[0][0].htmlBody).toContain('https://gym-a.repset.ie/event/summer-throwdown')
    expect(sendTransactionalEmail.mock.calls[0][0].htmlBody).not.toContain('crm.x.com')
  })
  it("falls back to the event's location when the host row carries no anchor, and the portal link is on the same host", async () => {
    const db = fakeDb()
    await notifyHostEventReviewed({ db, event, host: { id: 'h1', email: 'host@x.ie' }, action: 'reject', reason: 'no' })
    expect(resolveCustomerBaseUrl).toHaveBeenCalledWith(db, 'L1')
    expect(sendTransactionalEmail.mock.calls[0][0].htmlBody).toContain('https://gym-a.repset.ie/host')
  })
  it('the admin review-queue email stays on the CRM host', async () => {
    await notifyAdminsEventSubmitted({ db: fakeDb(), event, host: { id: 'h1', name: 'Acme' }, orgId: 'o1' })
    expect(resolveCustomerBaseUrl).not.toHaveBeenCalled()
    expect(sendTransactionalEmail.mock.calls[0][0].htmlBody).toContain('https://crm.x.com/settings/hosts')
  })
})
