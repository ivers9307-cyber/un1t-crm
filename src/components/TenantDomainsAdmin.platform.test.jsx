// @vitest-environment jsdom
//
// W1.L1 (mig 716) — the org's automatic <slug>.repset.ie row is read-only
// in the manager: it carries a "platform" badge and offers no Delete
// control (the API answers 409). Enable/Disable stays — tenant_domains.active
// is the hostname kill switch the suspend route leaves to this screen.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import TenantDomainsAdmin from './TenantDomainsAdmin'

const ORG = { id: 'org-a', name: 'Acme Gyms', slug: 'acme-gyms' }
const rows = [
  { id: 'r-platform', hostname: 'acme-gyms.repset.ie', organization_id: ORG.id, location_id: null, brand: {}, active: true, source: 'platform' },
  { id: 'r-custom', hostname: 'members.acmegym.ie', organization_id: ORG.id, location_id: null, brand: {}, active: true, source: 'custom' },
]

afterEach(cleanup)

describe('TenantDomainsAdmin — platform rows (W1.L1)', () => {
  it('a platform row is badged, keeps Enable/Disable (the kill switch) and has no Delete; a custom row keeps both', () => {
    render(<TenantDomainsAdmin initialDomains={rows} organizations={[ORG]} />)
    expect(screen.getByText('platform')).toBeTruthy()
    expect(screen.queryByLabelText('Delete acme-gyms.repset.ie')).toBeNull()
    expect(screen.getByLabelText('Delete members.acmegym.ie')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(2)
  })
})
