import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/anthropic', () => ({ anthropicMessages: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T' })) }))
vi.mock('./settings-resolve', () => ({
  resolveAgentSettings: vi.fn(async (_db, id) => ({
    ok: true,
    location: { id, name: 'Studio', timezone: 'Europe/Dublin', membership_source: id === 'loc-hatch' ? 'un1t_online' : 'glofox' },
    settings: {},
  })),
}))

import { anthropicMessages } from '@/lib/anthropic'
import { logWarn } from '@/lib/log'
import { buildSuggestionInstruction, sanitizeSuggestion, composeApprovalSuggestion } from './approval-suggest.js'

describe('buildSuggestionInstruction', () => {
  it('includes the kind and outcome', () => {
    const instr = buildSuggestionInstruction('pause', 'approved', {})
    expect(instr).toMatch(/pause their membership/)
    expect(instr).toMatch(/approved/)
  })

  it('includes the customer first name when given', () => {
    const instr = buildSuggestionInstruction('cancellation', 'saved', { firstName: 'Aoife' })
    expect(instr).toMatch(/Aoife/)
  })

  it('includes the decision reason when given', () => {
    const instr = buildSuggestionInstruction('class_cancellation', 'approved', { reason: 'injured knee' })
    expect(instr).toMatch(/injured knee/)
  })

  it('includes membership status and next class when given', () => {
    const instr = buildSuggestionInstruction('class_booking', 'actioned', {
      membershipStatus: 'active',
      nextClassName: 'HYROX',
      nextClassTime: '2026-07-10T09:00:00.000Z',
    })
    expect(instr).toMatch(/active/)
    expect(instr).toMatch(/HYROX/)
    expect(instr).toMatch(/2026-07-10T09:00:00.000Z/)
  })

  it('omits optional context lines when absent', () => {
    const instr = buildSuggestionInstruction('pause', 'declined', {})
    expect(instr).not.toMatch(/Their stated reason/)
    expect(instr).not.toMatch(/Their first name/)
    expect(instr).not.toMatch(/next booked class/)
  })

  it('asks for a short, warm, first-person, ≤2 sentence follow-up with [[SKIP]] escape', () => {
    const instr = buildSuggestionInstruction('cancellation', 'declined', {})
    expect(instr).toMatch(/first person/)
    expect(instr).toMatch(/≤2 sentences/)
    expect(instr).toMatch(/\[\[SKIP\]\]/)
    expect(instr).toMatch(/No placeholders or brackets/)
  })

  it('handles an unknown kind/outcome gracefully (falls back to the raw string)', () => {
    const instr = buildSuggestionInstruction('mystery_kind', 'mystery_outcome', {})
    expect(instr).toMatch(/mystery_kind/)
    expect(instr).toMatch(/mystery_outcome/)
  })
})

describe('sanitizeSuggestion', () => {
  it('returns null for falsy input', () => {
    expect(sanitizeSuggestion(null)).toBeNull()
    expect(sanitizeSuggestion(undefined)).toBeNull()
    expect(sanitizeSuggestion('')).toBeNull()
  })

  it('returns null for whitespace-only text', () => {
    expect(sanitizeSuggestion('   \n\t  ')).toBeNull()
  })

  it('returns null when the text contains [[SKIP]]', () => {
    expect(sanitizeSuggestion('[[SKIP]]')).toBeNull()
    expect(sanitizeSuggestion('  [[SKIP]]  ')).toBeNull()
    expect(sanitizeSuggestion('Some preamble [[SKIP]] trailing')).toBeNull()
    // …and its near misses, matched as leniently as the other sentinels.
    expect(sanitizeSuggestion('[[skip]]')).toBeNull()
    expect(sanitizeSuggestion('[[ SKIP ]]')).toBeNull()
  })

  // HUMANIZE.1 — staff click this straight into the composer and usually send
  // it unedited, so it gets the same deterministic treatment as a live reply.
  it('scrubs em dashes the model emitted', () => {
    expect(sanitizeSuggestion("All sorted — you're back on for Saturday."))
      .toBe("All sorted, you're back on for Saturday.")
  })
  it('strips a stray [[OPTIONS]] line instead of prefilling the raw sentinel', () => {
    expect(sanitizeSuggestion('Want another slot?\n[[OPTIONS]] Yes | No'))
      .toBe('Want another slot?')
  })
  it('returns null for a suggestion that is really a handoff', () => {
    expect(sanitizeSuggestion('[[HANDOFF]] wants to talk to a person')).toBeNull()
    expect(sanitizeSuggestion('Sorry about that. [[HANDOFF]] upset customer')).toBeNull()
  })

  it('trims surrounding whitespace on an otherwise good message', () => {
    expect(sanitizeSuggestion('  Great news! See you soon.  ')).toBe('Great news! See you soon.')
  })

  it('strips surrounding straight quotes when the whole message is quoted', () => {
    expect(sanitizeSuggestion('"Great news! See you soon."')).toBe('Great news! See you soon.')
  })

  it('strips surrounding curly quotes when the whole message is quoted', () => {
    expect(sanitizeSuggestion('“Great news! See you soon.”')).toBe('Great news! See you soon.')
  })

  it('does not strip quotes that are not surrounding the entire message', () => {
    const text = 'She said "hi" to me'
    expect(sanitizeSuggestion(text)).toBe(text)
  })

  it('caps at 500 chars, truncating at the last word boundary', () => {
    const long = 'word '.repeat(200).trim() // 999 chars
    const out = sanitizeSuggestion(long)
    expect(out.length).toBeLessThanOrEqual(500)
    // truncated at a word boundary — no partial word at the end
    expect(long.startsWith(out)).toBe(true)
    expect(out.endsWith(' ')).toBe(false)
  })

  it('leaves short text under the cap untouched', () => {
    expect(sanitizeSuggestion('Short and sweet.')).toBe('Short and sweet.')
  })
})

// MIAHATCH.5 Task 18 — a un1t.online card (details.provider) is followed up
// with the member's un1t.online membership and next class, read from the
// mirror through slice 1's shapers; never Glofox's columns, never a live
// un1t.online call. A Glofox card reads exactly what it always read.
describe('composeApprovalSuggestion — un1t.online vs Glofox context', () => {
  const futureIso = new Date(Date.now() + 2 * 86_400_000).toISOString()
  const pastIso = new Date(Date.now() - 86_400_000).toISOString()

  function recordingDb(answers = {}) {
    const reads = []
    return {
      reads,
      from(table) {
        const read = { table, select: null }
        reads.push(read)
        const result = () => answers[table] ?? { data: [], error: null }
        const b = {
          select: (cols) => { read.select = cols; return b },
          eq: () => b, in: () => b, gte: () => b, order: () => b, limit: () => b,
          maybeSingle: async () => result(),
          then: (ok, bad) => Promise.resolve(result()).then(ok, bad),
        }
        return b
      },
    }
  }
  const instruction = () => anthropicMessages.mock.calls[0][0].messages.at(-1).content
  const BASE = { id: 'r1', status: 'actioned', decision_note: null, contact_id: 'c-1', channel: 'whatsapp', conversation_id: null }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = 'test-key'
    anthropicMessages.mockResolvedValue({ res: { ok: true, status: 200 }, data: { content: [{ type: 'text', text: 'See you there.' }] } })
  })

  it('approval-suggest uses un1t context for un1t cards', async () => {
    const db = recordingDb({
      contacts: { data: { name: 'Member Test', first_name: 'Member', un1t_user_id: 'u-contact' }, error: null },
      un1t_subscriptions: { data: [{ status: 'active', product_title: 'Unlimited', current_period_end: futureIso }], error: null },
      un1t_bookings: { data: [{ un1t_id: 'bk-1', event_id: 'ev-1', status: 'booked' }, { un1t_id: 'bk-0', event_id: 'ev-0', status: 'booked' }], error: null },
      un1t_events: { data: [{ un1t_id: 'ev-1', title: 'RALLY', starts_at: futureIso, status: 'scheduled' }, { un1t_id: 'ev-0', title: 'OLD', starts_at: pastIso, status: 'scheduled' }], error: null },
    })
    const r = await composeApprovalSuggestion(db, { ...BASE, location_id: 'loc-hatch', kind: 'class_booking', details: { provider: 'un1t_online', origin: 'mia', un1t_user_id: 'u-1' } })
    expect(r).toEqual({ text: 'See you there.' })
    const selects = db.reads.map((x) => x.select || '').join(' | ')
    expect(selects).not.toMatch(/glofox_membership_state|recent_bookings|glofox_membership_plan/)
    expect(db.reads.map((x) => x.table)).toEqual(expect.arrayContaining(['un1t_subscriptions', 'un1t_bookings', 'un1t_events']))
    expect(instruction()).toMatch(/Their first name is Member\./)
    expect(instruction()).toMatch(/Their membership is currently: active \(Unlimited\)\./)
    expect(instruction()).toMatch(/Their next booked class is RALLY on /)
    expect(instruction()).not.toMatch(/OLD/)
  })

  it('a un1t card with nothing live in the mirror states no membership and no class', async () => {
    const db = recordingDb({ contacts: { data: { first_name: 'Member', un1t_user_id: null }, error: null } })
    await composeApprovalSuggestion(db, { ...BASE, location_id: 'loc-hatch', kind: 'class_cancellation', details: { provider: 'un1t_online', un1t_user_id: 'u-1' } })
    expect(instruction()).not.toMatch(/membership is currently/)
    expect(instruction()).not.toMatch(/next booked class/)
  })

  it('an unreadable mirror leaves the context out (silent), never Glofox fields', async () => {
    const down = { data: null, error: { code: 'XX000', message: 'down' } }
    const db = recordingDb({
      contacts: { data: { first_name: 'Member' }, error: null },
      un1t_subscriptions: down, un1t_bookings: down,
    })
    const r = await composeApprovalSuggestion(db, { ...BASE, location_id: 'loc-hatch', kind: 'class_booking', details: { provider: 'un1t_online', un1t_user_id: 'u-1' } })
    expect(r).toEqual({ text: 'See you there.' })
    expect(instruction()).not.toMatch(/membership is currently|next booked class/)
    expect(logWarn).toHaveBeenCalledWith('mia-un1t', 'suggest membership read failed', expect.objectContaining({ locationId: 'loc-hatch', code: 'XX000' }))
  })

  it('Glofox fields for Glofox cards; no un1t mirror read', async () => {
    const db = recordingDb({
      contacts: { data: { first_name: 'Member', glofox_membership_state: 'ACTIVE', recent_bookings: [{ time_start: Math.floor(Date.now() / 1000) + 86_400, event_name: 'HYROX', status: 'BOOKED' }] }, error: null },
    })
    await composeApprovalSuggestion(db, { ...BASE, location_id: 'loc-stillorgan', kind: 'class_booking', details: { event_id: 'g-1' } })
    const contactsRead = db.reads.find((x) => x.table === 'contacts')
    expect(contactsRead.select).toBe('name, first_name, pipeline_stage_slug, glofox_membership_state, glofox_membership_plan, recent_bookings')
    expect(db.reads.some((x) => x.table.startsWith('un1t_'))).toBe(false)
    expect(instruction()).toMatch(/Their membership is currently: ACTIVE\./)
    expect(instruction()).toMatch(/Their next booked class is HYROX on /)
  })
})
