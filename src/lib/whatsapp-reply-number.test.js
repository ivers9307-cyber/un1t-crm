// WAREPLYNUMBER.1 (C86) — a reply goes from the number the customer wrote to.
//
// The inbound webhook stamps whatsapp_conversations.whatsapp_number_id (mig
// 696) with the number that received the message. A reply into that thread
// (opts.replyInConversation on any whatsapp.js sender) resolves that number
// when it is still an active row AT the conversation's studio (or, at a studio
// with no number of its own, a same-organisation sibling's, WAHOMESTUDIO.1);
// otherwise the location default, exactly as before. A single-number studio sends from the
// same number either way. A template goes from the thread number only when it
// shares the default's WABA (templates are synced per studio from the
// default's account). A failed read in this layer is never a lost reply: it
// falls back to the default, logged. The real resolvers run against a fake DB.
// Fictional ids only: the repo is public.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { conversations: [], numbers: [], links: undefined, locations: [], faults: {}, reads: [], selects: undefined }
const reads = state.reads
vi.mock('./supabase', async () => {
  const { fakeWhatsAppDb } = await import('./whatsapp-numbers-fake-db.test-helpers.js')
  return { createServerClient: () => fakeWhatsAppDb(state) }
})
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const wa = await import('./whatsapp.js')
const { getConversationReplyConfig, getConversationNumberConfig, templateLocationIdFor, classifyInboundOwner } = await import('./whatsapp-config.js')
const { link } = await import('./whatsapp-numbers-fake-db.test-helpers.js')
const { isWhatsAppNumberMissing } = await import('./whatsapp-number-missing.js')
const { logWarn } = await import('./log')

const LOC = 'a0000000-0000-4000-8000-000000000001'
const LOC2 = 'a0000000-0000-4000-8000-000000000002'
const LOC3 = 'a0000000-0000-4000-8000-000000000003'
const CONV = 'c0000000-0000-4000-8000-000000000001'
const num = (id, extra = {}) => ({
  id, location_id: LOC, organization_id: 'ORG-1', label: id, phone_number_id: `PNI-${id}`, business_account_id: 'WABA-1', app_id: 'APP',
  access_token: `tok-${id}`, source: 'cloud_api', is_default: false, is_active: true, updated_at: '2026-09-01', ...extra,
})
const DEFAULT = num('n-default', { is_default: true })
const SECOND = num('n-second')
const conv = (whatsapp_number_id, extra = {}) => ({ id: CONV, location_id: LOC, whatsapp_number_id, ...extra })

let sentFrom
beforeEach(() => {
  vi.clearAllMocks()
  reads.length = 0
  state.conversations = []
  state.numbers = [DEFAULT, SECOND]
  state.links = undefined
  state.locations = [{ id: LOC, organization_id: 'ORG-1' }, { id: LOC2, organization_id: 'ORG-1' }, { id: LOC3, organization_id: 'ORG-2' }]
  state.faults = {}
  sentFrom = []
  globalThis.fetch = vi.fn(async (url) => {
    sentFrom.push(String(url).split('/')[4])
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OK' }], success: true }) }
  })
})

describe('getConversationReplyConfig', () => {
  it('a thread written to on the second number replies from it', async () => {
    state.conversations = [conv('n-second')]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-second')
  })

  it('a thread with no recorded number (every thread before 696, every single-number studio until it writes) uses the default', async () => {
    state.conversations = [conv(null)]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
  })

  it('a single-number studio replies from that number whether or not the thread recorded it', async () => {
    state.numbers = [DEFAULT]
    state.conversations = [conv('n-default')]
    const a = await getConversationReplyConfig(LOC, CONV)
    state.conversations = [conv(null)]
    const b = await getConversationReplyConfig(LOC, CONV)
    expect(a).toEqual(b)
  })

  it('a recorded number that was deactivated falls back to the default', async () => {
    state.numbers = [DEFAULT, { ...SECOND, is_active: false }]
    state.conversations = [conv('n-second')]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
  })

  it('a recorded number at ANOTHER studio is never used', async () => {
    state.numbers = [DEFAULT, { ...SECOND, location_id: LOC2 }]
    state.conversations = [conv('n-second')]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
  })

  it('a conversation at another studio than the caller named is not read as this one', async () => {
    state.conversations = [conv('n-second', { location_id: LOC2 })]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
  })

  it('a TEMPLATE goes from the thread number only when it shares the default number’s WABA', async () => {
    state.conversations = [conv('n-second')]
    expect((await getConversationReplyConfig(LOC, CONV, { template: true })).phoneNumberId).toBe('PNI-n-second')
    state.numbers = [DEFAULT, { ...SECOND, business_account_id: 'WABA-2' }]
    expect((await getConversationReplyConfig(LOC, CONV, { template: true })).phoneNumberId).toBe('PNI-n-default')
    state.numbers = [DEFAULT, { ...SECOND, business_account_id: null }]
    expect((await getConversationReplyConfig(LOC, CONV, { template: true })).phoneNumberId).toBe('PNI-n-default')
  })

  it('an unreadable conversation falls back to the default (a lost reply is worse), logged', async () => {
    state.conversations = [conv('n-second')]
    state.faults.whatsapp_conversations = { message: 'column whatsapp_conversations.whatsapp_number_id does not exist' }
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
    expect(logWarn).toHaveBeenCalledWith('wa-config', 'reply number unreadable; replying from the default number', { conversationId: CONV, err: 'column whatsapp_conversations.whatsapp_number_id does not exist' })
  })

  it('a studio with no number still refuses (WhatsAppNumberMissingError), as before', async () => {
    state.numbers = []
    state.conversations = [conv(null)]
    await expect(getConversationReplyConfig(LOC, CONV)).rejects.toSatisfy(isWhatsAppNumberMissing)
  })

  it('no conversation id: the default, with no conversation read', async () => {
    expect((await getConversationReplyConfig(LOC, null)).phoneNumberId).toBe('PNI-n-default')
    expect(reads).not.toContain('whatsapp_conversations')
  })
})

describe('WAHOMESTUDIO.1 — a number-less studio replies through a same-organisation sibling’s number', () => {
  // LOC owns DEFAULT and SECOND; LOC2 owns nothing.
  const hatchConv = (stamp) => conv(stamp, { location_id: LOC2 })

  it('a thread at a number-less studio stamped with a sibling’s number replies from it, templates too', async () => {
    state.conversations = [hatchConv('n-default')]
    expect((await getConversationReplyConfig(LOC2, CONV)).phoneNumberId).toBe('PNI-n-default')
    expect((await getConversationReplyConfig(LOC2, CONV, { template: true })).phoneNumberId).toBe('PNI-n-default')
  })

  it('a sibling stamp is ignored once the thread’s studio has a number of its own (Review Focus 1)', async () => {
    state.numbers = [DEFAULT, num('n-hatch', { location_id: LOC2, is_default: true })]
    state.conversations = [hatchConv('n-default')]
    expect((await getConversationReplyConfig(LOC2, CONV)).phoneNumberId).toBe('PNI-n-hatch')
  })

  it('a number in ANOTHER organisation is never used; the number-less studio still refuses', async () => {
    state.numbers = [num('n-foreign', { location_id: LOC3, organization_id: 'ORG-2', is_default: true })]
    state.conversations = [hatchConv('n-foreign')]
    expect(await getConversationNumberConfig(LOC2, CONV)).toBeNull()
    await expect(getConversationReplyConfig(LOC2, CONV)).rejects.toSatisfy(isWhatsAppNumberMissing)
  })

  it('an unreadable locations row is null (no sibling number), logged', async () => {
    state.conversations = [hatchConv('n-default')]
    state.faults.locations = { message: 'boom' }
    expect(await getConversationNumberConfig(LOC2, CONV)).toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })

  it('templateLocationIdFor names the number owner for a sibling stamp, else the thread’s studio', async () => {
    const { templateLocationIdFor } = await import('./whatsapp-config.js')
    state.conversations = [hatchConv('n-default')]
    expect(await templateLocationIdFor(LOC2, CONV)).toBe(LOC)
    state.conversations = [conv('n-second')]
    expect(await templateLocationIdFor(LOC, CONV)).toBe(LOC)
    expect(await templateLocationIdFor(LOC2, null)).toBe(LOC2)
  })
})

// WAORGNUMBER.1 (R2) — the thread's stamped number is used only while it is
// switched on at the thread's studio (location_whatsapp_numbers). The
// WAHOMESTUDIO.1 sibling clause stays, transitionally, for a studio with no
// number switched on at all.
describe('WAORGNUMBER.1 — the thread number must be switched on at the thread’s studio', () => {
  it('switched-off stamp is not used (Review Focus 1)', async () => {
    // LOC has DEFAULT switched on; the thread's stamp SECOND is active but was
    // switched off at LOC (still on at LOC2).
    state.links = [link(LOC, 'n-default', { is_default: true }), link(LOC2, 'n-second', { is_default: true })]
    state.conversations = [conv('n-second')]
    expect(await getConversationNumberConfig(LOC, CONV)).toBeNull()
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-default')
    expect((await getConversationReplyConfig(LOC, CONV, { template: true })).phoneNumberId).toBe('PNI-n-default')
  })

  it('a stamp switched on at the thread’s studio resolves FOR that studio, whatever its home', async () => {
    // Stillorgan's DEFAULT switched on at LOC2 too; a thread at LOC2 stamped with it.
    state.links = [link(LOC, 'n-default', { is_default: true }), link(LOC2, 'n-default', { is_default: true })]
    state.conversations = [conv('n-default', { location_id: LOC2 })]
    expect(await getConversationNumberConfig(LOC2, CONV)).toMatchObject({ id: 'n-default', locationId: LOC2, homeLocationId: LOC, viaSibling: false })
    expect((await getConversationReplyConfig(LOC2, CONV, { template: true })).phoneNumberId).toBe('PNI-n-default')
  })

  it('sibling clause applies only while the studio has no link rows', async () => {
    state.links = [link(LOC, 'n-default', { is_default: true }), link(LOC, 'n-second')]
    state.conversations = [conv('n-default', { location_id: LOC2 })]
    expect(await getConversationNumberConfig(LOC2, CONV)).toMatchObject({ id: 'n-default', locationId: LOC2, homeLocationId: LOC, viaSibling: true })
    expect((await getConversationReplyConfig(LOC2, CONV, { template: true })).phoneNumberId).toBe('PNI-n-default')
    // LOC2 gets a number of its own switched on: the sibling stamp is no longer used.
    state.numbers = [DEFAULT, SECOND, num('n-hatch', { location_id: LOC2 })]
    state.links = [link(LOC, 'n-default', { is_default: true }), link(LOC2, 'n-hatch', { is_default: true })]
    expect(await getConversationNumberConfig(LOC2, CONV)).toBeNull()
    expect((await getConversationReplyConfig(LOC2, CONV)).phoneNumberId).toBe('PNI-n-hatch')
  })

  it('a studio whose only link is to an inactive number is still number-less (the clause is unchanged)', async () => {
    state.numbers = [DEFAULT, num('n-hatch-off', { location_id: LOC2, is_active: false })]
    state.links = [link(LOC, 'n-default', { is_default: true }), link(LOC2, 'n-hatch-off', { is_default: true })]
    state.conversations = [conv('n-default', { location_id: LOC2 })]
    expect(await getConversationNumberConfig(LOC2, CONV)).toMatchObject({ id: 'n-default', viaSibling: true })
  })

  it('a number switched off at its own home studio is not used via the sibling clause', async () => {
    // LOC's only number was switched off at LOC (no link row at all), the thread
    // is still stamped with it: LOC no longer replies through it.
    state.links = []
    state.conversations = [conv('n-default')]
    expect(await getConversationNumberConfig(LOC, CONV)).toBeNull()
    await expect(getConversationReplyConfig(LOC, CONV)).rejects.toSatisfy(isWhatsAppNumberMissing)
    // A real sibling (another studio of the org, number home elsewhere) still can.
    state.conversations = [conv('n-default', { location_id: LOC2 })]
    expect(await getConversationNumberConfig(LOC2, CONV)).toMatchObject({ id: 'n-default', viaSibling: true, homeLocationId: LOC })
  })

  it('links stamped in the same instant resolve in a fixed order (number id ascending)', async () => {
    state.numbers = [DEFAULT, num('n-b'), num('n-a')]
    state.links = [link(LOC, 'n-b'), link(LOC, 'n-a')]
    expect((await getConversationReplyConfig(LOC, CONV)).phoneNumberId).toBe('PNI-n-a')
  })

  it('the own-number existence check reads no number columns (no access_token)', async () => {
    state.selects = []
    state.numbers = [DEFAULT]
    state.links = [link(LOC, 'n-default', { is_default: true })]
    state.conversations = [conv('n-default', { location_id: LOC2 })]
    expect(await getConversationNumberConfig(LOC2, CONV)).toMatchObject({ viaSibling: true })
    const linkSelects = state.selects.filter(([t]) => t === 'location_whatsapp_numbers').map(([, c]) => c)
    expect(linkSelects).toContain('is_default, created_at, whatsapp_numbers!inner(id)')
    state.selects = undefined
  })

  it('other organisation never', async () => {
    state.numbers = [num('n-foreign', { location_id: LOC3, organization_id: 'ORG-2' })]
    state.links = [link(LOC3, 'n-foreign', { is_default: true })]
    state.conversations = [conv('n-foreign', { location_id: LOC2 })]
    expect(await getConversationNumberConfig(LOC2, CONV)).toBeNull()
    await expect(getConversationReplyConfig(LOC2, CONV)).rejects.toSatisfy(isWhatsAppNumberMissing)
    // The org is judged on the NUMBER's organization_id, not its home studio's row.
    state.numbers = [num('n-moved', { location_id: LOC, organization_id: 'ORG-2' })]
    state.links = [link(LOC, 'n-moved', { is_default: true })]
    state.conversations = [conv('n-moved', { location_id: LOC2 })]
    expect(await getConversationNumberConfig(LOC2, CONV)).toBeNull()
  })

  it('templateLocationIdFor returns the number home only via sibling', async () => {
    // Via sibling: the number's home studio's templates.
    state.links = [link(LOC, 'n-default', { is_default: true })]
    state.conversations = [conv('n-default', { location_id: LOC2 })]
    expect(await templateLocationIdFor(LOC2, CONV)).toBe(LOC)
    // Switched on at LOC2: LOC2's own templates, though the number's home is LOC.
    state.links = [link(LOC, 'n-default', { is_default: true }), link(LOC2, 'n-default', { is_default: true })]
    expect(await templateLocationIdFor(LOC2, CONV)).toBe(LOC2)
    // No usable stamp: the thread's studio.
    state.conversations = [conv(null, { location_id: LOC2 })]
    expect(await templateLocationIdFor(LOC2, CONV)).toBe(LOC2)
  })
})

describe('whatsapp.js senders honour opts.replyInConversation', () => {
  it('text, interactive, flow, cta, carousel, media, reaction and typing go from the thread number', async () => {
    state.conversations = [conv('n-second')]
    const o = { locationId: LOC, replyInConversation: CONV }
    await wa.sendTextMessage('+353000000000', 'hi', o)
    await wa.sendInteractiveOptions('+353000000000', 'pick', ['a', 'b'], o)
    await wa.sendFlowMessage('+353000000000', { ...o, flowId: 'f1', flowToken: 't' })
    await wa.sendCtaUrlMessage('+353000000000', { bodyText: 'b', buttonText: 'Go', url: 'https://x.test' }, o)
    await wa.sendMediaCarousel('+353000000000', { bodyText: 'b', cards: [{ image_url: 'https://x.test/a.jpg' }, { image_url: 'https://x.test/b.jpg' }] }, o)
    await wa.sendMediaMessage('+353000000000', 'image', 'https://x.test/a.jpg', 'c', o)
    await wa.sendReaction('+353000000000', 'wamid.1', '👍', o)
    await wa.sendTypingIndicator('wamid.1', o)
    expect(sentFrom).toEqual(Array(8).fill('PNI-n-second'))
  })

  it('a template from the thread number when the WABA matches, else the default', async () => {
    state.conversations = [conv('n-second')]
    await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC, replyInConversation: CONV })
    state.numbers = [DEFAULT, { ...SECOND, business_account_id: 'WABA-2' }]
    await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC, replyInConversation: CONV })
    expect(sentFrom).toEqual(['PNI-n-second', 'PNI-n-default'])
  })

  it('without the option nothing changes: the default number, no conversation read', async () => {
    state.conversations = [conv('n-second')]
    await wa.sendTextMessage('+353000000000', 'hi', { locationId: LOC })
    expect(sentFrom).toEqual(['PNI-n-default'])
    expect(reads).not.toContain('whatsapp_conversations')
  })

  it('an explicit config still wins over everything', async () => {
    state.conversations = [conv('n-second')]
    await wa.sendTextMessage('+353000000000', 'hi', { locationId: LOC, replyInConversation: CONV, config: { token: 't', phoneNumberId: 'PNI-explicit' } })
    expect(sentFrom).toEqual(['PNI-explicit'])
  })
})

// WAORGNUMBER.2 (R5) — Meta sends a template only from a number on its own
// WABA. A studio can have numbers on two accounts switched on; the template
// row's business_account_id picks the number (Review Focus 2).
describe('WAORGNUMBER.2 — template sends pick the number by the template’s WABA', () => {
  const ON_WABA_2 = num('n-waba2', { business_account_id: 'WABA-2' })

  it('template send at a two-WABA studio goes from the template’s WABA', async () => {
    state.numbers = [DEFAULT, ON_WABA_2]
    await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC, businessAccountId: 'WABA-2' })
    await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC, businessAccountId: 'WABA-1' })
    // A row with no WABA recorded keeps the default, as before.
    await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC })
    expect(sentFrom).toEqual(['PNI-n-waba2', 'PNI-n-default', 'PNI-n-default'])
  })

  it('in a thread: the thread number when it is on the template’s WABA, else the studio’s number on it', async () => {
    state.numbers = [DEFAULT, SECOND, ON_WABA_2]
    state.conversations = [conv('n-second')]
    const o = { locationId: LOC, replyInConversation: CONV }
    await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { ...o, businessAccountId: 'WABA-1' })
    await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { ...o, businessAccountId: 'WABA-2' })
    expect(sentFrom).toEqual(['PNI-n-second', 'PNI-n-waba2'])
  })

  it('a thread on WABA-2 with no default on it still sends a WABA-2 template from the thread', async () => {
    state.numbers = [DEFAULT, ON_WABA_2]
    state.conversations = [conv('n-waba2')]
    await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC, replyInConversation: CONV, businessAccountId: 'WABA-2' })
    expect(sentFrom).toEqual(['PNI-n-waba2'])
  })

  it('no number on the template’s WABA switched on at the studio → typed refusal, Meta never called', async () => {
    state.numbers = [DEFAULT, { ...ON_WABA_2, location_id: LOC2 }]
    const err = await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC, businessAccountId: 'WABA-2' }).catch((e) => e)
    expect(isWhatsAppNumberMissing(err)).toBe(true)
    expect(err.locationId).toBe(LOC)
    state.conversations = [conv('n-default')]
    const err2 = await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC, replyInConversation: CONV, businessAccountId: 'WABA-2' }).catch((e) => e)
    expect(isWhatsAppNumberMissing(err2)).toBe(true)
    expect(sentFrom).toEqual([])
  })

  it('a number on that WABA switched off at the studio is not used', async () => {
    state.numbers = [DEFAULT, ON_WABA_2]
    state.links = [link(LOC, 'n-default', { is_default: true })]
    const err = await wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], { locationId: LOC, businessAccountId: 'WABA-2' }).catch((e) => e)
    expect(isWhatsAppNumberMissing(err)).toBe(true)
    expect(sentFrom).toEqual([])
  })

  it('pickTemplateConfig: thread on the WABA, else default on it, else null (resolve by WABA); no WABA → pickReplyConfig', async () => {
    const { pickTemplateConfig } = await import('./whatsapp-config.js')
    const thread = { id: 't', businessAccountId: 'WABA-2' }
    const dflt = { id: 'd', businessAccountId: 'WABA-1' }
    expect(pickTemplateConfig(thread, dflt, 'WABA-2')).toBe(thread)
    expect(pickTemplateConfig(thread, dflt, 'WABA-1')).toBe(dflt)
    expect(pickTemplateConfig(null, dflt, 'WABA-1')).toBe(dflt)
    expect(pickTemplateConfig(thread, dflt, 'WABA-3')).toBeNull()
    expect(pickTemplateConfig(thread, dflt, null)).toBe(dflt)
  })
})

describe('classifyInboundOwner names the receiving number', () => {
  it('returns the owning row id with the location', () => {
    expect(classifyInboundOwner({ source: 'db', id: 'n-second', locationId: LOC, homeLocationId: LOC })).toEqual({ action: 'location', locationId: LOC, numberId: 'n-second' })
    expect(classifyInboundOwner(null)).toEqual({ action: 'drop' })
  })
})

// The contact composer reads the thread number on its own (it already holds
// the checked default), so this half never throws and never resolves by
// location.
describe('getConversationNumberConfig', () => {
  it('the thread number while active at this studio; null otherwise; null on a failed read', async () => {
    state.conversations = [conv('n-second')]
    expect((await getConversationNumberConfig(LOC, CONV))?.id).toBe('n-second')
    expect(await getConversationNumberConfig(LOC2, CONV)).toBeNull()
    state.numbers = [DEFAULT, num('n-second', { is_active: false })]
    expect(await getConversationNumberConfig(LOC, CONV)).toBeNull()
    state.conversations = [conv(null)]
    expect(await getConversationNumberConfig(LOC, CONV)).toBeNull()
    state.conversations = [conv('n-second')]
    state.faults.location_whatsapp_numbers = { message: 'boom' }
    await expect(getConversationNumberConfig(LOC, CONV)).resolves.toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })
})
