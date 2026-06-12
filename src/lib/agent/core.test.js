// RADAR-AGENT.0 — unit tests for the pure agent runtime helpers.
import { describe, it, expect } from 'vitest'
import {
  normalisePhone,
  phoneMatchesAllowlist,
  minutesOfDayInTz,
  isWithinQuietHours,
  shouldAgentReply,
  formatHistoryForClaude,
  parseAgentResponse,
  isVerificationFresh,
  DEFAULT_HOLDING_MESSAGE,
  autoVerifyContactId,
  isHandoffExpired,
  resolveRearmPatch,
} from './core'
import { HANDOFF_PREFIX, OPTIONS_PREFIX } from './prompt'

describe('normalisePhone / phoneMatchesAllowlist', () => {
  it('strips non-digits', () => {
    expect(normalisePhone('+353 87 314 7675')).toBe('353873147675')
    expect(normalisePhone(null)).toBe('')
  })
  it('matches with or without country/plus formatting', () => {
    expect(phoneMatchesAllowlist('+353873147675', ['353873147675'])).toBe(true)
    expect(phoneMatchesAllowlist('353873147675', ['+353 87 314 7675'])).toBe(true)
    expect(phoneMatchesAllowlist('0873147675', ['+353873147675'])).toBe(true) // suffix match
    expect(phoneMatchesAllowlist('353871111111', ['353872222222'])).toBe(false)
    expect(phoneMatchesAllowlist('353873147675', [])).toBe(false)
  })
})

describe('quiet hours', () => {
  it('computes minutes-of-day in a tz', () => {
    // 12:30 UTC
    const d = new Date('2026-06-01T12:30:00Z')
    expect(minutesOfDayInTz(d, 'UTC')).toBe(12 * 60 + 30)
  })
  it('same-day window', () => {
    const q = { start: '09:00', end: '17:00', tz: 'UTC' }
    expect(isWithinQuietHours(new Date('2026-06-01T10:00:00Z'), q)).toBe(true)
    expect(isWithinQuietHours(new Date('2026-06-01T18:00:00Z'), q)).toBe(false)
  })
  it('overnight wrap-around window', () => {
    const q = { start: '21:00', end: '07:00', tz: 'UTC' }
    expect(isWithinQuietHours(new Date('2026-06-01T23:00:00Z'), q)).toBe(true)
    expect(isWithinQuietHours(new Date('2026-06-01T03:00:00Z'), q)).toBe(true)
    expect(isWithinQuietHours(new Date('2026-06-01T12:00:00Z'), q)).toBe(false)
  })
  it('incomplete config never matches', () => {
    expect(isWithinQuietHours(new Date(), null)).toBe(false)
    expect(isWithinQuietHours(new Date(), { start: '09:00' })).toBe(false)
    expect(isWithinQuietHours(new Date(), { start: '09:00', end: '09:00', tz: 'UTC' })).toBe(false)
  })
})

describe('shouldAgentReply', () => {
  // A tapped quick-reply button arrives as type 'interactive' with the
  // button title as the body — it IS the customer's reply. Treating it
  // as unsupported would soft-handoff the very flow the buttons drive.
  it('treats an interactive button tap as a text reply', () => {
    const r = shouldAgentReply({
      settings: { enabled: true },
      conversation: { agent_active: true },
      message: { type: 'interactive', body: '7am' },
      senderPhone: '353870000000',
    })
    expect(r).toEqual({ reply: true, reason: 'ok' })
  })

  const base = {
    settings: { enabled: true },
    conversation: { agent_active: true },
    message: { type: 'text', body: 'hi' },
    senderPhone: '+353871234567',
    now: new Date('2026-06-01T12:00:00Z'),
  }

  it('replies when enabled, active, text, non-empty', () => {
    expect(shouldAgentReply(base)).toEqual({ reply: true, reason: 'ok' })
  })
  it('no reply when disabled and not in test mode', () => {
    expect(shouldAgentReply({ ...base, settings: { enabled: false } }))
      .toEqual({ reply: false, reason: 'disabled' })
  })
  it('no reply when conversation handed off', () => {
    expect(shouldAgentReply({ ...base, conversation: { agent_active: false } }))
      .toEqual({ reply: false, reason: 'handed_off' })
  })
  it('no reply for non-text messages — but flags onDuty for a soft handoff', () => {
    expect(shouldAgentReply({ ...base, message: { type: 'image', body: '' } }))
      .toEqual({ reply: false, reason: 'unsupported_type', onDuty: true })
  })
  it('no reply for empty text', () => {
    expect(shouldAgentReply({ ...base, message: { type: 'text', body: '   ' } }))
      .toEqual({ reply: false, reason: 'empty', onDuty: true })
  })
  it('does NOT flag onDuty for a non-text message when off-duty (disabled / quiet / off-allowlist)', () => {
    // disabled — bails before the content gate, so no soft-handoff ack fires
    expect(shouldAgentReply({ ...base, settings: { enabled: false }, message: { type: 'image', body: '' } }))
      .toEqual({ reply: false, reason: 'disabled' })
    // quiet hours wins over the non-text content gate
    const quiet = { enabled: true, quiet_hours: { start: '00:00', end: '23:59', tz: 'UTC' } }
    expect(shouldAgentReply({ ...base, settings: quiet, message: { type: 'image', body: '' } }).reason).toBe('quiet_hours')
  })
  it('test mode: replies only to allow-listed numbers', () => {
    const s = { enabled: false, test_mode: true, test_phones: ['+353871234567'] }
    expect(shouldAgentReply({ ...base, settings: s }).reply).toBe(true)
    expect(shouldAgentReply({ ...base, settings: s, senderPhone: '+353879999999' }))
      .toEqual({ reply: false, reason: 'not_in_test_allowlist' })
  })
  it('respects quiet hours even when enabled', () => {
    const s = { enabled: true, quiet_hours: { start: '00:00', end: '23:59', tz: 'UTC' } }
    expect(shouldAgentReply({ ...base, settings: s }).reason).toBe('quiet_hours')
  })
  it('treats missing settings as disabled', () => {
    expect(shouldAgentReply({ ...base, settings: null }))
      .toEqual({ reply: false, reason: 'disabled' })
  })
})

describe('formatHistoryForClaude', () => {
  it('maps direction to roles and drops leading assistant turns', () => {
    const rows = [
      { direction: 'outbound', body: 'Welcome!' },          // dropped (leading assistant)
      { direction: 'inbound', body: 'how much is membership?' },
      { direction: 'outbound', body: 'It is €X' },
    ]
    expect(formatHistoryForClaude(rows)).toEqual([
      { role: 'user', content: 'how much is membership?' },
      { role: 'assistant', content: 'It is €X' },
    ])
  })
  it('placeholders empty / media-only rows', () => {
    const rows = [{ direction: 'inbound', body: '', message_type: 'image' }]
    expect(formatHistoryForClaude(rows)).toEqual([{ role: 'user', content: '[image]' }])
  })
  it('merges consecutive same-role turns', () => {
    const rows = [
      { direction: 'inbound', body: 'hi' },
      { direction: 'inbound', body: 'you there?' },
    ]
    expect(formatHistoryForClaude(rows)).toEqual([
      { role: 'user', content: 'hi\nyou there?' },
    ])
  })
  it('truncates to the last maxMessages', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      direction: i % 2 === 0 ? 'inbound' : 'outbound', body: `m${i}`,
    }))
    const out = formatHistoryForClaude(rows, { maxMessages: 4 })
    // last 4 rows: m26(in) m27(out) m28(in) m29(out)
    expect(out[0]).toEqual({ role: 'user', content: 'm26' })
    expect(out.length).toBe(4)
  })
})

describe('parseAgentResponse', () => {
  it('detects a handoff sentinel and extracts the reason', () => {
    const r = parseAgentResponse(`${HANDOFF_PREFIX} wants to cancel membership`)
    expect(r).toEqual({ action: 'handoff', text: '', reason: 'wants to cancel membership' })
  })
  it('detects the sentinel even when the model emits text before it', () => {
    const r = parseAgentResponse(`Sure, let me get someone. ${HANDOFF_PREFIX} billing question`)
    // The raw sentinel must NOT leak to the customer (text is empty → holding message).
    expect(r.action).toBe('handoff')
    expect(r.text).toBe('')
    expect(r.reason).toBe('billing question')
  })
  it('treats normal text as a reply', () => {
    expect(parseAgentResponse('Sure! Classes run 6am–9pm.'))
      .toEqual({ action: 'reply', text: 'Sure! Classes run 6am–9pm.', reason: 'ok' })
  })
  it('an empty model response is a handoff, not a blank send', () => {
    expect(parseAgentResponse('   ').action).toBe('handoff')
  })
  it('exposes a default holding message', () => {
    expect(DEFAULT_HOLDING_MESSAGE).toMatch(/team/i)
  })

  // AGENT-UX.1 — tap-choice options. The model ends a reply with one
  // [[OPTIONS]] a | b | c line; the orchestrator renders WhatsApp
  // interactive buttons. Parsing is sentinel-based (same philosophy as
  // HANDOFF): deterministic, no tool round-trip, never leaks raw
  // sentinel text to the customer.
  it('extracts a trailing [[OPTIONS]] line into options and strips it from the text', () => {
    const r = parseAgentResponse(`Tomorrow has 7am, 8am and 9am.\n${OPTIONS_PREFIX} 7am | 8am | 9am`)
    expect(r.action).toBe('reply')
    expect(r.text).toBe('Tomorrow has 7am, 8am and 9am.')
    expect(r.options).toEqual(['7am', '8am', '9am'])
  })
  it('normalizes options: trims, drops empties, dedupes, caps at 10, truncates to 20 chars', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `opt ${i}`).join(' | ')
    expect(parseAgentResponse(`Pick:\n${OPTIONS_PREFIX} ${eleven}`).options).toHaveLength(10)
    const r = parseAgentResponse(`Pick:\n${OPTIONS_PREFIX}  7am | | 7am | this label is way too long to be a button`)
    expect(r.options).toEqual(['7am', 'this label is way to'])
  })
  it('a single or zero usable option is a plain reply with the sentinel stripped', () => {
    const r = parseAgentResponse(`Sure thing.\n${OPTIONS_PREFIX} only-one`)
    expect(r.action).toBe('reply')
    expect(r.text).toBe('Sure thing.')
    expect(r.options).toBeUndefined()
    expect(r.text).not.toContain(OPTIONS_PREFIX)
  })
  it('handoff beats options', () => {
    const r = parseAgentResponse(`${HANDOFF_PREFIX} reason\n${OPTIONS_PREFIX} a | b`)
    expect(r.action).toBe('handoff')
  })
})

// AGENT-AUTH.1 — WhatsApp phone-number authentication. Meta has already
// authenticated the sender's number (SIM-bound), so on WhatsApp a sender
// whose number maps to EXACTLY ONE contact — the one the conversation is
// linked to — is treated as verified without the email/DOB questions.
// Ambiguous numbers (couples sharing a phone) and Instagram (no phone)
// keep the question-based verify_identity flow.
// AGENT-REARM.1 — a handoff must not silence the agent forever. Two
// release paths: an operator resolving the thread hands it straight
// back (resolveRearmPatch, used by the conversation PATCH routes), and
// a configurable cooldown auto-releases threads nobody resolved
// (isHandoffExpired + the rearm flag from shouldAgentReply).
describe('isHandoffExpired', () => {
  const now = new Date('2026-06-13T12:00:00Z')
  it('expires a handoff older than the cooldown', () => {
    expect(isHandoffExpired('2026-06-12T23:00:00Z', 12, now)).toBe(true)
  })
  it('keeps a fresh handoff held', () => {
    expect(isHandoffExpired('2026-06-13T05:00:00Z', 12, now)).toBe(false)
  })
  it('never expires without a timestamp (manual agent-off stays off)', () => {
    expect(isHandoffExpired(null, 12, now)).toBe(false)
  })
  it('a zero/absent cooldown means never auto-release', () => {
    expect(isHandoffExpired('2026-06-01T00:00:00Z', 0, now)).toBe(false)
    expect(isHandoffExpired('2026-06-01T00:00:00Z', null, now)).toBe(false)
  })
})

describe('resolveRearmPatch', () => {
  it('re-arms the agent when resolving a handed-off thread', () => {
    expect(resolveRearmPatch({ resolved: true, agent_handed_off_at: '2026-06-12T17:24:11Z' }))
      .toEqual({ agent_active: true, agent_handed_off_at: null })
  })
  it('does nothing when resolving a thread that was never handed off', () => {
    expect(resolveRearmPatch({ resolved: true, agent_handed_off_at: null })).toEqual({})
  })
  it('does nothing when un-resolving', () => {
    expect(resolveRearmPatch({ resolved: false, agent_handed_off_at: '2026-06-12T17:24:11Z' })).toEqual({})
  })
})

describe('shouldAgentReply handoff cooldown', () => {
  const base = {
    settings: { enabled: true, handoff_cooldown_hours: 12 },
    message: { type: 'text', body: 'Can I book a class?' },
    senderPhone: '353870000000',
    now: new Date('2026-06-13T12:00:00Z'),
  }
  it('re-engages with rearm:true once the cooldown has passed', () => {
    const r = shouldAgentReply({ ...base, conversation: { agent_active: false, agent_handed_off_at: '2026-06-12T17:24:11Z' } })
    expect(r.reply).toBe(true)
    expect(r.rearm).toBe(true)
  })
  it('stays handed off inside the cooldown window', () => {
    const r = shouldAgentReply({ ...base, conversation: { agent_active: false, agent_handed_off_at: '2026-06-13T08:00:00Z' } })
    expect(r).toEqual({ reply: false, reason: 'handed_off' })
  })
  it('a manual agent-off (no handoff timestamp) never auto-re-engages', () => {
    const r = shouldAgentReply({ ...base, conversation: { agent_active: false, agent_handed_off_at: null } })
    expect(r).toEqual({ reply: false, reason: 'handed_off' })
  })
  it('an active conversation never carries the rearm flag', () => {
    const r = shouldAgentReply({ ...base, conversation: { agent_active: true } })
    expect(r).toEqual({ reply: true, reason: 'ok' })
  })
})

describe('autoVerifyContactId', () => {
  const base = { trusted: true, conversationContactId: 'c1', matches: [{ id: 'c1' }] }
  it('verifies a trusted channel with a single agreeing phone match', () => {
    expect(autoVerifyContactId(base)).toBe('c1')
  })
  it('returns null on untrusted channels (Instagram)', () => {
    expect(autoVerifyContactId({ ...base, trusted: false })).toBeNull()
  })
  it('returns null when the conversation has no linked contact', () => {
    expect(autoVerifyContactId({ ...base, conversationContactId: null })).toBeNull()
  })
  it('returns null when the number matches more than one contact', () => {
    expect(autoVerifyContactId({ ...base, matches: [{ id: 'c1' }, { id: 'c2' }] })).toBeNull()
  })
  it('returns null when the single match is a different contact than the thread is linked to', () => {
    expect(autoVerifyContactId({ ...base, matches: [{ id: 'c2' }] })).toBeNull()
  })
  it('returns null on empty/missing matches', () => {
    expect(autoVerifyContactId({ ...base, matches: [] })).toBeNull()
    expect(autoVerifyContactId({ ...base, matches: null })).toBeNull()
  })
})

describe('isVerificationFresh', () => {
  const now = new Date('2026-06-01T12:00:00Z')
  it('is fresh within the TTL window', () => {
    expect(isVerificationFresh('2026-05-20T12:00:00Z', now)).toBe(true) // 12 days
  })
  it('is stale beyond the TTL window', () => {
    expect(isVerificationFresh('2026-04-01T12:00:00Z', now)).toBe(false) // ~61 days
  })
  it('treats missing / unparseable timestamps as not verified', () => {
    expect(isVerificationFresh(null, now)).toBe(false)
    expect(isVerificationFresh(undefined, now)).toBe(false)
    expect(isVerificationFresh('not-a-date', now)).toBe(false)
  })
  it('honours a custom ttl', () => {
    expect(isVerificationFresh('2026-06-01T11:59:00Z', now, 60_000)).toBe(false) // 1 min old, 60s ttl
    expect(isVerificationFresh('2026-06-01T11:59:40Z', now, 60_000)).toBe(true)  // 20s old
  })
})
