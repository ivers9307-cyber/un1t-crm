// @vitest-environment jsdom
//
// W1.E1 — the tenant wizard makes the custom_email_domain gate REACHABLE:
//   1. the owner step grants org_admin (default on) right after the invite,
//      so /settings/email-domain's org-admin gate is satisfiable for the
//      new tenant's owner (0 profile_organizations rows existed anywhere);
//   2. the Done step's "Assign a plan" links /admin/tenants/<orgId> — the
//      page that PINS plans — not /admin/plans, the catalogue editor.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({ href, children, className }) => <a href={typeof href === 'string' ? href : ''} className={className}>{children}</a>,
}))
const replace = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }))

import TenantWizard from './TenantWizard.jsx'

const ORG = 'org-9'
const LOC = 'loc-3'
const PROFILE = 'prof-1'

function jsonResponse(body, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body })
}

let fetchMock
beforeEach(() => {
  replace.mockReset()
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock
})
afterEach(() => cleanup())

function fillOwnerForm() {
  fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Pat Owner' } })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'Pat@Example.com' } })
}

describe('TenantWizard owner step — org_admin grant (W1.E1)', () => {
  it('the checkbox is on by default and the grant is PUT after the invite returns the profile id', async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse({ success: true, data: { id: PROFILE } }, 201))
      .mockImplementationOnce(() => jsonResponse({ success: true, data: { organization_ids: [ORG] } }))
    render(<TenantWizard initialParams={{ org: ORG, loc: LOC }} />)

    const box = screen.getByLabelText(/Organisation admin/)
    expect(box.checked).toBe(true)
    fillOwnerForm()
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [inviteUrl, inviteInit] = fetchMock.mock.calls[0]
    expect(inviteUrl).toBe('/api/staff')
    expect(JSON.parse(inviteInit.body)).toEqual({
      email: 'pat@example.com',
      full_name: 'Pat Owner',
      assignments: [{ location_id: LOC, role: 'owner', is_default: true }],
    })
    const [grantUrl, grantInit] = fetchMock.mock.calls[1]
    expect(grantUrl).toBe(`/api/staff/${PROFILE}/org-admin`)
    expect(grantInit.method).toBe('PUT')
    expect(JSON.parse(grantInit.body)).toEqual({ organization_ids: [ORG] })
    // Advanced to the branding step.
    expect(replace.mock.calls[0][0]).toContain('invited=1')
  })

  it('unticked: invites only, no grant call', async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ success: true, data: { id: PROFILE } }, 201))
    render(<TenantWizard initialParams={{ org: ORG, loc: LOC }} />)
    fireEvent.click(screen.getByLabelText(/Organisation admin/))
    fillOwnerForm()
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a failed grant after a sent invite says so, does not advance, and the retry re-sends ONLY the grant', async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse({ success: true, data: { id: PROFILE } }, 201))
      .mockImplementationOnce(() => jsonResponse({ success: false, error: 'Master role required.' }, 403))
      .mockImplementationOnce(() => jsonResponse({ success: true, data: { organization_ids: [ORG] } }))
    render(<TenantWizard initialParams={{ org: ORG, loc: LOC }} />)
    fillOwnerForm()
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

    await waitFor(() => expect(screen.getByText(/Invite sent, but the organisation admin grant failed/)).toBeTruthy())
    expect(screen.getByText(/Master role required\./)).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry grant' }))
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2][0]).toBe(`/api/staff/${PROFILE}/org-admin`)
  })

  it('a failed invite never attempts the grant', async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ success: false, error: 'Email already in use.' }, 409))
    render(<TenantWizard initialParams={{ org: ORG, loc: LOC }} />)
    fillOwnerForm()
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))
    await waitFor(() => expect(screen.getByText('Email already in use.')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('TenantWizard done step — the pin page is linked (W1.E1)', () => {
  it('"Assign a plan" links /admin/tenants/<orgId>, never /admin/plans', () => {
    render(<TenantWizard initialParams={{ org: ORG, loc: LOC, invited: '1', branded: 'skip', domain: 'skip' }} />)
    const link = screen.getByRole('link', { name: 'Assign a plan' })
    expect(link.getAttribute('href')).toBe(`/admin/tenants/${ORG}`)
    expect(document.querySelector('a[href="/admin/plans"]')).toBeNull()
  })
})
