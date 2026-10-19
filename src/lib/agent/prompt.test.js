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
  renderCustomerAgentBasePrompt,
  buildStudioFactsBlock,
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

// FLOWACK.1 — Mia told a customer "you're all set for your first visit" 4s
// after the Flow booking had FAILED, prompted by "(including via the 'Book your
// first visit' flow)". A class is booked only when a tool or a confirmation in
// the thread says so; a Flow submission is a request, not a booking.
describe('a Flow submission is never treated as a booking', () => {
  it('drops the flow clause and requires a tool or an in-thread confirmation', () => {
    for (const out of [buildCustomerSystemPrompt({}), renderCustomerAgentBasePrompt(undefined, { bookings: false })]) {
      expect(out).not.toMatch(/including via the "Book your first visit" flow/)
      expect(out).toContain('Only treat a class as booked when a booking tool or a booking confirmation already in the thread confirms it.')
      expect(out).toContain('"[Booking submitted via WhatsApp Flow]" message is a request the system is still processing, never a booking')
    }
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

  // EVENT-MOVE.7 — a different event goes through the move tools and staff
  // approval, never cancel + rebook.
  it('teaches moving an entry to another date through the approval tools', () => {
    const out = buildCustomerSystemPrompt({})
    expect(out).toMatch(/list_event_move_options/)
    expect(out).toMatch(/move_event_entry/)
    expect(out).toMatch(/never cancel and rebook/i)
    expect(out).not.toMatch(/different EVENT is a cancel/i)
    expect(out).toMatch(/A CLASS RESCHEDULE is a cancel \+ a new booking \(event entries are different/)
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

  // W1.S3 — the brand comes from getLocationBranding (which ends in the
  // location's own name); the prompt itself never names a gym.
  it('names no gym when businessName is absent (no literal fallback)', () => {
    const parts = buildCustomerSystemPromptParts({})
    expect(JSON.stringify(parts)).not.toContain('UN1T')
    expect(parts.stable).toContain('You are the AI assistant for a boutique fitness studio.')
  })

  it('reads "the AI assistant for {brand}, a boutique fitness studio" with a brand', () => {
    const parts = buildCustomerSystemPromptParts({ businessName: 'Gym A', agentName: 'Mia' })
    expect(parts.stable).toContain('You are Mia, the AI assistant for Gym A, a boutique fitness studio.')
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

// MIA-DUNNING.1 — Mia knows the overdue-payment reminder exists (the Pay now
// WhatsApp + emails, #1683) and checks the run before answering; billing in
// general still hands off, and card details never enter the chat.
describe('overdue payment reminders section', () => {
  const out = buildCustomerSystemPrompt({})
  it('has the section and routes reminder questions through get_my_payment_reminder first', () => {
    expect(out).toMatch(/## Overdue payment reminders/)
    expect(out).toMatch(/call get_my_payment_reminder BEFORE answering/i)
    expect(out).toMatch(/Pay now/)
  })
  it('places it after the account section and before pauses/cancellations', () => {
    const acct = out.indexOf('## Answering a member\'s own account questions')
    const dun = out.indexOf('## Overdue payment reminders')
    const pause = out.indexOf('## Pauses and cancellations')
    expect(acct).toBeGreaterThan(-1)
    expect(dun).toBeGreaterThan(acct)
    expect(pause).toBeGreaterThan(dun)
  })
  it('pins the outcome rules: no record, settled, still owed after "I paid", unknown', () => {
    expect(out).toMatch(/has_reminder is false[^\n]*hand off/i)
    expect(out).toMatch(/still_overdue is false[^\n]*stop automatically/i)
    expect(out).toMatch(/still_overdue is true[^\n]*they(’|')ve paid[^\n]*Do NOT contradict/i)
    expect(out).toMatch(/still_overdue is 'unknown'[^\n]*never guess/i)
  })
  it('bans card details in chat and says where they go instead', () => {
    expect(out).toMatch(/NEVER ask for or accept card numbers, expiry dates, CVV or bank details in chat/)
    expect(out).toMatch(/do not repeat them back/i)
    expect(out).toMatch(/sent card details in chat/i)
  })
  it('amends the billing line to carve out the reminder tool, everything else still hands off', () => {
    expect(out).not.toMatch(/You do NOT have their price, payment or billing standing\. If they ask/)
    expect(out).toMatch(/billing standing beyond what get_my_payment_reminder returns/i)
    expect(out).toMatch(/anything else about billing\/invoices, hand off/i)
  })
})

// W1.M3b — the base prompt is rendered for the studio's membership source.
describe('renderCustomerAgentBasePrompt (W1.M3b)', () => {
  it('the default render IS the Glofox prompt UN1T ran before the seam (CUSTOMER_AGENT_BASE_PROMPT)', async () => {
    const { renderCustomerAgentBasePrompt, GLOFOX_PROMPT_SOURCE } = await import('./prompt')
    expect(renderCustomerAgentBasePrompt()).toBe(CUSTOMER_AGENT_BASE_PROMPT)
    expect(renderCustomerAgentBasePrompt(GLOFOX_PROMPT_SOURCE)).toBe(CUSTOMER_AGENT_BASE_PROMPT)
    expect(CUSTOMER_AGENT_BASE_PROMPT).toContain('opens a secure Glofox payment page, plus the option to update the card on file in the Glofox app.')
    expect(CUSTOMER_AGENT_BASE_PROMPT).toContain('so the team checks Glofox.')
    expect(CUSTOMER_AGENT_BASE_PROMPT).toContain('If there is no pay_link, point them to updating their card in the Glofox app. If that also fails for them, hand off.')
    expect(CUSTOMER_AGENT_BASE_PROMPT).toContain('say the secure link or the Glofox app is the only place to enter them')
  })
  it('another provider is named by its label', async () => {
    const { renderCustomerAgentBasePrompt } = await import('./prompt')
    const p = renderCustomerAgentBasePrompt({ key: 'un1t', label: 'Repset' })
    expect(p).toContain('opens a secure Repset payment page, plus the option to update the card on file in the Repset app.')
    expect(p).toContain('updating their card in the Repset app')
    expect(p).not.toContain('Glofox')
  })
  it('a studio with NO membership source gets no app rules and never says Glofox', async () => {
    const { renderCustomerAgentBasePrompt } = await import('./prompt')
    const p = renderCustomerAgentBasePrompt({ key: 'none', label: 'No membership source' })
    expect(p).not.toContain('Glofox')
    expect(p).not.toContain('No membership source')
    expect(p).toContain('opens a secure payment page. If KNOWLEDGE')
    expect(p).toContain('If there is no pay_link, hand off.')
    expect(p).not.toContain('updating their card')
    expect(p).toContain('say the secure link is the only place to enter them')
    expect(p).toContain('so the team checks the payment.')
  })
  it('buildCustomerSystemPrompt threads membershipSource into the stable prefix; absent → the Glofox default', () => {
    expect(buildCustomerSystemPrompt({ membershipSource: { key: 'none', label: 'No membership source' } })).not.toContain('Glofox')
    expect(buildCustomerSystemPrompt({})).toContain(CUSTOMER_AGENT_BASE_PROMPT)
  })
})

// ── MIAHATCH.2 Task 7: the un1t.online prompt variants and the facts block ──
const UN1T_SOURCE = { key: 'un1t_online', label: 'un1t.online' }
const BANNED_WORDS = /limited|spaces|capacity/i
const DASHES = /[\u2014\u2013]/
const FACTS_RULE = (studio) => `Prices and the timetable for ${studio} come only from your tools and this block, never from the studio knowledge above.`
const VARIANT_CASES = [
  ['read', false, null],
  ['read', false, 'https://hatch.example.test/book'],
  ['read', true, null],
  ['read', true, 'https://hatch.example.test/book'],
  ['full', false, 'https://hatch.example.test/book'],
  ['full', true, null],
]
const render = (variant, multiStudio, bookingUrl) =>
  renderCustomerAgentBasePrompt(UN1T_SOURCE, { bookings: false, bookingUrl, un1tVariant: variant, multiStudio })

describe('un1t.online prompt variants', () => {
  it('read variant never says limited, spaces or capacity (the whole render)', () => {
    for (const [variant, multi, url] of VARIANT_CASES) {
      expect(render(variant, multi, url)).not.toMatch(BANNED_WORDS)
      const { stable, volatile } = buildCustomerSystemPromptParts({
        businessName: 'Studio', locationName: 'Hatch', un1tVariant: variant, multiStudio: multi,
        bookings: false, bookingUrl: url, membershipSource: UN1T_SOURCE,
        knowledge: [{ category: 'faq', title: 'Hours', content: 'Fictional: 6am to 9pm.' }],
      })
      expect(stable).not.toMatch(BANNED_WORDS)
      expect(volatile).not.toMatch(BANNED_WORDS)
    }
  })

  it('keeps the no-count rule without the banned words', () => {
    const out = render('read', false, null)
    expect(out).toMatch(/NEVER tell a customer how many places are left/)
    expect(out).toMatch(/whether something is full, never a count/)
  })

  it('the default (null) variant is today\'s bytes, for any source and booking mode', () => {
    expect(renderCustomerAgentBasePrompt()).toBe(CUSTOMER_AGENT_BASE_PROMPT)
    expect(renderCustomerAgentBasePrompt(undefined, { un1tVariant: null, multiStudio: true })).toBe(CUSTOMER_AGENT_BASE_PROMPT)
    expect(renderCustomerAgentBasePrompt(UN1T_SOURCE, { bookings: false, bookingUrl: 'u', un1tVariant: null }))
      .toBe(renderCustomerAgentBasePrompt(UN1T_SOURCE, { bookings: false, bookingUrl: 'u' }))
  })

  it('slice 1 renders full exactly as read (slice 2 adds the upsell rules)', () => {
    for (const multi of [false, true]) {
      for (const url of [null, 'https://hatch.example.test/book']) {
        expect(render('full', multi, url)).toBe(render('read', multi, url))
      }
    }
  })

  it('read variant: you cannot book from chat; share the booking link or hand off; account answers from tools only', () => {
    const withLink = render('read', false, 'https://hatch.example.test/book')
    expect(withLink).toContain("You can't book or cancel classes from chat at this studio. To book, send the studio's booking link.")
    expect(withLink).toContain("The studio's booking link is https://hatch.example.test/book.")
    const noLink = render('read', false, null)
    expect(noLink).toContain("You can't book or cancel classes from chat at this studio. To book, hand the customer to the team.")
    expect(noLink).not.toContain('http')
    for (const out of [withLink, noLink]) {
      expect(out).toMatch(/Account answers come from your tools only/)
      expect(out).not.toContain('You CAN book classes')
      expect(out).not.toContain('You CAN cancel')
    }
  })

  it('multiStudio asks to say which studio each answer is for; single studio does not', () => {
    expect(render('read', true, null)).toMatch(/Say which studio each answer is for/)
    expect(render('read', false, null)).not.toMatch(/Say which studio each answer is for/)
  })

  it('MIAHATCH.3: the single-studio read variant has its own overdue payment rules, with no pay link', () => {
    const out = render('read', false, null)
    expect(out).toMatch(/## Overdue payments/)
    expect(out).toMatch(/call get_my_payment_reminder BEFORE answering/)
    expect(out).toMatch(/"am I paid up"/)
    expect(out).toMatch(/Overdue payments at the un1t\.online studio are chased by the studio itself\. There is no pay link for them, and you never send or invent one/)
    expect(out).toMatch(/update the card on file at the un1t\.online studio, they can do it in the un1t\.online app, or the team can help/)
    expect(out).toMatch(/never state an amount or a date the tool did not give/)
    expect(out).toMatch(/still_overdue is 'unknown': never guess/)
    // The Glofox-only wording does not leak into the single-studio un1t render.
    expect(out).not.toMatch(/Pay now|send pay_link|first_sent_at|Glofox/)
    // The old blanket "hand off any payment reminder question" lines are gone.
    expect(out).not.toMatch(/You do NOT have their price, payment history or billing standing\./)
    expect(out).not.toMatch(/asks about a payment reminder or a failed payment/)
    expect(out).not.toMatch(/If the answer lists more than one studio/)
  })

  it('MIAHATCH.3 fix 1: the dual render scopes the no-pay-link rule to the named un1t studio and carries the Glofox rules for the other section', () => {
    const named = renderCustomerAgentBasePrompt(UN1T_SOURCE, { bookings: false, bookingUrl: null, un1tVariant: 'read', multiStudio: true, un1tStudioName: 'Hatch Street' })
    expect(named).toMatch(/Overdue payments at Hatch Street are chased by the studio itself\. There is no pay link for them/)
    expect(named).toMatch(/update the card on file at Hatch Street, they can do it in the un1t\.online app/)
    expect(named).not.toMatch(/There is no pay link for these payments/)
    expect(named).toMatch(/If the answer lists more than one studio, say which studio each part is for/)
    expect(named).toMatch(/The rules that follow apply only to the section of the answer for the Glofox studio, which can carry its own reminder details and pay link\. They never apply to the section for Hatch Street\./)
    // The shared lines are today's Glofox lines, byte for byte.
    const glofoxBullets = CUSTOMER_AGENT_BASE_PROMPT.slice(
      CUSTOMER_AGENT_BASE_PROMPT.indexOf('- When a message is about a payment reminder'),
      CUSTOMER_AGENT_BASE_PROMPT.indexOf('- NEVER ask for or accept card numbers, expiry dates, CVV or bank details in chat. If a customer sends them, do not repeat them back; say the secure link'),
    ).trimEnd()
    expect(glofoxBullets.split('\n')).toHaveLength(7)
    expect(named).toContain(glofoxBullets)
    expect(named).toContain('send pay_link in plain text')
    // Unnamed dual: the unnamed wording.
    expect(render('read', true, null)).toMatch(/section for the un1t\.online studio\./)
    // The added lines (everything not in today's prompt) are dash free; the reused ones have none either.
    expect(named.split('\n').filter((l) => /Pay now|pay_link/.test(l)).join('\n')).not.toMatch(DASHES)
    expect(named).not.toMatch(BANNED_WORDS)
  })

  it('every line a un1t variant adds is free of em and en dashes', () => {
    const base = new Set(CUSTOMER_AGENT_BASE_PROMPT.split('\n'))
    for (const [variant, multi, url] of VARIANT_CASES) {
      const added = render(variant, multi, url).split('\n').filter((l) => !base.has(l))
      expect(added.length).toBeGreaterThan(5)
      for (const l of added) expect(l).not.toMatch(DASHES)
    }
  })

  it('the stable prefix is byte-identical across two turns at the same studio and variant', () => {
    const o = { businessName: 'B', locationName: 'Hatch', un1tVariant: 'read', multiStudio: true, bookings: false, bookingUrl: 'https://hatch.example.test/book', membershipSource: UN1T_SOURCE, knowledge: [{ category: 'faq', title: 'Q', content: 'A' }] }
    const a = buildCachedSystem({ ...o, today: 'Saturday', identityPreverified: false })
    const b = buildCachedSystem({ ...o, today: 'Sunday', identityPreverified: true, knownContact: { firstName: 'Aoife' }, factsBlocks: ['## Facts for Other\nx'] })
    expect(a[0]).toEqual(b[0])
    expect(a[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('a un1t variant at a booking thread (bookings true) still carries the link and the variant text', () => {
    const { stable } = buildCustomerSystemPromptParts({ un1tVariant: 'read', multiStudio: true, bookings: true, bookingUrl: 'https://hatch.example.test/book' })
    expect(stable).toContain("The studio's booking link is https://hatch.example.test/book.")
  })
})

describe('un1t variant names the studio it answers for', () => {
  const CARVE_OUT = "When a facts block below names another studio, that studio's prices, offers, timetable and links come only from its facts block and your tools."
  const named = (variant, multiStudio, bookingUrl) =>
    renderCustomerAgentBasePrompt(UN1T_SOURCE, { bookings: true, bookingUrl, un1tVariant: variant, multiStudio, un1tStudioName: 'Hatch Street' })

  it('un1tStudioName replaces "this studio" in the booking lines (single and multi studio)', () => {
    for (const [multi, url] of [[false, 'https://hatch.example.test/book'], [false, null], [true, 'https://hatch.example.test/book'], [true, null]]) {
      const out = named('read', multi, url)
      expect(out).toContain('at Hatch Street')
      expect(out).not.toMatch(/at this studio/)
      expect(out).not.toMatch(BANNED_WORDS)
      if (!multi) expect(out).toContain("You can't book or cancel classes at Hatch Street from chat.")
      if (url) expect(out).toContain("Hatch Street's booking link is https://hatch.example.test/book.")
      if (!multi && url) expect(out).toContain("To book, send Hatch Street's booking link.")
    }
    expect(named('read', false, null)).toContain('You never book, cancel or change a class booking at Hatch Street from chat')
  })

  it('without a name the wording is unchanged, and a name is ignored without a un1t variant', () => {
    expect(render('read', false, 'https://hatch.example.test/book')).toContain("You can't book or cancel classes from chat at this studio.")
    expect(renderCustomerAgentBasePrompt(undefined, { un1tStudioName: 'Hatch Street' })).toBe(CUSTOMER_AGENT_BASE_PROMPT)
    const parts = buildCustomerSystemPromptParts({ un1tStudioName: 'Hatch Street' })
    expect(parts.stable).toBe(buildCustomerSystemPromptParts({}).stable)
  })

  it('the stable prefix stays identical across two turns with the name set', () => {
    const o = { businessName: 'B', locationName: 'Stillorgan', un1tVariant: 'read', un1tStudioName: 'Hatch Street', multiStudio: true, bookings: true, bookingUrl: 'https://hatch.example.test/book', knowledge: [{ category: 'faq', title: 'Q', content: 'A' }] }
    const a = buildCachedSystem({ ...o, today: 'Saturday' })
    const b = buildCachedSystem({ ...o, today: 'Sunday', identityPreverified: true, factsBlocks: ['## Facts for Hatch Street\nx'] })
    expect(a[0]).toEqual(b[0])
    expect(a[0].text).toContain('at Hatch Street')
  })

  it('the carve-out is in the read and full renders, in the stable text, and absent from Glofox and no-booking', () => {
    for (const variant of ['read', 'full']) {
      for (const multi of [false, true]) {
        for (const url of [null, 'https://hatch.example.test/book']) {
          const out = render(variant, multi, url)
          expect(out).toContain(CARVE_OUT)
          expect(out).toContain('The KNOWLEDGE section and the membership sign-up link describe the studio of this conversation only.')
          expect(out).not.toMatch(BANNED_WORDS)
        }
      }
    }
    expect(buildCustomerSystemPromptParts({ un1tVariant: 'read', bookings: false, membershipSource: UN1T_SOURCE }).stable).toContain(CARVE_OUT)
    expect(CUSTOMER_AGENT_BASE_PROMPT).not.toContain(CARVE_OUT)
    expect(renderCustomerAgentBasePrompt(UN1T_SOURCE, { bookings: false, bookingUrl: 'u' })).not.toContain(CARVE_OUT)
  })
})

describe('buildStudioFactsBlock', () => {
  const full = {
    studioName: 'Hatch Street', address: '1 Fictional Row, Dublin 2',
    bookingUrl: 'https://hatch.example.test/book', membershipUrl: 'https://hatch.example.test/join',
    offers: [
      { title: '10 class pack', price_label: '€125', blurb: 'Valid for three months' },
      { title: 'Monthly', price_label: '€189 a month' },
    ],
    knowledge: [
      { category: 'faq', title: 'Showers', content: 'Fictional: showers on the ground floor.', enabled: true },
      { category: 'faq', title: 'Hidden', content: 'secret', enabled: false },
      { category: 'faq', title: 'Blank', content: '   ' },
    ],
  }

  it('carries name, address, both links, offers, knowledge and the exact rule line last', () => {
    const out = buildStudioFactsBlock(full)
    expect(out).toContain('Hatch Street')
    expect(out).toContain('1 Fictional Row, Dublin 2')
    expect(out).toContain('https://hatch.example.test/book')
    expect(out).toContain('https://hatch.example.test/join')
    expect(out).toContain('10 class pack')
    expect(out).toContain('€125')
    expect(out).toContain('Valid for three months')
    expect(out).toContain('€189 a month')
    expect(out).toContain('Showers: Fictional: showers on the ground floor.')
    expect(out).not.toContain('secret')
    expect(out).not.toContain('Blank')
    expect(out.endsWith(FACTS_RULE('Hatch Street'))).toBe(true)
    expect(out).not.toMatch(DASHES)
  })

  it('omits anything missing: no "undefined", no empty label lines', () => {
    const out = buildStudioFactsBlock({ studioName: 'Hatch Street' })
    expect(out).not.toMatch(/undefined|null/)
    for (const l of out.split('\n')) expect(l.trim()).not.toMatch(/:\s*$/)
    expect(out.replace(FACTS_RULE('Hatch Street'), '')).not.toMatch(/Address|Booking link|sign-up|Offers|About/)
    expect(out.endsWith(FACTS_RULE('Hatch Street'))).toBe(true)
    const partial = buildStudioFactsBlock({ studioName: 'Hatch Street', address: '  ', bookingUrl: 'https://hatch.example.test/book', offers: null, knowledge: undefined })
    expect(partial).toContain('https://hatch.example.test/book')
    expect(partial).not.toMatch(/Address|sign-up|undefined/)
  })

  it('an offer without a title is skipped; a price-less offer shows just its title', () => {
    const out = buildStudioFactsBlock({ studioName: 'H', offers: [{ price_label: '€5' }, { title: 'Trial' }] })
    expect(out).toContain('- Trial')
    expect(out).not.toContain('€5')
  })
})

describe('facts blocks in the uncached suffix only', () => {
  const base = { businessName: 'B', locationName: 'Stillorgan', today: 'Saturday', knowledge: [{ category: 'faq', title: 'Q', content: 'A' }] }
  const block = buildStudioFactsBlock({ studioName: 'Hatch Street', address: '1 Fictional Row', bookingUrl: 'https://hatch.example.test/book' })

  it('stable text and cache_control are unchanged by factsBlocks', () => {
    const without = buildCachedSystem(base)
    const withFacts = buildCachedSystem({ ...base, factsBlocks: [block] })
    expect(withFacts[0]).toEqual(without[0])
    expect(buildCustomerSystemPromptParts({ ...base, factsBlocks: [block] }).stable)
      .toBe(buildCustomerSystemPromptParts(base).stable)
    expect(withFacts[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(withFacts.slice(1).every((b) => !b.cache_control)).toBe(true)
    expect(withFacts[0].text).not.toContain('Hatch Street')
    expect(withFacts[1].text).toContain(block)
  })

  it('facts blocks render after Context in the volatile part; empty and blank ones are dropped', () => {
    const { volatile } = buildCustomerSystemPromptParts({ ...base, factsBlocks: [block, '', '  ', null] })
    expect(volatile.indexOf('## Context')).toBeLessThan(volatile.indexOf(block))
    expect(volatile.endsWith(block)).toBe(true)
    expect(buildCachedSystem({ ...base, factsBlocks: [] })).toEqual(buildCachedSystem(base))
  })

  it('with no un1t options the prompt is unchanged', () => {
    expect(buildCustomerSystemPrompt({ ...base, un1tVariant: null, multiStudio: false, factsBlocks: [] }))
      .toBe(buildCustomerSystemPrompt(base))
  })
})
