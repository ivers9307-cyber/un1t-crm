// FU-INVOICES-APPROVER — /schedule/expenses hard-coded its isApprover
// check to master-role or owner-at-any-location, ignoring the grantable
// approvals_fte_expenses key that src/lib/approvals/providers/fte-expenses.js
// and the Money hub's Staff-expenses tab (src/app/(money)/layout.js) both
// gate on. Same bug class fixed in InvoicesManager.jsx (fu-invoices-approver).
//
// Pattern follows src/app/(marketing)/automations/[id]/page.test.js:
// hoisted mocks for @/lib/auth + @/lib/supabase + next/navigation,
// renderToStaticMarkup to inspect the resulting page (the approver-vs-
// submitter header copy lives directly in this page's JSX).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({ data: [] }),
          }),
        }),
      }),
    }),
  })),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  // SCHED.9 — the page now mounts ScheduleTabs, which reads these.
  usePathname: () => '/schedule/expenses',
  useSearchParams: () => new URLSearchParams(),
}))

vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: [] }) })))

import ExpensesPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

function user({ role = 'staff', employment_type = 'fte', perms = {}, rolesByLocation = {} } = {}) {
  return {
    id: 'u1',
    role,
    profileRole: role,
    employment_type,
    activeLocation: { id: 'loc1', features: {} },
    activeAssignment: { permissions: { approvals_fte_expenses: false, ...perms } },
    rolesByLocation,
    locations: [{ id: 'loc1', name: 'Stillorgan' }],
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/schedule/expenses approver gate', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(ExpensesPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login\?redirect=\/schedule\/expenses$/)
  })

  it('redirects to /schedule for a non-FTE manager with no grant and no owner role', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'manager', employment_type: 'fte_ish' }))
    await expect(ExpensesPage()).rejects.toThrow(/^NEXT_REDIRECT:\/schedule$/)
  })

  it('gives reviewer access to a manager explicitly granted approvals_fte_expenses', async () => {
    getCurrentUser.mockResolvedValue(
      user({ role: 'manager', employment_type: 'fte_ish', perms: { approvals_fte_expenses: true } })
    )
    const html = renderToStaticMarkup(await ExpensesPage())
    expect(html).toContain('Review and approve expense claims submitted by your team.')
  })

  it('still gives reviewer access to an owner-at-a-location with no explicit grant (safety-net OR)', async () => {
    getCurrentUser.mockResolvedValue(
      user({ role: 'owner', employment_type: 'fte_ish', rolesByLocation: { loc1: 'owner' } })
    )
    const html = renderToStaticMarkup(await ExpensesPage())
    expect(html).toContain('Review and approve expense claims submitted by your team.')
  })

  it('does not give reviewer access to an FTE with no grant (only submitter copy renders)', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'staff', employment_type: 'fte' }))
    const html = renderToStaticMarkup(await ExpensesPage())
    expect(html).toContain('Submit your monthly expense receipts for reimbursement.')
    expect(html).not.toContain('Review and approve expense claims')
  })
})
