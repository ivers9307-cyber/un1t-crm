// APPROVALS-STUDIO.2 — only UNCLAIMED issues count as approvals. A claimed
// (in_progress) issue is decided and just pending actioning; counting it
// left the approvals badge stuck while work was underway.
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
  it("queries status 'open' only — in_progress is decided, not pending approval", async () => {
    const { db, captured } = dbCapturingStatuses([])
    await issuesProvider.fetchPending(db, { id: 'u1' })
    expect(captured.statuses).toEqual(['open'])
  })
})
