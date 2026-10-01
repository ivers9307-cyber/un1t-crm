// C120 GATES-3 — the routes GATES-2 (#1896) found still judging membership
// or the ACTIVE studio's role. Each now asks the question the way its
// siblings do: at SOME studio first (a cheap 403 before any read), then at
// the record's studio (or org).
//   (a) GET/POST /api/whatsapp/broadcasts → `whatsapp` (the [id] routes' rule)
//   (b) WhatsApp template create / content edit / delete / resubmit →
//       `whatsapp` at the template's studio, beside MANAGER_ROLES there
//       (canManageWaTemplatesAt). roleCases for these live in broadcasts.test.js.
//   (c) POST /api/contracts and GET /api/contract-templates (the issue
//       wizard's list) → canManageContractsSomewhere, then the template's org;
//       never the ACTIVE studio's role (`user.role`).
// And C134 WEBBOOKINGWRITES.1: the two web booking writes (status, skip
// reminder) moved off the browser client, whose RLS judged the PHONE
// `bookings` key, onto service-role routes that judge the WEB `bookings` key
// at the booking's studio.
// Harness: tests/helpers/role-gate-probe.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { describeGate, gateProbe, runProbed } from '../helpers/role-gate-probe.js'
import { permissionCases, keyOnAtBOnly, person, MASTER, ORG, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import * as broadcasts from '@/app/api/whatsapp/broadcasts/route.js'
import * as waTemplates from '@/app/api/whatsapp/templates/route.js'
import * as waTemplate from '@/app/api/whatsapp/templates/[id]/route.js'
import * as waResubmit from '@/app/api/whatsapp/templates/[id]/resubmit/route.js'
import * as contracts from '@/app/api/contracts/route.js'
import * as contractTemplates from '@/app/api/contract-templates/route.js'
import * as bookingStatus from '@/app/api/bookings/[id]/status/route.js'
import * as bookingSkip from '@/app/api/bookings/[id]/skip-reminder/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })
const row = (fields) => (loc) => [{ data: { ...fields, location_id: loc }, error: null }]
// These routes had no permission check: every member passed on main.
const noMainNotes = (key) => permissionCases(key)
  .map(([label, ...rest]) => [label.replace(/ \(main: [a-z]+\)$/, ''), ...rest])

const WA_FORBIDDEN = { status: 403, body: { success: false, error: 'Forbidden — WhatsApp not enabled' } }
const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const TPL_FORBIDDEN = { status: 403, body: { success: false, error: 'Forbidden' } }
const BODY_HIDDEN = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
const TPL = '00000000-0000-4000-8000-0000000000e1'

beforeEach(() => vi.clearAllMocks())

// ── (a) WhatsApp broadcasts list + create ──────────────────────────────────
describeGate('GET /api/whatsapp/broadcasts?location_id= (whatsapp at the studio)', {
  call: (loc) => broadcasts.GET(bare('GET', `?location_id=${loc}`)),
  forbidden: WA_FORBIDDEN, hidden: BODY_HIDDEN, cases: noMainNotes('whatsapp'),
}, T)
describeGate('POST /api/whatsapp/broadcasts (whatsapp at the studio it creates at)', {
  call: (loc) => broadcasts.POST(json('POST', {
    name: 'Spring', template_id: TPL, location_id: loc,
    audience_filter: { logic: 'and', filters: [] },
  })),
  forbidden: WA_FORBIDDEN, hidden: BODY_HIDDEN, cases: noMainNotes('whatsapp'),
}, T)

describe('GET /api/whatsapp/broadcasts with no location lists only the studios where the caller holds whatsapp', () => {
  it('filters to B when whatsapp is off for them at A', async () => {
    getCurrentUser.mockResolvedValue(keyOnAtBOnly('whatsapp'))
    const probe = gateProbe()
    createServerClient.mockReturnValue(probe.db)
    await runProbed(probe, () => broadcasts.GET(bare('GET')))
    expect(probe.tripped?.table).toBe('whatsapp_broadcasts')
    expect(probe.tripped.chain).toContainEqual(['in', 'location_id', [LOC_B]])
  })
  it('holding whatsapp nowhere is refused before any read', async () => {
    getCurrentUser.mockResolvedValue({ ...keyOnAtBOnly('whatsapp'), assignmentsByLocation: {
      [LOC_A]: { role: 'owner', permissions: { whatsapp: false } },
      [LOC_B]: { role: 'owner', permissions: { whatsapp: false } },
    } })
    const from = vi.fn()
    createServerClient.mockReturnValue({ from })
    const res = await broadcasts.GET(bare('GET'))
    expect({ status: res.status, body: await res.json() }).toEqual(WA_FORBIDDEN)
    expect(from).not.toHaveBeenCalled()
  })
})

// ── (b) WhatsApp templates: the role AND `whatsapp` at the template's studio ─
// On main a manager with WhatsApp switched off at the studio passed (role only).
describeGate('POST /api/whatsapp/templates (whatsapp at the studio it creates at)', {
  call: (loc) => waTemplates.POST(json('POST', { name: 'promo_x', components: [], location_id: loc })),
  forbidden: TPL_FORBIDDEN, hidden: BODY_HIDDEN, cases: noMainNotes('whatsapp'),
}, T)
describeGate('PUT /api/whatsapp/templates/[id] with a content field (whatsapp at the template)', {
  call: () => waTemplate.PUT(json('PUT', { components: [{ type: 'BODY', text: 'x' }] }), params({ id: 'wt-1' })),
  gateReads: row({ status: 'draft', meta_template_id: null }),
  forbidden: TPL_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('whatsapp'),
}, T)
describeGate('DELETE /api/whatsapp/templates/[id] (whatsapp at the template)', {
  call: () => waTemplate.DELETE(bare('DELETE'), params({ id: 'wt-1' })),
  gateReads: row({ name: 'promo_x' }),
  forbidden: TPL_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('whatsapp'),
}, T)
describeGate('POST /api/whatsapp/templates/[id]/resubmit (whatsapp at the template)', {
  call: () => waResubmit.POST(json('POST', { components: [] }), params({ id: 'wt-1' })),
  gateReads: row({ id: 'wt-1', status: 'REJECTED', meta_template_id: 'meta-1' }),
  forbidden: TPL_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('whatsapp'),
}, T)

// ── (c) contracts: the org, never the active role ──────────────────────────
describe('POST /api/contracts and GET /api/contract-templates judge the org, not the active role', () => {
  const OTHER_ORG = 'e0000000-0000-4000-8000-0000000000e0'
  const ownerBManagerAActive = person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'owner' } }, LOC_A)
  const adminStaffActive = person({ [LOC_A]: { role: 'staff' } }, LOC_A, { orgAdminOrgIds: [ORG] })
  const managerBoth = person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'manager' } }, LOC_A)
  const ownerOtherActive = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
  const template = (org) => ({ data: { id: TPL, organization_id: org, body_markdown: '', variables_schema: [], employment_type: 'both', active: true }, error: null })
  const issue = () => contracts.POST(json('POST', {
    template_id: TPL, profile_id: '00000000-0000-4000-8000-0000000000a1', variables: {}, issuer_signature: 'A Name',
  }))
  const FORBIDDEN = { status: 403, body: { success: false, error: 'Master or owner only' } }
  const TEMPLATE_NOT_FOUND = { status: 404, body: { success: false, error: 'Template not found' } }

  it.each([
    ['an owner of the org whose ACTIVE role is manager (main: forbidden)', ownerBManagerAActive, ORG, 'pass'],
    ['an org admin whose own role at the active studio is staff (main: forbidden)', adminStaffActive, ORG, 'pass'],
    ['a master', MASTER, ORG, 'pass'],
    ['an owner at the active studio, template of ANOTHER org', ownerOtherActive, OTHER_ORG, 'hidden'],
    ['a manager who owns no org', managerBoth, ORG, 'forbidden'],
  ])('POST /api/contracts: %s', async (_label, caller, org, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const probe = gateProbe([template(org)])
    createServerClient.mockReturnValue(probe.db)
    const { status, body } = await runProbed(probe, issue)
    if (outcome === 'pass') {
      expect(probe.passed, `refused: ${status} ${JSON.stringify(body)}`).toBe(true)
      expect(probe.tripped.table).toBe('profiles')
      return
    }
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual(outcome === 'hidden' ? TEMPLATE_NOT_FOUND : FORBIDDEN)
    if (outcome === 'forbidden') expect(probe.reads).toEqual([])
  })

  it.each([
    ['an owner of the org whose ACTIVE role is manager (main: forbidden)', ownerBManagerAActive, 'pass'],
    ['an org admin whose own role at the active studio is staff', adminStaffActive, 'pass'],
    ['a manager who owns no org', managerBoth, 'forbidden'],
  ])('GET /api/contract-templates: %s', async (_label, caller, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const probe = gateProbe()
    createServerClient.mockReturnValue(probe.db)
    const { status, body } = await runProbed(probe, () => contractTemplates.GET(bare('GET')))
    if (outcome === 'pass') {
      expect(probe.passed, `refused: ${status} ${JSON.stringify(body)}`).toBe(true)
      expect(probe.tripped.chain).toContainEqual(['in', 'organization_id', [ORG]])
      return
    }
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual(FORBIDDEN)
  })
})

// ── C134 web booking writes: the WEB `bookings` key at the booking's studio ─
// On main these were browser-client writes whose RLS judged the PHONE key.
const BOOKINGS_FORBIDDEN = { status: 403, body: { success: false, error: 'No bookings permission at this location' } }
describeGate('POST /api/bookings/[id]/status (web bookings at the booking)', {
  call: () => bookingStatus.POST(json('POST', { status: 'completed' }), params({ id: 'bk-1' })),
  gateReads: row({ id: 'bk-1', status: 'confirmed', event_types: null }),
  forbidden: BOOKINGS_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('bookings'),
}, T)
describeGate('POST /api/bookings/[id]/skip-reminder (web bookings at the booking)', {
  call: () => bookingSkip.POST(json('POST', { skip_reminder: true }), params({ id: 'bk-1' })),
  gateReads: row({ id: 'bk-1', status: 'confirmed', event_types: null }),
  forbidden: BOOKINGS_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('bookings'),
}, T)

describe('C134: web bookings without the phone key is enough; the phone key alone is not', () => {
  const webOnly = person({ [LOC_B]: { role: 'manager', permissions: { bookings: true, mobile: { bookings: false } } } }, LOC_B)
  const phoneOnly = person({ [LOC_B]: { role: 'manager', permissions: { bookings: false, mobile: { bookings: true } } } }, LOC_B)
  const answer = [{ data: { id: 'bk-1', status: 'confirmed', location_id: LOC_B, event_types: null }, error: null }]
  it.each([
    ['status', () => bookingStatus.POST(json('POST', { status: 'no_show' }), params({ id: 'bk-1' }))],
    ['skip-reminder', () => bookingSkip.POST(json('POST', { skip_reminder: false }), params({ id: 'bk-1' }))],
  ])('%s', async (_label, call) => {
    getCurrentUser.mockResolvedValue(webOnly)
    let probe = gateProbe([...answer])
    createServerClient.mockReturnValue(probe.db)
    await runProbed(probe, call)
    expect(probe.passed).toBe(true)

    getCurrentUser.mockResolvedValue(phoneOnly)
    probe = gateProbe([...answer])
    createServerClient.mockReturnValue(probe.db)
    const { status, body } = await runProbed(probe, call)
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual(BOOKINGS_FORBIDDEN)
  })

  it('a booking with no studio of its own is judged at its booking type\'s', async () => {
    getCurrentUser.mockResolvedValue(webOnly)
    const probe = gateProbe([{ data: { id: 'bk-1', status: 'confirmed', location_id: null, event_types: { location_id: LOC_B } }, error: null }])
    createServerClient.mockReturnValue(probe.db)
    await runProbed(probe, () => bookingSkip.POST(json('POST', { skip_reminder: true }), params({ id: 'bk-1' })))
    expect(probe.passed).toBe(true)
  })
})
