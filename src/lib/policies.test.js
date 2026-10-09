// POLICIES.1 + POLICIES-VIEWS.1 — unit tests for the policies lib.
//
// Mocks createServerClient with a minimal fake supabase that returns
// configurable data per (table, op) pair. Focus areas:
//   - listPoliciesWithStatus: current-version + view status join
//   - outstandingPolicyCount: not-yet-viewed counting
//   - detectSectionHeadings: heading-detection heuristic (numbered
//     headings, ALL-CAPS headings, blank-line-followed)
//
// W0.5 — policies belong to an organisation (mig 710). The fake's `policies`
// reads really apply `.eq`, so a read that forgets the organisation filter
// returns the other tenant's rows here and fails, rather than passing
// vacuously against a mock that returns whatever it is given.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const {
  listPoliciesWithStatus,
  getPolicyBySlug,
  outstandingPolicyCount,
  policyOrgIdFor,
  detectSectionHeadings,
} = await import('./policies.js')

const ORG = 'org-a'
const FOREIGN = 'org-b'
const user = { id: 'u1', activeOrganization: { id: ORG } }

function buildDb({ policies = [], views = [] }) {
  return {
    from: vi.fn((table) => {
      if (table === 'policies') {
        let matched = [...policies]
        const b = {}
        b.select = vi.fn(() => b)
        b.eq = vi.fn((col, val) => { matched = matched.filter((r) => r[col] === val); return b })
        b.order = vi.fn(() => Object.assign(b, {
          then: (resolve) => resolve({ data: matched, error: null }),
        }))
        b.maybeSingle = vi.fn(async () => ({ data: matched[0] ?? null, error: null }))
        return b
      }
      if (table === 'policy_views') {
        return {
          select: vi.fn().mockReturnThis(),
          eq:     vi.fn().mockReturnThis(),
          in:     vi.fn().mockReturnThis(),
          not:    vi.fn().mockReturnThis(),
          order:  vi.fn().mockResolvedValue({ data: views, error: null }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

beforeEach(() => { createServerClient.mockReset() })

describe('policyOrgIdFor', () => {
  it('prefers the active organisation, then the active location\'s organisation, else null', () => {
    expect(policyOrgIdFor({ activeOrganization: { id: ORG }, activeLocation: { organization_id: FOREIGN } })).toBe(ORG)
    expect(policyOrgIdFor({ activeLocation: { organization_id: FOREIGN } })).toBe(FOREIGN)
    expect(policyOrgIdFor({ id: 'u1' })).toBeNull()
    expect(policyOrgIdFor(null)).toBeNull()
  })
})

describe('listPoliciesWithStatus', () => {
  it('returns [] when user is missing', async () => {
    const result = await listPoliciesWithStatus(null)
    expect(result).toEqual([])
  })

  it('returns [] without querying when the user has no organisation (W0.5)', async () => {
    createServerClient.mockReturnValue(buildDb({ policies: [{ id: 'p1', organization_id: ORG, active: true }] }))
    expect(await listPoliciesWithStatus({ id: 'u1' })).toEqual([])
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('reads only the caller\'s organisation\'s policies, never another tenant\'s (W0.5)', async () => {
    const fake = buildDb({
      policies: [
        { id: 'p1', slug: 'employee-handbook', title: 'Handbook', description: null, display_order: 10,
          active: true, organization_id: ORG, policy_versions: [] },
        { id: 'p2', slug: 'employee-handbook', title: 'Other tenant handbook', description: null, display_order: 10,
          active: true, organization_id: FOREIGN, policy_versions: [] },
      ],
    })
    createServerClient.mockReturnValue(fake)
    const result = await listPoliciesWithStatus(user)
    expect(result.map((p) => p.id)).toEqual(['p1'])
    expect(fake.from.mock.results[0].value.eq).toHaveBeenCalledWith('organization_id', ORG)
  })

  it('marks a policy as viewed_at when a completed view exists', async () => {
    createServerClient.mockReturnValue(buildDb({
      policies: [
        {
          id: 'p1', slug: 'handbook', title: 'Handbook', description: 'd', display_order: 10,
          active: true, organization_id: ORG,
          policy_versions: [
            { id: 'v2', version_number: 2, body_markdown: 'new', change_summary: 'Updated',
              effective_date: '2026-05-01', published_at: '2026-05-01T00:00:00Z', is_current: true },
          ],
        },
        {
          id: 'p2', slug: 'aup', title: 'AUP', description: null, display_order: 20,
          active: true, organization_id: ORG,
          policy_versions: [
            { id: 'v3', version_number: 1, body_markdown: 'aup', change_summary: null,
              effective_date: '2026-05-01', published_at: '2026-05-01T00:00:00Z', is_current: true },
          ],
        },
      ],
      views: [
        // Only v3 has a completed view for this user.
        { policy_version_id: 'v3', ended_at: '2026-05-10T12:00:00Z' },
        { policy_version_id: 'v3', ended_at: '2026-05-12T09:30:00Z' },
      ],
    }))

    const result = await listPoliciesWithStatus(user)
    expect(result).toHaveLength(2)
    // Handbook: current v2, NOT viewed.
    expect(result[0].current_version.id).toBe('v2')
    expect(result[0].viewed_at).toBeNull()
    expect(result[0].view_count).toBe(0)
    // AUP: current v3, viewed twice. latest is the more-recent ended_at.
    expect(result[1].current_version.id).toBe('v3')
    expect(result[1].viewed_at).toBe('2026-05-12T09:30:00Z')
    expect(result[1].view_count).toBe(2)
  })

  it('returns current_version: null + view_count: 0 when no current version', async () => {
    createServerClient.mockReturnValue(buildDb({
      policies: [{
        id: 'p1', slug: 'x', title: 'X', description: null, display_order: 10,
        active: true, organization_id: ORG,
        policy_versions: [],
      }],
    }))
    const result = await listPoliciesWithStatus(user)
    expect(result[0].current_version).toBeNull()
    expect(result[0].viewed_at).toBeNull()
    expect(result[0].view_count).toBe(0)
  })
})

describe('getPolicyBySlug (W0.5)', () => {
  const rows = [
    { id: 'p1', slug: 'employee-handbook', title: 'Handbook', description: null,
      active: true, organization_id: ORG, policy_versions: [] },
    { id: 'p2', slug: 'employee-handbook', title: 'Other tenant handbook', description: null,
      active: true, organization_id: FOREIGN, policy_versions: [] },
  ]

  it('resolves the slug inside the caller\'s organisation only', async () => {
    const fake = buildDb({ policies: rows })
    createServerClient.mockReturnValue(fake)
    const policy = await getPolicyBySlug('employee-handbook', user)
    expect(policy?.id).toBe('p1')
    expect(fake.from.mock.results[0].value.eq).toHaveBeenCalledWith('organization_id', ORG)
    // The same slug for the OTHER tenant.
    const foreign = await getPolicyBySlug('employee-handbook', { id: 'u2', activeOrganization: { id: FOREIGN } })
    expect(foreign?.id).toBe('p2')
  })

  it('returns null without querying when the user has no organisation', async () => {
    createServerClient.mockReturnValue(buildDb({ policies: rows }))
    expect(await getPolicyBySlug('employee-handbook', { id: 'u1' })).toBeNull()
    expect(createServerClient).not.toHaveBeenCalled()
  })
})

describe('outstandingPolicyCount', () => {
  it('counts policies whose current version the user has NOT viewed', async () => {
    createServerClient.mockReturnValue(buildDb({
      policies: [
        { id: 'a', slug: 'a', title: 'A', display_order: 10, active: true, organization_id: ORG,
          policy_versions: [{ id: 'va', version_number: 1, is_current: true,
            body_markdown: 'x', change_summary: null, effective_date: '2026-05-01',
            published_at: '2026-05-01T00:00:00Z' }] },
        { id: 'b', slug: 'b', title: 'B', display_order: 20, active: true, organization_id: ORG,
          policy_versions: [{ id: 'vb', version_number: 1, is_current: true,
            body_markdown: 'x', change_summary: null, effective_date: '2026-05-01',
            published_at: '2026-05-01T00:00:00Z' }] },
        { id: 'c', slug: 'c', title: 'C', display_order: 30, active: true, organization_id: ORG,
          policy_versions: [{ id: 'vc', version_number: 1, is_current: true,
            body_markdown: 'x', change_summary: null, effective_date: '2026-05-01',
            published_at: '2026-05-01T00:00:00Z' }] },
        // No-current-version policy doesn't count.
        { id: 'd', slug: 'd', title: 'D', display_order: 40, active: true, organization_id: ORG,
          policy_versions: [] },
      ],
      views: [
        { policy_version_id: 'va', ended_at: '2026-05-10T00:00:00Z' },
      ],
    }))
    const count = await outstandingPolicyCount(user)
    // a viewed; b, c outstanding; d has no current version. Expected 2.
    expect(count).toBe(2)
  })

  it('returns 0 when user is missing', async () => {
    expect(await outstandingPolicyCount(null)).toBe(0)
  })
})

describe('detectSectionHeadings', () => {
  it('finds ALL-CAPS heading lines followed by a blank line', () => {
    const body = `EMPLOYEE HANDBOOK

Some intro text here that runs on for a bit and shouldn't be flagged.

PURPOSE AND STATUS

Body of section.

ANOTHER SECTION HEADING

More body.`
    const headings = detectSectionHeadings(body)
    expect(headings).toEqual([
      'EMPLOYEE HANDBOOK',
      'PURPOSE AND STATUS',
      'ANOTHER SECTION HEADING',
    ])
  })

  it('finds numbered headings like "1. PURPOSE AND SCOPE"', () => {
    const body = `1. PURPOSE AND SCOPE

1.1 This Acceptable Use Policy sets out...

2. CORE PRINCIPLES

You will:`
    const headings = detectSectionHeadings(body)
    expect(headings).toContain('1. PURPOSE AND SCOPE')
    expect(headings).toContain('2. CORE PRINCIPLES')
  })

  it('does not flag in-line ALL-CAPS phrases inside paragraphs', () => {
    // The line is followed by content (not a blank), so it's not
    // a heading.
    const body = `Some intro
NEXT LINE IS NOT A HEADING because it has content right after.
more content here.

ACTUAL HEADING

Body.`
    const headings = detectSectionHeadings(body)
    expect(headings).toEqual(['ACTUAL HEADING'])
  })

  it('returns [] for empty input', () => {
    expect(detectSectionHeadings('')).toEqual([])
    expect(detectSectionHeadings(null)).toEqual([])
    expect(detectSectionHeadings(undefined)).toEqual([])
  })

  it('rejects ALL-CAPS lines shorter than 5 non-whitespace chars', () => {
    const body = `Heading 1
ABC

body

THIS HEADING

body`
    const headings = detectSectionHeadings(body)
    expect(headings).not.toContain('ABC')
    expect(headings).toContain('THIS HEADING')
  })
})
