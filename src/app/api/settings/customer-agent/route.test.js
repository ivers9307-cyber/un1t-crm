import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUT, GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fakeLocationsDb, BOOM } from '@/lib/location-settings.test-helpers'

beforeEach(() => vi.clearAllMocks())

// MIAROLE.1 — the PUT is owner-at-the-studio (or master) only.
const OWNER = { id: 'u', role: 'owner', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }], rolesByLocation: { loc1: 'owner' } }

function putReq(body) {
  return new Request('http://x/api/settings/customer-agent', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('PUT /api/settings/customer-agent — CTA fields', () => {
  it('403 for a non-owner', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'staff', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }], rolesByLocation: { loc1: 'staff' } })
    expect((await PUT(putReq({ enabled: true }))).status).toBe(403)
  })

  it('persists the join CTA (membership url + label) into settings.customer_agent', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
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
    getCurrentUser.mockResolvedValue(OWNER)
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
    getCurrentUser.mockResolvedValue(OWNER)
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
    getCurrentUser.mockResolvedValue(OWNER)
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
    getCurrentUser.mockResolvedValue(OWNER)
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
  const owner = OWNER // MIAROLE.1 — only an owner reaches the PUT's read/write

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
    getCurrentUser.mockResolvedValue(owner)
    const db = fakeLocationsDb({ reads: { data: null, error: BOOM } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(putReq({ enabled: true }))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('settings_unreadable')
    expect(db.writes).toEqual([])
  })

  it('pin: PUT keeps sibling keys (glofox) and writes the column in the same UPDATE', async () => {
    getCurrentUser.mockResolvedValue(owner)
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

describe('GET /api/settings/customer-agent — CHECKINSTALL.1 day rollup', () => {
  it('passes last_outcome.checkins_day through as checkin_stats.last_run.day', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    const day = { day: '2026-09-30', ticks: 5, daytime_ticks: 5, failed_ticks: 0, candidates: 8, freeform: 0, templates: 1, skipped: 7, reasons: { human_active: 7 }, previous: null }
    createServerClient.mockReturnValue(fakeLocationsDb({
      reads: { data: { name: 'Stillorgan', settings: { customer_agent: {} } }, error: null },
      tables: { cron_heartbeats: { data: { last_ok_at: '2026-09-30T09:00:00Z', last_outcome: { checkins: { skipped: 1 }, checkins_day: day } }, error: null } },
    }))
    const body = await (await GET()).json()
    expect(body.checkin_stats.last_run).toEqual({ at: '2026-09-30T09:00:00Z', checkins: { skipped: 1 }, day })
  })
})

// MIAROLE.1 (C80, the owner's call on 30 Sep) — only an OWNER at the studio
// being changed, or a master, may change Mia's settings. The PUT used to take
// MANAGER_ROLES off `user.role`, so head coaches and managers could switch her
// on, off or into test mode. Judged at the location written (the active one),
// never at the caller's highest role anywhere.
describe('PUT /api/settings/customer-agent — who may change Mia (MIAROLE.1)', () => {
  const at = (role, extra = {}) => ({
    id: 'u', role, profileRole: role === 'master' ? 'master' : 'staff',
    activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }, { id: 'loc2' }],
    rolesByLocation: role === 'master' ? {} : { loc1: role }, ...extra,
  })
  const goodDb = () => fakeLocationsDb({ reads: { data: { settings: {} }, error: null } })

  for (const role of ['head_coach', 'manager', 'staff']) {
    it(`a ${role} at the studio is refused (403) and nothing is written`, async () => {
      getCurrentUser.mockResolvedValue(at(role))
      const db = goodDb()
      createServerClient.mockReturnValue(db)
      const res = await PUT(putReq({ enabled: true }))
      expect(res.status).toBe(403)
      expect(db.writes).toEqual([])
    })
  }

  it('an owner at the studio may change them', async () => {
    getCurrentUser.mockResolvedValue(at('owner'))
    const db = goodDb()
    createServerClient.mockReturnValue(db)
    const res = await PUT(putReq({ enabled: true }))
    expect(res.status).toBe(200)
    expect(db.writes).toHaveLength(1)
  })

  it('a master may change them', async () => {
    getCurrentUser.mockResolvedValue(at('master'))
    const db = goodDb()
    createServerClient.mockReturnValue(db)
    expect((await PUT(putReq({ enabled: true }))).status).toBe(200)
  })

  it('an owner at ANOTHER studio (a manager here) is refused', async () => {
    // user.role reads 'owner' by the highest-role fallback; the role that
    // counts is the one held at loc1, the studio being written.
    getCurrentUser.mockResolvedValue(at('owner', { rolesByLocation: { loc1: 'manager', loc2: 'owner' } }))
    const db = goodDb()
    createServerClient.mockReturnValue(db)
    const res = await PUT(putReq({ enabled: true }))
    expect(res.status).toBe(403)
    expect(db.writes).toEqual([])
  })

  it('a caller not at the studio at all gets 404, not a role complaint', async () => {
    getCurrentUser.mockResolvedValue(at('owner', { locations: [{ id: 'loc2' }], rolesByLocation: { loc2: 'owner' } }))
    const db = goodDb()
    createServerClient.mockReturnValue(db)
    const res = await PUT(putReq({ enabled: true }))
    expect(res.status).toBe(404)
    expect(db.writes).toEqual([])
  })
})

// CHECKINRISKS.1 (C106 c) — the card's "Sent today" counted contacts STAMPED
// today (first_class_checkin_at), and the runner stamps non-sends too
// ('skipped — already discussed', 'skipped — no marketing consent'). It now
// counts the day's agent_checkin activity rows that were sends, with the
// runner's own daily-cap counter, so the card and the cap agree. A failed read
// is unknown (null), never 0.
describe('GET /api/settings/customer-agent — check-in counts are sends (CHECKINRISKS.1)', () => {
  const manager = { id: 'u', role: 'manager', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }
  const LOC = { data: { name: 'Stillorgan', settings: { customer_agent: {} } }, error: null }
  const ROWS = [
    { note: 'Spin (template)', created_at: '2026-09-30T10:00:00Z', contacts: { name: 'A' } },
    { note: 'Spin (in-window)', created_at: '2026-09-30T09:00:00Z', contacts: { name: 'B' } },
    { note: 'Spin (skipped — no marketing consent)', created_at: '2026-09-30T08:00:00Z', contacts: { name: 'C' } },
  ]

  it('sent_today counts sends, not stamps; total is the all-time send count', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(fakeLocationsDb({
      reads: LOC,
      tables: {
        // three contacts were STAMPED today; only two were sends
        contacts: { data: null, count: 3, error: null },
        activities: { data: ROWS, count: 7, error: null },
      },
    }))
    const body = await (await GET()).json()
    expect(body.checkin_stats.sent_today).toBe(2)
    expect(body.checkin_stats.total).toBe(7)
  })

  it('a failed activities read is unknown (null), never 0', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(fakeLocationsDb({
      reads: LOC,
      tables: { contacts: { data: null, count: 0, error: null }, activities: { data: null, error: BOOM } },
    }))
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.checkin_stats.sent_today).toBeNull()
    expect(body.checkin_stats.total).toBeNull()
    expect(body.checkin_stats.last_unreadable).toBe(true)
  })
})
