// ROLESWEEP.1a — WhatsApp broadcast routes judge `whatsapp` (and the template
// resubmit judges MANAGER_ROLES) at the broadcast's / template's location,
// never at the caller's ACTIVE studio. (The SMS broadcast routes this also
// swept left with the SMS channel, TWILIO-RETIRE.1.)
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
import { MANAGER_ROLES } from '@/lib/schemas'
import { describeGate } from '../helpers/role-gate-probe.js'
import { roleCases, permissionCases } from '../helpers/role-sweep-callers.js'
import * as waSend from '@/app/api/whatsapp/broadcasts/[id]/send/route.js'
import * as waResubmit from '@/app/api/whatsapp/templates/[id]/resubmit/route.js'
import * as waTemplates from '@/app/api/whatsapp/templates/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })
const row = (fields) => (loc) => [{ data: { ...fields, location_id: loc }, error: null }]

const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }

beforeEach(() => vi.clearAllMocks())

describeGate('POST /api/whatsapp/broadcasts/[id]/send', {
  call: () => waSend.POST(bare('POST'), params({ id: 'wb-1' })),
  gateReads: row({}),
  forbidden: { status: 403, body: { success: false, error: 'Forbidden — WhatsApp not enabled' } },
  hidden: NOT_FOUND, cases: permissionCases('whatsapp'),
}, T)

describeGate('POST /api/whatsapp/templates/[id]/resubmit (MANAGER_ROLES at the template)', {
  call: () => waResubmit.POST(json('POST', { components: [] }), params({ id: 'wt-1' })),
  gateReads: row({ id: 'wt-1', status: 'REJECTED', meta_template_id: 'meta-1' }),
  forbidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  hidden: NOT_FOUND, cases: roleCases(MANAGER_ROLES),
}, T)

// WATPLROLE.1 — template create, edit and delete judge the resubmit rule
// (MANAGER_ROLES) at the location created at / the template's location.
// Create takes its location from the body, so its non-member answer is
// assertLocationAccess's 403; the two detail handlers keep their 404.
describeGate('POST /api/whatsapp/templates (MANAGER_ROLES at the body location)', {
  call: (target) => waTemplates.POST(json('POST', { name: 'promo_x', components: [], location_id: target })),
  forbidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  hidden: { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } },
  cases: roleCases(MANAGER_ROLES),
}, T)
