// CONTACTREADSCOPE.1a — GET /api/dashboard/studio-contacts judges
// dashboard_studio at ?location_id (the studio whose contact numbers it
// reads), never at the caller's ACTIVE studio, and never asks for Contacts.
// Harness: tests/helpers/role-gate-probe.js (a refused caller never reaches a
// DB call; an allowed one trips the first contacts read).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
// The tripwire throws past the gate; the route logs that as a failed read.
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { describeGate } from '../helpers/role-gate-probe.js'
import { roleCases, permissionCases, person, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import * as studioContacts from '@/app/api/dashboard/studio-contacts/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const get = (qs) => new Request(`http://localhost/api/x?${qs}`)
const call = (loc) => studioContacts.GET(get(`location_id=${loc}`))

const FORBIDDEN = { status: 403, body: { success: false, error: 'Forbidden' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }

beforeEach(() => vi.clearAllMocks())

// The key's code default: master, owner, manager, head_coach hold it; staff
// and reception do not.
describeGate('GET /api/dashboard/studio-contacts (role defaults at the target)', {
  call, forbidden: FORBIDDEN, hidden: NOT_MEMBER,
  cases: roleCases(['owner', 'manager', 'head_coach']),
}, T)

describeGate('GET /api/dashboard/studio-contacts (dashboard_studio at the target)', {
  call, forbidden: FORBIDDEN, hidden: NOT_MEMBER, cases: permissionCases('dashboard_studio'),
}, T)

// Contacts is NOT the gate: these are counts. A Studio-dashboard holder with
// Contacts switched off on web and phone still gets the numbers.
describeGate('GET /api/dashboard/studio-contacts (Contacts off does not refuse)', {
  call, forbidden: FORBIDDEN, hidden: NOT_MEMBER,
  cases: [
    ['head coach at B with Contacts off (web and phone)',
      person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'head_coach', permissions: { contacts: false, mobile: { contacts: false } } } }, LOC_A),
      LOC_B, 'pass'],
  ],
}, T)
