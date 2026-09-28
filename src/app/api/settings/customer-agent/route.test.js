import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUT, GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fakeLocationsDb, BOOM } from '@/lib/location-settings.test-helpers'

beforeEach(() => vi.clearAllMocks())

function putReq(body) {
  return new Request('http://x/api/settings/customer-agent', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('PUT /api/settings/customer-agent — CTA fields', () => {
  it('403 for a non-manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'staff', activeLocation: { id: 'loc1' } })
    expect((await PUT(putReq({ enabled: true }))).status).toBe(403)
  })

  it('persists the join CTA (membership url + label) into settings.customer_agent', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    let written = null
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { settings: {} }, error: null }) }) }),
        update: (patch) => { written = patch; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) } },
      }),
    })
    const res = await PUT(putReq({
      enabled: true,
      membership_signup_url: 'https://join.example',
      membership_cta_label: 'Join us',
    }))
    expect(res.status).toBe(200)
    expect(written.settings.customer_agent).toMatchObject({
      membership_signup_url: 'https://join.example',
      membership_cta_label: 'Join us',
    })
    // Pulse stays out of booking — no booking CTA plumbing is persisted.
    expect(written.settings.customer_agent).not.toHaveProperty('booking_url')
    expect(written.settings.customer_agent).not.toHaveProperty('booking_cta_label')
  })

  it('coerces blank/invalid membership CTA to null', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    let written = null
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { settings: {} }, error: null }) }) }),
        update: (patch) => { written = patch; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) } },
      }),
    })
    const res = await PUT(putReq({ enabled: true, membership_signup_url: '', membership_cta_label: '   ' }))
    expect(res.status).toBe(200)
    expect(written.settings.customer_agent.membership_signup_url).toBeNull()
    expect(written.settings.customer_agent.membership_cta_label).toBeNull()
  })

  // MIA-BOOK.1 — the handoff copy round-trips; blank coerces to null (code default).
  it('persists booking_issue_handoff_text and coerces blank to null', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    let written = null
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { settings: {} }, error: null }) }) }),
        update: (patch) => { written = patch; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) } },
      }),
    })
    let res = await PUT(putReq({ enabled: true, booking_issue_handoff_text: 'Account hiccup, the crew will ping you.' }))
    expect(res.status).toBe(200)
    expect(written.settings.customer_agent.booking_issue_handoff_text).toBe('Account hiccup, the crew will ping you.')
    res = await PUT(putReq({ enabled: true, booking_issue_handoff_text: '   ' }))
    expect(res.status).toBe(200)
    expect(written.settings.customer_agent.booking_issue_handoff_text).toBeNull()
  })
})

// CANCEL-FORM.2 — the cancellation-form block rides the blob; the Glofox
// auto-cancel toggle is the locations.glofox_auto_cancel_memberships COLUMN.
describe('PUT /api/settings/customer-agent — cancellation form', () => {
  function dbCapturing() {
    const written = { patch: null }
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { settings: { social_enabled: true } }, error: null }) }) }),
        update: (patch) => { written.patch = patch; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) } },
      }),
    })
    return written
  }

  it('persists cancellation_form inside the blob and writes the toggle to its own column', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    const written = dbCapturing()
    const res = await PUT(putReq({
      enabled: true,
      glofox_auto_cancel: true,
      cancellation_form: { form_intro: 'Hi {first_name}', notice_days: 30, reason_labels: { price: 'Too dear' } },
    }))
    expect(res.status).toBe(200)
    expect(written.patch.settings.customer_agent.cancellation_form).toMatchObject({
      form_intro: 'Hi {first_name}', notice_days: 30, reason_labels: { price: 'Too dear' },
    })
    expect(written.patch.settings.customer_agent).not.toHaveProperty('glofox_auto_cancel')
    expect(written.patch.glofox_auto_cancel_memberships).toBe(true)
  })

  it('an omitted toggle writes false (never leaves a stale true behind), and an absent block writes null', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    const written = dbCapturing()
    const res = await PUT(putReq({ enabled: true }))
    expect(res.status).toBe(200)
    expect(written.patch.glofox_auto_cancel_memberships).toBe(false)
    expect(written.patch.settings.customer_agent.cancellation_form).toBeNull()
  })
})

describe('GET /api/settings/customer-agent — cancellation form', () => {
  it('surfaces glofox_auto_cancel from the locations column', async () => {
    const { GET } = await import('./route')
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    const locRow = { name: 'Stillorgan', settings: { customer_agent: { cancellation_form: { notice_days: 14 } } }, glofox_auto_cancel_memberships: true }
    // Permissive chainable double: the locations read resolves to locRow,
    // everything else (stats queries) to empty.
    function chain(table) {
      const result = table === 'locations' ? { data: locRow, error: null, count: 0 } : { data: [], error: null, count: 0 }
      const c = {}
      for (const m of ['select', 'eq', 'gte', 'not', 'order', 'limit']) c[m] = () => c
      c.single = () => Promise.resolve(result)
      c.maybeSingle = () => Promise.resolve({ data: null, error: null })
      c.then = (res, rej) => Promise.resolve(result).then(res, rej)
      return c
    }
    createServerClient.mockReturnValue({ from: (t) => chain(t) })
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.settings.glofox_auto_cancel).toBe(true)
    expect(body.settings.cancellation_form).toEqual({ notice_days: 14 })
  })
})

// SETTINGSWIPE.1 — the GET answered a failed read with Mia's DEFAULTS
// (enabled:false) as if they were her saved settings, and the PUT discarded
// its read error and wrote over the WHOLE settings column. One Save after a
// blip turned Mia off AND wiped the Glofox credentials.
describe('SETTINGSWIPE.1 — a failed read is never the defaults, and never a wipe', () => {
  const manager = { id: 'u', role: 'manager', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }

  it('GET: a failed locations read → 500 settings_unreadable, no settings, no defaults', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(fakeLocationsDb({ reads: { data: null, error: BOOM } }))
    const res = await GET()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.code).toBe('settings_unreadable')
    expect(body.settings).toBeUndefined()
  })

  it('PUT: a failed read → 500, NOTHING written (no settings, no auto-cancel column)', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const db = fakeLocationsDb({ reads: { data: null, error: BOOM } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(putReq({ enabled: true }))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('settings_unreadable')
    expect(db.writes).toEqual([])
  })

  it('pin: PUT keeps sibling keys (glofox) and writes the column in the same UPDATE', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const db = fakeLocationsDb({ reads: { data: { settings: { glofox: { branch_id: 'b1' }, scoring: { participation_points: 60 } } }, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(putReq({ enabled: true, social_enabled: true, glofox_auto_cancel: true }))
    expect(res.status).toBe(200)
    const { patch } = db.writes[0]
    expect(patch.settings.glofox).toEqual({ branch_id: 'b1' })
    expect(patch.settings.scoring).toEqual({ participation_points: 60 })
    expect(patch.settings.social_enabled).toBe(true)
    expect(patch.settings.customer_agent.enabled).toBe(true)
    expect(patch.glofox_auto_cancel_memberships).toBe(true)
  })
})
