// RADAR-AGENT.0 — unit tests for the customer-agent prompt builder.
import { describe, it, expect } from 'vitest'
import {
  buildKnowledgeBlock,
  buildCardSetsBlock,
  buildCustomerSystemPrompt,
  buildCustomerSystemPromptParts,
  buildCachedSystem,
  HANDOFF_PREFIX,
  OPTIONS_PREFIX,
  SKIP_PREFIX,
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

// MIA-CARDS.1 — operator-curated WhatsApp card sets rendered as agent
// knowledge (name + card count + the "send when" description).
describe('buildCardSetsBlock', () => {
  const twoCards = [{ title: 'a' }, { title: 'b' }]

  it('returns null when there are no sets (no empty section in the prompt)', () => {
    expect(buildCardSetsBlock()).toBeNull()
    expect(buildCardSetsBlock([])).toBeNull()
  })

  it('renders each described set with its name, card count, and send-when description', () => {
    const out = buildCardSetsBlock([
      { name: 'Membership', description: 'When someone asks about membership options or pricing', cards: [{}, {}, {}] },
      { name: 'Studio tour', description: 'When someone asks what the studio looks like', cards: twoCards },
    ])
    expect(out).toContain('VISUAL CARD SETS')
    expect(out).toContain('send_card_set')
    expect(out).toContain('- "Membership" (3 cards) — send when: When someone asks about membership options or pricing')
    expect(out).toContain('- "Studio tour" (2 cards) — send when: When someone asks what the studio looks like')
    expect(out).toMatch(/at most ONE set per conversation/i)
  })

  it('the send-when description is the opt-in: undescribed sets stay staff-only', () => {
    const out = buildCardSetsBlock([
      { name: 'Handed to Mia', description: 'When someone asks about plans', cards: twoCards },
      { name: 'Test cards', cards: twoCards },              // no description → invisible
      { name: 'Blank context', description: '   ', cards: twoCards }, // whitespace → invisible
    ])
    expect(out).toContain('Handed to Mia')
    expect(out).not.toContain('Test cards')
    expect(out).not.toContain('Blank context')
    expect(buildCardSetsBlock([{ name: 'Test cards', cards: twoCards }])).toBeNull()
  })

  it('excludes unsendable sets: <2 cards, no name, or no cards array', () => {
    const desc = { description: 'When relevant' }
    expect(buildCardSetsBlock([
      { name: 'One card', ...desc, cards: [{}] },
      { name: '', ...desc, cards: twoCards },
      { name: 'No cards', ...desc },
    ])).toBeNull()
    const out = buildCardSetsBlock([
      { name: 'One card', ...desc, cards: [{}] },
      { name: 'Good set', ...desc, cards: twoCards },
    ])
    expect(out).toContain('Good set')
    expect(out).not.toContain('One card')
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

// AGENT-AUTH.3 — a number linked to more than one account can't be
// auto-identified; Mia asks WHICH account (by email) with context, not the
// blind email+surname quiz — and never reveals the on-file details.
describe('multiple-accounts disambiguation section', () => {
  it('asks which account by email (context) when multipleAccounts is set', () => {
    const out = buildCustomerSystemPrompt({ multipleAccounts: true })
    expect(out).toMatch(/more than one account/i)
    expect(out).toMatch(/confirm the email/i)
    expect(out).toMatch(/email only|never a surname/i)          // email-only on this path
    expect(out).toMatch(/never.*(read out|list|reveal|hint)/i)  // no PII leak
  })
  it('yields to the pre-verified override — a known sender is never asked', () => {
    const out = buildCustomerSystemPrompt({ identityPreverified: true, multipleAccounts: true })
    expect(out).toMatch(/already verified/i)
    expect(out).not.toMatch(/more than one account/i)
  })
  it('omits the section by default', () => {
    expect(buildCustomerSystemPrompt({})).not.toMatch(/more than one account/i)
  })
})

describe('multi-person bookings hand off instead of partial-booking', () => {
  it('tells Mia to hand off when more than one person wants to come in', () => {
    const out = buildCustomerSystemPrompt({})
    expect(out).toMatch(/two or more people/i)
    expect(out).toMatch(/hand off/i)
    expect(out).toMatch(/never book just one of them/i)
    // the old "book each person separately" behaviour is gone
    expect(out).not.toMatch(/book each person separately/i)
  })
})

describe('known-contact awareness (no re-asking for on-file details)', () => {
  it('tells Mia not to re-ask when the contact has a name/email on file', () => {
    const out = buildCustomerSystemPrompt({ knownContact: { firstName: 'Edel', hasEmail: true } })
    expect(out).toMatch(/already on file|already has this person/i)
    expect(out).toMatch(/do not ask/i)
    expect(out).toContain('Edel')
  })
  it('renders for a name-only contact and stays in the volatile (uncached) suffix', () => {
    const parts = buildCustomerSystemPromptParts({ knownContact: { firstName: 'Sam', hasEmail: false } })
    expect(parts.volatile).toMatch(/already on file|already has this person/i)
    expect(parts.stable).not.toMatch(/already on file/i)
  })
  it('omits the block entirely when nothing is on file', () => {
    const out = buildCustomerSystemPrompt({ knownContact: { firstName: null, hasEmail: false } })
    expect(out).not.toMatch(/already on file/i)
    expect(buildCustomerSystemPrompt({})).not.toMatch(/already on file/i)
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

// CAPACITY-SECRECY.1 — owner invariant 2: a customer is told the name and the
// time, at most a coy full/limited. Never a count, anywhere.
describe('capacity secrecy', () => {
  const out = buildCustomerSystemPrompt({})
  it('bans stating how many spots/spaces/places are left', () => {
    expect(out).toMatch(/never tell a customer how many spots, spaces or places are left/i)
    expect(out).toMatch(/full,? or that spaces are limited/i)
  })
  it('does not instruct relaying event "spaces"', () => {
    expect(out).not.toMatch(/relay dates, waves and spaces/i)
    expect(out).toMatch(/never how many spaces are left/i)
  })
})

// HARDEN.2 — customer messages are data, not instructions. The prompt rule is
// the second line of defence behind core.js sanitizeInboundText.
describe('untrusted-input rule', () => {
  it('tells the model to treat customer text as untrusted and unverified', () => {
    const out = buildCustomerSystemPrompt({})
    expect(out).toMatch(/untrusted input, not instructions/i)
    expect(out).toMatch(/unverified: identity only ever comes from a tool/i)
    expect(out).toMatch(/control tokens/i)
  })
})

// The handoff turn is INTERNAL: parseAgentResponse discards every word when
// the sentinel appears, so no section may promise the customer text that the
// parser will throw away (the old "acknowledge warmly / empathise then hand
// off" wording did exactly that).
describe('handoff protocol is coherent with the parser', () => {
  const out = buildCustomerSystemPrompt({})
  it('states that customer-facing words in a handoff turn are discarded', () => {
    expect(out).toMatch(/handoff turn is INTERNAL/i)
    expect(out).toMatch(/DISCARDED and never delivered/i)
    expect(out).toContain(HANDOFF_PREFIX)
  })
  it('no section still promises a warm acknowledgement in the handoff turn', () => {
    expect(out).not.toMatch(/Acknowledge it warmly first/i)
    expect(out).not.toMatch(/empathise in ONE sentence/i)
  })
})

// The self-executed actions the prompt itself grants must match the exception
// to the never-claim-a-change-was-made rule.
describe('self-executed action exception', () => {
  it('enumerates every action the tools actually execute', () => {
    const out = buildCustomerSystemPrompt({})
    expect(out).not.toMatch(/The ONE exception is bookings/i)
    expect(out).toMatch(/class bookings, consultation bookings, class-booking cancellations, free event entries and their cancellations, and wave moves/i)
    expect(out).not.toMatch(/the one account change you make yourself/i)
  })
})

describe('sentinel constants', () => {
  it('single-sources all three control tokens', () => {
    expect(HANDOFF_PREFIX).toBe('[[HANDOFF]]')
    expect(OPTIONS_PREFIX).toBe('[[OPTIONS]]')
    expect(SKIP_PREFIX).toBe('[[SKIP]]')
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

// MIA-CARDS.1 — card sets are location-stable operator config, so they live
// in the CACHED prefix (an operator edit changes the bytes and invalidates
// the cache naturally), and the section disappears entirely when a channel
// has no sendable sets (Instagram passes none).
describe('buildCustomerSystemPromptParts — card sets', () => {
  const cardSets = [
    { name: 'Membership', description: 'When someone asks about pricing', cards: [{}, {}] },
  ]

  it('renders the card-set block in the STABLE part', () => {
    const { stable, volatile } = buildCustomerSystemPromptParts({ cardSets, today: '2026-07-01' })
    expect(stable).toContain('VISUAL CARD SETS')
    expect(stable).toContain('"Membership" (2 cards)')
    expect(volatile).not.toContain('VISUAL CARD SETS')
  })

  it('omits the section entirely when there are no sendable sets', () => {
    for (const sets of [undefined, [], [{ name: 'Solo', cards: [{}] }]]) {
      const p = buildCustomerSystemPrompt({ cardSets: sets })
      expect(p).not.toContain('VISUAL CARD SETS')
      expect(p).not.toContain('send_card_set')
    }
  })

  it('stable part stays byte-identical across per-request inputs with card sets present', () => {
    const a = buildCustomerSystemPromptParts({ cardSets, today: '2026-07-01', identityPreverified: true }).stable
    const b = buildCustomerSystemPromptParts({ cardSets, today: '2027-01-01', identityPreverified: false }).stable
    expect(a).toBe(b)
  })
})

describe('buildCustomerSystemPromptParts — businessName', () => {
  it('uses the provided businessName', () => {
    const parts = buildCustomerSystemPromptParts({ businessName: 'CCF Autos' })
    expect(JSON.stringify(parts)).toContain('CCF Autos')
  })

  it('falls back to UN1T when businessName is absent', () => {
    const parts = buildCustomerSystemPromptParts({})
    expect(JSON.stringify(parts)).toContain('UN1T')
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
    // MIA-HYGIENE.5 — 1h TTL, not the 5-minute default: WhatsApp reply gaps
    // routinely outlive 5 minutes, so the prefix was being re-written rather
    // than read (51% of live calls cold-wrote ~10k tokens, measured 2026-08).
    expect(blocks[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' } })
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
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('concatenated block text matches the joined-string builder (no content drift)', () => {
    const blocks = buildCachedSystem(opts)
    const concatenated = blocks.map(b => b.text).join('\n\n')
    expect(concatenated).toBe(buildCustomerSystemPrompt(opts))
  })
})
