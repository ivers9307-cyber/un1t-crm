// @vitest-environment jsdom
//
// A first attempt that created the Postmark server but failed to attach the
// domain (live 11 Oct: "Domain already exists" on un1tdublin.com) leaves a
// 'pending' row with no sending_domain. The wizard must offer the domain form
// again (POST reuses the server and can adopt the domain), not a Verify button
// with nothing to verify.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import EmailDomainWizard from './EmailDomainWizard.jsx'

afterEach(() => cleanup())

const base = { account_configured: true, addon_active: true, from_email: null, from_name: null, dkim_verified: false, return_path_verified: false, records: [] }

describe('EmailDomainWizard retry after a half-finished attempt', () => {
  it('a pending row with no domain shows the domain form and the last error, not Verify', () => {
    render(<EmailDomainWizard initialState={{ ...base, status: 'pending', sending_domain: null, last_error: 'Postmark account API error: Domain already exists.' }} />)
    expect(screen.getByText('Set up your sending domain')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create sending domain' })).toBeTruthy()
    expect(screen.getByText(/The last attempt did not finish: Postmark account API error: Domain already exists\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull()
  })

  it('a fresh org shows the form with no error banner', () => {
    render(<EmailDomainWizard initialState={{ ...base, status: 'not_configured', sending_domain: null, last_error: null }} />)
    expect(screen.getByRole('button', { name: 'Create sending domain' })).toBeTruthy()
    expect(screen.queryByText(/The last attempt did not finish/)).toBeNull()
  })

  it('a row with a domain still shows the DNS + Verify step', () => {
    render(<EmailDomainWizard initialState={{ ...base, status: 'pending', sending_domain: 'mail.example.com', last_error: null }} />)
    expect(screen.queryByText('Set up your sending domain')).toBeNull()
    expect(screen.getByRole('button', { name: 'Verify' })).toBeTruthy()
  })
})
