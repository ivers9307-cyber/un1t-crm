import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
// Only getCurrentUser is faked. assertOrganizationAccess stays REAL so the org
// gate below is scored against the membership set getCurrentUser actually
// builds, not against a stub that would agree with whatever the route asks it.
vi.mock('@/lib/auth', async (importActual) => ({
  ...(await importActual()),
  getCurrentUser: vi.fn(),
}))
// @/lib/permissions is deliberately NOT mocked. The permission this route
// gates on has to resolve at a location INSIDE the synced org rather than at
// the caller's active one, and a mocked `hasPermission* → true/false` cannot
// tell those two apart — it would pass whichever way the route was wired.
// Roles are expressed in the fixtures instead and the real tiered resolver
// scores them.
//
// Only the orchestrator is mocked. applyDeletionGuard stays REAL so the
// redaction tests below assert against the guard object the route actually
// receives in production — a hand-written guard literal is what let the
// untripped shape (which carries the full delete list and no `sample` key)
// slip past the first version of this redaction.
vi.mock('@/lib/zoom/reconcile', async (importActual) => ({
  ...(await importActual()),
  runZoomContactSync: vi.fn(),
}))

import { getCurrentUser } from '@/lib/auth'
import { runZoomContactSync, applyDeletionGuard } from '@/lib/zoom/reconcile'
import { POST } from './route'

const post = (body) => new Request('https://x.test/api/integrations/zoom-contacts/run', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

const ORG_SYNC = 'org-1'
const ORG_OTHER = 'org-other'
const KEY = 'integrations_zoom_manage'

/**
 * A user shaped the way getCurrentUser() returns one.
 *
 * `at` is the membership fact — { [locationId]: { org, role, permissions? } },
 * mirroring profile_locations. `activeLocationId` is session state, kept
 * independent of it so the tests can put a caller's active location in one org
 * while their role lives in another. That divergence is the whole point: it is
 * ordinary for staff who work across UN1T and CCF Autos.
 */
function userWith({ at = {}, activeLocationId = null, master = false, orgAdminOrgIds = [] } = {}) {
  const locations = Object.entries(at).map(([id, v]) => ({ id, organization_id: v.org }))
  const assignmentsByLocation = Object.fromEntries(
    Object.entries(at).map(([id, v]) => [id, { role: v.role, permissions: v.permissions || {} }])
  )
  const activeLocation = activeLocationId
    ? locations.find((l) => l.id === activeLocationId) || null
    : null
  return {
    id: 'u-1',
    isMaster: master,
    role: master ? 'master' : (assignmentsByLocation[activeLocationId]?.role || 'staff'),
    locations,
    assignmentsByLocation,
    activeAssignment: activeLocationId ? assignmentsByLocation[activeLocationId] || null : null,
    activeLocation,
    // Session state only — mirrors the active location, exactly as auth.js
    // derives it. Present so a regression that reads it again is visible.
    activeOrganization: activeLocation ? { id: activeLocation.organization_id } : null,
    organizationsById: Object.fromEntries(Object.values(at).map((v) => [v.org, { id: v.org }])),
    orgAdminOrgIds,
    rolesByLocation: Object.fromEntries(Object.entries(at).map(([id, v]) => [id, v.role])),
    roleTemplatesByLocation: {},
  }
}

// Owner inside the synced org, operating there. The ordinary happy path.
const ownerInSyncOrg = () => userWith({
  at: { 'loc-un1t': { org: ORG_SYNC, role: 'owner' } },
  activeLocationId: 'loc-un1t',
})

// Member of the synced org with no authority to write there.
const staffInSyncOrg = () => userWith({
  at: { 'loc-un1t': { org: ORG_SYNC, role: 'staff' } },
  activeLocationId: 'loc-un1t',
})

beforeEach(() => {
  process.env.ZOOM_SYNC_ORGANIZATION_ID = ORG_SYNC
  // mockClear on both — without it, mock.calls accumulates across tests in this
  // file (vitest does not auto-clear mocks between tests) and `.mock.calls[0]`
  // / `.not.toHaveBeenCalled()` below stop meaning "the call this test just
  // made" (same rationale as the cron route's sibling test).
  vi.mocked(getCurrentUser).mockClear()
  vi.mocked(runZoomContactSync).mockClear()
  vi.mocked(getCurrentUser).mockResolvedValue(ownerInSyncOrg())
  vi.mocked(runZoomContactSync).mockResolvedValue({ ok: true, counts: { creates: 1, updates: 0, deletes: 0 }, enqueued: 1 })
})

describe('POST /api/integrations/zoom-contacts/run', () => {
  it('401s when unauthenticated', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    expect((await POST(post({ dry: true }))).status).toBe(401)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  // A preview writes nothing, so it must NOT consult the permission key.
  it('lets an unprivileged user preview', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(staffInSyncOrg())
    const res = await POST(post({ dry: true }))
    expect(res.status).toBe(200)
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0]).toMatchObject({ dry: true, trigger: 'manual', triggeredBy: 'u-1' })
  })

  it('refuses a real run without the permission', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(staffInSyncOrg())
    expect((await POST(post({ dry: false }))).status).toBe(403)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  // force is destructive even alongside dry — it must never ride in on the
  // preview exemption.
  it('refuses the guard override without the permission, even with dry set', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(staffInSyncOrg())
    expect((await POST(post({ dry: true, force: true }))).status).toBe(403)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  // Pins the KEY itself without asserting on a mock call: a per-location
  // override of exactly this key, at the synced org's location, is what lifts
  // an otherwise-refused staffer. A route reading a different key stays 403.
  it('checks the right permission key', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userWith({
      at: { 'loc-un1t': { org: ORG_SYNC, role: 'staff', permissions: { [KEY]: true } } },
      activeLocationId: 'loc-un1t',
    }))
    expect((await POST(post({ force: true }))).status).toBe(200)
  })

  it('lets a permitted user run and force', async () => {
    expect((await POST(post({ force: true }))).status).toBe(200)
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].force).toBe(true)
  })

  it('refuses a user outside the synced organisation even with the permission', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userWith({
      at: { 'loc-ccf': { org: ORG_OTHER, role: 'owner' } },
      activeLocationId: 'loc-ccf',
    }))
    expect((await POST(post({ dry: true }))).status).toBe(403)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  // ─── Org membership is not the active session ──────────────────────────
  //
  // The gate used to compare ZOOM_SYNC_ORGANIZATION_ID against
  // `user.activeOrganization`, which mirrors whichever LOCATION is selected in
  // the caller's session. Someone who genuinely runs a UN1T studio got a bare
  // "Forbidden" purely for having a CCF Autos location selected, with nothing
  // in the response hinting that switching location was the fix.

  it('lets an owner inside the synced org run while ANOTHER org’s location is active', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userWith({
      at: {
        'loc-un1t': { org: ORG_SYNC, role: 'owner' },
        'loc-ccf': { org: ORG_OTHER, role: 'staff' },
      },
      activeLocationId: 'loc-ccf',
    }))
    expect((await POST(post({ force: true }))).status).toBe(200)
  })

  it('lets a member of the synced org preview while another org’s location is active', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userWith({
      at: {
        'loc-un1t': { org: ORG_SYNC, role: 'staff' },
        'loc-ccf': { org: ORG_OTHER, role: 'staff' },
      },
      activeLocationId: 'loc-ccf',
    }))
    expect((await POST(post({ dry: true }))).status).toBe(200)
  })

  // SAAS-4 (mig 417): an org admin reaches every active location of their org
  // via a synthetic 'owner' assignment, which is the shape getCurrentUser
  // hands downstream — so the gate sees them even from a foreign active org.
  it('lets an org admin of the synced org run from another org’s active location', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userWith({
      at: {
        'loc-un1t': { org: ORG_SYNC, role: 'owner' },   // synthetic, from expandOrgAdminAccess
        'loc-ccf': { org: ORG_OTHER, role: 'staff' },
      },
      activeLocationId: 'loc-ccf',
      orgAdminOrgIds: [ORG_SYNC],
    }))
    expect((await POST(post({ force: true }))).status).toBe(200)
  })

  // The hole that opens if the org gate is loosened while the capability check
  // still resolves at the ACTIVE location: this caller is a genuine member of
  // the synced org, so membership passes, and `hasPermission()` would say true
  // because they are owner at their active CCF Autos location. But staff is
  // the only role they hold inside the synced org, so they may not write to
  // its directory.
  it('refuses a destructive run to someone whose only authority is in another org', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userWith({
      at: {
        'loc-un1t': { org: ORG_SYNC, role: 'staff' },
        'loc-ccf': { org: ORG_OTHER, role: 'owner' },
      },
      activeLocationId: 'loc-ccf',
    }))
    expect((await POST(post({ force: true }))).status).toBe(403)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  // assertOrganizationAccess passes a null org id through as "the caller named
  // no organisation". Unset is the LIVE state — the sync ships dark until the
  // ZOOM_* secrets land — so delegating this case would hand the destructive
  // run to every authenticated user.
  it('refuses everyone but master when ZOOM_SYNC_ORGANIZATION_ID is unset', async () => {
    delete process.env.ZOOM_SYNC_ORGANIZATION_ID
    expect((await POST(post({ dry: true }))).status).toBe(403)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  it('still lets master through when ZOOM_SYNC_ORGANIZATION_ID is unset', async () => {
    delete process.env.ZOOM_SYNC_ORGANIZATION_ID
    vi.mocked(getCurrentUser).mockResolvedValue(userWith({ master: true }))
    expect((await POST(post({ force: true }))).status).toBe(200)
  })

  it('lets master through from an organisation that is not the synced one', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userWith({
      at: { 'loc-ccf': { org: ORG_OTHER, role: 'owner' } },
      activeLocationId: 'loc-ccf',
      master: true,
    }))
    expect((await POST(post({ force: true }))).status).toBe(200)
  })

  it('400s on a bad limit', async () => {
    expect((await POST(post({ limit: -5 }))).status).toBe(400)
  })

  it('redacts the guard sample for a caller who cannot act on it', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(staffInSyncOrg())
    vi.mocked(runZoomContactSync).mockResolvedValue({
      ok: false, guardTripped: true,
      guard: { threshold: 20, attempted: 400, sample: ['+353871111111', '+353872222222'] },
    })
    const body = await (await POST(post({ dry: true }))).json()
    expect(body.data.guard.sample).toBeUndefined()
    expect(body.data.guard.sampleRedacted).toBe(2)
    expect(body.data.guard.attempted).toBe(400)   // counts still useful
  })

  it('gives the sample to a caller who can act on it', async () => {
    vi.mocked(runZoomContactSync).mockResolvedValue({
      ok: false, guardTripped: true,
      guard: { threshold: 20, attempted: 400, sample: ['+353871111111'] },
    })
    const body = await (await POST(post({ dry: true }))).json()
    expect(body.data.guard.sample).toEqual(['+353871111111'])
  })

  // Redaction follows the same org-scoped answer as the write gate: a member
  // of the synced org whose authority lives in ANOTHER org can preview, but
  // must not be handed member phone numbers on the strength of it.
  it('redacts the sample from a caller whose authority is in another org', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userWith({
      at: {
        'loc-un1t': { org: ORG_SYNC, role: 'staff' },
        'loc-ccf': { org: ORG_OTHER, role: 'owner' },
      },
      activeLocationId: 'loc-ccf',
    }))
    vi.mocked(runZoomContactSync).mockResolvedValue({
      ok: false, guardTripped: true,
      guard: { threshold: 20, attempted: 400, sample: ['+353871111111'] },
    })
    const body = await (await POST(post({ dry: true }))).json()
    expect(body.data.guard.sample).toBeUndefined()
    expect(body.data.guard.sampleRedacted).toBe(1)
  })

  // The UNTRIPPED guard is the ordinary preview, and it is the worse leak: it
  // has no `sample` key at all, it carries `deletes` — every delete candidate,
  // uncapped, each with a real member number — and the dry branch of
  // runZoomContactSyncBody returns `guard` whether or not it tripped.
  it('leaks no member number to an unprivileged previewer when the guard did not trip', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(staffInSyncOrg())
    const guard = applyDeletionGuard(
      [{ e164: '+353871111111', zoomId: 'z1' }, { e164: '+353872222222', zoomId: 'z2' }],
      5000,
    )
    // Premise of the test, asserted rather than assumed.
    expect(guard.tripped).toBe(false)
    expect(guard.sample).toBeUndefined()
    expect(guard.deletes).toHaveLength(2)

    vi.mocked(runZoomContactSync).mockResolvedValue({
      ok: true, dry: true, counts: { creates: 0, updates: 0, deletes: 2 },
      guardTripped: false, guard, ownedInZoom: 5000,
    })
    const res = await POST(post({ dry: true }))
    const body = await res.json()

    expect(JSON.stringify(body)).not.toContain('+353871111111')
    expect(body.data.guard.deletes).toBeUndefined()
    // The counts a previewer legitimately needs survive.
    expect(body.data.guard.deletesRedacted).toBe(2)
    expect(body.data.guard.threshold).toBe(250)
    expect(body.data.counts.deletes).toBe(2)
  })

  it('gives the untripped delete list to a caller who can act on it', async () => {
    const guard = applyDeletionGuard([{ e164: '+353871111111', zoomId: 'z1' }], 5000)
    vi.mocked(runZoomContactSync).mockResolvedValue({ ok: true, dry: true, guard })
    const body = await (await POST(post({ dry: true }))).json()
    expect(body.data.guard.deletes).toEqual([{ e164: '+353871111111', zoomId: 'z1' }])
  })
})
