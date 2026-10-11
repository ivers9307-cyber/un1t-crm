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

import { sendEmail, sendBatch, sendTransactionalEmail, sendMarketingEmail } from './postmark.js'
import { withRequestedFrom } from './from-address.js'
import { resolveEmailSender } from './tenant-email.js'
import { createServerClient } from './supabase.js'

const GLOBAL_TOKEN = 'global-server-token'
// W1.E2 — the env holds a bare platform ADDRESS; with no resolved sender the
// wire From is PLATFORM_NAME on it. Nothing in this file spells a gym.
const PLATFORM_ADDRESS = 'hello@platform.test'
const GLOBAL_FROM = 'Repset <hello@platform.test>'

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
  process.env.POSTMARK_FROM_EMAIL = PLATFORM_ADDRESS
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

  it('a pre-resolved `sender` bypasses the resolver; its ADDRESS wins over `from`, the caller display name stays (W1.E2)', async () => {
    fetchSpy = okSingle()
    await sendEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      from: 'Kept <i@x.com>',
      sender: { serverToken: 'tenant-tok', fromEmail: 'hi@mail.gymx.com', fromName: null },
    })
    expect(resolveEmailSender).not.toHaveBeenCalled()
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe('tenant-tok')
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('Kept <hi@mail.gymx.com>')
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

  it('sender option → tenant token + tenant ADDRESS for every email in the batch; a per-email display name is kept (W1.E2)', async () => {
    fetchSpy = okBatch()
    await sendBatch(
      [
        { to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', from: 'Camp <camp@x.com>' },
        { to: 'b@x.ie', subject: 'S', htmlBody: '<p>x</p>' },
      ],
      { sender: { serverToken: 'tenant-tok', fromEmail: 'hi@mail.gymx.com', fromName: 'GymX' } },
    )
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe('tenant-tok')
    expect(bodyOf(fetchSpy.mock.calls[0])[0].From).toBe('Camp <hi@mail.gymx.com>')
    expect(bodyOf(fetchSpy.mock.calls[0])[1].From).toBe('GymX <hi@mail.gymx.com>')
  })

  it('locationId option resolves once for the whole batch', async () => {
    fetchSpy = okBatch()
    resolveEmailSender.mockResolvedValue({ serverToken: 'tenant-tok', fromEmail: 'hi@mail.gymx.com', fromName: null })
    await sendBatch([{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' }], { locationId: 'loc-1' })
    expect(resolveEmailSender).toHaveBeenCalledTimes(1)
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe('tenant-tok')
  })
})

// ── W1.E2 — the PRE-DOMAIN sender on the wire ───────────────────────────────
// No tenant token: the GLOBAL server, the platform ADDRESS, the tenant's brand
// as display name, the location's address as Reply-To.
const PRE_DOMAIN = { serverToken: null, fromEmail: PLATFORM_ADDRESS, fromName: 'Gym A', replyTo: 'hi@gyma.ie' }

describe('W1.E2 — pre-domain sends go out as "{Brand} <platform address>" with the location reply-to', () => {

  it('sendEmail with locationId and no tenant token puts `Gym A <hello@platform.test>` and ReplyTo hi@gyma.ie on the wire, on the global server', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue(PRE_DOMAIN)
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1' })
    const wire = bodyOf(fetchSpy.mock.calls[0])
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe(GLOBAL_TOKEN)
    expect(wire.From).toBe('Gym A <hello@platform.test>')
    expect(wire.ReplyTo).toBe('hi@gyma.ie')
  })

  it('an explicit replyTo beats the resolved one; a resolved null leaves ReplyTo unset', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue(PRE_DOMAIN)
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1', replyTo: 'ops@gyma.ie' })
    expect(bodyOf(fetchSpy.mock.calls[0]).ReplyTo).toBe('ops@gyma.ie')

    resolveEmailSender.mockResolvedValue({ ...PRE_DOMAIN, replyTo: null })
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1' })
    expect(bodyOf(fetchSpy.mock.calls[1]).ReplyTo).toBeUndefined()
  })

  it('a caller `fromName` (campaign/sequence From name) rides the platform address, never its own', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue(PRE_DOMAIN)
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1', fromName: 'Garrett at Gym A' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('Garrett at Gym A <hello@platform.test>')
  })

  it('an explicit full `from` keeps its display name but takes the platform ADDRESS pre-domain', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue(PRE_DOMAIN)
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1', from: 'Garrett <ops@gyma.ie>' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('Garrett <hello@platform.test>')
  })

  it('sendEmail without locationId and without an explicit from uses `Repset <hello@platform.test>`', async () => {
    fetchSpy = okSingle()
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('Repset <hello@platform.test>')
    expect(bodyOf(fetchSpy.mock.calls[0]).ReplyTo).toBeUndefined()
  })

  it('sendBatch: every email carries the brand From + location ReplyTo; a per-email fromName/replyTo wins', async () => {
    fetchSpy = okBatch()
    await sendBatch(
      [
        { to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' },
        { to: 'b@x.ie', subject: 'S', htmlBody: '<p>x</p>', fromName: 'Garrett at Gym A', replyTo: 'garrett@gyma.ie' },
      ],
      { sender: PRE_DOMAIN },
    )
    const wire = bodyOf(fetchSpy.mock.calls[0])
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe(GLOBAL_TOKEN)
    expect(wire[0].From).toBe('Gym A <hello@platform.test>')
    expect(wire[0].ReplyTo).toBe('hi@gyma.ie')
    expect(wire[1].From).toBe('Garrett at Gym A <hello@platform.test>')
    expect(wire[1].ReplyTo).toBe('garrett@gyma.ie')
  })

  it('no code path produces the old literal sender: the env is the only address', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue(PRE_DOMAIN)
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1' })
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' })
    for (const call of fetchSpy.mock.calls) {
      expect(JSON.stringify(bodyOf(call))).not.toContain('un1t.ie')
      expect(JSON.stringify(bodyOf(call))).not.toContain('UN1T')
    }
  })

  // sendTransactionalEmail resolves the sender itself and hands it to
  // sendEmail as `sender` — this pins that hand-off (dropping it to `null`
  // left every other test green).
  it('sendTransactionalEmail with locationId: brand From + location ReplyTo on the wire; email_sends.from_email is the BARE platform address', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue(PRE_DOMAIN)
    const insert = vi.fn().mockResolvedValue({ error: null })
    createServerClient.mockReturnValue({ from: vi.fn(() => ({ insert })) })
    await sendTransactionalEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1', contactId: 'c-1' })
    expect(resolveEmailSender).toHaveBeenCalledWith(expect.anything(), 'loc-1')
    const wire = bodyOf(fetchSpy.mock.calls[0])
    expect(wire.From).toBe('Gym A <hello@platform.test>')
    expect(wire.ReplyTo).toBe('hi@gyma.ie')
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe(GLOBAL_TOKEN)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][0]).toMatchObject({ from_email: 'hello@platform.test', to_email: 'a@x.ie', location_id: 'loc-1' })
  })

  it('sendTransactionalEmail without a contactId: same wire, nothing logged', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue(PRE_DOMAIN)
    const insert = vi.fn()
    createServerClient.mockReturnValue({ from: vi.fn(() => ({ insert })) })
    await sendTransactionalEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('Gym A <hello@platform.test>')
    expect(bodyOf(fetchSpy.mock.calls[0]).ReplyTo).toBe('hi@gyma.ie')
    expect(insert).not.toHaveBeenCalled()
  })

  it('env unset and nothing resolved → no From on the wire (Postmark refuses loudly), never a literal', async () => {
    fetchSpy = okSingle()
    delete process.env.POSTMARK_FROM_EMAIL
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBeUndefined()
    expect(JSON.stringify(bodyOf(fetchSpy.mock.calls[0]))).not.toContain('un1t')
  })
})

// ── FROMDOMAIN — any address on the org's VERIFIED domain, never another ──
describe('FROMDOMAIN — a requested From address rides the wire only on the verified domain', () => {
  const LIVE_UN1T = {
    serverToken: 'tenant-srv-tok',
    fromEmail: 'hello@un1tdublin.com',
    fromName: 'UN1T',
    replyTo: 'hi@un1tdublin.com',
    sendingDomain: 'un1tdublin.com',
  }
  const PRE = { serverToken: null, fromEmail: PLATFORM_ADDRESS, fromName: 'Gym A', replyTo: 'hi@gyma.ie' }

  function marketingDb() {
    const insert = vi.fn().mockResolvedValue({ error: null })
    createServerClient.mockReturnValue({ from: vi.fn(() => ({ insert })) })
    return insert
  }
  const send = (extra) => sendMarketingEmail({
    to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', locationId: 'loc-1', contactId: 'c-1',
    unsubscribeUrl: 'https://crm.test/unsubscribe/tok', ...extra,
  })

  it('sendBatch (the campaign path): "Garrett Ivers <garrett@un1tdublin.com>" on the tenant server', async () => {
    fetchSpy = okBatch()
    await sendBatch([{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', fromName: 'Garrett Ivers' }],
      { sender: withRequestedFrom(LIVE_UN1T, 'garrett@un1tdublin.com') })
    expect(bodyOf(fetchSpy.mock.calls[0])[0].From).toBe('Garrett Ivers <garrett@un1tdublin.com>')
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe('tenant-srv-tok')
  })

  it('sendMarketingEmail (the sequence path): requested address on the verified domain → wire From + email_sends.from_email', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue({ ...LIVE_UN1T })
    const insert = marketingDb()
    await send({ fromName: 'Garrett Ivers', fromEmail: 'garrett@un1tdublin.com' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('Garrett Ivers <garrett@un1tdublin.com>')
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe('tenant-srv-tok')
    expect(insert.mock.calls[0][0].from_email).toBe('garrett@un1tdublin.com')
  })

  it('case-insensitive: Alex@UN1TDublin.com sends (and logs) as alex@un1tdublin.com', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue({ ...LIVE_UN1T })
    const insert = marketingDb()
    await send({ fromEmail: 'Alex@UN1TDublin.com' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('UN1T <alex@un1tdublin.com>')
    expect(insert.mock.calls[0][0].from_email).toBe('alex@un1tdublin.com')
  })

  it('another domain → the tenant fromEmail, and the requested address is nowhere on the wire', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue({ ...LIVE_UN1T })
    const insert = marketingDb()
    await send({ fromName: 'Garrett Ivers', fromEmail: 'x@other.com' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('Garrett Ivers <hello@un1tdublin.com>')
    expect(insert.mock.calls[0][0].from_email).toBe('hello@un1tdublin.com')
    expect(JSON.stringify(bodyOf(fetchSpy.mock.calls[0]))).not.toContain('other.com')
  })

  it('a subdomain of the verified domain → the tenant fromEmail', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue({ ...LIVE_UN1T })
    const insert = marketingDb()
    await send({ fromEmail: 'garrett@mail.un1tdublin.com' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('UN1T <hello@un1tdublin.com>')
    expect(insert.mock.calls[0][0].from_email).toBe('hello@un1tdublin.com')
  })

  it('no live tenant domain → the platform address regardless of the requested one, on the global server', async () => {
    fetchSpy = okSingle()
    resolveEmailSender.mockResolvedValue({ ...PRE })
    const insert = marketingDb()
    await send({ fromName: 'Garrett Ivers', fromEmail: 'garrett@un1tdublin.com' })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe('Garrett Ivers <hello@platform.test>')
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe(GLOBAL_TOKEN)
    expect(insert.mock.calls[0][0].from_email).toBe(PLATFORM_ADDRESS)
    expect(JSON.stringify(bodyOf(fetchSpy.mock.calls[0]))).not.toContain('garrett@')
  })
})
