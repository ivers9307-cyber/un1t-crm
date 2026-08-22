// MIA-HYGIENE.2 — completes EFFORT.1. The inbound reply path has set
// output_config.effort since #590, but the two PROACTIVE compose paths
// (followups nudges, approval suggestions) sent no output_config at all, so
// they ran at the Messages API default — `high`, the priciest and slowest
// setting — to write a 300-token nudge. These are short, scoped, latency-
// tolerant generations: `low` is the right floor.
//
// Neither compose path had ANY test coverage before this file; the request
// body was never asserted, which is how the omission survived #590.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const anthropicMessages = vi.fn()
vi.mock('@/lib/anthropic', () => ({ anthropicMessages }))

const { composeAgentText: composeFollowupText } = await import('./followups')
const { composeAgentText: composeSuggestionText } = await import('./approval-suggest')

const LOCATION = { id: 'loc-1', name: 'Stillorgan' }
const SETTINGS = { agent_name: 'Mia' }

function okReply(text = 'Hey, still keen on that class?') {
  return { res: { ok: true }, data: { content: [{ type: 'text', text }] } }
}

function bodyOfLastCall() {
  return anthropicMessages.mock.calls.at(-1)[0]
}

describe('proactive compose paths send an explicit effort', () => {
  beforeEach(() => {
    anthropicMessages.mockReset()
    anthropicMessages.mockResolvedValue(okReply())
    process.env.ANTHROPIC_API_KEY = 'test-key'
  })
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY
  })

  it('followup nudges request effort low', async () => {
    const out = await composeFollowupText({
      location: LOCATION,
      settings: SETTINGS,
      historyRows: [],
      instruction: 'Nudge them about the class they asked about.',
      companyName: 'UN1T',
      knowledge: [],
    })
    expect(out.text).toBeTruthy()
    expect(bodyOfLastCall().output_config).toEqual({ effort: 'low' })
  })

  it('approval suggestions request effort low', async () => {
    const out = await composeSuggestionText(
      LOCATION,
      SETTINGS,
      [],
      'Suggest a short follow-up after the booking was approved.',
      'UN1T',
      undefined,
    )
    expect(out.text).toBeTruthy()
    expect(bodyOfLastCall().output_config).toEqual({ effort: 'low' })
  })

  // MIA-SONNET5 — the cap moved 300 → 600 on both paths: Sonnet 5's tokenizer
  // adds ~31% and adaptive thinking shares the same ceiling, and a truncated
  // nudge would go out as a real customer message.
  it('keeps a shared token cap and the shared model on both paths', async () => {
    await composeFollowupText({
      location: LOCATION, settings: SETTINGS, historyRows: [],
      instruction: 'x', companyName: 'UN1T', knowledge: [],
    })
    const followupBody = bodyOfLastCall()
    await composeSuggestionText(LOCATION, SETTINGS, [], 'x', 'UN1T', undefined)
    const suggestionBody = bodyOfLastCall()

    expect(followupBody.max_tokens).toBe(600)
    expect(suggestionBody.max_tokens).toBe(600)
    expect(suggestionBody.model).toBe(followupBody.model)
    // Both proactive paths think adaptively, like the reply path.
    expect(followupBody.thinking).toEqual({ type: 'adaptive' })
    expect(suggestionBody.thinking).toEqual({ type: 'adaptive' })
  })
})
