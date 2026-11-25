// INBOXFOLLOW.3 — the staff-thread nudge: pure classifier first (every row of
// the order, the boundaries at exactly Q and Q + 24 h), then the runner on a
// fake database. The "do not send" cases matter most.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))
const { sendTextMessage, sendTemplateMessage, anthropicMessages, logError } = vi.hoisted(() => ({
  sendTextMessage: vi.fn(), sendTemplateMessage: vi.fn(), anthropicMessages: vi.fn(), logError: vi.fn(),
}))
vi.mock('@/lib/whatsapp', () => ({ sendTextMessage, sendTemplateMessage, headerComponentFor: () => null }))
vi.mock('@/lib/radar-outreach', () => ({ extractTemplateBody: () => ({ varCount: 0 }) }))
vi.mock('@/lib/anthropic', () => ({ anthropicMessages }))
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logError, logWarn: vi.fn() }))

import { runAgentFollowups } from './followups'
import { classifyStaffNudge, runStaffThreadNudges, STAFF_NUDGE_DEFAULTS } from './staff-nudges'
import { WhatsAppNumberMissingError } from '@/lib/whatsapp-number-missing'
import { createFakeDb } from '../../../tests/helpers/fake-db'

const H = 3600_000
const NOW = Date.UTC(2026, 10, 25, 13, 0, 0) // 13:00 Dublin
const Q = 48

describe('STAFF_NUDGE_DEFAULTS', () => {
  it('is off, 48 hours, no template', () => {
    expect(STAFF_NUDGE_DEFAULTS).toEqual({ quiet_after_hours: 48, nudge_enabled: false, template_name: null })
  })
})

describe('classifyStaffNudge', () => {
  // A thread that is due, inside the band, with every gate open and the window shut.
  const base = (o = {}) => ({
    staffWaitingSinceMs: NOW - (Q + 2) * H, snoozedUntilMs: null, windowExpiresAtMs: NOW - 30 * H, nowMs: NOW, quietHours: Q,
    hasContact: true, optedOut: false, blocked: false, marketingConsent: true, sensitiveIntent: false,
    templateReady: true, daytimeOpen: true, capReached: false, customerRepliedSince: false, ...o,
  })
  const run = (o) => classifyStaffNudge(base(o))

  it('sends the template outside the window with consent', () => expect(run()).toEqual({ action: 'template' }))
  it('sends free text while the window is open', () => expect(run({ windowExpiresAtMs: NOW + H })).toEqual({ action: 'freeform' }))
  it('a window that closes exactly now is closed', () => expect(run({ windowExpiresAtMs: NOW }).action).toBe('template'))

  it('waits before the quiet period (not_due) and is due at exactly Q', () => {
    expect(run({ staffWaitingSinceMs: NOW - Q * H + 1 })).toEqual({ action: 'wait', reason: 'not_due' })
    expect(run({ staffWaitingSinceMs: NOW - Q * H }).action).toBe('template')
    expect(run({ staffWaitingSinceMs: null })).toEqual({ action: 'wait', reason: 'not_due' })
  })
  it('not_due beats everything else', () => {
    expect(run({ staffWaitingSinceMs: NOW - H, customerRepliedSince: true, optedOut: true })).toEqual({ action: 'wait', reason: 'not_due' })
  })
  it('skips when the customer wrote since the coach (checked right after not_due)', () => {
    expect(run({ customerRepliedSince: true })).toEqual({ action: 'skip', reason: 'customer_replied' })
    expect(run({ customerRepliedSince: true, snoozedUntilMs: NOW + H }).reason).toBe('customer_replied')
  })
  it('waits while snoozed', () => {
    expect(run({ snoozedUntilMs: NOW + H })).toEqual({ action: 'wait', reason: 'snoozed' })
  })
  it('a snooze that has ended but ran past the quiet point is skipped (after_snooze)', () => {
    const waiting = NOW - (Q + 2) * H
    expect(run({ snoozedUntilMs: waiting + Q * H + 1 })).toEqual({ action: 'skip', reason: 'after_snooze' })
    expect(run({ snoozedUntilMs: waiting + Q * H }).action).toBe('template') // ended exactly at the quiet point: not past it
  })
  it('is still sendable at exactly Q + 24 h and expired one millisecond later', () => {
    expect(run({ staffWaitingSinceMs: NOW - (Q + 24) * H }).action).toBe('template')
    expect(run({ staffWaitingSinceMs: NOW - (Q + 24) * H - 1 })).toEqual({ action: 'skip', reason: 'expired' })
  })
  it('skips a thread with no contact, an opted-out contact, a blocked thread', () => {
    expect(run({ hasContact: false })).toEqual({ action: 'skip', reason: 'no_contact' })
    expect(run({ optedOut: true })).toEqual({ action: 'skip', reason: 'opted_out' })
    expect(run({ blocked: true })).toEqual({ action: 'skip', reason: 'blocked' })
  })
  it('skips a customer who asked to pause or cancel', () => {
    expect(run({ sensitiveIntent: true })).toEqual({ action: 'skip', reason: 'sensitive_intent' })
    expect(run({ sensitiveIntent: true, windowExpiresAtMs: NOW + H }).reason).toBe('sensitive_intent')
  })
  it('waits outside daytime or at the daily cap', () => {
    expect(run({ daytimeOpen: false })).toEqual({ action: 'wait', reason: 'quiet_hours' })
    expect(run({ capReached: true })).toEqual({ action: 'wait', reason: 'daily_cap' })
  })
  it('without a template, outside the window, skips (no_template); free text needs none', () => {
    expect(run({ templateReady: false })).toEqual({ action: 'skip', reason: 'no_template' })
    expect(run({ templateReady: false, windowExpiresAtMs: NOW + H }).action).toBe('freeform')
  })
  it('the template is consent-gated, the in-window free text is not', () => {
    expect(run({ marketingConsent: false })).toEqual({ action: 'skip', reason: 'no_consent' })
    expect(run({ marketingConsent: false, windowExpiresAtMs: NOW + H }).action).toBe('freeform')
  })
  it('follows the brief order: contact before intent before gates before window', () => {
    expect(run({ hasContact: false, optedOut: true, sensitiveIntent: true }).reason).toBe('no_contact')
    expect(run({ sensitiveIntent: true, daytimeOpen: false }).reason).toBe('sensitive_intent')
    expect(run({ daytimeOpen: false, capReached: true }).reason).toBe('quiet_hours')
    expect(run({ capReached: true, windowExpiresAtMs: NOW + H }).reason).toBe('daily_cap')
  })
})

// ── the runner ──────────────────────────────────────────────────────

const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const NUMBER = 'b0000000-0000-0000-0000-0000000000b1'
const CONTACT = 'c0000000-0000-0000-0000-0000000000c1'
const iso = (ms) => new Date(ms).toISOString()
const STAFF_THREADS = { quiet_after_hours: Q, nudge_enabled: true, template_name: 'staff_check_in' }

const agentSettings = (o = {}) => ({ enabled: true, followups: { staff_threads: STAFF_THREADS }, ...o })

function conv(o = {}) {
  return {
    id: 'conv-1', location_id: LOC, contact_id: CONTACT, wa_phone: '353870000000', agent_active: true,
    last_message_at: iso(NOW - 50 * H), last_message_direction: 'outbound', is_blocked: false,
    staff_owned_since: iso(NOW - 51 * H), staff_waiting_since: iso(NOW - 50 * H), window_expires_at: iso(NOW - 26 * H),
    staff_nudged_at: null, staff_nudge_outcome: null, resolved_at: null, agent_paused_at: null, snoozed_until: null, agent_handed_off_at: null,
    ...o,
  }
}
const inbound = (o = {}) => ({ id: 'm-in', conversation_id: 'conv-1', direction: 'inbound', source: 'api', body: 'Can I do Tuesdays?', created_at: iso(NOW - 60 * H), ...o })
const coach = (o = {}) => ({ id: 'm-co', conversation_id: 'conv-1', direction: 'outbound', source: 'api', sent_by: 'd0000000-0000-0000-0000-0000000000d1', body: 'Yes, 6pm works. Does that suit?', created_at: iso(NOW - 50 * H), ...o })

function world({ settings = agentSettings(), convs = [conv()], messages = [inbound(), coach()], contact = {}, consent = true, number = true, template = true, requests = [], errors = {} } = {}) {
  return createFakeDb({
    errors,
    tables: {
      locations: [{ id: LOC, name: 'Stillorgan', organization_id: null, membership_source: 'none', active: true, timezone: 'Europe/Dublin', settings: { customer_agent: settings } }],
      whatsapp_numbers: number ? [{ id: NUMBER, location_id: LOC, is_active: true }] : [],
      location_whatsapp_numbers: number ? [{ location_id: LOC, whatsapp_number_id: NUMBER }] : [],
      contacts: [{ id: CONTACT, first_name: 'Jane', name: 'Jane Murphy', wa_phone: '353870000000', phone: '353870000000', wa_status: 'active', ...contact }],
      contact_location_preferences: consent ? [{ contact_id: CONTACT, location_id: LOC, whatsapp_marketing: true }] : [],
      whatsapp_templates: template ? [{ location_id: LOC, name: 'staff_check_in', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, checking in about {{2}}' }] }] : [],
      whatsapp_conversations: convs,
      whatsapp_messages: messages,
      agent_membership_requests: requests,
    },
  })
}
const row = (db, id = 'conv-1') => db.tables.whatsapp_conversations.find((c) => c.id === id)
const agentMessages = (db) => db.tables.whatsapp_messages.filter((m) => m.source === 'agent')
const sentNothing = () => { expect(sendTextMessage).not.toHaveBeenCalled(); expect(sendTemplateMessage).not.toHaveBeenCalled() }
const untouched = (db) => { const r = row(db); expect(r.staff_nudged_at).toBe(null); expect(r.staff_nudge_outcome).toBe(null) }
const run = (db, nowMs = NOW) => runStaffThreadNudges(db, { nowMs })

let warn
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  vi.clearAllMocks()
  sendTextMessage.mockResolvedValue({ messageId: 'wamid.text' })
  sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.tpl' })
  anthropicMessages.mockResolvedValue({ res: { ok: true }, data: { content: [{ type: 'text', text: 'Hi Jane, just checking you saw the 6pm slot?' }] } })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())
const warned = (reason) => warn.mock.calls.some((c) => String(c[1]).includes(`"reason":"staff_nudge_${reason}"`))

describe('runStaffThreadNudges — studio gates', () => {
  it('a studio with nudges off sends nothing and stamps nothing', async () => {
    const db = world({ settings: agentSettings({ followups: { enabled: true, staff_threads: { ...STAFF_THREADS, nudge_enabled: false } } }) })
    expect(await run(db)).toMatchObject({ freeform: 0, templates: 0 })
    sentNothing(); untouched(db)
  })
  it('a studio with no staff_threads at all is off', async () => {
    const db = world({ settings: { enabled: true, followups: { enabled: true } } })
    await run(db); sentNothing(); untouched(db)
  })
  it('agent neither enabled nor in test mode sends nothing', async () => {
    const db = world({ settings: agentSettings({ enabled: false, test_mode: false }) })
    await run(db); sentNothing(); untouched(db)
  })
  it('test mode honours the phone allowlist: a stranger waits unstamped', async () => {
    const db = world({ settings: agentSettings({ enabled: false, test_mode: true, test_phones: ['353870009999'] }), convs: [conv({ window_expires_at: iso(NOW + H) })] })
    const out = await run(db)
    expect(out.freeform + out.templates + out.skipped).toBe(0); sentNothing(); untouched(db)
  })
  it('test mode reaches an allow-listed thread behind 150 older strangers, and never stamps the strangers', async () => {
    const strangers = Array.from({ length: 150 }, (_, n) => conv({ id: `s-${n}`, contact_id: `e${String(n).padStart(7, '0')}-0000-0000-0000-000000000000`, wa_phone: '353879999999', window_expires_at: iso(NOW + H), staff_waiting_since: iso(NOW - (300 - n) * H) }))
    const mine = conv({ id: 'mine', window_expires_at: iso(NOW + H), staff_waiting_since: iso(NOW - 50 * H) })
    const db = world({
      settings: agentSettings({ enabled: false, test_mode: true, test_phones: ['353870000000'] }), convs: [...strangers, mine],
      messages: [inbound({ conversation_id: 'mine' }), coach({ conversation_id: 'mine' })],
    })
    db.tables.contacts.push(...strangers.map((c) => ({ id: c.contact_id, first_name: 'X', name: 'X', wa_phone: '353879999999', phone: '353879999999', wa_status: 'active' })))
    const out = await run(db)
    expect(out.freeform).toBe(1)
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
    expect(sendTextMessage.mock.calls[0][0]).toBe('353870000000')
    expect(row(db, 'mine').staff_nudge_outcome).toBe('sent')
    expect(db.tables.whatsapp_conversations.filter((c) => c.id.startsWith('s-') && (c.staff_nudged_at || c.staff_nudge_outcome))).toHaveLength(0)
  })
  it('test mode sends to an allow-listed phone', async () => {
    const db = world({ settings: agentSettings({ enabled: false, test_mode: true, test_phones: ['353870000000'] }), convs: [conv({ window_expires_at: iso(NOW + H) })] })
    expect((await run(db)).freeform).toBe(1)
  })
  it('outside the studio daytime nothing is sent or stamped (the thread waits)', async () => {
    const db = world()
    await run(db, Date.UTC(2026, 10, 25, 22, 0, 0)); sentNothing(); untouched(db)
  })
  it('the operator quiet hours hold it back too', async () => {
    const db = world({ settings: agentSettings({ quiet_hours: { start: '12:00', end: '14:00', tz: 'Europe/Dublin' } }) })
    await run(db); sentNothing(); untouched(db)
  })
  it('a studio with no WhatsApp number sends nothing and stamps nothing', async () => {
    const db = world({ number: false })
    await run(db); sentNothing(); untouched(db)
    expect(warned('no_number')).toBe(true) // a studio gate, logged with the locationId
  })
  it('does not need followups.enabled (that switch is Mia\'s own-thread ladder)', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })] })
    expect(db.tables.locations[0].settings.customer_agent.followups.enabled).toBeUndefined()
    expect((await run(db)).freeform).toBe(1)
  })
})

describe('runStaffThreadNudges — what is sent', () => {
  it('free text in the window: records Mia\'s message, stamps sent, leaves the coach\'s ownership alone', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })] })
    const before = { ...row(db) }
    const out = await run(db)
    expect(out).toMatchObject({ freeform: 1, templates: 0, skipped: 0 })
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
    expect(sendTextMessage.mock.calls[0][0]).toBe('353870000000')
    const [msg] = agentMessages(db)
    expect(msg).toMatchObject({ direction: 'outbound', source: 'agent', message_type: 'text', conversation_id: 'conv-1', body: 'Hi Jane, just checking you saw the 6pm slot?' })
    const after = row(db)
    expect(after.staff_nudge_outcome).toBe('sent')
    expect(after.staff_nudged_at).toBe(iso(NOW))
    for (const k of ['staff_owned_since', 'staff_waiting_since', 'agent_active', 'agent_handed_off_at', 'resolved_at', 'snoozed_until', 'agent_followup_stage', 'agent_followup_sent_at']) {
      expect(after[k], k).toEqual(before[k])
    }
  })
  it('the model is told it is a coach\'s thread', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })] })
    await run(db)
    const msgs = anthropicMessages.mock.calls[0][0].messages
    expect(msgs.at(-1).content).toMatch(/coach/)
    expect(msgs.at(-1).content).toMatch(/SKIP/)
  })
  it('a template outside the window, with the studio\'s consent', async () => {
    const db = world()
    expect(await run(db)).toMatchObject({ freeform: 0, templates: 1 })
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(sendTemplateMessage.mock.calls[0][1]).toBe('staff_check_in')
    expect(agentMessages(db)[0]).toMatchObject({ message_type: 'template', template_name: 'staff_check_in', source: 'agent' })
    expect(row(db).staff_nudge_outcome).toBe('sent')
    expect(row(db).staff_waiting_since).toBe(iso(NOW - 50 * H))
  })
  it('no marketing consent at this studio: skipped:no_consent, nothing sent', async () => {
    const db = world({ consent: false })
    await run(db); sentNothing()
    expect(row(db)).toMatchObject({ staff_nudge_outcome: 'skipped:no_consent', staff_nudged_at: iso(NOW) })
  })
  it('no template set and the window shut: skipped:no_template', async () => {
    const db = world({ settings: agentSettings({ followups: { staff_threads: { ...STAFF_THREADS, template_name: null } } }) })
    await run(db); sentNothing()
    expect(row(db).staff_nudge_outcome).toBe('skipped:no_template')
  })
  it('a template that is not approved: skipped:no_template, nothing sent', async () => {
    const db = world({ template: false })
    await run(db); sentNothing()
    expect(row(db).staff_nudge_outcome).toBe('skipped:no_template')
  })
  it('the model says SKIP: skipped:model_skip, nothing sent', async () => {
    anthropicMessages.mockResolvedValue({ res: { ok: true }, data: { content: [{ type: 'text', text: '[[SKIP]]' }] } })
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })] })
    await run(db); sentNothing()
    expect(row(db).staff_nudge_outcome).toBe('skipped:model_skip')
    expect(agentMessages(db)).toHaveLength(0)
  })
  it('a model that fails is skipped:compose_failed, nothing sent', async () => {
    anthropicMessages.mockResolvedValue({ res: { ok: false, status: 500 }, data: {} })
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })] })
    await run(db); sentNothing()
    expect(row(db).staff_nudge_outcome).toBe('skipped:compose_failed')
  })
  it('a send that returns no message id is skipped:send_failed and records nothing', async () => {
    sendTextMessage.mockResolvedValue({})
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })] })
    await run(db)
    expect(row(db).staff_nudge_outcome).toBe('skipped:send_failed')
    expect(agentMessages(db)).toHaveLength(0)
  })
  it('a send that throws is skipped:send_failed; a missing number is skipped:no_number', async () => {
    sendTemplateMessage.mockRejectedValueOnce(new Error('meta down'))
    const db = world()
    await run(db)
    expect(row(db).staff_nudge_outcome).toBe('skipped:send_failed')
    sendTemplateMessage.mockRejectedValueOnce(new WhatsAppNumberMissingError(LOC))
    const db2 = world()
    await run(db2)
    expect(row(db2).staff_nudge_outcome).toBe('skipped:no_number')
  })
})

describe('runStaffThreadNudges — threads that must not be nudged', () => {
  it.each([
    ['paused', { agent_paused_at: iso(NOW - H) }],
    ['resolved', { resolved_at: iso(NOW - H) }],
    ['snoozed', { snoozed_until: iso(NOW + H) }],
    ['not yet quiet long enough', { staff_waiting_since: iso(NOW - 10 * H) }],
    ['already nudged', { staff_nudged_at: iso(NOW - 2 * H), staff_nudge_outcome: 'sent' }],
    ['not waiting on the customer', { staff_waiting_since: null }],
    ['not a coach\'s thread', { staff_owned_since: null }],
  ])('a %s thread is never a candidate: nothing sent, nothing changed', async (_n, patch) => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H), ...patch })] })
    const before = { ...row(db) }
    await run(db); sentNothing()
    expect(row(db)).toEqual(before)
  })

  it.each([
    ['blocked', { is_blocked: true }, {}, 'blocked'],
    ['no contact', { contact_id: null }, {}, 'no_contact'],
    ['opted out', {}, { wa_status: 'opted_out' }, 'opted_out'],
    ['past Q + 24 h', { staff_waiting_since: iso(NOW - (Q + 25) * H) }, {}, 'expired'],
  ])('%s: stamps skipped:<reason> and sends nothing', async (_n, convPatch, contactPatch, reason) => {
    const messages = [inbound({ created_at: iso(NOW - 90 * H) }), coach({ created_at: iso(NOW - (Q + 25) * H) })]
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H), ...convPatch })], contact: contactPatch, messages })
    await run(db); sentNothing()
    expect(row(db)).toMatchObject({ staff_nudge_outcome: `skipped:${reason}`, staff_nudged_at: iso(NOW) })
  })

  it('a snooze that ended past the quiet point is skipped, not nudged late', async () => {
    const waiting = NOW - 50 * H
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H), snoozed_until: iso(waiting + Q * H + 60_000) })] })
    await run(db); sentNothing()
    expect(row(db).staff_nudge_outcome).toBe('skipped:after_snooze')
  })

  it('a customer who asked to pause is never chased', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })], requests: [{ id: 'r1', location_id: LOC, conversation_id: 'conv-1', kind: 'pause', status: 'pending', created_at: iso(NOW - 59 * H) }] })
    await run(db); sentNothing()
    expect(row(db).staff_nudge_outcome).toBe('skipped:sensitive_intent')
  })

  it('a customer message newer than the coach\'s wait (an inbound that raced a send) is never nudged', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })], messages: [inbound(), coach(), inbound({ id: 'm-in2', body: 'Actually yes!', created_at: iso(NOW - 49 * H) })] })
    await run(db); sentNothing()
    expect(row(db).staff_nudge_outcome).toBe('skipped:customer_replied')
  })

  it('a thread that cannot be read waits unstamped', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })], errors: { whatsapp_messages: { select: { message: 'boom' } } } })
    const out = await run(db)
    expect(out.waiting).toBe(1); sentNothing(); untouched(db)
  })

  it('a consent read that fails waits unstamped (never read as "no consent")', async () => {
    const db = world({ errors: { contact_location_preferences: { select: { message: 'boom' } } } })
    await run(db); sentNothing(); untouched(db)
  })
})

describe('runStaffThreadNudges — claim before send', () => {
  it('a thread whose staff_waiting_since changed between read and claim gets no send', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })] })
    const from = db.from.bind(db)
    db.from = (table) => {
      // the customer replies (inboundPatch) after the tick read the thread, before the claim
      if (table === 'whatsapp_messages') row(db).staff_waiting_since = null
      return from(table)
    }
    const out = await run(db)
    sentNothing()
    expect(out).toMatchObject({ freeform: 0, templates: 0 })
    expect(row(db).staff_nudged_at).toBe(null)
    expect(warned('claim_lost')).toBe(true)
  })
  it('claims with the conditional filters and .select()', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })] })
    await run(db)
    const claim = db.calls.find((c) => c.op === 'update' && c.filters.some((f) => f.column === 'staff_waiting_since'))
    const cols = claim.filters.map((f) => `${f.column}:${f.op}`)
    expect(cols).toEqual(expect.arrayContaining(['id:eq', 'staff_nudged_at:is', 'staff_waiting_since:eq', 'resolved_at:is', 'agent_paused_at:is']))
  })
  it('a claim that cannot be written sends nothing', async () => {
    const db = world({ errors: { whatsapp_conversations: { update: { message: 'boom' } } } })
    await run(db); sentNothing()
  })
  it('a second tick in the same quiet spell never sends a second nudge', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })] })
    await run(db)
    await run(db, NOW + 15 * 60_000)
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
  })
  it('an in-flight claim blocks a concurrent tick', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H), staff_nudged_at: iso(NOW - 60_000), staff_nudge_outcome: 'sending' })] })
    await run(db); sentNothing()
  })
  it('a claim stuck at sending for over 30 minutes becomes skipped:send_failed', async () => {
    const db = world({ convs: [conv({ staff_nudged_at: iso(NOW - 31 * 60_000), staff_nudge_outcome: 'sending' })] })
    const out = await run(db)
    expect(row(db).staff_nudge_outcome).toBe('skipped:send_failed')
    expect(out.released).toBe(1)
    sentNothing()
  })
  it('a claim younger than 30 minutes is left alone', async () => {
    const db = world({ convs: [conv({ staff_nudged_at: iso(NOW - 10 * 60_000), staff_nudge_outcome: 'sending' })] })
    await run(db)
    expect(row(db).staff_nudge_outcome).toBe('sending')
  })
  it('a reply that clears the claim mid-send is not overwritten by the outcome', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })] })
    sendTextMessage.mockImplementation(async () => {
      Object.assign(row(db), { staff_nudged_at: null, staff_nudge_outcome: null, staff_waiting_since: null }) // inboundPatch
      return { messageId: 'wamid.text' }
    })
    const out = await run(db)
    expect(out.freeform).toBe(1) // the customer has the message
    expect(out.outcomeWriteFailed).toBe(1)
    expect(row(db).staff_nudge_outcome).toBe(null)
    expect(logError).toHaveBeenCalledWith('staff-nudges', expect.stringContaining('outcome not written'), expect.anything())
  })
})

describe('runStaffThreadNudges — daily cap', () => {
  it('is shared with the ladder and makes the rest wait, unstamped', async () => {
    const convs = [1, 2, 3].map((n) => conv({ id: `conv-${n}`, window_expires_at: iso(NOW + H), staff_waiting_since: iso(NOW - (50 + n) * H) }))
    const messages = convs.flatMap((c) => [inbound({ id: `i${c.id}`, conversation_id: c.id }), coach({ id: `c${c.id}`, conversation_id: c.id, created_at: c.staff_waiting_since })])
    // one ladder send already counted today (agent_followup_sent_at), cap 2
    convs.push(conv({ id: 'ladder', staff_owned_since: null, staff_waiting_since: null, agent_followup_sent_at: iso(NOW - 2 * H) }))
    const db = world({ settings: agentSettings({ followups: { daily_cap: 2, staff_threads: STAFF_THREADS } }), convs, messages })
    const out = await run(db)
    expect(out.freeform).toBe(1)
    expect(out.waiting).toBe(2)
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
    expect(row(db, 'conv-3').staff_nudge_outcome).toBe('sent') // oldest first
    expect(row(db, 'conv-2').staff_nudged_at).toBe(null)
    expect(row(db, 'conv-1').staff_nudged_at).toBe(null)
    expect(warned('daily_cap')).toBe(true)
  })
  it('counts nudges already sent today', async () => {
    const convs = [conv({ window_expires_at: iso(NOW + H) }), conv({ id: 'done', staff_nudged_at: iso(NOW - 3 * H), staff_nudge_outcome: 'sent' })]
    const db = world({ settings: agentSettings({ followups: { daily_cap: 1, staff_threads: STAFF_THREADS } }), convs })
    const out = await run(db)
    expect(out.freeform).toBe(0); sentNothing(); untouched(db)
  })
})

describe('the daily cap is one cap for the ladder and the staff nudge', () => {
  const ladderWorld = (cap, staffSent) => {
    const ladder = { id: 'ladder', location_id: LOC, contact_id: CONTACT, wa_phone: '353870000000', agent_active: true, agent_followup_stage: 0, last_message_at: iso(NOW - 5 * H), last_message_direction: 'outbound', window_expires_at: iso(NOW + 10 * H) }
    const sent = staffSent.map((id) => conv({ id, staff_nudged_at: iso(NOW - 2 * H), staff_nudge_outcome: 'sent' }))
    const messages = [inbound({ conversation_id: 'ladder', created_at: iso(NOW - 6 * H) }), { id: 'a1', conversation_id: 'ladder', direction: 'outbound', source: 'agent', body: 'Want a class?', created_at: iso(NOW - 5 * H) }]
    return world({ settings: agentSettings({ followups: { enabled: true, daily_cap: cap, nudge_after_hours: 3, staff_threads: STAFF_THREADS } }), convs: [ladder, ...sent], messages })
  }
  it('staff nudges that fill the cap make the ladder wait', async () => {
    const db = ladderWorld(1, ['s1'])
    const out = await runAgentFollowups(db, { nowMs: NOW })
    expect(out.nudges).toBe(0); sentNothing()
  })
  it('with room under the cap the same ladder thread is nudged', async () => {
    const db = ladderWorld(2, ['s1'])
    const out = await runAgentFollowups(db, { nowMs: NOW })
    expect(out.nudges).toBe(1)
  })
  it('an unreadable staff count makes the staff runner send nothing', async () => {
    const db = world({ convs: [conv({ window_expires_at: iso(NOW + H) })], errors: { whatsapp_conversations: { select: { message: 'boom' } } } })
    await run(db); sentNothing(); untouched(db)
  })
})
