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
  DEFAULT_HOLDING_MESSAGE,
} from './core'
import { HANDOFF_PREFIX } from './prompt'

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
  it('no reply for non-text messages', () => {
    expect(shouldAgentReply({ ...base, message: { type: 'image', body: '' } }))
      .toEqual({ reply: false, reason: 'unsupported_type' })
  })
  it('no reply for empty text', () => {
    expect(shouldAgentReply({ ...base, message: { type: 'text', body: '   ' } }))
      .toEqual({ reply: false, reason: 'empty' })
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
})
