// C120 GATES-3 — the routes GATES-2 (#1896) found still judging membership
// or the ACTIVE studio's role. Each now asks the question the way its
// siblings do: at SOME studio first (a cheap 403 before any read), then at
// the record's studio (or org).
//   (a) GET/POST /api/whatsapp/broadcasts → `whatsapp` (the [id] routes' rule)
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

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
// These routes had no permission check: every member passed on main.
const noMainNotes = (key) => permissionCases(key)
  .map(([label, ...rest]) => [label.replace(/ \(main: [a-z]+\)$/, ''), ...rest])

const WA_FORBIDDEN = { status: 403, body: { success: false, error: 'Forbidden — WhatsApp not enabled' } }
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
