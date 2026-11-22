// HOSTSTUDIONOTICE.1 — PUT /api/host/events/[id] tells staff (never asks)
// when a PUBLISHED event is linked to a studio, moved to another, or uses its
// studio for longer. The save is never blocked or changed by the notice.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const W1 = 'f0000000-0000-4000-8000-0000000000f1'
const W2 = 'f0000000-0000-4000-8000-0000000000f2'
const ORG = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'b0000000-0000-4000-8000-000000000001'
const STILL = 'b0000000-0000-4000-8000-000000000002'
let session
let db

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/event-sessions', async (importOriginal) => ({ ...(await importOriginal()), syncEventSessions: vi.fn(async () => ({ ok: true, waves: [] })), judgeSessions: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/event-venue-studio', async (importOriginal) => ({ ...(await importOriginal()), judgeVenueStudio: vi.fn(async (_db, { venueLocationId }) => ({ ok: true, venueLocationId: venueLocationId ?? null })) }))
vi.mock('@/lib/host-notifications', async (importOriginal) => ({ ...(await importOriginal()), notifyAdminsEventStudioChange: vi.fn(async () => {}) }))

const { notifyAdminsEventStudioChange } = await import('@/lib/host-notifications')
const { logError } = await import('@/lib/log')
const { PUT } = await import('./route.js')

const props = () => ({ params: Promise.resolve({ id: E1 }) })
const SESSIONS = [{ id: W1, start_time: '10:00', capacity: 20 }, { id: W2, start_time: '12:00', capacity: 20 }]
const BODY = {
  kind: 'workshop', name: 'Mobility', race_date: '2026-12-05', allowed_team_sizes: [1, 2],
  ticket_price_cents: 2500, venue_name: 'Hatch Street', venue_location_id: HATCH, sessions: SESSIONS,
}
const put = (body) => PUT(new Request(`https://crm.test/api/host/events/${E1}`, { method: 'PUT', body: JSON.stringify(body) }), props())

function seed({ status = 'published', venue = HATCH, duration = null, holdMinutes = null } = {}) {
  db = createFakeDb({
    tables: {
      race_events: [{
        id: E1, host_id: 'h1', location_id: HATCH, status, kind: 'workshop', name: 'Mobility', slug: 'hatch-dec05-1000',
        race_date: '2026-12-05', allowed_team_sizes: [1, 2], non_member_fee_cents: 2500, venue_name: 'Hatch Street',
        venue_location_id: venue, duration_minutes: duration, series_id: null,
      }],
      race_waves: [
        { id: W1, race_event_id: E1, start_time: '10:00:00', capacity: 20, label: null, display_order: 0 },
        { id: W2, race_event_id: E1, start_time: '12:00:00', capacity: 20, label: null, display_order: 1 },
      ],
      location_automations: holdMinutes ? [{ id: 'c0000000-0000-4000-8000-000000000001', location_id: HATCH, automation_key: 'event_hold', config: { hold_minutes: holdMinutes } }] : [],
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1', name: 'Run Club', organization_id: ORG } }
  seed()
})

async function expectSaved(res) {
  expect(res.status).toBe(200)
  expect((await res.json()).success).toBe(true)
}
const notice = () => notifyAdminsEventStudioChange.mock.calls[0][0]

describe('notice sent', () => {
  it('when a published event is linked to a studio', async () => {
    seed({ venue: null })
    await expectSaved(await put(BODY))
    expect(notifyAdminsEventStudioChange).toHaveBeenCalledTimes(1)
    expect(notice()).toMatchObject({ reasons: ['studio'], studioId: HATCH, previousStudioId: null, orgId: ORG, host: session.host })
    expect(notice().event).toEqual({ id: E1, name: 'Mobility', location_id: HATCH })
  })
  it('when it moves to another studio', async () => {
    await expectSaved(await put({ ...BODY, venue_location_id: STILL }))
    expect(notice()).toMatchObject({ reasons: ['studio'], studioId: STILL, previousStudioId: HATCH })
  })
  it('when a session runs later than the last', async () => {
    await expectSaved(await put({ ...BODY, sessions: [...SESSIONS, { start_time: '19:00', capacity: 10 }] }))
    expect(notice()).toMatchObject({ reasons: ['studio_hours'], studioId: HATCH, growth: { earlier: null, later: '19:00', longerHoldMinutes: null } })
  })
  it('when a session starts earlier than the first', async () => {
    await expectSaved(await put({ ...BODY, sessions: [{ start_time: '07:00', capacity: 10 }, ...SESSIONS] }))
    expect(notice()).toMatchObject({ reasons: ['studio_hours'], growth: { earlier: '07:00' } })
  })
  it('when the hold grows past the current one', async () => {
    await expectSaved(await put({ ...BODY, duration_minutes: 180 }))
    expect(notice()).toMatchObject({ reasons: ['studio_hours'], growth: { longerHoldMinutes: 180 } })
  })
  it("measured against the studio's own hold setting", async () => {
    seed({ holdMinutes: 240 })
    await expectSaved(await put({ ...BODY, duration_minutes: 180 }))
    expect(notifyAdminsEventStudioChange).not.toHaveBeenCalled()
    await expectSaved(await put({ ...BODY, duration_minutes: 300 }))
    expect(notice()).toMatchObject({ growth: { longerHoldMinutes: 300 } })
  })
})

describe('no notice', () => {
  it('on a move out of the studio', async () => {
    await expectSaved(await put({ ...BODY, venue_location_id: null, sessions: [...SESSIONS, { start_time: '21:00', capacity: 5 }] }))
    expect(notifyAdminsEventStudioChange).not.toHaveBeenCalled()
  })
  it('on a shorter duration', async () => {
    seed({ duration: 240 })
    await expectSaved(await put({ ...BODY, duration_minutes: 180 }))
    expect(notifyAdminsEventStudioChange).not.toHaveBeenCalled()
  })
  it('on a new session inside the current hours', async () => {
    await expectSaved(await put({ ...BODY, sessions: [...SESSIONS, { start_time: '11:00', capacity: 10 }] }))
    expect(notifyAdminsEventStudioChange).not.toHaveBeenCalled()
  })
  it('on a draft, whatever changes', async () => {
    seed({ status: 'draft', venue: null })
    await expectSaved(await put({ ...BODY, duration_minutes: 600, sessions: [...SESSIONS, { start_time: '21:00', capacity: 5 }] }))
    expect(notifyAdminsEventStudioChange).not.toHaveBeenCalled()
  })
  it('on a cosmetic edit', async () => {
    await expectSaved(await put({ ...BODY, description: 'New words', hero_image_url: 'https://img.test/a.jpg' }))
    expect(notifyAdminsEventStudioChange).not.toHaveBeenCalled()
  })
})

describe('a failed notice never fails the save', () => {
  it('saves, answers 200 and logs', async () => {
    notifyAdminsEventStudioChange.mockRejectedValueOnce(new Error('postmark down'))
    seed({ venue: null })
    const res = await put(BODY)
    expect(await res.json()).toEqual({ success: true, data: { id: E1, status: 'published' } })
    expect(db.tables.race_events[0].venue_location_id).toBe(HATCH)
    expect(logError).toHaveBeenCalledWith('host-event-studio-notice', 'notify admins failed', expect.anything())
  })
  it('the save is unchanged by the notice (status stays published)', async () => {
    await expectSaved(await put({ ...BODY, venue_location_id: STILL }))
    expect(db.tables.race_events[0]).toMatchObject({ status: 'published', venue_location_id: STILL })
  })
})
