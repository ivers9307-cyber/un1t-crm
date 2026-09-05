// CANCEL-FORM.5 — the customer confirmation after staff decide a pause /
// cancellation: which text, on which channel, and never a throw.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn(async () => ({ messageId: 'pm' })) }))
vi.mock('@/lib/agent/notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ sent: true })),
  DEFAULT_APPROVAL_DECLINE_TEXT: "Sorry, we couldn't complete that request this time. The team will be in touch to help.",
}))
vi.mock('@/lib/whatsapp', () => ({ sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.t' })) }))

import { outcomeMessageText, formatEndDate, sendMembershipOutcomeMessage } from './confirm.js'
import { CANCELLATION_FORM_DEFAULTS } from './defaults.js'
import { sendTransactionalEmail } from '@/lib/postmark'
import { sendAgentThreadMessage } from '@/lib/agent/notify'
import { sendTemplateMessage } from '@/lib/whatsapp'

const copy = { ...CANCELLATION_FORM_DEFAULTS }
const contact = { id: 'c1', first_name: 'Aoife', name: 'Aoife Byrne', email: 'a@example.com', email_status: 'active' }

beforeEach(() => vi.clearAllMocks())

describe('formatEndDate', () => {
  it('renders an ISO day as a long Irish date and tolerates junk', () => {
    expect(formatEndDate('2026-10-05')).toBe('5 October 2026')
    expect(formatEndDate(null)).toBe('')
    expect(formatEndDate('soon')).toBe('soon')
  })
})

describe('outcomeMessageText', () => {
  const vars = { first_name: 'Aoife', end_date: '5 October 2026', start_date: '10 September 2026' }
  it('picks the cancel / pause / saved / decline text by kind + status', () => {
    expect(outcomeMessageText({ kind: 'cancellation', finalStatus: 'actioned', copy, vars, declineTemplate: null }))
      .toBe('Hi Aoife, we have received your cancellation and your membership will end on 5 October 2026. Thanks for training with us, you are welcome back any time.')
    expect(outcomeMessageText({ kind: 'cancellation', finalStatus: 'approved', copy, vars })).toContain('5 October 2026')
    expect(outcomeMessageText({ kind: 'pause', finalStatus: 'approved', copy, vars })).toBe('Hi Aoife, your membership pause from 10 September 2026 to 5 October 2026 is confirmed. See you when you are back.')
    expect(outcomeMessageText({ kind: 'cancellation', finalStatus: 'saved', copy, vars })).toBe('Hi Aoife, thanks for the chat. Your membership stays as it is. Any questions, just reply here.')
    expect(outcomeMessageText({ kind: 'cancellation', finalStatus: 'declined', copy, vars, declineTemplate: 'Custom decline — sorry.' })).toBe('Custom decline, sorry.')
    expect(outcomeMessageText({ kind: 'cancellation', finalStatus: 'declined', copy, vars })).toMatch(/^Sorry, we couldn't/)
    expect(outcomeMessageText({ kind: 'cancellation', finalStatus: 'failed', copy, vars })).toBeNull()
    expect(outcomeMessageText({ kind: 'class_booking', finalStatus: 'actioned', copy, vars })).toBeNull()
  })

  it('drops the "on {end_date}" clause when no date is known rather than printing a hole', () => {
    const t = outcomeMessageText({ kind: 'cancellation', finalStatus: 'approved', copy, vars: { first_name: 'Aoife', end_date: '' } })
    expect(t).toBe('Hi Aoife, we have received your cancellation and your membership will end as requested. Thanks for training with us, you are welcome back any time.')
  })
})

describe('sendMembershipOutcomeMessage', () => {
  const base = { id: 'r1', kind: 'cancellation', location_id: 'L1', channel: 'email', conversation_id: null, details: { requested_end_date: '2026-10-05' } }
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }), limit: () => Promise.resolve({ data: [], error: null }) }) }) }) }

  it('emails a form-delivered row with the cancel text and the Glofox date when known', async () => {
    const out = await sendMembershipOutcomeMessage(db, { row: base, finalStatus: 'actioned', endDate: '2026-10-07', contact, copy, locationName: 'UN1T Stillorgan' })
    expect(out).toMatchObject({ sent: true, channel: 'email' })
    const call = sendTransactionalEmail.mock.calls[0][0]
    expect(call).toMatchObject({ to: 'a@example.com', contactId: 'c1', locationId: 'L1', tag: 'cancellation_confirmation' })
    expect(call.htmlBody).toContain('7 October 2026')
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })

  it('refuses to email a bounced address and says so', async () => {
    const out = await sendMembershipOutcomeMessage(db, { row: base, finalStatus: 'approved', contact: { ...contact, email_status: 'bounced' }, copy })
    expect(out).toMatchObject({ sent: false, channel: 'email', reason: 'email_blocked' })
  })

  it('sends in-thread for a conversation row, and reports window_closed with no template', async () => {
    const threadRow = { ...base, channel: 'whatsapp', conversation_id: 'conv1' }
    const out = await sendMembershipOutcomeMessage(db, { row: threadRow, finalStatus: 'saved', contact, copy })
    expect(out).toMatchObject({ sent: true, channel: 'whatsapp' })
    expect(sendAgentThreadMessage).toHaveBeenCalledWith(db, expect.objectContaining({ channel: 'whatsapp', conversationId: 'conv1', text: expect.stringContaining('stays as it is') }))
    sendAgentThreadMessage.mockResolvedValueOnce({ sent: false, reason: 'window_closed' })
    const closed = await sendMembershipOutcomeMessage(db, { row: threadRow, finalStatus: 'approved', contact, copy })
    expect(closed).toMatchObject({ sent: false, channel: 'whatsapp', reason: 'window_closed' })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('falls back to the configured template when the window is closed', async () => {
    const threadRow = { ...base, channel: 'whatsapp', conversation_id: 'conv1' }
    sendAgentThreadMessage.mockResolvedValueOnce({ sent: false, reason: 'window_closed' })
    const tpl = { name: 'membership_cancellation_confirmed', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, your membership ends on {{2}}.' }] }
    const db2 = { from: (t) => ({ select: () => ({ eq: () => ({
      maybeSingle: () => Promise.resolve({ data: t === 'whatsapp_conversations' ? { wa_phone: '353871234567', contacts: { wa_phone: null } } : null, error: null }),
      eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: t === 'whatsapp_templates' ? [tpl] : [], error: null }) }) }),
    }) }) }) }
    const out = await sendMembershipOutcomeMessage(db2, { row: threadRow, finalStatus: 'actioned', endDate: '2026-10-05', contact, copy: { ...copy, confirmation_template_cancel: tpl.name } })
    expect(out).toMatchObject({ sent: true, channel: 'whatsapp', via: 'template' })
    expect(sendTemplateMessage).toHaveBeenCalledWith('353871234567', tpl.name, 'en', [{ type: 'body', parameters: [{ type: 'text', text: 'Aoife' }, { type: 'text', text: '5 October 2026' }] }], { locationId: 'L1' })
  })

  it('never throws: an unknown channel and a transport error both come back as not sent', async () => {
    expect(await sendMembershipOutcomeMessage(db, { row: { ...base, channel: null, conversation_id: null }, finalStatus: 'approved', contact, copy })).toMatchObject({ sent: false, reason: 'no_channel' })
    sendTransactionalEmail.mockRejectedValueOnce(new Error('boom'))
    expect(await sendMembershipOutcomeMessage(db, { row: base, finalStatus: 'approved', contact, copy })).toMatchObject({ sent: false, reason: 'send_error' })
    expect(await sendMembershipOutcomeMessage(db, { row: base, finalStatus: 'failed', contact, copy })).toMatchObject({ sent: false, reason: 'no_message' })
  })
})
