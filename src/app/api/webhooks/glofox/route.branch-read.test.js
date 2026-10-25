// REGISTRYREAD.1a — a branch lookup that FAILED is not "unknown branch".
// It used to answer 401 and drop the delivery; now 503 (a sender that retries
// 5xx can redeliver; event_id UNIQUE dedupes) and a structured logError.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  readGlofoxCredentialsByBranchId: vi.fn(),
}))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/sequences/triggers', () => ({
  triggerSequencesForTagsAdded: vi.fn(),
  triggerSequencesForContactCreated: vi.fn(),
  triggerSequencesForMembershipStateChange: vi.fn(),
}))
vi.mock('@/lib/glofox-invoices', () => ({ applyInvoiceWebhook: vi.fn() }))
vi.mock('@/lib/glofox-services', () => ({ applyServiceWebhook: vi.fn() }))
vi.mock('@/lib/glofox-membership', () => ({ applyMembershipPauseWindow: vi.fn() }))
vi.mock('@/lib/dunning', () => ({ maybeEnrolDunning: vi.fn(), exitDunningForContact: vi.fn(), dunningActionFor: vi.fn() }))
vi.mock('@/lib/glofox-sync', () => ({ applyMemberSync: vi.fn() }))
vi.mock('@/lib/webhook-dead-letter', () => ({ deadLetterWebhook: vi.fn() }))

import { POST } from './route.js'
import { readGlofoxCredentialsByBranchId } from '@/lib/glofox'
import { logError } from '@/lib/log'

const deliver = () => POST(new Request('http://localhost/api/webhooks/glofox', {
  method: 'POST',
  headers: { 'content-type': 'application/json', signature: 'deadbeef' },
  body: JSON.stringify({ branch_id: 'b123', type: 'MEMBER_UPDATED' }),
}))

beforeEach(() => vi.clearAllMocks())

describe('POST /api/webhooks/glofox — branch lookup', () => {
  it('a failed lookup answers 503 and logs it (it used to 401 as "unknown branch")', async () => {
    readGlofoxCredentialsByBranchId.mockResolvedValueOnce({ creds: null, error: { message: 'boom' } })
    const res = await deliver()
    expect(res.status).toBe(503)
    expect(logError).toHaveBeenCalledWith('glofox-webhook', expect.any(String), expect.objectContaining({ branch_id: 'b123' }))
  })

  it('a branch nobody has is still 401 (unchanged)', async () => {
    readGlofoxCredentialsByBranchId.mockResolvedValueOnce({ creds: null, error: null })
    const res = await deliver()
    expect(res.status).toBe(401)
    expect(logError).not.toHaveBeenCalled()
  })
})
