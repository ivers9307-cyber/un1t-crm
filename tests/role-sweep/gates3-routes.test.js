// C120 GATES-3 — the routes GATES-2 (#1896) found still judging membership
// or the ACTIVE studio's role. Each now asks the question the way its
// siblings do: at SOME studio first (a cheap 403 before any read), then at
// the record's studio (or org).
//   (a) GET/POST /api/whatsapp/broadcasts → `whatsapp` (the [id] routes' rule)
//   (b) WhatsApp template create / content edit / delete / resubmit →
//       `whatsapp` at the template's studio, beside MANAGER_ROLES there
//       (canManageWaTemplatesAt). roleCases for these live in broadcasts.test.js.
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
import { permissionCases, keyOnAtBOnly, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import * as broadcasts from '@/app/api/whatsapp/broadcasts/route.js'
import * as waTemplates from '@/app/api/whatsapp/templates/route.js'
import * as waTemplate from '@/app/api/whatsapp/templates/[id]/route.js'
import * as waResubmit from '@/app/api/whatsapp/templates/[id]/resubmit/route.js'

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
