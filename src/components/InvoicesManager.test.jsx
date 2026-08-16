// @vitest-environment jsdom
//
// FU-INVOICES-APPROVER — InvoicesManager hard-coded its approver check to
// role === 'master' || role === 'owner', ignoring the grantable
// `approvals_contractor_invoices` permission that the Money hub's
// Contractor-invoices tab (src/app/(money)/layout.js) and the approvals
// provider (src/lib/approvals/providers/contractor-invoices.js) both gate
// on. A manager granted that key could see + click the tab but landed on
// the "not set up as a contractor" fallback instead of the review queue.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

import InvoicesManager from './InvoicesManager.jsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, data: [] }),
  })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('InvoicesManager approver gate', () => {
  it('shows the reviewer queue for a manager granted approvals_contractor_invoices', async () => {
    const user = {
      id: 'u1',
      role: 'manager',
      employment_type: 'fte',
      activeAssignment: { permissions: { approvals_contractor_invoices: true } },
    }
    render(<InvoicesManager user={user} />)
    await waitFor(() => expect(screen.getByText(/Awaiting review/)).toBeTruthy())
  })

  it('still shows the friendly fallback for a manager WITHOUT the grant', async () => {
    const user = {
      id: 'u2',
      role: 'manager',
      employment_type: 'fte',
      activeAssignment: { permissions: { approvals_contractor_invoices: false } },
    }
    render(<InvoicesManager user={user} />)
    await waitFor(() => expect(screen.getByText(/don.t have access to invoice submission/)).toBeTruthy())
  })

  it('master keeps reviewer access regardless of the per-user override', async () => {
    const user = {
      id: 'u3',
      role: 'master',
      employment_type: 'fte',
      activeAssignment: { permissions: { approvals_contractor_invoices: false } },
    }
    render(<InvoicesManager user={user} />)
    await waitFor(() => expect(screen.getByText(/Awaiting review/)).toBeTruthy())
  })
})
