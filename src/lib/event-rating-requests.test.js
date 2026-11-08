// HOSTPAGE.2 — the morning after a HOST event, every confirmed entry's lead
// gets one "How was <event>?" email with a signed /event/rate/ link:
// claim-before-send, reminder-style consent, hosts' events only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

vi.mock('@/lib/postmark', async (orig) => ({ ...(await orig()), sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/event-comms-location', async (orig) => ({ ...(await orig()), resolveEventCommsLocation: vi.fn(async () => ({ id: 'L-comms' })) }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://un1t.repset.ie') }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T' })), getLocationOrgBrandName: vi.fn(async () => 'UN1T') }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { sendTransactionalEmail } = await import('@/lib/postmark')
const { runRatingRequests } = await import('./event-rating-requests')
const { verifyRatingToken } = await import('./event-ratings')

process.env.SUPABASE_SERVICE_ROLE_KEY = 's3cret'
const NOW = Date.parse('2026-07-19T08:05:00Z') // 09:05 Irish Summer Time: the morning after the 18th
const EV = {
  id: 'e1', name: 'Mobility Workshop', slug: 'mob', race_date: '2026-07-18', location_id: 'L1', host_id: 'h1', sending_location_id: null,
  accent_hex: null, hero_image_url: null, rating_email_subject: null, rating_email_intro: null,
  host: { id: 'h1', name: 'Acme Events', anchor_location_id: 'L1' },
  locations: { id: 'L1', name: 'Acme (host events)', is_host_anchor: true, timezone: 'Europe/Dublin' },
}
const contact = (over = {}) => ({ id: 'c1', email: 'aoife@example.test', first_name: 'Aoife', name: 'Aoife Byrne', email_status: 'active', contact_preferences: [{ email_administrative: true }], ...over })
const REGS = [{ id: 'r1', contact_id: 'c1', contact: contact() }, { id: 'r2', contact_id: 'c2', contact: contact({ id: 'c2', email: 'dan@example.test', first_name: 'Dan' }) }]

let events, regs, requested, claimAnswer
function db() {
  return fakeDb((q) => {
    if (q.table === 'race_events') return { data: events, error: null }
    if (q.table === 'race_registrations') return { data: regs, error: null }
    if (q.table === 'event_rating_requests') {
      if (q.action === 'insert') return claimAnswer(q)
      return { data: requested.map((id) => ({ registration_id: id })), error: null }
    }
    return { data: null, error: null }
  })
}
const isDue = () => true

beforeEach(() => {
  vi.clearAllMocks()
  events = [EV]; regs = REGS; requested = []; claimAnswer = () => ({ data: null, error: null })
})

describe('runRatingRequests', () => {
  it('the morning after a host event, each confirmed entry gets one email with a verifying rate link', async () => {
    const d = db()
    const out = await runRatingRequests({ db: d, nowMs: NOW, isDue })
    expect(out).toEqual({ events: 1, sent: 2, skipped: 0, request_read_failed: 0, claim_failed: 0 })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2)
    const first = sendTransactionalEmail.mock.calls[0][0]
    expect(first.to).toBe('aoife@example.test')
    expect(first.subject).toBe('How was Mobility Workshop?')
    expect(first.tag).toBe('event-rating-request')
    expect(first.locationId).toBe('L-comms')
    const m = first.htmlBody.match(/https:\/\/un1t\.repset\.ie\/event\/rate\/([A-Za-z0-9_.-]+)/)
    expect(m).toBeTruthy()
    expect(verifyRatingToken(m[1], 's3cret', { nowMs: NOW })).toEqual({ registrationId: 'r1', eventId: 'e1' })
    expect(first.htmlBody).not.toContain('(host events)')
    // the query asks only for hosts' published, active events
    const q = d.queries.find((x) => x.table === 'race_events')
    expect(q.ops).toEqual(expect.arrayContaining([['eq', 'active', true], ['eq', 'status', 'published'], ['not', 'host_id', 'is', null], ['neq', 'kind', 'lead_gen']]))
    // claims were written before the sends
    const claims = d.queries.filter((x) => x.table === 'event_rating_requests' && x.action === 'insert')
    expect(claims.map((c) => c.payload)).toEqual([{ registration_id: 'r1', race_event_id: 'e1' }, { registration_id: 'r2', race_event_id: 'e1' }])
  })
  it('an event that is not "yesterday" on its own clock, or not this location\'s slot, sends nothing', async () => {
    expect(await runRatingRequests({ db: db(), nowMs: Date.parse('2026-07-20T08:05:00Z'), isDue })).toMatchObject({ events: 0, sent: 0 })
    expect(await runRatingRequests({ db: db(), nowMs: NOW, isDue: () => false })).toMatchObject({ events: 0, sent: 0 })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('an already-asked entry, an opted-out contact and a duplicate claim are skipped; the claim is kept on an opt-out', async () => {
    requested = ['r1']
    regs = [REGS[0], { id: 'r2', contact_id: 'c2', contact: contact({ id: 'c2', email: 'dan@example.test', contact_preferences: [{ email_administrative: false }] }) }]
    const d = db()
    const out = await runRatingRequests({ db: d, nowMs: NOW, isDue })
    expect(out).toMatchObject({ sent: 0, skipped: 2, claim_failed: 0 })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(d.queries.filter((x) => x.table === 'event_rating_requests' && x.action === 'insert').map((c) => c.payload.registration_id)).toEqual(['r2'])
    claimAnswer = () => ({ data: null, error: { code: '23505' } })
    requested = []; regs = REGS
    expect(await runRatingRequests({ db: db(), nowMs: NOW, isDue })).toMatchObject({ sent: 0, skipped: 2, claim_failed: 0 })
  })
  it('a claim error is counted as the arm\'s own fault and never sends', async () => {
    claimAnswer = () => ({ data: null, error: { code: '42501', message: 'denied' } })
    const out = await runRatingRequests({ db: db(), nowMs: NOW, isDue })
    expect(out).toMatchObject({ sent: 0, skipped: 2, claim_failed: 2 })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
  it('a failed registrations read is the arm\'s fault too', async () => {
    const d = fakeDb((q) => (q.table === 'race_events' ? { data: events, error: null } : q.table === 'race_registrations' ? { data: null, error: { message: 'boom' } } : { data: null, error: null }))
    expect(await runRatingRequests({ db: d, nowMs: NOW, isDue })).toMatchObject({ events: 1, sent: 0, request_read_failed: 1 })
  })
  it('operator copy on the event wins over the default subject', async () => {
    events = [{ ...EV, rating_email_subject: 'Tell us about {{event_name}}' }]
    await runRatingRequests({ db: db(), nowMs: NOW, isDue })
    expect(sendTransactionalEmail.mock.calls[0][0].subject).toBe('Tell us about Mobility Workshop')
  })
})
