import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./usage.js', () => ({
  recordUsage: vi.fn(async () => {}),
}))

import { anthropicMessages, ANTHROPIC_API_URL } from './anthropic.js'
import { recordUsage } from './usage.js'

const OK_BODY = {
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
}

function okResponse(body = OK_BODY) {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('anthropicMessages', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    recordUsage.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs the body to the Messages API with the standard headers', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await anthropicMessages(
      { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [] },
      { apiKey: 'sk-test', locationId: 'loc-1', source: 'test' }
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(ANTHROPIC_API_URL)
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('sk-test')
    expect(init.headers['anthropic-version']).toBe('2023-06-01')
    expect(JSON.parse(init.body).model).toBe('claude-sonnet-4-6')
  })

  it('returns { res, data } and records usage on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))

    const { res, data } = await anthropicMessages(
      { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [] },
      { apiKey: 'k', locationId: 'loc-1', organizationId: 'org-1', source: 'mia_auto_reply' }
    )

    expect(res.ok).toBe(true)
    expect(data.stop_reason).toBe('end_turn')
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0][0]).toMatchObject({
      locationId: 'loc-1',
      organizationId: 'org-1',
      source: 'mia_auto_reply',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
  })

  it('returns data:null on a non-OK response and does not record usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('overloaded', { status: 529 }))
    )

    const { res, data } = await anthropicMessages(
      { model: 'm', max_tokens: 1, messages: [] },
      { apiKey: 'k', source: 'test' }
    )

    expect(res.ok).toBe(false)
    expect(res.status).toBe(529)
    // The caller can still read the error body — the wrapper must not consume it.
    expect(await res.text()).toBe('overloaded')
    expect(data).toBeNull()
    expect(recordUsage).not.toHaveBeenCalled()
  })

  it('returns data:null when the OK body is not JSON (caller decides what that means)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })))
    const { res, data } = await anthropicMessages(
      { model: 'm', max_tokens: 1, messages: [] },
      { apiKey: 'k', source: 'test' }
    )
    expect(res.ok).toBe(true)
    expect(data).toBeNull()
    expect(recordUsage).not.toHaveBeenCalled()
  })

  it('propagates network errors unchanged (callers own their try/catch semantics)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    await expect(
      anthropicMessages({ model: 'm', max_tokens: 1, messages: [] }, { apiKey: 'k', source: 'test' })
    ).rejects.toThrow('fetch failed')
  })

  it('passes an AbortSignal through to fetch', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await anthropicMessages(
      { model: 'm', max_tokens: 1, messages: [] },
      { apiKey: 'k', source: 'test', signal: controller.signal }
    )
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })

  // MIA-REVIEW.2 — the usage write used to be fire-and-forget, which Vercel
  // gives no guarantee of completing once the response resolves. The caps and
  // wallet gates read usage_events, so a dropped write under-meters invisibly.
  it('awaits the usage write before returning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    let landed = false
    recordUsage.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 5))
      landed = true
    })

    await anthropicMessages({ model: 'm', max_tokens: 1, messages: [] }, { apiKey: 'k', source: 'test' })

    expect(landed).toBe(true)
  })

  it('a recordUsage failure never breaks the reply path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    recordUsage.mockImplementationOnce(async () => {
      throw new Error('db down')
    })
    const { data } = await anthropicMessages(
      { model: 'm', max_tokens: 1, messages: [] },
      { apiKey: 'k', source: 'test' }
    )
    expect(data.stop_reason).toBe('end_turn')
  })
})
