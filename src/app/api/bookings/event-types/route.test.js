// EVENTTYPERLS.1 — POST /api/bookings/event-types is the ONLY way to create a
// booking type (the form used to INSERT with the browser client, which RLS let
// any member of the studio do). A cookie caller creates only as a master or
// with MANAGER_ROLES at body.location_id — canManageEventType, the rule the
// New page, the Edit/Delete buttons and the [id] route already use. The
// per-org API-key path is org-gated by assertCreateInOrg; the retired
// shared integration key is refused (APIKEYS.4). api-auth + validate are real;
// only supabase/getCurrentUser are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDb, twoOrgFixture, ORG1_KEY, RETIRED_SHARED_KEY } from '@/lib/api-auth.test-helpers.js'

let db
let tables
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual()
  return { ...actual, getCurrentUser: vi.fn(async () => null) }
})

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'

// location_id is validated as a UUID-shaped string (uuidLike), so the body
// cannot use the fixture's 'loc-1a' ids. Synthetic ids.
const STUDIO_A = 'a1000000-0000-4000-8000-0000000000a1'
const STUDIO_B = 'b2000000-0000-4000-8000-0000000000b2'

const cookiePost = (body) => new Request('http://localhost/api/bookings/event-types', {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
})
const keyPost = (body, key = ORG1_KEY) => new Request('http://localhost/api/bookings/event-types', {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', authorization: `Bearer ${key}` },
})

const at = (role, ...locationIds) => ({
  role,
  isMaster: false,
  profileRole: 'staff',
  locations: locationIds.map((id) => ({ id, organization_id: 'org-1' })),
  activeLocation: { id: locationIds[0], organization_id: 'org-1' },
  rolesByLocation: Object.fromEntries(locationIds.map((id) => [id, role])),
})

const FORM_BODY = {
  name: 'Free Consultation',
  description: null,
  duration_minutes: 30,
  buffer_minutes: 0,
  max_advance_days: 30,
  color: '#3B82F6',
  availability: { mon: { start: '09:00', end: '18:00' } },
  custom_fields: [],
  webhook_url: null,
  staff_required: 1,
  active: true,
  confirmation_enabled: true,
  confirmation_channels: ['email'],
  confirmation_email_template_id: null,
  confirmation_email_subject: 'See you soon',
  create_in_glofox: false,
  location_id: STUDIO_A,
}

beforeEach(() => {
  getCurrentUser.mockResolvedValue(null)
  tables = twoOrgFixture()
  tables.locations.push({ id: STUDIO_A, organization_id: 'org-1' }, { id: STUDIO_B, organization_id: 'org-2' })
  tables.event_types = []
  db = makeFakeDb(tables)
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/bookings/event-types — cookie caller (EVENTTYPERLS.1)', () => {
  it('a manager at the studio creates it there, with the slug and the confirmation fields', async () => {
    getCurrentUser.mockResolvedValue(at('manager', STUDIO_A))
    const res = await POST(cookiePost(FORM_BODY))
    expect(res.status).toBe(200)
    expect(tables.event_types).toHaveLength(1)
    expect(tables.event_types[0]).toMatchObject({
      name: 'Free Consultation',
      slug: 'free-consultation',
      location_id: STUDIO_A,
      confirmation_enabled: true,
      confirmation_channels: ['email'],
      confirmation_email_subject: 'See you soon',
      active: true,
    })
  })

  it('a head coach at the studio creates too (MANAGER_ROLES)', async () => {
    getCurrentUser.mockResolvedValue(at('head_coach', STUDIO_A))
    expect((await POST(cookiePost(FORM_BODY))).status).toBe(200)
  })

  it('plain staff → 401, nothing created (they could, through RLS, before)', async () => {
    getCurrentUser.mockResolvedValue(at('staff', STUDIO_A))
    const res = await POST(cookiePost(FORM_BODY))
    expect(res.status).toBe(401)
    expect(tables.event_types).toHaveLength(0)
  })

  it('a manager elsewhere creating at a studio they do not belong to → 403, nothing created', async () => {
    getCurrentUser.mockResolvedValue(at('manager', STUDIO_B))
    const res = await POST(cookiePost(FORM_BODY))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden — location not in your assignments' })
    expect(tables.event_types).toHaveLength(0)
  })

  it('a cookie caller with no location_id → 400, never a location-less booking type', async () => {
    getCurrentUser.mockResolvedValue(at('manager', STUDIO_A))
    const noLoc = { ...FORM_BODY }
    delete noLoc.location_id
    const res = await POST(cookiePost(noLoc))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'location_id required' })
    expect(tables.event_types).toHaveLength(0)
  })

  it('nobody signed in → 401', async () => {
    expect((await POST(cookiePost(FORM_BODY))).status).toBe(401)
    expect(tables.event_types).toHaveLength(0)
  })
})

describe('POST /api/bookings/event-types — API-key path (per-org key, org-scoped)', () => {
  it('the retired shared key → 401, nothing created (APIKEYS.4)', async () => {
    const res = await POST(keyPost({ name: 'Intro Call', location_id: STUDIO_A }, RETIRED_SHARED_KEY))
    expect(res.status).toBe(401)
    expect(tables.event_types).toHaveLength(0)
  })

  it('a per-org key creates at a studio in its org without confirmation keys (column defaults kept)', async () => {
    const res = await POST(keyPost({ name: 'Intro Call', location_id: STUDIO_A }))
    expect(res.status).toBe(200)
    expect(tables.event_types).toHaveLength(1)
    const row = tables.event_types[0]
    expect(row).toMatchObject({ name: 'Intro Call', slug: 'intro-call', duration_minutes: 30, active: true, location_id: STUDIO_A })
    expect('confirmation_enabled' in row).toBe(false)
    expect('confirmation_channels' in row).toBe(false)
  })

  it('a per-org key without a location → 400, nothing created (an org-scoped key needs a target studio)', async () => {
    const res = await POST(keyPost({ name: 'Intro Call' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'location_id required for org-scoped key' })
    expect(tables.event_types).toHaveLength(0)
  })

  it('a per-org key creating at another org\'s studio → 403, nothing created', async () => {
    const res = await POST(keyPost({ name: 'Intro Call', location_id: STUDIO_B }))
    expect(res.status).toBe(403)
    expect(tables.event_types).toHaveLength(0)
  })
})

// ETSLUG.1 — event_types.slug is one namespace for every studio (the public
// /book/[slug] address). A clash used to come back as the raw duplicate-key
// error; now a derived slug picks a free variant and an explicit one is a 409.
describe('POST /api/bookings/event-types — the public slug (ETSLUG.1)', () => {
  beforeEach(() => {
    tables.locations.find((l) => l.id === STUDIO_A).slug = 'un1t-hatch-street'
    tables.event_types.push({ id: 'held', slug: 'free-consultation', location_id: STUDIO_B, active: false })
  })

  it('a name another studio already uses gets the studio-suffixed address, not an error', async () => {
    getCurrentUser.mockResolvedValue(at('manager', STUDIO_A))
    const res = await POST(cookiePost(FORM_BODY))
    expect(res.status).toBe(200)
    expect((await res.json()).data.slug).toBe('free-consultation-un1t-hatch-street')
    expect(tables.event_types.find((e) => e.id === 'held').slug).toBe('free-consultation')
  })

  it('an explicit slug another type holds → 409 with a readable message, nothing created', async () => {
    const res = await POST(keyPost({ name: 'Intro Call', slug: 'free-consultation', location_id: STUDIO_A }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'That booking link is already in use. Choose a different one.' })
    expect(tables.event_types).toHaveLength(1)
  })

  it('a create that loses the race on its derived slug picks again and succeeds', async () => {
    getCurrentUser.mockResolvedValue(at('manager', STUDIO_A))
    const real = db
    let raced = false
    db = {
      from: (t) => {
        const b = real.from(t)
        if (t !== 'event_types') return b
        const insert = b.insert
        b.insert = (row) => {
          if (!raced) {
            raced = true
            // Another create takes the address between our read and our insert.
            tables.event_types.push({ id: 'racer', slug: row.slug, location_id: STUDIO_B })
            const fail = { select: () => fail, single: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "event_types_slug_key"' } }) }
            return fail
          }
          return insert(row)
        }
        return b
      },
    }
    const res = await POST(cookiePost(FORM_BODY))
    expect(res.status).toBe(200)
    expect((await res.json()).data.slug).toBe('free-consultation-2')
  })
})
