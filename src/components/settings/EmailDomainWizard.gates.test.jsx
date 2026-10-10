// @vitest-environment jsdom
//
// W1.E1 — the two gate states of /settings/email-domain tell the operator
// WHAT is missing and WHO fixes it, instead of a bare "not configured":
//   - no platform account token → "ask Repset support" (env POSTMARK_ACCOUNT_TOKEN)
//   - plan without the feature  → names the plan(s) that carry it and says
//     who pins one (the plan is a PAID feature; decision 1 of the W1 plan)

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import EmailDomainWizard from './EmailDomainWizard.jsx'

afterEach(() => cleanup())

const base = { status: 'not_configured', sending_domain: null, from_email: null, from_name: null, dkim_verified: false, return_path_verified: false, records: [], last_error: null }

describe('EmailDomainWizard gate states (W1.E1)', () => {
  it('no platform account token: names the platform token and says to ask Repset support', () => {
    render(<EmailDomainWizard initialState={{ ...base, account_configured: false, addon_active: true }} />)
    expect(screen.getByText(/Platform Postmark account token is not configured/)).toBeTruthy()
    expect(screen.getByText(/ask Repset support/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('plan without the feature: says it comes with the email-marketing plan and NAMES the plans that carry it', () => {
    render(
      <EmailDomainWizard
        initialState={{ ...base, account_configured: true, addon_active: false }}
        featurePlans={[{ id: 'p1', slug: 'scale', name: 'Scale', kind: 'tier' }, { id: 'p2', slug: 'custom_email_domain', name: 'Custom email domain', kind: 'addon' }]}
      />
    )
    expect(screen.getByText(/Comes with the plan that includes email marketing/)).toBeTruthy()
    expect(screen.getByText(/ask your account manager to pin it/)).toBeTruthy()
    expect(screen.getByText('Scale')).toBeTruthy()
    expect(screen.getByText('Custom email domain')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('plan without the feature and no catalogue read: still says who pins it, no list', () => {
    render(<EmailDomainWizard initialState={{ ...base, account_configured: true, addon_active: false }} />)
    expect(screen.getByText(/ask your account manager to pin it/)).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('master sees the pin link to the tenant drill-in; an org admin does not', () => {
    render(<EmailDomainWizard initialState={{ ...base, account_configured: true, addon_active: false }} organizationId="org-9" />)
    expect(screen.getByRole('link', { name: /Pin a plan/ }).getAttribute('href')).toBe('/admin/tenants/org-9')
    cleanup()
    render(<EmailDomainWizard initialState={{ ...base, account_configured: true, addon_active: false }} organizationId={null} />)
    expect(screen.queryByRole('link', { name: /Pin a plan/ })).toBeNull()
  })

  it('the gates are checked in order: the token gate wins over the plan gate', () => {
    render(<EmailDomainWizard initialState={{ ...base, account_configured: false, addon_active: false }} />)
    expect(screen.getByText(/Platform Postmark account token/)).toBeTruthy()
    expect(screen.queryByText(/account manager/)).toBeNull()
  })
})
