// ASSISTCAP.1 — the staff assistant's own spend cap, enforced at the route.
//
// The point of the cap is that a capped org spends NOTHING MORE, so the
// assertion that matters is not the status code: it is that anthropicMessages
// was never called. A 402 that still burned a turn would be the cap failing
// while looking like it worked.
//
// Checked on BOTH answer paths (buffered and stream: true), because the gate
// sits upstream of the branch and a future refactor that moves it inside one
// branch should fail here.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('@/lib/usage', () => ({ recordUsage: vi.fn(async () => {}) }))
vi.mock('@/lib/usage-caps', () => ({ getAssistantCapStatus: vi.fn() }))
vi.mock('@/lib/anthropic', () => ({
  anthropicMessages: vi.fn(async () => ({
    res: { ok: true },
    data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
  })),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { getAssistantCapStatus } from '@/lib/usage-caps'
import { anthropicMessages } from '@/lib/anthropic'

const USER = {
  id: 'u1',
  full_name: 'Test Manager',
  role: 'manager',
  permissions: {},
  activeLocation: { id: 'loc1', name: 'Studio' },
}

const post = (body) => POST(new Request('http://localhost/api/assistant/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))

const MESSAGES = [{ role: 'user', content: 'How many shifts this week?' }]

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  getCurrentUser.mockResolvedValue(USER)
  global.fetch = vi.fn(async () => { throw new Error('no network expected') })
})

describe('at the assistant spend cap', () => {
  beforeEach(() => {
    getAssistantCapStatus.mockResolvedValue({
      capped: true, capCents: 2000, spendCents: 2500, organizationId: 'org-1',
    })
  })

  it('refuses with 402 and code assistant_spend_cap, and calls Anthropic ZERO times', async () => {
    const res = await post({ messages: MESSAGES })
    expect(res.status).toBe(402)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.code).toBe('assistant_spend_cap')
    // The whole point: no spend.
    expect(anthropicMessages).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('refuses the STREAMING path too, with no Anthropic call', async () => {
    const res = await post({ messages: MESSAGES, stream: true })
    expect(res.status).toBe(402)
    expect(anthropicMessages).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('tells the operator who can raise it and where, and reports the numbers', async () => {
    const json = await (await post({ messages: MESSAGES })).json()
    // The person who hits this usually cannot fix it themselves.
    expect(json.error).toMatch(/owner or master/i)
    expect(json.error).toMatch(/Usage/)
    expect(json.data).toEqual({ capCents: 2000, spendCents: 2500 })
  })

  it('is judged at the org of the session’s ACTIVE location, never a client-supplied one', async () => {
    await post({ messages: MESSAGES, userContext: { locationId: 'loc-SOMEONE-ELSE' } })
    expect(getAssistantCapStatus).toHaveBeenCalledWith({ locationId: 'loc1' })
  })
})

describe('under the cap, or with no cap', () => {
  it('answers normally when not capped', async () => {
    getAssistantCapStatus.mockResolvedValue({ capped: false, organizationId: 'org-1' })
    const res = await post({ messages: MESSAGES })
    expect(res.status).toBe(200)
    expect(anthropicMessages).toHaveBeenCalled()
  })

  it('answers normally when the cap check fails open', async () => {
    // getAssistantCapStatus swallows its own errors and returns capped:false;
    // the route must treat that as permission to proceed, not as a refusal.
    getAssistantCapStatus.mockResolvedValue({ capped: false })
    const res = await post({ messages: MESSAGES })
    expect(res.status).toBe(200)
    expect(anthropicMessages).toHaveBeenCalled()
  })
})

// The operator-facing half: the bubble must special-case the SAME code the
// route sends, or the cap message arrives wrapped in "Sorry, something went
// wrong" and reads as a bug to report rather than a budget to raise. A
// source-level pin rather than a render: the realistic drift is a rename, and
// this catches it in both files at once.
describe('the cap code is shared by the route and the chat bubble', () => {
  const read = (p) => readFileSync(join(process.cwd(), p), 'utf8')

  it('both name assistant_spend_cap, and the bubble shows it unwrapped', () => {
    const route = read('src/app/api/assistant/chat/route.js')
    const bubble = read('src/components/AssistantBubble.jsx')
    expect(route).toMatch(/code: 'assistant_spend_cap'/)
    expect(bubble).toMatch(/data\?\.code === 'assistant_spend_cap'/)
    // Shown as written, not prefixed.
    expect(bubble).toMatch(/content: data\.error/)
  })
})
