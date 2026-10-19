// FLOWACK.1 — a WhatsApp Flow booking is answered honestly: one
// acknowledgement on submit, then the real outcome (booked → a confirmation,
// review → a holding line with the staff card linked to the thread). Every
// send is best-effort: a failed notice is logged and never changes a booking.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/agent/notify', async (importOriginal) => ({
  ...(await importOriginal()),
  sendAgentThreadMessage: vi.fn(async () => ({ sent: true })),
}))
vi.mock('@/lib/agent/settings-resolve', () => ({
  resolveAgentSettings: vi.fn(async () => ({ ok: true, settings: {}, location: { id: 'loc1', timezone: 'Europe/Dublin' } })),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import {
  FLOW_SUBMISSION_BODY, findFlowThread, sendFlowSubmissionReply, notifyFlowBookingOutcome,
} from './booking-notice.js'
import { DEFAULT_FLOW_BOOKING_ACK_TEXT, DEFAULT_FLOW_BOOKING_HOLDING_TEXT } from '@/lib/agent/default-copy'
import { sendAgentThreadMessage } from '@/lib/agent/notify'
import { resolveAgentSettings } from '@/lib/agent/settings-resolve'
import { logError } from '@/lib/log'

// A recording double: whatsapp_messages answers the marker lookup; every
// update is recorded with its filters.
function makeDb({ markers = [], markerError = null, stampError = null, stampRows = [{ id: 'amr1' }] } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const ops = []
      const b = {}
      for (const m of ['select', 'eq', 'is', 'order', 'limit', 'in']) b[m] = (...a) => { ops.push([m, ...a]); return b }
      b.update = (patch) => { ops.push(['update', patch]); return b }
      b.then = (res, rej) => {
        calls.push({ table, ops })
        let out = { data: null, error: null }
        if (table === 'whatsapp_messages') out = { data: markerError ? null : markers, error: markerError }
        if (table === 'agent_membership_requests') out = { data: stampError ? null : stampRows, error: stampError }
        return Promise.resolve(out).then(res, rej)
      }
      return b
    },
  }
}

const REQUEST = {
  id: 'cbr1', location_id: 'loc1', contact_id: 'ct1', class_name: 'HIIT',
  starts_at: '2026-10-21T17:00:00.000Z', created_at: '2026-10-19T12:07:02.000Z',
}
const marker = (over = {}) => ({ conversation_id: 'conv1', created_at: '2026-10-19T12:07:01.000Z', ...over })

beforeEach(() => vi.clearAllMocks())

describe('findFlowThread', () => {
  it('finds the thread of the Flow submission that created the row', async () => {
    const db = makeDb({ markers: [marker()] })
    expect(await findFlowThread(db, REQUEST)).toEqual({ conversationId: 'conv1' })
    const q = db.calls.find((c) => c.table === 'whatsapp_messages').ops
    expect(q).toEqual(expect.arrayContaining([
      ['eq', 'contact_id', 'ct1'], ['eq', 'location_id', 'loc1'], ['eq', 'direction', 'inbound'],
      ['eq', 'message_type', 'interactive'], ['eq', 'body', FLOW_SUBMISSION_BODY],
    ]))
  })

  it('a website /start row (no Flow submission near it) is not a Flow request', async () => {
    expect(await findFlowThread(makeDb({ markers: [] }), REQUEST)).toBe(null)
    // An old Flow submission from weeks ago does not make today's web booking a Flow one.
    expect(await findFlowThread(makeDb({ markers: [marker({ created_at: '2026-09-01T10:00:00.000Z' })] }), REQUEST)).toBe(null)
  })

  it('an unreadable lookup is "not known to be a Flow request" (today\'s behaviour), never a throw', async () => {
    expect(await findFlowThread(makeDb({ markerError: { message: 'boom' } }), REQUEST)).toBe(null)
    expect(await findFlowThread({ from() { throw new Error('down') } }, REQUEST)).toBe(null)
  })

  it('no contact or no created_at: nothing to prove, null', async () => {
    expect(await findFlowThread(makeDb({ markers: [marker()] }), { ...REQUEST, contact_id: null })).toBe(null)
    expect(await findFlowThread(makeDb({ markers: [marker()] }), { ...REQUEST, created_at: null })).toBe(null)
  })
})

describe('sendFlowSubmissionReply', () => {
  it('class: ONE acknowledgement on the thread (the default), never a booking claim', async () => {
    const r = await sendFlowSubmissionReply(makeDb(), { conversationId: 'conv1', locationId: 'loc1', completion: { handled: true, kind: 'class' } })
    expect(r.sent).toBe(true)
    expect(sendAgentThreadMessage).toHaveBeenCalledTimes(1)
    expect(sendAgentThreadMessage).toHaveBeenCalledWith(expect.anything(), { channel: 'whatsapp', conversationId: 'conv1', text: DEFAULT_FLOW_BOOKING_ACK_TEXT })
    expect(DEFAULT_FLOW_BOOKING_ACK_TEXT).toBe("Got it, we're booking your spot now. You'll get a confirmation shortly.")
  })

  it('class: the operator\'s flow_booking_ack_text wins (em dashes scrubbed)', async () => {
    resolveAgentSettings.mockResolvedValueOnce({ ok: true, settings: { flow_booking_ack_text: 'On it — we will confirm soon.' }, location: { id: 'loc1', timezone: null } })
    await sendFlowSubmissionReply(makeDb(), { conversationId: 'conv1', locationId: 'loc1', completion: { handled: true, kind: 'class' } })
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toBe('On it, we will confirm soon.')
  })

  it('consult (booked on submit): the booking confirmation, with the slot on the studio clock', async () => {
    await sendFlowSubmissionReply(makeDb(), {
      conversationId: 'conv1', locationId: 'loc1',
      completion: { handled: true, kind: 'consult', date: '2026-10-21', startTime: '10:00' },
    })
    const { text } = sendAgentThreadMessage.mock.calls[0][1]
    expect(text).toMatch(/^Good news, you're booked in for your consultation, Wed, 21 Oct, 10:00\. See you there\.$/)
  })

  it('a failed send is logged structurally and returned, never thrown', async () => {
    sendAgentThreadMessage.mockResolvedValueOnce({ sent: false, reason: 'send_error' })
    const r = await sendFlowSubmissionReply(makeDb(), { conversationId: 'conv1', locationId: 'loc1', completion: { handled: true, kind: 'class' } })
    expect(r).toMatchObject({ sent: false, reason: 'send_error' })
    expect(logError).toHaveBeenCalledWith('flow-booking-notice', expect.any(String), expect.objectContaining({ conversationId: 'conv1', reason: 'send_error' }))

    sendAgentThreadMessage.mockRejectedValueOnce(new Error('meta down'))
    await expect(sendFlowSubmissionReply(makeDb(), { conversationId: 'conv1', locationId: 'loc1', completion: { handled: true, kind: 'class' } }))
      .resolves.toMatchObject({ sent: false })
  })

  it('unreadable settings: the defaults are sent', async () => {
    resolveAgentSettings.mockResolvedValueOnce({ ok: false, reason: 'read_failed' })
    await sendFlowSubmissionReply(makeDb(), { conversationId: 'conv1', locationId: 'loc1', completion: { handled: true, kind: 'class' } })
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toBe(DEFAULT_FLOW_BOOKING_ACK_TEXT)
  })
})

describe('notifyFlowBookingOutcome', () => {
  it('not a Flow request: sends nothing and stamps nothing', async () => {
    const db = makeDb({ markers: [] })
    const r = await notifyFlowBookingOutcome(db, REQUEST, { outcome: 'needs_review', approvalId: 'amr1' })
    expect(r).toMatchObject({ flow: false, sent: false })
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    expect(db.calls.some((c) => c.table === 'agent_membership_requests')).toBe(false)
  })

  it('booked: one confirmation on the thread (booking_confirmation_text default)', async () => {
    const r = await notifyFlowBookingOutcome(makeDb({ markers: [marker()] }), REQUEST, { outcome: 'booked', classTime: 'Wed, 21 Oct, 18:00' })
    expect(r).toMatchObject({ flow: true, sent: true })
    expect(sendAgentThreadMessage).toHaveBeenCalledTimes(1)
    expect(sendAgentThreadMessage.mock.calls[0][1]).toEqual({
      channel: 'whatsapp', conversationId: 'conv1', text: "Good news, you're booked in for HIIT, Wed, 21 Oct, 18:00. See you there.",
    })
  })

  it('booked with no label passed: labels the class on the studio clock', async () => {
    await notifyFlowBookingOutcome(makeDb({ markers: [marker()] }), REQUEST, { outcome: 'booked' })
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toBe("Good news, you're booked in for HIIT, Wed, 21 Oct, 18:00. See you there.")
  })

  it('needs_review: stamps the card with the thread (whatsapp) THEN sends the holding line', async () => {
    const db = makeDb({ markers: [marker()] })
    const r = await notifyFlowBookingOutcome(db, REQUEST, { outcome: 'needs_review', approvalId: 'amr1' })
    expect(r).toMatchObject({ flow: true, sent: true, stamped: true })
    const stamp = db.calls.find((c) => c.table === 'agent_membership_requests').ops
    expect(stamp).toEqual(expect.arrayContaining([
      ['update', { conversation_id: 'conv1', channel: 'whatsapp' }], ['eq', 'id', 'amr1'], ['is', 'conversation_id', null],
    ]))
    expect(sendAgentThreadMessage).toHaveBeenCalledWith(expect.anything(), { channel: 'whatsapp', conversationId: 'conv1', text: DEFAULT_FLOW_BOOKING_HOLDING_TEXT })
    expect(DEFAULT_FLOW_BOOKING_HOLDING_TEXT).toBe('Thanks, the team is confirming your class and will be in touch shortly.')
  })

  it('needs_review: the operator\'s flow_booking_holding_text wins', async () => {
    resolveAgentSettings.mockResolvedValueOnce({ ok: true, settings: { flow_booking_holding_text: 'The team will confirm your class shortly.' }, location: { id: 'loc1', timezone: null } })
    await notifyFlowBookingOutcome(makeDb({ markers: [marker()] }), REQUEST, { outcome: 'needs_review', approvalId: 'amr1' })
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toBe('The team will confirm your class shortly.')
  })

  it('a failed card stamp is logged and the holding line still goes', async () => {
    const db = makeDb({ markers: [marker()], stampError: { message: 'denied' } })
    const r = await notifyFlowBookingOutcome(db, REQUEST, { outcome: 'needs_review', approvalId: 'amr1' })
    expect(r).toMatchObject({ sent: true, stamped: false })
    expect(logError).toHaveBeenCalledWith('flow-booking-notice', expect.stringMatching(/card/), expect.objectContaining({ requestId: 'cbr1', approvalId: 'amr1' }))
  })

  it('failed with no card: the holding line goes and the missing card is logged at error', async () => {
    const r = await notifyFlowBookingOutcome(makeDb({ markers: [marker()] }), REQUEST, { outcome: 'failed' })
    expect(r).toMatchObject({ flow: true, sent: true })
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toBe(DEFAULT_FLOW_BOOKING_HOLDING_TEXT)
    expect(logError).toHaveBeenCalledWith('flow-booking-notice', expect.stringMatching(/no staff card/), expect.objectContaining({ requestId: 'cbr1' }))
  })

  it('a send failure or throw anywhere is logged and returned, never thrown', async () => {
    sendAgentThreadMessage.mockResolvedValueOnce({ sent: false, reason: 'window_closed' })
    await expect(notifyFlowBookingOutcome(makeDb({ markers: [marker()] }), REQUEST, { outcome: 'booked', classTime: 'x' }))
      .resolves.toMatchObject({ flow: true, sent: false, reason: 'window_closed' })
    expect(logError).toHaveBeenCalledWith('flow-booking-notice', expect.any(String), expect.objectContaining({ requestId: 'cbr1', reason: 'window_closed' }))

    sendAgentThreadMessage.mockRejectedValueOnce(new Error('boom'))
    await expect(notifyFlowBookingOutcome(makeDb({ markers: [marker()] }), REQUEST, { outcome: 'needs_review', approvalId: 'amr1' }))
      .resolves.toMatchObject({ sent: false })
  })
})
