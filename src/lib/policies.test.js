// POLICIES.1 — unit tests for the policies lib.
// Mocks createServerClient with a minimal fake supabase that returns
// configurable data per (table, op) pair.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { listPoliciesWithStatus, outstandingPolicyCount } = await import('./policies.js')

function buildDb({ policies = [], acks = [] }) {
  return {
    from: vi.fn((table) => {
      if (table === 'policies') {
        return {
          select: vi.fn().mockReturnThis(),
          eq:     vi.fn().mockReturnThis(),
          order:  vi.fn().mockImplementation(function order() {
            // Two .order() calls in the production code (display_order, title).
            // Both no-op, terminal resolve happens via the awaited promise.
            return Object.assign(this, {
              then: (resolve) => resolve({ data: policies, error: null }),
            })
          }),
        }
      }
      if (table === 'policy_acknowledgements') {
        return {
          select: vi.fn().mockReturnThis(),
          eq:     vi.fn().mockReturnThis(),
          in:     vi.fn().mockResolvedValue({ data: acks, error: null }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

beforeEach(() => {
  createServerClient.mockReset()
})

describe('listPoliciesWithStatus', () => {
  it('returns [] when user is missing', async () => {
    const result = await listPoliciesWithStatus(null)
    expect(result).toEqual([])
  })

  it('attaches current_version and acknowledged_at per policy', async () => {
    createServerClient.mockReturnValue(buildDb({
      policies: [
        {
          id: 'p1', slug: 'handbook', title: 'Handbook', description: 'd', display_order: 10,
          policy_versions: [
            { id: 'v1', version_number: 1, body_markdown: 'old',  change_summary: null,
              effective_date: '2026-01-01', published_at: '2026-01-01T00:00:00Z', is_current: false },
            { id: 'v2', version_number: 2, body_markdown: 'new',  change_summary: 'Updated',
              effective_date: '2026-05-01', published_at: '2026-05-01T00:00:00Z', is_current: true },
          ],
        },
        {
          id: 'p2', slug: 'aup', title: 'AUP', description: null, display_order: 20,
          policy_versions: [
            { id: 'v3', version_number: 1, body_markdown: 'aup', change_summary: null,
              effective_date: '2026-05-01', published_at: '2026-05-01T00:00:00Z', is_current: true },
          ],
        },
      ],
      acks: [
        { policy_version_id: 'v3', acknowledged_at: '2026-05-10T12:00:00Z' },
      ],
    }))

    const result = await listPoliciesWithStatus({ id: 'u1' })
    expect(result).toHaveLength(2)
    // Handbook: current_version is v2, not acknowledged.
    expect(result[0].current_version.id).toBe('v2')
    expect(result[0].acknowledged_at).toBeNull()
    // AUP: current_version is v3, acknowledged.
    expect(result[1].current_version.id).toBe('v3')
    expect(result[1].acknowledged_at).toBe('2026-05-10T12:00:00Z')
  })

  it('returns current_version: null when a policy has no current version', async () => {
    createServerClient.mockReturnValue(buildDb({
      policies: [{
        id: 'p1', slug: 'x', title: 'X', description: null, display_order: 10,
        policy_versions: [], // none current
      }],
    }))
    const result = await listPoliciesWithStatus({ id: 'u1' })
    expect(result[0].current_version).toBeNull()
    expect(result[0].acknowledged_at).toBeNull()
  })
})

describe('outstandingPolicyCount', () => {
  it('counts only policies with a current version that the user has NOT acknowledged', async () => {
    createServerClient.mockReturnValue(buildDb({
      policies: [
        { id: 'a', slug: 'a', title: 'A', display_order: 10,
          policy_versions: [{ id: 'va', version_number: 1, is_current: true,
            body_markdown: 'x', change_summary: null, effective_date: '2026-05-01',
            published_at: '2026-05-01T00:00:00Z' }] },
        { id: 'b', slug: 'b', title: 'B', display_order: 20,
          policy_versions: [{ id: 'vb', version_number: 1, is_current: true,
            body_markdown: 'x', change_summary: null, effective_date: '2026-05-01',
            published_at: '2026-05-01T00:00:00Z' }] },
        { id: 'c', slug: 'c', title: 'C', display_order: 30,
          policy_versions: [{ id: 'vc', version_number: 1, is_current: true,
            body_markdown: 'x', change_summary: null, effective_date: '2026-05-01',
            published_at: '2026-05-01T00:00:00Z' }] },
        // No-current-version policy doesn't count as outstanding.
        { id: 'd', slug: 'd', title: 'D', display_order: 40,
          policy_versions: [] },
      ],
      acks: [
        { policy_version_id: 'va', acknowledged_at: '2026-05-10T00:00:00Z' },
      ],
    }))
    const count = await outstandingPolicyCount({ id: 'u1' })
    // a acked; b, c outstanding; d has no current version. Expected 2.
    expect(count).toBe(2)
  })

  it('returns 0 when user is missing', async () => {
    const count = await outstandingPolicyCount(null)
    expect(count).toBe(0)
  })
})
