// C115 POLICYVIEWERS.1 — the /policies/manage list's "N / M opened" column
// counts the caller's organisation's people (currentVersionOpenCounts), the
// same people the version page it links to lists. It used to count every
// viewer and every active profile in the estate.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/policies', () => ({ currentVersionOpenCounts: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }) => <a href={typeof href === 'string' ? href : ''}>{children}</a>,
}))

import AdminPoliciesPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { currentVersionOpenCounts } from '@/lib/policies'

const POLICIES = [{
  id: 'pol-1', slug: 'conduct', title: 'Code of conduct', active: true,
  policy_versions: [{ id: 'pv-1', version_number: 2, effective_date: '2026-09-01', published_at: '2026-09-01T00:00:00Z', is_current: true }],
}]

function db() {
  const b = {}
  b.select = () => b
  b.order = () => b
  b.then = (resolve) => Promise.resolve({ data: POLICIES, error: null }).then(resolve)
  return { from: vi.fn(() => b) }
}

describe('/policies/manage open counts', () => {
  it('renders the scoped counts for the caller, never an estate-wide profiles count', async () => {
    const user = { id: 'owner', role: 'owner', isMaster: false, activeOrganization: { id: 'org-a' }, orgAdminOrgIds: ['org-a'] }
    vi.mocked(getCurrentUser).mockResolvedValue(user)
    const fake = db()
    vi.mocked(createServerClient).mockReturnValue(fake)
    vi.mocked(currentVersionOpenCounts).mockResolvedValue({ viewerCount: new Map([['pv-1', 1]]), activeStaffCount: 3 })

    const html = renderToStaticMarkup(await AdminPoliciesPage())

    expect(currentVersionOpenCounts).toHaveBeenCalledWith(['pv-1'], user)
    expect(html.replace(/<[^>]+>/g, '')).toMatch(/1 \/ 3opened/)
    // The page itself no longer reads profiles or policy_views directly.
    expect(fake.from.mock.calls.map(([t]) => t)).toEqual(['policies'])
  })
})
