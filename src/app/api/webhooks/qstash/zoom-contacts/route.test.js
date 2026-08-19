import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/qstash', () => ({
  verifyQStashSignature: vi.fn(() => ({ ok: true, matched: 'current' })),
  ZOOM_CONTACTS_WORKER_PATH: '/api/webhooks/qstash/zoom-contacts',
}))
vi.mock('@/lib/app-url', () => ({ getAppUrl: vi.fn(() => 'https://x.test') }))
vi.mock('@/lib/zoom/external-contacts', () => ({
  createContact: vi.fn(async () => ({ ok: true })),
  updateContact: vi.fn(async () => ({ ok: true })),
  deleteContact: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ db: true })) }))
vi.mock('@/lib/webhook-dead-letter', () => ({ deadLetterWebhook: vi.fn(async () => {}) }))
// Only the budget probe is stubbed — isPermanentZoomFailure stays REAL, since
// the status classification is the thing most of this file is asserting.
vi.mock('@/lib/zoom/failures', async (importOriginal) => ({
  ...(await importOriginal()),
  parkingBudgetExhausted: vi.fn(async () => false),
}))

import { verifyQStashSignature } from '@/lib/qstash'
import { createContact, updateContact, deleteContact } from '@/lib/zoom/external-contacts'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { ZOOM_SYNC_PROVIDER, parkingBudgetExhausted } from '@/lib/zoom/failures'
import { POST } from './route'

const post = (body) => new Request('https://x.test/api/webhooks/qstash/zoom-contacts', {
  method: 'POST',
  headers: { 'upstash-signature': 'sig' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  vi.mocked(verifyQStashSignature).mockReturnValue({ ok: true, matched: 'current' })
  vi.mocked(createContact).mockResolvedValue({ ok: true })
  vi.mocked(updateContact).mockResolvedValue({ ok: true })
  vi.mocked(deleteContact).mockResolvedValue({ ok: true })
  vi.mocked(deadLetterWebhook).mockClear()
  vi.mocked(parkingBudgetExhausted).mockResolvedValue(false)
})

describe('POST /api/webhooks/qstash/zoom-contacts', () => {
  it('401s on a bad signature', async () => {
    vi.mocked(verifyQStashSignature).mockReturnValue({ ok: false, reason: 'malformed' })
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'A', contactId: 'u1' }))
    expect(res.status).toBe(401)
    expect(createContact).not.toHaveBeenCalled()
  })

  it('503s when our own signing keys are unset', async () => {
    vi.mocked(verifyQStashSignature).mockReturnValue({ ok: false, reason: 'missing_keys' })
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'A', contactId: 'u1' }))
    expect(res.status).toBe(503)
  })

  it('applies a create', async () => {
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'Aoife Ryan', contactId: 'u1' }))
    expect(res.status).toBe(200)
    expect(createContact).toHaveBeenCalledWith({ e164: '+353871111111', name: 'Aoife Ryan', contactId: 'u1' })
  })

  it('applies an update', async () => {
    const res = await POST(post({ op: 'update', e164: '+353871111111', name: 'New', contactId: 'u2', zoomId: 'z1' }))
    expect(res.status).toBe(200)
    expect(updateContact).toHaveBeenCalledWith({ zoomId: 'z1', name: 'New', contactId: 'u2' })
  })

  it('applies a delete', async () => {
    const res = await POST(post({ op: 'delete', e164: '+353871111111', zoomId: 'z1' }))
    expect(res.status).toBe(200)
    expect(deleteContact).toHaveBeenCalledWith({ zoomId: 'z1' })
  })

  it('400s on an unknown op without retrying forever', async () => {
    const res = await POST(post({ op: 'explode', e164: '+353871111111' }))
    expect(res.status).toBe(400)
  })

  it('400s on malformed JSON', async () => {
    const req = new Request('https://x.test/api/webhooks/qstash/zoom-contacts', {
      method: 'POST', headers: { 'upstash-signature': 'sig' }, body: 'not json',
    })
    expect((await POST(req)).status).toBe(400)
  })

  it('500s on a Zoom failure so QStash retries', async () => {
    vi.mocked(createContact).mockResolvedValue({ ok: false, status: 500, error: 'zoom 500' })
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'A', contactId: 'u1' }))
    expect(res.status).toBe(500)
  })
})

/**
 * ZOOMSYNC.4 — a 400 from Zoom is a verdict on the payload, and retrying it is
 * what produced 280 identical runtime errors in 7 days. The worker's job is to
 * tell that apart from Zoom having a bad minute.
 */
describe('POST /api/webhooks/qstash/zoom-contacts — permanent failures', () => {
  const badNumberJob = { op: 'create', e164: '+87654567890', name: 'Aoife Ryan', contactId: 'u1' }

  it('parks a 400 and answers 200 so QStash stops retrying', async () => {
    vi.mocked(createContact).mockResolvedValue({
      ok: false, status: 400,
      error: 'create +87654567890: {"code":400,"message":"Phone number (+87654567890) must be E.164 format."}',
    })

    const res = await POST(post(badNumberJob))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, parked: true })
  })

  it('captures the whole job, so an operator can see which contact to fix', async () => {
    vi.mocked(createContact).mockResolvedValue({ ok: false, status: 400, error: 'must be E.164 format' })

    await POST(post(badNumberJob))

    expect(deadLetterWebhook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: ZOOM_SYNC_PROVIDER,
      eventType: 'create',
      payload: badNumberJob,
      error: 'must be E.164 format',
    }))
  })

  it.each([401, 408, 429, 500, 502, 503])('does NOT park a %d — that is transient, QStash must retry', async (status) => {
    vi.mocked(createContact).mockResolvedValue({ ok: false, status, error: 'later' })
    const res = await POST(post(badNumberJob))
    expect(res.status).toBe(500)
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })

  it('does not park a failure with no status — never park on a guess', async () => {
    vi.mocked(createContact).mockResolvedValue({ ok: false, error: 'network reset' })
    const res = await POST(post(badNumberJob))
    expect(res.status).toBe(500)
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })

  it('parks a permanently-refused update the same way', async () => {
    vi.mocked(updateContact).mockResolvedValue({ ok: false, status: 422, error: 'nope' })
    const res = await POST(post({ op: 'update', e164: '+353871111111', name: 'New', contactId: 'u2', zoomId: 'z1' }))
    expect(res.status).toBe(200)
    expect(deadLetterWebhook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'update' }))
  })

  it('never parks a success — 409 duplicate and 404 already-gone are the desired end state', async () => {
    vi.mocked(createContact).mockResolvedValue({ ok: true, duplicate: true })
    vi.mocked(deleteContact).mockResolvedValue({ ok: true, alreadyGone: true })
    expect((await POST(post(badNumberJob))).status).toBe(200)
    expect((await POST(post({ op: 'delete', e164: '+353871111111', zoomId: 'z1' }))).status).toBe(200)
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })

  // The circuit breaker. A 4xx per number is triage; a 4xx on every number is
  // an account-level refusal (lost scope, lapsed plan, quota) wearing the same
  // status code. Parking those would convert one credential fault into
  // thousands of permanent per-number suppressions, so past the budget the
  // worker stops parking and hands it back as a loud transient instead.
  describe('parking budget', () => {
    it('stops parking and 500s once the budget is spent', async () => {
      vi.mocked(parkingBudgetExhausted).mockResolvedValue(true)
      vi.mocked(createContact).mockResolvedValue({ ok: false, status: 400, error: 'no scope' })
      const res = await POST(post(badNumberJob))
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ success: false, error: 'park_budget_exhausted' })
      // Nothing suppressed: no dead-letter row, so no number is withheld from
      // the next reconcile once the underlying cause is fixed.
      expect(deadLetterWebhook).not.toHaveBeenCalled()
    })

    it('still parks normally while the budget holds', async () => {
      vi.mocked(createContact).mockResolvedValue({ ok: false, status: 400, error: 'bad number' })
      const res = await POST(post(badNumberJob))
      expect(res.status).toBe(200)
      expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
    })

    // The budget only ever gates the PARK decision — a transient failure was
    // never going to be parked, and must keep its retryable 500 either way.
    it('does not consult the budget for a transient failure', async () => {
      vi.mocked(parkingBudgetExhausted).mockResolvedValue(true)
      vi.mocked(createContact).mockResolvedValue({ ok: false, status: 503, error: 'zoom down' })
      const res = await POST(post(badNumberJob))
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ error: 'zoom down' })
      expect(deadLetterWebhook).not.toHaveBeenCalled()
    })
  })
})
