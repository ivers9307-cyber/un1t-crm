import { describe, it, expect, vi, beforeEach } from 'vitest'

// W1.L3b — the HOST's review email links land on the tenant host of the
// event's location (the host's anchor); the admin's review-queue email stays
// on the CRM host.
vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.x.com' }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://gym-a.repset.ie') }))
vi.mock('@/lib/push-dedup', async (importOriginal) => ({ ...(await importOriginal()), sendPushOnce: vi.fn(async () => ({ ok: true })) }))

import { assembleHostRecipients, buildReviewedEmail, buildPublishedEmail, notifyHostEventReviewed, notifyAdminsEventPublished } from './host-notifications'
import * as hostNotifications from './host-notifications'
import { describeStudioChange, buildStudioChangeEmail, notifyAdminsEventStudioChange } from './host-notifications'
import { createFakeDb } from '../../tests/helpers/fake-db.js'
import { sendPushOnce } from '@/lib/push-dedup'
import { getNotificationCategory } from '@/lib/notifications-registry'
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

describe('buildPublishedEmail (HOSTAUTOPUB.1)', () => {
  it('tells staff the event is live, asks nothing, and links the staff edit page', () => {
    const m = buildPublishedEmail({ event: { id: 'e1', name: 'Gala', slug: 'gala' }, host: { name: 'Acme' }, appUrl: 'https://crm.x.com', publicBaseUrl: 'https://gym-a.repset.ie' })
    expect(m.subject).toBe('Host event published: Gala')
    expect(m.htmlBody).toContain('Acme')
    expect(m.htmlBody).toContain('nothing needs your approval')
    expect(m.htmlBody).toContain('https://crm.x.com/events/e1/edit')
    expect(m.htmlBody).toContain('https://gym-a.repset.ie/event/gala')
    expect(m.htmlBody).not.toMatch(/approve or reject|review queue|settings\/hosts/i)
  })
  it('leaves out the public link when there is no base url', () => {
    const m = buildPublishedEmail({ event: { id: 'e1', name: 'Gala', slug: 'gala' }, host: { name: 'Acme' }, appUrl: 'https://crm.x.com' })
    expect(m.htmlBody).not.toContain('/event/gala')
  })
  it('the old submitted-for-review builders are gone', () => {
    expect(hostNotifications.buildSubmittedEmail).toBeUndefined()
    expect(hostNotifications.notifyAdminsEventSubmitted).toBeUndefined()
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
  it('the admin notice links the staff page on the CRM host, and the public page on the tenant host', async () => {
    await notifyAdminsEventPublished({ db: fakeDb(), event, host: { id: 'h1', name: 'Acme' }, orgId: 'o1' })
    const body = sendTransactionalEmail.mock.calls[0][0].htmlBody
    expect(body).toContain('https://crm.x.com/events/e1/edit')
    expect(body).toContain('https://gym-a.repset.ie/event/summer-throwdown')
    expect(sendTransactionalEmail.mock.calls[0][0].tag).toBe('host-event-published')
  })
})

describe('HOSTAUTOPUB.1 — notifyAdminsEventPublished is a notice, not an approval', () => {
  const event = { id: 'e1', name: 'Summer Throwdown', slug: 'summer-throwdown', location_id: 'L1', submitted_at: '2026-11-22T10:00:00.000Z' }
  it('pushes the admins an informational notice on the registered category', async () => {
    const db = fakeDb()
    await notifyAdminsEventPublished({ db, event, host: { id: 'h1', name: 'Acme' }, orgId: 'o1' })
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
    const [, key, recipients, payload] = sendPushOnce.mock.calls[0]
    expect(key).toBe('host_event_published:e1:2026-11-22T10:00:00.000Z')
    expect(recipients).toEqual(['p1'])
    expect(payload).toEqual({
      title: 'Host event published',
      body: 'Acme published "Summer Throwdown". It is on sale now.',
      category: 'host_event_review',
      data: { type: 'host_event_published', event_id: 'e1' },
    })
    expect(payload.title).not.toMatch(/approval/i)
    // An unregistered category fails closed in sendPush: this one is registered.
    expect(getNotificationCategory(payload.category)).toBeTruthy()
    expect(getNotificationCategory(payload.category).label).toBe('Host event published')
  })
  it('a push failure never blocks the email', async () => {
    sendPushOnce.mockRejectedValueOnce(new Error('expo down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await notifyAdminsEventPublished({ db: fakeDb(), event, host: { id: 'h1', name: 'Acme' }, orgId: 'o1' })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('HOSTSTUDIONOTICE.1 — studio change notice', () => {
  const ORG = 'o0000000-0000-4000-8000-000000000001'
  const OTHER_ORG = 'o0000000-0000-4000-8000-000000000002'
  const HATCH = 'l0000000-0000-4000-8000-000000000001'
  const STILL = 'l0000000-0000-4000-8000-000000000002'
  const FOREIGN = 'l0000000-0000-4000-8000-000000000003'
  const event = { id: 'e1', name: 'Gala', location_id: HATCH }
  const host = { id: 'h1', name: 'Acme' }
  const db = () => createFakeDb({
    tables: {
      locations: [
        { id: HATCH, name: 'Hatch Street', organization_id: ORG },
        { id: STILL, name: 'Stillorgan', organization_id: ORG },
        { id: FOREIGN, name: 'Elsewhere Gym', organization_id: OTHER_ORG },
      ],
      profile_locations: [
        { profile_id: 'p1', location_id: HATCH, role: 'owner' },
        { profile_id: 'p2', location_id: STILL, role: 'staff' },
        { profile_id: 'p3', location_id: FOREIGN, role: 'owner' },
      ],
      profiles: [{ id: 'p1', email: 'Owner@X.ie' }, { id: 'p2', email: 'staff@x.ie' }, { id: 'p3', email: 'other@y.ie' }],
    },
  })

  it('describes each change in words', () => {
    expect(describeStudioChange({ reasons: ['studio'], studioName: 'Hatch Street' })).toBe('linked to Hatch Street')
    expect(describeStudioChange({ reasons: ['studio'], studioName: 'Hatch Street', previousStudioName: 'Stillorgan' })).toBe('moved from Stillorgan to Hatch Street')
    expect(describeStudioChange({ reasons: ['studio_hours'], growth: { later: '21:00' }, studioName: 'Hatch Street' })).toBe('now runs later (last session 21:00) at Hatch Street')
    expect(describeStudioChange({ reasons: ['studio_hours'], growth: { earlier: '07:00', longerHoldMinutes: 150 }, studioName: 'Hatch Street' }))
      .toBe('now starts earlier (first session 07:00) and holds the studio for longer (2 h 30 min) at Hatch Street')
  })
  it('the email names the event, the host and the change, asks nothing, and links the staff edit page', () => {
    const m = buildStudioChangeEmail({ event, host: { name: 'A<b>' }, change: 'linked to Hatch Street', appUrl: 'https://crm.x.com' })
    expect(m.subject).toBe('Host event studio change: Gala')
    expect(m.htmlBody).toContain('A&lt;b&gt;')
    expect(m.htmlBody).toContain('linked to Hatch Street')
    expect(m.htmlBody).toContain('Nothing needs your approval')
    expect(m.htmlBody).toContain('https://crm.x.com/events/e1/edit')
  })
  it("pushes and emails the org's admins only, in the registered category", async () => {
    await notifyAdminsEventStudioChange({ db: db(), event, host, orgId: ORG, reasons: ['studio'], studioId: HATCH, sessionTimes: ['10:00', '12:00'] })
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
    const [, key, recipients, payload] = sendPushOnce.mock.calls[0]
    expect(key).toBe(`host_event_studio:e1:${HATCH}:10:00-12:00:`)
    expect(recipients).toEqual(['p1'])
    expect(payload).toEqual({
      title: 'Host event studio change',
      body: 'Acme changed "Gala": linked to Hatch Street.',
      category: 'host_event_review',
      data: { type: 'host_event_studio_change', event_id: 'e1' },
    })
    expect(getNotificationCategory(payload.category)).toBeTruthy()
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(sendTransactionalEmail.mock.calls[0][0]).toMatchObject({ to: 'owner@x.ie', subject: 'Host event studio change: Gala', tag: 'host-event-studio-change', locationId: HATCH })
  })
  it("names a move between the org's studios, and never reads another org's studio name", async () => {
    await notifyAdminsEventStudioChange({ db: db(), event, host, orgId: ORG, reasons: ['studio'], studioId: HATCH, previousStudioId: STILL })
    expect(sendPushOnce.mock.calls[0][3].body).toBe('Acme changed "Gala": moved from Stillorgan to Hatch Street.')
    vi.clearAllMocks()
    await notifyAdminsEventStudioChange({ db: db(), event, host, orgId: ORG, reasons: ['studio'], studioId: FOREIGN })
    expect(sendPushOnce.mock.calls[0][3].body).toBe('Acme changed "Gala": linked to a studio.')
  })
  it('says nothing when there is no reason', async () => {
    await notifyAdminsEventStudioChange({ db: db(), event, host, orgId: ORG, reasons: [], studioId: HATCH })
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('a push failure never blocks the email', async () => {
    sendPushOnce.mockRejectedValueOnce(new Error('expo down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await notifyAdminsEventStudioChange({ db: db(), event, host, orgId: ORG, reasons: ['studio_hours'], growth: { later: '21:00' }, studioId: HATCH, sessionTimes: ['10:00', '21:00'] })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(sendTransactionalEmail.mock.calls[0][0].htmlBody).toContain('now runs later (last session 21:00) at Hatch Street')
    warn.mockRestore()
  })
})
