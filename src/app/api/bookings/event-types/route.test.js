// EVENTTYPERLS.1 — POST /api/bookings/event-types is the ONLY way to create a
// booking type (the form used to INSERT with the browser client, which RLS let
// any member of the studio do). A cookie caller creates only as a master or
// with MANAGER_ROLES at body.location_id — canManageEventType, the rule the
// New page, the Edit/Delete buttons and the [id] route already use. The
// API-key paths are unchanged. api-auth + validate are real; only
// supabase/getCurrentUser are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDb, twoOrgFixture, GLOBAL_KEY } from '@/lib/api-auth.test-helpers.js'

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
const keyPost = (body) => new Request('http://localhost/api/bookings/event-types', {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', authorization: `Bearer ${GLOBAL_KEY}` },
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
  confirmation_channels: ['sms'],
  confirmation_email_template_id: null,
  confirmation_email_subject: null,
  confirmation_sms_body: 'See you soon',
  create_in_glofox: false,
  location_id: STUDIO_A,
}

beforeEach(() => {
  vi.stubEnv('CRM_API_KEY', GLOBAL_KEY)
  getCurrentUser.mockResolvedValue(null)
  tables = twoOrgFixture()
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
      confirmation_channels: ['sms'],
      confirmation_sms_body: 'See you soon',
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

describe('POST /api/bookings/event-types — API-key path unchanged', () => {
  it('the legacy key still creates without a location and without confirmation keys (column defaults kept)', async () => {
    const res = await POST(keyPost({ name: 'Intro Call' }))
    expect(res.status).toBe(200)
    expect(tables.event_types).toHaveLength(1)
    const row = tables.event_types[0]
    expect(row).toMatchObject({ name: 'Intro Call', slug: 'intro-call', duration_minutes: 30, active: true })
    expect('location_id' in row).toBe(false)
    expect('confirmation_enabled' in row).toBe(false)
    expect('confirmation_channels' in row).toBe(false)
  })
})
