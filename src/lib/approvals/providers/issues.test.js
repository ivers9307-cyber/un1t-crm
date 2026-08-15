// HOME.3 — unified with countInboxIssues (open + in_progress; see
// src/lib/issues.js — the same query the retired /api/issues/count
// sidebar-badge route used to run). The provider used to count 'open'
// only on the theory that a claimed issue is "decided, just pending
// actioning" (APPROVALS-STUDIO.2) — but that made the approvals tab and
// the sidebar issues badge disagree about the same population, which is
// exactly the kind of drift the home queue exists to remove. Unified on
// open+in_progress so a number an operator sees in one surface means the
// same thing in the other.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../registry', () => ({
  canApproveAtActiveLocation: vi.fn(() => true),
  viewerActiveLocationId: vi.fn(() => 'loc1'),
}))

import { issuesProvider } from './issues'

function dbCapturingStatuses(rows = []) {
  const captured = { statuses: null }
  const b = {
    select: () => b,
    eq: () => b,
    in: (_col, statuses) => { captured.statuses = statuses; return b },
    order: () => b,
    limit: async () => ({ data: rows, error: null }),
  }
  return { db: { from: () => b }, captured }
}

describe('issuesProvider', () => {
  it("queries status 'open' AND 'in_progress' — unified with countInboxIssues", async () => {
    const { db, captured } = dbCapturingStatuses([])
    await issuesProvider.fetchPending(db, { id: 'u1' })
    expect(captured.statuses).toEqual(['open', 'in_progress'])
  })
})
