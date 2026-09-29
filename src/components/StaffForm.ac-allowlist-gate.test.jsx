// ACALLOWLISTGATE.1 — the per-user AC allowlist ("Studio Management AC
// units") was gated on UniFi being configured, so a studio with AC but no
// UniFi could not set one, and a studio with UniFi but no AC offered a picker
// with nothing in it. It is gated on ac_configured (server-computed from the
// studio's AC credentials). The UniFi controls keep the UniFi gate.
// Fictional values only.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

const { default: StaffForm } = await import('./StaffForm.jsx')

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const AC_PICKER = 'Studio Management AC units'
const staff = {
  id: 'p0000000-0000-4000-8000-000000000001', full_name: 'Test Person', email: 'test.person@example.test',
  active: true, employment_type: 'fte',
  assignments: [{ location_id: LOC, role: 'staff', is_default: true, permissions: {}, unifi_door_access: false, ac_device_ids: null }],
}
const render = (flags) => renderToStaticMarkup(
  <StaffForm
    staff={staff}
    locations={[{ id: LOC, name: 'Alpha', slug: 'alpha', features: {}, ...flags }]}
    callerOwnerLocationIds={[LOC]}
  />,
)

describe('StaffForm — AC allowlist gate (ACALLOWLISTGATE.1)', () => {
  it('AC configured, UniFi not: the AC picker shows; the UniFi door controls say not configured', () => {
    const html = render({ unifi_configured: false, ac_configured: true })
    expect(html).toContain(AC_PICKER)
    expect(html).toContain('UniFi not configured for this location')
  })

  it('UniFi configured, AC not: no AC picker', () => {
    const html = render({ unifi_configured: true, ac_configured: false })
    expect(html).not.toContain(AC_PICKER)
  })

  it('both: the picker shows', () => {
    expect(render({ unifi_configured: true, ac_configured: true })).toContain(AC_PICKER)
  })

  it('neither: no picker', () => {
    expect(render({ unifi_configured: false, ac_configured: false })).not.toContain(AC_PICKER)
  })

  it('a missing flag is "not configured" (=== true, never truthy)', () => {
    expect(render({ unifi_configured: true, ac_configured: 'yes' })).not.toContain(AC_PICKER)
  })
})
