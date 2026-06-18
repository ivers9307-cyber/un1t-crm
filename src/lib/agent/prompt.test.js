// RADAR-AGENT.0 — unit tests for the customer-agent prompt builder.
import { describe, it, expect } from 'vitest'
import {
  buildKnowledgeBlock,
  buildCustomerSystemPrompt,
  buildCustomerSystemPromptParts,
  buildCachedSystem,
  HANDOFF_PREFIX,
  CUSTOMER_AGENT_BASE_PROMPT,
} from './prompt'

describe('buildKnowledgeBlock', () => {
  it('returns an explicit empty notice when there is no knowledge', () => {
    const out = buildKnowledgeBlock([])
    expect(out).toMatch(/No knowledge has been added/i)
  })
  it('drops disabled and empty entries', () => {
    const out = buildKnowledgeBlock([
      { category: 'sales', title: 'Price', content: '€89/mo', enabled: true },
      { category: 'sales', title: 'Hidden', content: 'secret', enabled: false },
      { category: 'sales', title: 'Blank', content: '   ', enabled: true },
    ])
    expect(out).toContain('€89/mo')
    expect(out).not.toContain('secret')
    expect(out).not.toContain('Blank')
  })
  it('orders sales before general', () => {
    const out = buildKnowledgeBlock([
      { category: 'general', title: 'G', content: 'gen' },
      { category: 'sales', title: 'S', content: 'sale' },
    ])
    expect(out.indexOf('SALES')).toBeLessThan(out.indexOf('GENERAL'))
  })
})

describe('buildCustomerSystemPrompt', () => {
  it('always includes the base rules + handoff convention', () => {
    const p = buildCustomerSystemPrompt({})
    expect(p).toContain(CUSTOMER_AGENT_BASE_PROMPT)
    expect(p).toContain(HANDOFF_PREFIX)
  })
  it('includes context, tone, extra rules and knowledge when provided', () => {
    const p = buildCustomerSystemPrompt({
      businessName: 'UN1T',
      locationName: 'Stillorgan',
      tone: 'Friendly and brief',
      extraRules: 'Never discuss competitors',
      today: '2026-06-01',
      knowledge: [{ category: 'sales', title: 'Trial', content: 'First class free' }],
    })
    expect(p).toContain('Stillorgan')
    expect(p).toContain('Friendly and brief')
    expect(p).toContain('Never discuss competitors')
    expect(p).toContain('First class free')
    expect(p).toContain('2026-06-01')
  })
  it('omits optional sections cleanly when absent', () => {
    const p = buildCustomerSystemPrompt({ knowledge: [] })
    expect(p).not.toContain('Tone & voice')
    expect(p).not.toContain('Extra rules (from the studio)')
  })
})

// AGENT-AUTH.1 — when the channel has already authenticated the sender
// (WhatsApp phone match), the prompt must tell the model to skip the
// verification questions; otherwise the base flow stands.
describe('identity pre-verification section', () => {
  it('includes the pre-verified override when identityPreverified is set', () => {
    const out = buildCustomerSystemPrompt({ identityPreverified: true })
    expect(out).toMatch(/already verified/i)
    expect(out).toMatch(/do not ask.*(email|date of birth|surname)/i)
  })
  it('omits the override by default so the question-based flow stands', () => {
    const out = buildCustomerSystemPrompt({})
    expect(out).not.toMatch(/already verified/i)
  })
})

// AGENT-ID.1 — named agent + Meta AI-disclosure rules (Jan 2026
// AI-Assisted Business Messaging Guidelines: disclose AI in the first
// message, never claim to be human, human escalation available).
describe('agent identity & disclosure', () => {
  it('names the agent and identifies it as an AI assistant', () => {
    const out = buildCustomerSystemPrompt({ agentName: 'Mia' })
    expect(out).toMatch(/You are Mia/)
    expect(out).toMatch(/AI assistant/i)
  })
  it('falls back to an unnamed AI assistant when no name is set', () => {
    const out = buildCustomerSystemPrompt({})
    expect(out).toMatch(/AI assistant/i)
    expect(out).not.toMatch(/You are Mia/)
  })
  it('instructs first-message disclosure and never claiming to be human', () => {
    const out = buildCustomerSystemPrompt({ agentName: 'Mia' })
    expect(out).toMatch(/introduce yourself/i)
    expect(out).toMatch(/never claim or imply you are a human/i)
  })
})

// AGENT-LANG.1 — Mia replies in the customer's language.
describe('multilingual replies', () => {
  it('instructs replying in the customer language and keeping class names verbatim', () => {
    const out = buildCustomerSystemPrompt({ agentName: 'Mia' })
    expect(out).toMatch(/reply in the (same )?language/i)
    expect(out).toMatch(/class names/i)
  })
})

// AGENT-EVENTS.1 — events guidance with the answer-first suggestion rule.
describe('events section', () => {
  it('teaches event tools and the answer-first suggestion rule', () => {
    const out = buildCustomerSystemPrompt({})
    expect(out).toMatch(/list_upcoming_events/)
    expect(out).toMatch(/answer the customer's actual question FIRST/i)
    expect(out).toMatch(/never collect payment details in chat/i)
  })
})

// AGENT-MEMSALES.1 — editable membership signup link.
describe('membership signup link', () => {
  it('renders the link and share-when-joining guidance when configured', () => {
    const out = buildCustomerSystemPrompt({ membershipUrl: 'https://example.com/join' })
    expect(out).toMatch(/https:\/\/example\.com\/join/)
    expect(out).toMatch(/membership sign-up link/i)
  })
  it('omits the section when no link is configured', () => {
    const out = buildCustomerSystemPrompt({})
    expect(out).not.toMatch(/membership sign-up link/i)
  })
})

// CACHE.2 — split the system prompt into a location-stable prefix (cacheable)
// and a per-request volatile suffix (today's date + the per-conversation
// identity override). The cache breakpoint lands on the stable prefix so the
// big base prompt + knowledge cache across every inbound message for a
// location; the volatile suffix re-renders each call WITHOUT busting the
// cached prefix. buildCustomerSystemPrompt stays the joined-string convenience.
describe('buildCustomerSystemPromptParts (cache split)', () => {
  const opts = {
    businessName: 'UN1T',
    locationName: 'Stillorgan',
    agentName: 'Mia',
    membershipUrl: 'https://example.com/join',
    tone: 'Friendly and brief',
    extraRules: 'Never discuss competitors',
    knowledge: [{ category: 'sales', title: 'Trial', content: 'First class free' }],
    today: '2026-06-18',
    identityPreverified: true,
  }

  it('keeps the big location-stable content in the stable part', () => {
    const { stable } = buildCustomerSystemPromptParts(opts)
    expect(stable).toContain(CUSTOMER_AGENT_BASE_PROMPT)
    expect(stable).toContain('You are Mia')
    expect(stable).toContain('First class free')          // knowledge
    expect(stable).toContain('Friendly and brief')         // tone
    expect(stable).toContain('Never discuss competitors')  // extra rules
    expect(stable).toContain('https://example.com/join')   // membership link
  })

  it('keeps the volatile bits OUT of the stable part', () => {
    const { stable } = buildCustomerSystemPromptParts(opts)
    expect(stable).not.toContain('2026-06-18')       // today's date
    expect(stable).not.toMatch(/already verified/i)  // per-conversation override
  })

  it('puts today and the identity override in the volatile part', () => {
    const { volatile } = buildCustomerSystemPromptParts(opts)
    expect(volatile).toContain('2026-06-18')
    expect(volatile).toMatch(/already verified/i)
  })

  // The cache-correctness invariant: the stable prefix must NOT change when
  // only per-request inputs change, or every inbound message is a cache miss.
  it('stable part is byte-identical regardless of today (cache stability)', () => {
    const a = buildCustomerSystemPromptParts({ ...opts, today: '2026-06-18' }).stable
    const b = buildCustomerSystemPromptParts({ ...opts, today: '2027-01-01' }).stable
    expect(a).toBe(b)
  })

  it('stable part is byte-identical regardless of identityPreverified (cache stability)', () => {
    const a = buildCustomerSystemPromptParts({ ...opts, identityPreverified: true }).stable
    const b = buildCustomerSystemPromptParts({ ...opts, identityPreverified: false }).stable
    expect(a).toBe(b)
  })

  it('loses no section vs the joined-string builder', () => {
    const { stable, volatile } = buildCustomerSystemPromptParts(opts)
    const joined = buildCustomerSystemPrompt(opts)
    for (const needle of [
      CUSTOMER_AGENT_BASE_PROMPT, 'First class free', 'Friendly and brief',
      'Never discuss competitors', 'https://example.com/join', '2026-06-18', 'Stillorgan',
    ]) {
      expect(joined).toContain(needle)
      expect(`${stable}\n\n${volatile}`).toContain(needle)
    }
  })
})

describe('buildCachedSystem (Anthropic system blocks)', () => {
  const opts = {
    businessName: 'UN1T',
    locationName: 'Stillorgan',
    knowledge: [{ category: 'sales', title: 'Trial', content: 'First class free' }],
    today: '2026-06-18',
  }

  it('returns an ephemeral-cached stable block followed by an uncached volatile block', () => {
    const blocks = buildCachedSystem(opts)
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } })
    expect(blocks[0].text).toContain(CUSTOMER_AGENT_BASE_PROMPT)
    const last = blocks[blocks.length - 1]
    expect(last.type).toBe('text')
    expect(last.cache_control).toBeUndefined()
    expect(last.text).toContain('2026-06-18')
  })

  it('emits only the stable block (still cached) when there is no volatile content', () => {
    // no today, no preverified, no business/studio → nothing volatile
    const blocks = buildCachedSystem({ knowledge: [{ category: 'sales', content: 'x' }] })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('concatenated block text matches the joined-string builder (no content drift)', () => {
    const blocks = buildCachedSystem(opts)
    const concatenated = blocks.map(b => b.text).join('\n\n')
    expect(concatenated).toBe(buildCustomerSystemPrompt(opts))
  })
})
