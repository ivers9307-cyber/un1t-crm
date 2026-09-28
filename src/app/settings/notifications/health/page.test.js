// TENANTSCOPE.1 — the push-delivery fleet page shows the ACTIVE
// organisation's studios and staff. It had an EXEMPT in
// check:location-scoping ("single-org estate today; revisit when a second
// org onboards") and two more organisations have onboarded.
//
// Real @/lib/auth guards + real permissions, getCurrentUser swapped, over
// the SAAS-10 two-tenant double; rendered to static markup with the two
// client buttons stubbed.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }) => <a href={typeof href === 'string' ? href : ''}>{children}</a>,
}))
vi.mock('@/components/settings/TestPushButton', () => ({ default: () => null }))
vi.mock('@/components/settings/NudgeUpdateButton', () => ({ default: () => null }))

import PushHealthPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  makeWorld, makeTenantDb, users, P_STAFF_A1, P_STAFF_B1,
} from '../../../../../tests/cross-tenant/fixture.js'

function fleetWorld() {
  const w = makeWorld()
  for (const l of w.locations) l.is_host_anchor = false
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const device = (id, userId, version) => ({
    id, user_id: userId, platform: 'ios', device_name: id, app_version: version,
    created_at: at, last_seen_at: at, geofence_permission: null, geofence_permission_at: null,
    expo_push_token: `ExponentPushToken[${id}]`, native_build: null,
  })
  w.device_tokens = [device('dt-a1', P_STAFF_A1, '2.4.0'), device('dt-b1', P_STAFF_B1, '2.5.0')]
  return w
}

async function render(user) {
  vi.mocked(getCurrentUser).mockResolvedValue(user)
  vi.mocked(createServerClient).mockReturnValue(makeTenantDb(fleetWorld()))
  return renderToStaticMarkup(await PushHealthPage())
}

describe('/settings/notifications/health — the active organisation only (TENANTSCOPE.1)', () => {
  it("a manager at A One sees org A's studios and staff, never org B's", async () => {
    const html = await render(users.managerA1())
    expect(html).toContain('Staff A-One')
    expect(html).toContain('A Two')
    expect(html).not.toContain('Staff B-One') // main: listed under "B One"
    expect(html).not.toContain('B One')
    expect(html).not.toContain('@b.com')
  })

  it('still shows the estate target version — one app binary', async () => {
    const html = await render(users.managerA1())
    expect(html).toContain('v2.5.0') // org B's phone sets it
  })

  it('a master still sees every studio in the estate', async () => {
    const html = await render(users.master())
    expect(html).toContain('Staff B-One')
    expect(html).toContain('B Two')
  })
})

// "Total staff" is the big number on the page; read it off the card.
const totalStaff = (html) => Number(html.match(/>(\d+)<\/div><div[^>]*>Total staff</)?.[1])

describe('/settings/notifications/health — everyone counted is listed (TENANTSCOPE.1)', () => {
  it("lists org A's org admin, who has no studio membership, under \"No active studio\"", async () => {
    const html = await render(users.managerA1())
    // Org A's fleet: four studio members + the org admin (profile_organizations only).
    expect(totalStaff(html)).toBe(5)
    expect(html).toContain('No active studio')
    expect(html).toContain('Org Admin A') // main of this branch: counted in the 5, listed nowhere
    for (const email of ['staff.a1@a.com', 'mgr.a1@a.com', 'owner.a1@a.com', 'staff.a2@a.com', 'admin@a.com']) {
      expect(html).toContain(email)
    }
  })

  it('every counted person appears in some group, for a master too', async () => {
    const html = await render(users.master())
    const listedEmails = new Set(html.match(/[a-z0-9.]+@[a-z]+\.com/g))
    expect(totalStaff(html)).toBe(9)
    expect(listedEmails.size).toBe(9) // The Master + Org Admin A sit under "No active studio"
  })

  it('shows no "No active studio" group when everyone has a studio', async () => {
    const world = fleetWorld()
    world.profile_organizations = []
    vi.mocked(getCurrentUser).mockResolvedValue(users.managerA1())
    vi.mocked(createServerClient).mockReturnValue(makeTenantDb(world))
    const html = renderToStaticMarkup(await PushHealthPage())
    expect(totalStaff(html)).toBe(4)
    expect(html).not.toContain('No active studio')
  })
})
