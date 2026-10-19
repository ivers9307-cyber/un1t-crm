import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// W1.S3 — the GET carries the location's resolved brand for the editor's placeholders.
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'Gym A', shortName: 'GA', locationName: 'Gym A North' })) }))

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
    // Pulse stays out of booking. MIAORG.1 added Mia's own booking link (for a
    // studio with no booking integration), so the keys now exist in the blob,
    // but a save that does not supply one persists none.
    expect(written.settings.customer_agent.booking_url).toBe(null)
    expect(written.settings.customer_agent.booking_cta_label).toBe(null)
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
    // W1.S3 — the editor's placeholders read the resolved brand off the GET.
    expect(body.brand).toEqual({ companyName: 'Gym A', shortName: 'GA' })
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

// TZ.5 — the editor names the studio's zone next to the quiet-hours fields
// (quiet hours with no stored tz are read in it).
describe('GET /api/settings/customer-agent — TZ.5 location timezone', () => {
  const getWith = async (timezone) => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    createServerClient.mockReturnValue(fakeLocationsDb({
      reads: { data: { name: 'Studio', settings: { customer_agent: {} }, timezone }, error: null },
    }))
    return (await (await GET()).json()).location
  }
  it('carries a New York studio\'s zone', async () => {
    expect(await getWith('America/New_York')).toEqual({ id: 'loc1', name: 'Studio', timezone: 'America/New_York' })
  })
  it('a Dublin or NULL column reads Europe/Dublin', async () => {
    expect((await getWith('Europe/Dublin')).timezone).toBe('Europe/Dublin')
    expect((await getWith(null)).timezone).toBe('Europe/Dublin')
  })
})

// MIAORG.1 Task 3 — the studio editor saves only what the STUDIO sets, so org
// defaults keep reaching it (Review Focus 1); GET shows where each value comes
// from. Fictional ids throughout.
describe('MIAORG.1 Task 3 — PUT with `overridden` saves overrides only', () => {
  const STORED = { settings: { glofox: { branch_id: 'b1' }, customer_agent: { tone: 'Old', enabled: true } } }
  const save = async (body) => {
    getCurrentUser.mockResolvedValue(OWNER)
    const db = fakeLocationsDb({ reads: { data: STORED, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(putReq(body))
    return { res, db, blob: db.writes[0]?.patch.settings.customer_agent }
  }
  // What the editor sends: every field it shows, inherited ones included.
  const BODY = {
    enabled: true, test_mode: false, test_phones: [], booking_mode: 'auto',
    tone: 'Org tone', extra_rules: 'Org rule', agent_name: 'Mia', handoff_cooldown_hours: 12,
    followups: { enabled: false, nudge_after_hours: 3, template_name: null, daily_cap: 50 },
    social_enabled: true, glofox_auto_cancel: false,
  }

  it('saving without touching inherited fields leaves them out of the blob', async () => {
    const { res, blob } = await save({ ...BODY, overridden: [] })
    expect(res.status).toBe(200)
    expect(blob).toEqual({ enabled: true, test_mode: false, test_phones: [], booking_mode: 'auto' })
  })

  it('editing one field adds just it', async () => {
    const { blob } = await save({ ...BODY, tone: 'Studio tone', overridden: ['tone'] })
    expect(blob).toEqual({ enabled: true, test_mode: false, test_phones: [], booking_mode: 'auto', tone: 'Studio tone' })
  })

  it('an object field override stores only that field (T3-A)', async () => {
    const { blob } = await save({ ...BODY, followups: { ...BODY.followups, daily_cap: 90 }, overridden: ['followups.daily_cap'] })
    expect(blob.followups).toEqual({ daily_cap: 90 })
  })

  it('"use default" (the path no longer listed) removes the stored override', async () => {
    // STORED holds tone 'Old'; the editor un-overrode it, so the save drops it
    const { blob } = await save({ ...BODY, overridden: [] })
    expect(blob).not.toHaveProperty('tone')
  })

  it('enabled and test_mode are always saved, and naming a studio-only key changes nothing (T3-B)', async () => {
    const a = (await save({ ...BODY, enabled: false, test_mode: true, overridden: [] })).blob
    const b = (await save({ ...BODY, enabled: false, test_mode: true, overridden: ['enabled', 'test_mode'] })).blob
    expect(a).toEqual(b)
    expect(a).toMatchObject({ enabled: false, test_mode: true })
  })

  it('the siblings and the column are written exactly as in a full save', async () => {
    const { db } = await save({ ...BODY, glofox_auto_cancel: true, overridden: [] })
    const { patch } = db.writes[0]
    expect(patch.settings.glofox).toEqual({ branch_id: 'b1' })
    expect(patch.settings.social_enabled).toBe(true)
    expect(patch.glofox_auto_cancel_memberships).toBe(true)
    expect(patch.settings.customer_agent).not.toHaveProperty('overridden')
  })

  it('an unknown entry is a 400 with issues, and nothing is written (T3-C)', async () => {
    const { res, db } = await save({ ...BODY, overridden: ['tone', 'followups.max_per_day'] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.issues.length).toBeGreaterThan(0)
    expect(JSON.stringify(body.issues)).toContain('overridden')
    expect(db.writes).toEqual([])
  })

  it('an overridden follow-up number the editor cleared (left out of the body) is not stored as the schema default', async () => {
    const { res, blob } = await save({ ...BODY, followups: { enabled: true, template_name: null }, overridden: ['followups.enabled', 'followups.daily_cap', 'followups.nudge_after_hours'] })
    expect(res.status).toBe(200)
    expect(blob.followups).toEqual({ enabled: true })
  })

  it('a cleared top-level number (null) is not stored with overridden; the legacy body still writes the code default', async () => {
    expect((await save({ ...BODY, handoff_cooldown_hours: null, overridden: ['handoff_cooldown_hours'] })).blob).not.toHaveProperty('handoff_cooldown_hours')
    expect((await save({ ...BODY, handoff_cooldown_hours: null })).blob.handoff_cooldown_hours).toBe(12)
  })

  it('a body WITHOUT overridden saves the whole blob, as before (an old editor tab)', async () => {
    const { blob } = await save(BODY)
    expect(blob).toMatchObject({ tone: 'Org tone', extra_rules: 'Org rule', agent_name: 'Mia', handoff_cooldown_hours: 12 })
    expect(blob.followups).toEqual(BODY.followups)
    expect(Object.keys(blob).length).toBeGreaterThan(30)
  })
})

describe('MIAORG.1 Task 3 — GET returns the resolved settings and both raw layers', () => {
  const manager = { id: 'u', role: 'manager', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }
  const studioRow = (extra = {}) => ({ data: { name: 'Studio', settings: { customer_agent: { enabled: false, tone: 'Studio tone', followups: { enabled: true } } }, ...extra }, error: null })
  // An org layer that (wrongly) holds studio-only keys: they never reach a studio.
  const ORG = { tone: 'Org tone', extra_rules: 'Org rule', enabled: true, test_mode: true, booking_url: 'https://org.example/book', followups: { daily_cap: 80 } }

  it('merges the org layer under the studio; studio-only keys never come from the org', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(fakeLocationsDb({
      reads: studioRow({ organization_id: 'org-1' }),
      tables: { org_settings: { data: { customer_agent: ORG }, error: null } },
    }))
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.settings.tone).toBe('Studio tone')
    expect(body.settings.extra_rules).toBe('Org rule')
    expect(body.settings.enabled).toBe(false)
    expect(body.settings.followups).toMatchObject({ enabled: true, daily_cap: 80 })
    expect(body.studio).toEqual({ enabled: false, tone: 'Studio tone', followups: { enabled: true } })
    // the org layer as it applies here: studio-only keys stripped (enabled)
    expect(body.org).toEqual({ tone: 'Org tone', extra_rules: 'Org rule', followups: { daily_cap: 80 } })
    expect(body.org).not.toHaveProperty('enabled')
    expect(body.sources).toMatchObject({ tone: 'studio', extra_rules: 'org', enabled: 'studio', agent_name: 'default' })
    // "Use organisation default" restores this
    expect(body.inherited.tone).toBe('Org tone')
    expect(body.inherited.enabled).toBe(false)
  })

  it('a studio with no organisation: org null, values as today', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(fakeLocationsDb({ reads: studioRow({ organization_id: null }) }))
    const body = await (await GET()).json()
    expect(body.org).toBe(null)
    expect(body.settings.extra_rules).toBe(null)
    expect(body.inherited.tone).toBe(null)
  })

  it('a failed ORG read is not a 500: the editor gets the studio\'s own values, org null', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(fakeLocationsDb({
      reads: studioRow({ organization_id: 'org-1' }),
      tables: { org_settings: { data: null, error: BOOM } },
    }))
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.org).toBe(null)
    expect(body.settings.tone).toBe('Studio tone')
  })

  it('no studio blob (Hatch): studio null, Mia off', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(fakeLocationsDb({
      reads: { data: { name: 'Hatch', settings: {}, organization_id: 'org-1' }, error: null },
      tables: { org_settings: { data: { customer_agent: ORG }, error: null } },
    }))
    const body = await (await GET()).json()
    expect(body.studio).toBe(null)
    expect(body.settings.enabled).toBe(false)
    expect(body.settings.tone).toBe('Org tone')
    expect(body.live_despite_test_mode).toBe(false)
  })
})

// MIAORG.1 final review — the studio editor's Booking link fields: studio-only,
// always saved from the body, and the GET says whether this studio's
// membership source takes bookings (the editor shows the fields when not).
describe('MIAORG.1 final review — booking link + bookings flag', () => {
  const STORED = { settings: { glofox: { branch_id: 'b1' }, customer_agent: { enabled: false } } }
  const save = async (body) => {
    getCurrentUser.mockResolvedValue(OWNER)
    const db = fakeLocationsDb({ reads: { data: STORED, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(putReq(body))
    return { res, blob: db.writes[0]?.patch.settings.customer_agent }
  }
  const BODY = { enabled: false, test_mode: true, test_phones: ['+353870000000'], booking_mode: 'auto', social_enabled: false, glofox_auto_cancel: false }

  it('the link and label are stored with no override path (studio-only keys always save)', async () => {
    const { res, blob } = await save({ ...BODY, booking_url: 'https://book.example.test/hatch', booking_cta_label: 'Book now', overridden: [] })
    expect(res.status).toBe(200)
    expect(blob).toMatchObject({ booking_url: 'https://book.example.test/hatch', booking_cta_label: 'Book now' })
  })

  it('a null link (the editor\'s blank) stores null', async () => {
    const { blob } = await save({ ...BODY, booking_url: null, booking_cta_label: null, overridden: [] })
    expect(blob.booking_url).toBe(null)
    expect(blob.booking_cta_label).toBe(null)
  })

  it('a non-http(s) link and a 21-character label are 400s naming the field, and nothing is written', async () => {
    for (const [bad, path] of [[{ booking_url: 'javascript:alert(1)' }, 'booking_url'], [{ booking_cta_label: 'x'.repeat(21) }, 'booking_cta_label']]) {
      const { res, blob } = await save({ ...BODY, ...bad, overridden: [] })
      expect(res.status).toBe(400)
      expect((await res.json()).issues.map((i) => i.path)).toContain(path)
      expect(blob).toBeUndefined()
    }
  })

  it('a monthly points target is stored from the body, with no override path (studio-only)', async () => {
    const { blob } = await save({ ...BODY, monthly_points_target: 3000, overridden: [] })
    expect(blob.monthly_points_target).toBe(3000)
  })

  it('GET: bookings true at a Glofox studio, false at un1t.online / none', async () => {
    const manager = { id: 'u', role: 'manager', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }
    getCurrentUser.mockResolvedValue(manager)
    for (const [source, want] of [['glofox', true], ['un1t_online', false], ['none', false]]) {
      const db = fakeLocationsDb({ reads: { data: { name: 'S', settings: {}, organization_id: null, membership_source: source }, error: null } })
      createServerClient.mockReturnValue(db)
      const body = await (await GET()).json()
      expect(body.bookings, source).toBe(want)
    }
  })

  it('GET: membership_source_key is the studio\'s locations.membership_source, and no settings blob rides along', async () => {
    const manager = { id: 'u', role: 'manager', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }
    getCurrentUser.mockResolvedValue(manager)
    for (const source of ['glofox', 'un1t_online', 'none']) {
      const db = fakeLocationsDb({ reads: { data: { name: 'S', settings: { un1t_online: { token: 'secret' } }, organization_id: null, membership_source: source }, error: null } })
      createServerClient.mockReturnValue(db)
      const body = await (await GET()).json()
      expect(body.membership_source_key, source).toBe(source)
      expect(JSON.stringify(body)).not.toContain('secret')
    }
  })

})
