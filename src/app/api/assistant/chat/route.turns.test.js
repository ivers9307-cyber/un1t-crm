// STAFFASSISTPREFILL.1 (C108) — the staff assistant takes its message list
// from the client. Current Claude models refuse a request whose last message
// is an assistant turn ("does not support assistant message prefill", HTTP
// 400), and every request must open on a user turn. These tests read the
// request body actually sent to the Messages API, on both the buffered and
// the streaming path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('@/lib/usage', () => ({ recordUsage: vi.fn(async () => {}) }))
vi.mock('@/lib/anthropic', () => ({
  anthropicMessages: vi.fn(async () => ({
    res: { ok: true },
    data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
  })),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { anthropicMessages } from '@/lib/anthropic'

const USER = {
  id: 'u1', full_name: 'Test Manager', role: 'manager', permissions: {},
  activeLocation: { id: 'loc1', name: 'Studio' },
}

const post = (body) => POST(new Request('http://localhost/api/assistant/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))

const sentMessages = () => anthropicMessages.mock.calls[0][0].messages

function expectValidTurns(messages) {
  expect(messages.length).toBeGreaterThan(0)
  expect(messages[0].role).toBe('user')
  expect(messages[messages.length - 1].role).toBe('user')
  for (let i = 1; i < messages.length; i++) expect(messages[i].role).not.toBe(messages[i - 1].role)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  getCurrentUser.mockResolvedValue(USER)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('POST /api/assistant/chat — the turns sent to the API (STAFFASSISTPREFILL.1)', () => {
  it('a well-formed list goes through unchanged', async () => {
    const messages = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello, how can I help?' },
      { role: 'user', content: 'Who is on tomorrow?' },
    ]
    const res = await post({ messages })
    expect(res.status).toBe(200)
    expect(sentMessages()).toEqual(messages)
  })

  it('a list that opens on an assistant turn is sent opening on the user turn', async () => {
    await post({ messages: [
      { role: 'assistant', content: 'Hi, I am your assistant.' },
      { role: 'user', content: 'Who is on tomorrow?' },
    ] })
    expectValidTurns(sentMessages())
    expect(sentMessages()).toEqual([{ role: 'user', content: 'Who is on tomorrow?' }])
  })

  it('consecutive user turns are merged, so the roles alternate', async () => {
    await post({ messages: [
      { role: 'user', content: 'Hi' },
      { role: 'user', content: 'Who is on tomorrow?' },
    ] })
    expectValidTurns(sentMessages())
    expect(sentMessages()).toEqual([{ role: 'user', content: 'Hi\n\nWho is on tomorrow?' }])
  })

  it('empty turns (a streaming placeholder) are dropped before they break the alternation', async () => {
    await post({ messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Anyone there?' },
    ] })
    expectValidTurns(sentMessages())
    expect(sentMessages()).toEqual([{ role: 'user', content: 'Hi\n\nAnyone there?' }])
  })

  it('a list that ENDS on an assistant turn never reaches the API as a prefill', async () => {
    const res = await post({ messages: [
      { role: 'user', content: 'Who is on tomorrow?' },
      { role: 'assistant', content: 'Sam and Alex.' },
    ] })
    // Nothing new to answer: no API call (a re-answer could re-run a write tool).
    expect(anthropicMessages).not.toHaveBeenCalled()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, code: 'nothing_to_answer' })
  })

  it('the streaming path sends the normalised list too', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, body: null, text: async () => 'stop here' }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await post({ stream: true, messages: [
      { role: 'assistant', content: 'Hi, I am your assistant.' },
      { role: 'user', content: 'Hi' },
      { role: 'user', content: 'Who is on tomorrow?' },
    ] })
    await res.text() // drain the SSE stream so the fetch has run
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).messages
    expectValidTurns(sent)
    expect(sent).toEqual([{ role: 'user', content: 'Hi\n\nWho is on tomorrow?' }])
  })

  it('the streaming path refuses a trailing assistant turn before any fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await post({ stream: true, messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello.' },
    ] })
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
