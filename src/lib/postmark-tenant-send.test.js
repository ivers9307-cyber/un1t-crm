// INTEG-B3 — ZERO-BEHAVIOUR-CHANGE proof for the tenant send-path seam.
//
// The hard requirement: with NO tenant email domain (today's state), the
// X-Postmark-Server-Token header + the From are byte-identical to before
// this feature existed — for BOTH sendEmail and sendBatch. And when the
// resolver hands back a live tenant sender, the token + From come from it.
// resolveEmailSender is mocked so these are pure send-path assertions.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./tenant-email', () => ({ resolveEmailSender: vi.fn() }))
vi.mock('./supabase', () => ({ createServerClient: vi.fn(() => ({ __service: true })) }))

import { sendEmail, sendBatch } from './postmark.js'
import { resolveEmailSender } from './tenant-email.js'

const GLOBAL_TOKEN = 'global-server-token'
const GLOBAL_FROM = 'UN1T <hello@un1t.ie>'

let fetchSpy

function okSingle() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ MessageID: 'pm-1', To: 'a@x.ie', SubmittedAt: '2026-07-20T10:00:00Z' }),
  })
}
function okBatch() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, status: 200,
    json: async () => ([{ ErrorCode: 0, MessageID: 'pm-1' }]),
  })
}
const bodyOf = (call) => JSON.parse(call[1].body)
const tokenOf = (call) => call[1].headers['X-Postmark-Server-Token']

beforeEach(() => {
  vi.clearAllMocks()
  process.env.POSTMARK_API_KEY = GLOBAL_TOKEN
  process.env.POSTMARK_FROM_EMAIL = GLOBAL_FROM
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('sendEmail — zero behaviour change (no tenant)', () => {
  it('no locationId/sender → global token + global From, resolver NOT called', async () => {
    fetchSpy = okSingle()
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' })
    expect(resolveEmailSender).not.toHaveBeenCalled()
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe(GLOBAL_TOKEN)
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe(GLOBAL_FROM)
  })

  it('explicit `from` is preserved when there is no tenant', async () => {
    fetchSpy = okSingle()
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', from: 'Custom <c@x.com>' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('Custom <c@x.com>')
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe(GLOBAL_TOKEN)
  })

  it('a resolver that returns the global default (serverToken null) → byte-identical', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue({ serverToken: null, fromEmail: GLOBAL_FROM, fromName: null })
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1' })
    expect(resolveEmailSender).toHaveBeenCalledWith(expect.anything(), 'loc-1')
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe(GLOBAL_TOKEN)
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe(GLOBAL_FROM)
  })
})

describe('sendEmail — live tenant override', () => {
  it('locationId → resolver tenant token + From (name + email)', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue({ serverToken: 'tenant-tok', fromEmail: 'hi@mail.gymx.com', fromName: 'GymX' })
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1' })
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe('tenant-tok')
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('GymX <hi@mail.gymx.com>')
  })

  it('a pre-resolved `sender` bypasses the resolver and wins over `from`', async () => {
    fetchSpy = okSingle()
    await sendEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      from: 'Ignored <i@x.com>',
      sender: { serverToken: 'tenant-tok', fromEmail: 'hi@mail.gymx.com', fromName: null },
    })
    expect(resolveEmailSender).not.toHaveBeenCalled()
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe('tenant-tok')
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('hi@mail.gymx.com')
  })
})

describe('sendBatch — zero behaviour change + tenant override', () => {
  it('no options → global token + per-email global From, resolver NOT called', async () => {
    fetchSpy = okBatch()
    await sendBatch([{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' }])
    expect(resolveEmailSender).not.toHaveBeenCalled()
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe(GLOBAL_TOKEN)
    expect(bodyOf(fetchSpy.mock.calls[0])[0].From).toBe(GLOBAL_FROM)
  })

  it('per-email `from` preserved with no tenant', async () => {
    fetchSpy = okBatch()
    await sendBatch([{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', from: 'Camp <camp@x.com>' }])
    expect(bodyOf(fetchSpy.mock.calls[0])[0].From).toBe('Camp <camp@x.com>')
  })

  it('sender option → tenant token + tenant From for every email in the batch', async () => {
    fetchSpy = okBatch()
    await sendBatch(
      [{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', from: 'Camp <camp@x.com>' }],
      { sender: { serverToken: 'tenant-tok', fromEmail: 'hi@mail.gymx.com', fromName: 'GymX' } },
    )
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe('tenant-tok')
    expect(bodyOf(fetchSpy.mock.calls[0])[0].From).toBe('GymX <hi@mail.gymx.com>')
  })

  it('locationId option resolves once for the whole batch', async () => {
    fetchSpy = okBatch()
    resolveEmailSender.mockResolvedValue({ serverToken: 'tenant-tok', fromEmail: 'hi@mail.gymx.com', fromName: null })
    await sendBatch([{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' }], { locationId: 'loc-1' })
    expect(resolveEmailSender).toHaveBeenCalledTimes(1)
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe('tenant-tok')
  })
})
