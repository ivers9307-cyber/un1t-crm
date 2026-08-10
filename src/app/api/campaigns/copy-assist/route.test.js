// GAPS-P8 — POST /api/campaigns/copy-assist.
//
// Three things this route must never do, all asserted below:
//   1. spend money for an unauthenticated or unbounded caller,
//   2. break the composer when Anthropic is unset or down,
//   3. hand the operator whatever the model happened to say.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const OTHER_LOC = 'b0000000-0000-0000-0000-000000000002'

let currentUser
let permission
let anthropicImpl
let rateLimitImpl

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn(async () => currentUser) }
})
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual('@/lib/permissions')
  return { ...actual, hasPermissionForLocation: vi.fn((...args) => permission(...args)) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ rpc: async () => ({ data: 1, error: null }) }) }))
vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual('@/lib/rate-limit')
  return { ...actual, checkRateLimit: vi.fn((...args) => rateLimitImpl(...args)) }
})
vi.mock('@/lib/anthropic', () => ({ anthropicMessages: vi.fn((...args) => anthropicImpl(...args)) }))

import { anthropicMessages } from '@/lib/anthropic'
import { checkRateLimit } from '@/lib/rate-limit'
import { POST } from './route.js'

const post = (body) =>
  new Request('http://localhost/api/campaigns/copy-assist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const modelReply = (text) => ({
  res: { ok: true, status: 200 },
  data: { content: [{ type: 'text', text }] },
})

const validBody = {
  location_id: LOC,
  kind: 'subject',
  brief: 'Membership is open again at UN1T Stillorgan this weekend.',
  subject: 'Weekend offer',
}

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
  currentUser = { id: 'user-1', role: 'manager', locations: [{ id: LOC, role: 'manager' }] }
  permission = () => true
  rateLimitImpl = async () => ({ allowed: true, remaining: 9, resetAt: new Date(Date.now() + 60_000), retryAfterSec: 60 })
  anthropicImpl = async () => modelReply('["Membership is open again", "Back at UN1T this weekend"]')
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('guards', () => {
  it('401s an unauthenticated caller and never calls the model', async () => {
    currentUser = null
    const res = await POST(post(validBody))
    expect(res.status).toBe(401)
    expect(anthropicMessages).not.toHaveBeenCalled()
  })

  it('400s an invalid body', async () => {
    const res = await POST(post({ location_id: LOC, kind: 'haiku' }))
    expect(res.status).toBe(400)
    expect(anthropicMessages).not.toHaveBeenCalled()
  })

  it('400s when the operator supplied nothing to work from', async () => {
    const res = await POST(post({ location_id: LOC, kind: 'subject' }))
    expect(res.status).toBe(400)
    expect(anthropicMessages).not.toHaveBeenCalled()
  })

  it('403s a location the caller is not assigned to', async () => {
    const res = await POST(post({ ...validBody, location_id: OTHER_LOC }))
    expect(res.status).toBe(403)
    expect(anthropicMessages).not.toHaveBeenCalled()
  })

  it('403s a caller without email permission at that location', async () => {
    permission = () => false
    const res = await POST(post(validBody))
    expect(res.status).toBe(403)
    expect(anthropicMessages).not.toHaveBeenCalled()
  })

  it('checks permission at the TARGET location, not the active one', async () => {
    currentUser = { id: 'u', role: 'manager', locations: [{ id: LOC }, { id: OTHER_LOC }] }
    const seen = []
    permission = (_u, locId) => { seen.push(locId); return true }
    await POST(post({ ...validBody, location_id: OTHER_LOC }))
    expect(seen).toContain(OTHER_LOC)
  })
})

describe('rate limiting', () => {
  it('meters per user AND per location before spending anything', async () => {
    await POST(post(validBody))
    const keys = checkRateLimit.mock.calls.map((c) => c[1])
    expect(keys.some((k) => k.includes('user-1'))).toBe(true)
    expect(keys.some((k) => k.includes(LOC))).toBe(true)
  })

  it('429s and does not call the model when the caller is over the limit', async () => {
    rateLimitImpl = async () => ({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000), retryAfterSec: 60 })
    const res = await POST(post(validBody))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(anthropicMessages).not.toHaveBeenCalled()
  })

  it('rate-limits before the model call, not after', async () => {
    const order = []
    rateLimitImpl = async () => { order.push('limit'); return { allowed: true, remaining: 1, resetAt: new Date(), retryAfterSec: 1 } }
    anthropicImpl = async () => { order.push('model'); return modelReply('["ok"]') }
    await POST(post(validBody))
    expect(order[order.length - 1]).toBe('model')
  })
})

describe('failing soft', () => {
  it('returns 200 with available:false when ANTHROPIC_API_KEY is unset, and never calls out', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const res = await POST(post(validBody))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.available).toBe(false)
    expect(body.data.reason).toBe('not_configured')
    expect(body.data.suggestions).toEqual([])
    expect(anthropicMessages).not.toHaveBeenCalled()
  })

  it('returns 200 with available:false when Anthropic answers non-2xx', async () => {
    anthropicImpl = async () => ({ res: { ok: false, status: 529 }, data: null })
    const res = await POST(post(validBody))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.available).toBe(false)
    expect(body.data.suggestions).toEqual([])
  })

  it('returns 200 with available:false when the call throws', async () => {
    anthropicImpl = async () => { throw new Error('ECONNRESET') }
    const res = await POST(post(validBody))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.available).toBe(false)
  })

  it('returns 200 with an empty list when everything the model said was dropped', async () => {
    anthropicImpl = async () => modelReply('["Only 3 spots left", "Just €19 on Tuesday"]')
    const res = await POST(post(validBody))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.available).toBe(true)
    expect(body.data.suggestions).toEqual([])
    expect(body.data.dropped.length).toBe(2)
  })
})

describe('what reaches the operator', () => {
  it('scrubs em dashes, emoji and shouting out of the model reply', async () => {
    anthropicImpl = async () => modelReply(JSON.stringify([
      'MEMBERSHIP IS OPEN AGAIN — THIS WEEKEND 🔥',
      'Back at UN1T 💪 this weekend!!!',
    ]))
    const res = await POST(post(validBody))
    const body = await res.json()
    expect(body.data.suggestions).toEqual([
      'Membership is open again, this weekend',
      'Back at UN1T this weekend!',
    ])
  })

  it('marks the payload as machine-generated and unreviewed', async () => {
    const res = await POST(post(validBody))
    const body = await res.json()
    expect(body.data.generated_by).toBe('model')
    expect(body.data.reviewed).toBe(false)
  })

  it('sends an Anthropic model, and meters the call with a source and location', async () => {
    let seen
    anthropicImpl = async (payload, meta) => { seen = { payload, meta }; return modelReply('["ok"]') }
    await POST(post(validBody))
    expect(seen.payload.model).toMatch(/^claude-/)
    expect(seen.meta.source).toBe('campaign_copy_assist')
    expect(seen.meta.locationId).toBe(LOC)
  })

  it('puts ONLY the operator brief and draft in the prompt (no contact PII)', async () => {
    let seen
    anthropicImpl = async (payload) => { seen = payload; return modelReply('["ok"]') }
    await POST(post({ ...validBody, body: '<p>Hi <b>there</b>, membership is open again.</p>' }))
    const sent = JSON.stringify(seen.messages) + seen.system
    expect(sent).toContain('Membership is open again at UN1T Stillorgan this weekend.')
    expect(sent).toContain('Weekend offer')
    expect(sent).toContain('Hi there, membership is open again.')
    // nothing about the audience, the recipients, or who they are
    expect(sent).not.toMatch(/@|contact_id|audience|recipient/i)
  })

  it('flattens an HTML draft body before it reaches the model', async () => {
    let seen
    anthropicImpl = async (payload) => { seen = payload; return modelReply('["ok"]') }
    await POST(post({ ...validBody, kind: 'body', body: '<p>One</p><p>Two</p>' }))
    const sent = JSON.stringify(seen.messages)
    expect(sent).not.toMatch(/<p>/)
    expect(sent).toContain('One')
  })
})
