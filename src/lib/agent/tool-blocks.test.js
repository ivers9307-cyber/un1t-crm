// MIAHATCH.2 Task 3 — Mia's tool blocks at Hatch Street (un1t.online): the two
// provider-aware READ blocks, the pure block selector, refuseToolForTurn and
// the tagged ids. Production behaviour must not move: the Glofox and
// no-booking blocks are pinned to fixtures captured BEFORE this task.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  ALL_AGENT_TOOLS, CACHED_ACCOUNT_TOOLS, CACHED_NO_BOOKING_TOOLS,
  CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS, CACHED_UN1T_FULL_TOOLS, agentToolsFor,
} from './auto-reply'
import {
  UN1T_TOOL_DESCRIPTIONS, UN1T_DUAL_TOOL_DESCRIPTIONS, UN1T_FULL_TOOL_DESCRIPTIONS, UN1T_WRITE_TOOL_NAMES, UN1T_PURCHASE_TOOL_NAMES,
  REQUEST_REFUND_TOOL, MOVE_CLASS_BOOKING_TOOL, deriveUn1tReadTools, deriveUn1tFullTools, selectToolBlock, withCacheBreakpoint,
} from './tool-blocks'
import { planTurnTools, resolveTurnPlan, turnForPlan } from './turn-studios'
import { logWarn } from '@/lib/log'
import { UN1T_ID_PREFIX, tagUn1tId, parseAgentId } from './studio-ids'
import { TOOL_NOT_AT_THIS_STUDIO, refuseToolForTurn, deriveNoBookingTools } from './tool-capability'
import { PURCHASE_TOOLS, PURCHASE_TOOL_NAMES, LIST_PURCHASE_OPTIONS_TOOL, SEND_PURCHASE_LINK_TOOL, CHECK_MY_PURCHASE_TOOL } from './purchase-tools'
import { executeAccountTool } from './account-tools'
import { executeBookingTool } from './booking-tools'
import { MEMBERSHIP_SOURCES } from '@/lib/membership/source'

vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn(), logError: vi.fn() }))

const FIX_DIR = path.join(__dirname, '__fixtures__')
const GLOFOX_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'glofox-agent-tools.fixture.json'), 'utf8'))
const NO_BOOKING_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'no-booking-agent-tools.fixture.json'), 'utf8'))

const STILLORGAN = 'a1000000-0000-0000-0000-000000000001'
const HATCH_ID = 'a1000000-0000-0000-0000-000000000002'
const hatch = { locationId: HATCH_ID, name: 'UN1T Hatch Street', providerKey: 'un1t_online', active: true, answerable: true, contactIds: ['c2'], un1tUserId: 'u1' }
const stillorgan = { locationId: STILLORGAN, name: 'UN1T Stillorgan', providerKey: 'glofox', active: true, answerable: true, contactIds: ['c1'], glofoxMemberId: 'g1' }
const un1t = MEMBERSHIP_SOURCES.un1t_online
const glofox = MEMBERSHIP_SOURCES.glofox
const none = MEMBERSHIP_SOURCES.none

const names = (tools) => tools.map((t) => t.name)
const PAYMENT_REMINDER = 'get_my_payment_reminder'
const TWO_BOOKING = ['book_class', 'cancel_class_booking']
const REDESCRIBED = ['get_my_membership', 'get_my_next_class', 'list_my_upcoming_bookings', 'get_my_recent_attendance', 'list_upcoming_classes', 'get_my_payment_reminder']

function throwingDb() {
  return { from: vi.fn(() => { throw new Error('no read may happen') }) }
}

describe('cache stability', () => {
  it('each block is built once; agentToolsFor returns the SAME array object across calls', () => {
    const turn = { answerable: [hatch], threadProvider: un1t, channel: 'whatsapp', un1tWrites: false }
    const a = agentToolsFor(turn)
    expect(agentToolsFor({ ...turn })).toBe(a)
    expect(a).toBe(CACHED_UN1T_READ_TOOLS)
    expect(JSON.stringify(a)).toBe(JSON.stringify(CACHED_UN1T_READ_TOOLS))
    const dual = agentToolsFor({ answerable: [hatch, stillorgan], threadProvider: glofox, channel: 'whatsapp', un1tWrites: false })
    expect(dual).toBe(CACHED_UN1T_READ_DUAL_TOOLS)
    expect(agentToolsFor({ answerable: [hatch, stillorgan], threadProvider: glofox, channel: 'whatsapp', un1tWrites: false })).toBe(dual)
  })

  it('the boolean form (eval harness) still returns the same two arrays; the object form agrees', () => {
    expect(agentToolsFor(true)).toBe(CACHED_ACCOUNT_TOOLS)
    expect(agentToolsFor(false)).toBe(CACHED_NO_BOOKING_TOOLS)
    expect(agentToolsFor({ answerable: [stillorgan], threadProvider: glofox, channel: 'whatsapp', un1tWrites: false })).toBe(CACHED_ACCOUNT_TOOLS)
    expect(agentToolsFor({ answerable: [], threadProvider: un1t, channel: 'whatsapp', un1tWrites: false })).toBe(CACHED_NO_BOOKING_TOOLS)
    expect(agentToolsFor({ answerable: [hatch], threadProvider: un1t, channel: 'instagram', un1tWrites: false })).toBe(CACHED_NO_BOOKING_TOOLS)
  })

  it('exactly one cache_control (ttl 1h) per block, on its last tool; Glofox and no-booking blocks still equal the fixtures', () => {
    for (const block of [CACHED_ACCOUNT_TOOLS, CACHED_NO_BOOKING_TOOLS, CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS, CACHED_UN1T_FULL_TOOLS]) {
      const marked = block.filter((t) => t.cache_control)
      expect(marked).toHaveLength(1)
      expect(block.at(-1).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    }
    expect(JSON.stringify(CACHED_ACCOUNT_TOOLS)).toBe(JSON.stringify(GLOFOX_FIXTURE.cached_tools))
    expect(JSON.stringify(CACHED_NO_BOOKING_TOOLS)).toBe(JSON.stringify(NO_BOOKING_FIXTURE.cached_tools))
    expect(names(CACHED_NO_BOOKING_TOOLS)).toEqual(NO_BOOKING_FIXTURE.names)
    // Still derived from the full list, not hand-built.
    const derived = deriveNoBookingTools(ALL_AGENT_TOOLS)
    expect(JSON.stringify(withCacheBreakpoint(derived))).toBe(JSON.stringify(NO_BOOKING_FIXTURE.cached_tools))
  })

  it('withCacheBreakpoint marks only the last tool, copies it, and never touches its input', () => {
    const input = [{ name: 'a' }, { name: 'b' }]
    const out = withCacheBreakpoint(input)
    expect(out).toEqual([{ name: 'a' }, { name: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } }])
    expect(input[1]).toEqual({ name: 'b' })
    expect(out[0]).toBe(input[0])
  })
})

describe('the un1t read blocks', () => {
  it('3a has no book_class/cancel_class_booking; 3a dual has both; neither has a purchase or refund tool', () => {
    const glofoxNames = names(ALL_AGENT_TOOLS)
    expect(names(CACHED_UN1T_READ_TOOLS)).toEqual(glofoxNames.filter((n) => !TWO_BOOKING.includes(n)))
    expect(names(CACHED_UN1T_READ_DUAL_TOOLS)).toEqual(glofoxNames)
    for (const block of [CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS]) {
      for (const n of [...UN1T_PURCHASE_TOOL_NAMES, 'request_refund']) expect(names(block)).not.toContain(n)
    }
    for (const n of TWO_BOOKING) expect(names(CACHED_UN1T_READ_TOOLS)).not.toContain(n)
  })

  it('get_my_payment_reminder is in both un1t blocks (MIAHATCH.3, with a neutral description) and request_cancellation too', () => {
    for (const block of [CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS]) {
      expect(names(block)).toContain(PAYMENT_REMINDER)
      expect(names(block)).toContain('request_cancellation')
      const tool = block.find((t) => t.name === PAYMENT_REMINDER)
      expect(tool.description).toBe(block === CACHED_UN1T_READ_DUAL_TOOLS ? UN1T_DUAL_TOOL_DESCRIPTIONS[PAYMENT_REMINDER] : UN1T_TOOL_DESCRIPTIONS[PAYMENT_REMINDER])
      expect(tool.description).toMatch(/overdue/i)
      expect(tool.description).not.toMatch(/glofox|limited|spaces|capacity|[–—]/i)
    }
    // Single block: never a pay link. Dual block: one section per studio, only the un1t.online one is link free.
    expect(UN1T_TOOL_DESCRIPTIONS[PAYMENT_REMINDER]).toMatch(/never gives a pay link/i)
    const dual = UN1T_DUAL_TOOL_DESCRIPTIONS[PAYMENT_REMINDER]
    expect(dual).toMatch(/one section per studio/i)
    expect(dual).toMatch(/un1t\.online studio's section[^.]*never has a pay link/i)
    expect(dual).toMatch(/may carry its own pay link/i)
    expect(dual).not.toMatch(/the answer never gives a pay link/i)
    expect(names(CACHED_ACCOUNT_TOOLS)).toContain(PAYMENT_REMINDER)
    expect(names(CACHED_NO_BOOKING_TOOLS)).not.toContain(PAYMENT_REMINDER)
  })

  it('order is kept and only the six re-described tools are new objects', () => {
    for (const [block, dual] of [[CACHED_UN1T_READ_TOOLS, false], [CACHED_UN1T_READ_DUAL_TOOLS, true]]) {
      const derived = deriveUn1tReadTools(ALL_AGENT_TOOLS, { dual })
      expect(names(block)).toEqual(names(derived))
      for (const t of derived) {
        if (REDESCRIBED.includes(t.name)) {
          expect(ALL_AGENT_TOOLS).not.toContain(t)
          expect(t.description).toBe((dual && UN1T_DUAL_TOOL_DESCRIPTIONS[t.name]) || UN1T_TOOL_DESCRIPTIONS[t.name])
        } else {
          expect(ALL_AGENT_TOOLS).toContain(t)
        }
      }
    }
    expect(Object.keys(UN1T_TOOL_DESCRIPTIONS).sort()).toEqual([...REDESCRIBED].sort())
    expect(Object.keys(UN1T_DUAL_TOOL_DESCRIPTIONS)).toEqual([PAYMENT_REMINDER])
    // The full list's own objects are never touched.
    expect(JSON.stringify(CACHED_ACCOUNT_TOOLS)).toBe(JSON.stringify(GLOFOX_FIXTURE.cached_tools))
  })

  it('the last tool is the same tool as in the Glofox block', () => {
    expect(CACHED_UN1T_READ_TOOLS.at(-1).name).toBe(CACHED_ACCOUNT_TOOLS.at(-1).name)
    expect(CACHED_UN1T_READ_DUAL_TOOLS.at(-1).name).toBe(CACHED_ACCOUNT_TOOLS.at(-1).name)
  })

  it('3a list_upcoming_classes description never says limited or spaces; descriptions free of em/en dashes', () => {
    const d = UN1T_TOOL_DESCRIPTIONS.list_upcoming_classes
    expect(UN1T_TOOL_DESCRIPTIONS.get_my_membership).toMatch(/use get_my_payment_reminder/)
    expect(UN1T_TOOL_DESCRIPTIONS.get_my_membership).not.toMatch(/live billing standing/)
    expect(d).toMatch(/event_id/)
    expect(d).toMatch(/\bfull\b/)
    for (const [name, text] of [...Object.entries(UN1T_TOOL_DESCRIPTIONS), ...Object.entries(UN1T_DUAL_TOOL_DESCRIPTIONS)]) {
      expect(text, name).not.toMatch(/[—–]/)
      expect(text, name).not.toMatch(/limited|spaces|capacity|headcount|glofox/i)
    }
    // The whole re-described tool (schema text included) is model-facing.
    for (const block of [CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS]) {
      for (const t of block.filter((x) => REDESCRIBED.includes(x.name))) {
        const json = JSON.stringify(t)
        expect(json, t.name).not.toMatch(/[—–]/)
        expect(json, t.name).not.toMatch(/limited|spaces|capacity|glofox/i)
      }
    }
  })
})

// MIAHATCH.5 (Task 15) — block 3b: the dual read block plus request_refund,
// with book_class and cancel_class_booking re-described for either studio.
// MIAHATCH.6 (Task 19) — then the three purchase tools.
describe('the un1t full block (3b)', () => {
  const NEW_IN_FULL = ['book_class', 'cancel_class_booking']
  const PURCHASE = ['list_purchase_options', 'send_purchase_link', 'check_my_purchase']

  it('is the dual block plus move_class_booking, request_refund and the three purchase tools, in the same order', () => {
    expect(names(CACHED_UN1T_FULL_TOOLS)).toEqual([...names(CACHED_UN1T_READ_DUAL_TOOLS), 'move_class_booking', 'request_refund', ...PURCHASE])
    expect(names(deriveUn1tFullTools(ALL_AGENT_TOOLS))).toEqual(names(CACHED_UN1T_FULL_TOOLS))
    expect(new Set(PURCHASE)).toEqual(new Set(UN1T_PURCHASE_TOOL_NAMES))
    expect(PURCHASE_TOOL_NAMES).toEqual(UN1T_PURCHASE_TOOL_NAMES)
  })

  it('the purchase tools: offer_id required, the class context optional, no dash, nothing about how full a class is or saying paid on their own', () => {
    expect(SEND_PURCHASE_LINK_TOOL.input_schema.required).toEqual(['offer_id'])
    expect(Object.keys(SEND_PURCHASE_LINK_TOOL.input_schema.properties).sort()).toEqual(['class_name', 'class_time', 'event_id', 'offer_id', 'starts_at'])
    expect(LIST_PURCHASE_OPTIONS_TOOL.input_schema).toEqual({ type: 'object', properties: {} })
    expect(CHECK_MY_PURCHASE_TOOL.input_schema).toEqual({ type: 'object', properties: {} })
    expect(SEND_PURCHASE_LINK_TOOL.description).toMatch(/restate the product and its price and get a clear yes/i)
    expect(LIST_PURCHASE_OPTIONS_TOOL.description).toMatch(/never invent, round or change a price/i)
    for (const t of PURCHASE_TOOLS) {
      const json = JSON.stringify(t)
      expect(json, t.name).not.toMatch(/[—–]/)
      expect(json, t.name).not.toMatch(/limited|spaces|capacity|glofox/i)
      expect(t.description, t.name).not.toMatch(/you have paid|payment (is|was) (received|complete)/i)
      // The cached block carries them unchanged (only the last gets the breakpoint).
      const inBlock = CACHED_UN1T_FULL_TOOLS.find((x) => x.name === t.name)
      expect({ ...inBlock, cache_control: undefined }).toEqual({ ...t, cache_control: undefined })
    }
  })

  // MIAFIX.1 (4) — invented offer ids ("10_class_pack") before any list call;
  // (3, 6) an open link for another product is surfaced and hands off.
  it('MIAFIX.1: send_purchase_link says its offer_id must come from list_purchase_options in this conversation, never invented', () => {
    expect(SEND_PURCHASE_LINK_TOOL.description).toMatch(/offer_id MUST be one that list_purchase_options \(or book_class's needs_purchase offers\) returned in this conversation, copied exactly; never invent, guess or build one from a product name/)
    expect(SEND_PURCHASE_LINK_TOOL.input_schema.properties.offer_id.description).toMatch(/returned by list_purchase_options in this conversation[^.]*never invent one/)
    expect(SEND_PURCHASE_LINK_TOOL.description).toMatch(/already waiting for a different product, no link is made and the conversation is handed to the team/)
    expect(LIST_PURCHASE_OPTIONS_TOOL.description).toMatch(/open_link[^.]*never offer to send a link for a different product/)
  })

  it('built once: agentToolsFor returns the SAME array for a WhatsApp turn with writes, one 1h breakpoint on the last tool', () => {
    const turn = { answerable: [hatch], threadProvider: un1t, channel: 'whatsapp', un1tWrites: true }
    expect(agentToolsFor(turn)).toBe(CACHED_UN1T_FULL_TOOLS)
    expect(agentToolsFor({ ...turn, answerable: [hatch, stillorgan] })).toBe(CACHED_UN1T_FULL_TOOLS)
    expect(CACHED_UN1T_FULL_TOOLS.filter((t) => t.cache_control)).toHaveLength(1)
    expect(CACHED_UN1T_FULL_TOOLS.at(-1)).toMatchObject({ name: 'check_my_purchase', cache_control: { type: 'ephemeral', ttl: '1h' } })
    // Writes off, or Instagram, never reach it.
    expect(agentToolsFor({ ...turn, un1tWrites: false })).toBe(CACHED_UN1T_READ_TOOLS)
    expect(agentToolsFor({ ...turn, channel: 'instagram' })).toBe(CACHED_NO_BOOKING_TOOLS)
  })

  // UN1TMOVE.1 — one call moves a un1t.online booking (never cancel then book).
  it('move_class_booking: booking_id, event_id and starts_at all required (no optional parameter), un1t ids only, never a word about how full', () => {
    expect(MOVE_CLASS_BOOKING_TOOL.name).toBe('move_class_booking')
    expect(MOVE_CLASS_BOOKING_TOOL.input_schema).toMatchObject({ type: 'object', required: ['booking_id', 'event_id', 'starts_at'] })
    expect(Object.keys(MOVE_CLASS_BOOKING_TOOL.input_schema.properties).sort()).toEqual(['booking_id', 'event_id', 'starts_at'])
    expect(MOVE_CLASS_BOOKING_TOOL.description).toMatch(/moved only when/i)
    expect(MOVE_CLASS_BOOKING_TOOL.description).toMatch(/never cancel and book/i)
    const json = JSON.stringify(MOVE_CLASS_BOOKING_TOOL)
    expect(json).toMatch(/un1t:/)
    expect(json).not.toMatch(/[—–]/)
    expect(json).not.toMatch(/limited|spaces|capacity|glofox/i)
    const inBlock = CACHED_UN1T_FULL_TOOLS.find((x) => x.name === 'move_class_booking')
    expect(inBlock).toEqual(MOVE_CLASS_BOOKING_TOOL)
  })

  it('request_refund: reason required, booking_id optional; neutral words that never promise a refund', () => {
    expect(REQUEST_REFUND_TOOL.name).toBe('request_refund')
    expect(REQUEST_REFUND_TOOL.input_schema).toMatchObject({ type: 'object', required: ['reason'] })
    expect(Object.keys(REQUEST_REFUND_TOOL.input_schema.properties).sort()).toEqual(['booking_id', 'reason'])
    expect(REQUEST_REFUND_TOOL.input_schema.properties.reason.type).toBe('string')
    expect(REQUEST_REFUND_TOOL.input_schema.properties.booking_id.type).toBe('string')
    expect(REQUEST_REFUND_TOOL.input_schema.properties.booking_id.description).toMatch(/un1t:/)
    const text = JSON.stringify(REQUEST_REFUND_TOOL)
    expect(REQUEST_REFUND_TOOL.description).toMatch(/pass(es)? .*refund request to the team/i)
    expect(REQUEST_REFUND_TOOL.description).toMatch(/team .*decides?/i)
    expect(text).not.toMatch(/will be refunded|refund is on its way|we will refund|you will get/i)
    expect(text).not.toMatch(/[—–]/)
    expect(text).not.toMatch(/limited|spaces|capacity|glofox/i)
  })

  it('book_class and cancel_class_booking are re-described for either studio, schemas unchanged in shape', () => {
    for (const name of NEW_IN_FULL) {
      const tool = CACHED_UN1T_FULL_TOOLS.find((t) => t.name === name)
      const glofoxTool = ALL_AGENT_TOOLS.find((t) => t.name === name)
      expect(tool.description).toBe(UN1T_FULL_TOOL_DESCRIPTIONS[name])
      // FEES.2: 3b's cancel adds exactly one optional input, confirm_late_fee.
      const extra = name === 'cancel_class_booking' ? ['confirm_late_fee'] : []
      expect(Object.keys(tool.input_schema.properties)).toEqual([...Object.keys(glofoxTool.input_schema.properties), ...extra])
      expect(tool.input_schema.required).toEqual(glofoxTool.input_schema.required)
      const json = JSON.stringify(tool)
      expect(json, name).not.toMatch(/[—–]/)
      expect(json, name).not.toMatch(/limited|spaces|capacity|glofox|24-hex/i)
      expect(json, name).toMatch(/un1t:/)
    }
    expect(UN1T_FULL_TOOL_DESCRIPTIONS.book_class).toMatch(/booked only when/i)
    expect(UN1T_FULL_TOOL_DESCRIPTIONS.cancel_class_booking).toMatch(/cancelled only when/i)
    expect(UN1T_FULL_TOOL_DESCRIPTIONS.cancel_class_booking).toMatch(/never promise a refund or a credit/i)
    expect(Object.keys(UN1T_FULL_TOOL_DESCRIPTIONS).sort()).toEqual([...NEW_IN_FULL].sort())
  })

  it('every other tool is the dual block\'s own object; the full list is never touched', () => {
    for (const t of CACHED_UN1T_FULL_TOOLS.slice(0, -5)) {
      if (NEW_IN_FULL.includes(t.name)) continue
      const dualTool = deriveUn1tReadTools(ALL_AGENT_TOOLS, { dual: true }).find((x) => x.name === t.name)
      expect(JSON.stringify(t), t.name).toBe(JSON.stringify(dualTool))
    }
    expect(JSON.stringify(CACHED_ACCOUNT_TOOLS)).toBe(JSON.stringify(GLOFOX_FIXTURE.cached_tools))
    expect(JSON.stringify(CACHED_NO_BOOKING_TOOLS)).toBe(JSON.stringify(NO_BOOKING_FIXTURE.cached_tools))
  })

  it('extraTools are appended after request_refund (the purchase tools by default)', () => {
    const extra = [{ name: 'list_purchase_options', description: 'x', input_schema: { type: 'object', properties: {} } }]
    const out = deriveUn1tFullTools(ALL_AGENT_TOOLS, { extraTools: extra })
    expect(names(out).slice(-2)).toEqual(['request_refund', 'list_purchase_options'])
    expect(out.at(-1)).toBe(extra[0])
  })
})

// MIAHATCH.5 (Task 15) — Ruling 25: un1t_full needs WhatsApp, the un1t.online
// studio's writes_enabled AND its Mia switch un1t_chat_actions_enabled.
describe('un1t_full selection (planTurnTools / resolveTurnPlan)', () => {
  const memberStudios = (...studios) => ({ studios, readFailed: false })
  const args = (over = {}) => ({
    memberStudios: memberStudios(hatch), threadLocationId: HATCH_ID, threadProvider: un1t, channel: 'whatsapp', ...over,
  })
  // A fake per-turn studios accessor (createActionStudios' shape).
  function studiosWith({ mia = {}, writes = {}, settingsFail = [], writesFail = [] } = {}) {
    return {
      settings: vi.fn(async (id) => (settingsFail.includes(id) ? null : { ...(mia[id] || {}) })),
      zone: vi.fn(async () => 'Europe/Dublin'),
      un1tWriteSettings: vi.fn(async (id) => {
        if (writesFail.includes(id)) throw Object.assign(new Error('read failed'), { name: 'Un1tSettingsReadError', code: 'XX000' })
        return { writesEnabled: writes[id] === true }
      }),
    }
  }
  const on = { [HATCH_ID]: { un1t_chat_actions_enabled: true } }
  const writesOn = { [HATCH_ID]: true }

  it('un1t_full only on WhatsApp with writes_enabled and the Mia switch', async () => {
    const plan = await resolveTurnPlan(args(), studiosWith({ mia: on, writes: writesOn }))
    expect(plan.block).toBe('un1t_full')
    expect(plan.un1tStudio.locationId).toBe(HATCH_ID)
    expect(turnForPlan(plan, 'whatsapp')).toEqual({ block: 'un1t_full', answerable: [hatch], channel: 'whatsapp', un1tWrites: true })
    const dual = await resolveTurnPlan(args({ memberStudios: memberStudios(hatch, stillorgan) }), studiosWith({ mia: on, writes: writesOn }))
    expect(dual.block).toBe('un1t_full')
    expect(dual.multiStudio).toBe(true)
    expect(plan.multiStudio).toBe(false)
  })

  it('writes_enabled true but the switch absent (the live Hatch state): un1t_read / un1t_read_dual, as today', async () => {
    const studios = studiosWith({ writes: writesOn })
    const plan = await resolveTurnPlan(args(), studios)
    expect(plan.block).toBe('un1t_read')
    expect(turnForPlan(plan, 'whatsapp').un1tWrites).toBe(false)
    expect((await resolveTurnPlan(args({ memberStudios: memberStudios(hatch, stillorgan) }), studios)).block).toBe('un1t_read_dual')
    // The switch decides first: writes_enabled is never even read with it off.
    expect(studios.un1tWriteSettings).not.toHaveBeenCalled()
    for (const v of [false, 'true', 1, null]) {
      expect((await resolveTurnPlan(args(), studiosWith({ mia: { [HATCH_ID]: { un1t_chat_actions_enabled: v } }, writes: writesOn }))).block, String(v)).toBe('un1t_read')
    }
  })

  it('writes off -> un1t_read(_dual), switch or not', async () => {
    expect((await resolveTurnPlan(args(), studiosWith({ mia: on }))).block).toBe('un1t_read')
    expect((await resolveTurnPlan(args({ memberStudios: memberStudios(hatch, stillorgan) }), studiosWith({ mia: on }))).block).toBe('un1t_read_dual')
  })

  it("Instagram -> today's block even with writes and the switch on (R3)", async () => {
    const studios = studiosWith({ mia: on, writes: writesOn })
    const plan = await resolveTurnPlan(args({ channel: 'instagram' }), studios)
    expect(plan.block).toBe('no_booking')
    expect(turnForPlan(plan, 'instagram')).toBeUndefined()
    expect(studios.settings).not.toHaveBeenCalledWith(HATCH_ID)
  })

  it('a failed settings read for the decision fails closed to the read block, logged', async () => {
    vi.mocked(logWarn).mockClear()
    expect((await resolveTurnPlan(args(), studiosWith({ mia: on, writes: writesOn, writesFail: [HATCH_ID] }))).block).toBe('un1t_read')
    expect(logWarn).toHaveBeenCalledWith('mia-un1t', expect.stringMatching(/un1t write settings/), expect.objectContaining({ locationId: HATCH_ID }))
    vi.mocked(logWarn).mockClear()
    expect((await resolveTurnPlan(args(), studiosWith({ mia: on, writes: writesOn, settingsFail: [HATCH_ID] }))).block).toBe('un1t_read')
    expect(logWarn).toHaveBeenCalledWith('mia-un1t', expect.any(String), expect.objectContaining({ locationId: HATCH_ID }))
    const throwing = { ...studiosWith({ mia: on, writes: writesOn }), settings: vi.fn(async () => { throw new Error('boom') }) }
    expect((await resolveTurnPlan(args(), throwing)).block).toBe('un1t_read')
  })

  it('with two un1t.online studios answerable, every one must pass', async () => {
    const SECOND = 'a1000000-0000-0000-0000-000000000009'
    const second = { ...hatch, locationId: SECOND, name: 'UN1T Second' }
    const both = args({ memberStudios: memberStudios(hatch, second) })
    expect((await resolveTurnPlan(both, studiosWith({ mia: on, writes: writesOn }))).block).toBe('un1t_read')
    const allOn = studiosWith({ mia: { ...on, [SECOND]: { un1t_chat_actions_enabled: true } }, writes: { ...writesOn, [SECOND]: true } })
    expect((await resolveTurnPlan(both, allOn)).block).toBe('un1t_full')
  })

  it('planTurnTools is still pure and read-only by default (un1tWrites false)', () => {
    expect(planTurnTools(args()).block).toBe('un1t_read')
    expect(planTurnTools(args({ un1tWrites: true })).block).toBe('un1t_full')
    expect(planTurnTools(args({ un1tWrites: true, channel: 'instagram' })).block).toBe('no_booking')
  })
})

describe('selectToolBlock: the decision table', () => {
  const sel = (answerable, threadProvider, channel, un1tWrites = false) =>
    selectToolBlock({ answerable, threadProvider, channel, un1tWrites })

  it('non-WhatsApp is today\'s rule: glofox if the thread provider takes bookings, else no_booking', () => {
    expect(sel([hatch, stillorgan], glofox, 'instagram')).toBe('glofox')
    expect(sel([hatch], un1t, 'instagram')).toBe('no_booking')
    expect(sel([hatch], none, 'instagram')).toBe('no_booking')
    expect(sel([hatch], un1t, 'instagram', true)).toBe('no_booking')
  })

  it('WhatsApp with nobody answerable is today\'s rule', () => {
    expect(sel([], glofox, 'whatsapp')).toBe('glofox')
    expect(sel([], un1t, 'whatsapp')).toBe('no_booking')
    expect(sel(undefined, glofox, 'whatsapp')).toBe('glofox')
    expect(sel(null, un1t, 'whatsapp')).toBe('no_booking')
  })

  it('WhatsApp, every answerable studio on Glofox: glofox', () => {
    expect(sel([stillorgan], glofox, 'whatsapp')).toBe('glofox')
    expect(sel([stillorgan], un1t, 'whatsapp')).toBe('glofox')
  })

  it('WhatsApp, a un1t studio answerable: un1t_read, or un1t_read_dual with a Glofox studio too', () => {
    expect(sel([hatch], un1t, 'whatsapp')).toBe('un1t_read')
    expect(sel([hatch, stillorgan], glofox, 'whatsapp')).toBe('un1t_read_dual')
    expect(sel([stillorgan, hatch], un1t, 'whatsapp')).toBe('un1t_read_dual')
  })

  it('un1tWrites on a un1t studio is un1t_full (never reached in production until Task 15)', () => {
    expect(sel([hatch], un1t, 'whatsapp', true)).toBe('un1t_full')
    expect(sel([hatch, stillorgan], glofox, 'whatsapp', true)).toBe('un1t_full')
    // Writes never promote a Glofox-only turn, and never leave WhatsApp.
    expect(sel([stillorgan], glofox, 'whatsapp', true)).toBe('glofox')
    expect(sel([hatch], un1t, 'instagram', true)).toBe('no_booking')
  })

  it('a studio with no provider is not a un1t studio: today\'s rule', () => {
    const bare = { ...hatch, providerKey: 'none' }
    expect(sel([bare], none, 'whatsapp')).toBe('no_booking')
    expect(sel([bare, stillorgan], glofox, 'whatsapp')).toBe('glofox')
  })
})

describe('refuseToolForTurn', () => {
  const turn = (block, extra = {}) => ({ block, answerable: [hatch], channel: 'whatsapp', un1tWrites: false, ...extra })

  it('invented tools: send_purchase_link, check_my_purchase, list_purchase_options, request_refund refused in glofox, no_booking, un1t_read and un1t_read_dual, before any db call', () => {
    const db = throwingDb()
    for (const block of ['glofox', 'no_booking', 'un1t_read', 'un1t_read_dual']) {
      for (const name of [...UN1T_PURCHASE_TOOL_NAMES, 'request_refund', 'move_class_booking']) {
        expect(refuseToolForTurn(name, { db, turn: turn(block) })).toMatchObject({ error: 'not_available_at_this_studio' })
      }
    }
    expect(db.from).not.toHaveBeenCalled()
  })

  it('the refusal is a COPY of TOOL_NOT_AT_THIS_STUDIO', () => {
    const r = refuseToolForTurn('send_purchase_link', { turn: turn('glofox') })
    expect(r).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(r).not.toBe(TOOL_NOT_AT_THIS_STUDIO)
  })

  it('book_class in un1t_read is refused; ctx without turn keeps the canBook rule', () => {
    expect(refuseToolForTurn('book_class', { turn: turn('un1t_read') })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(refuseToolForTurn('cancel_class_booking', { turn: turn('un1t_read') })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    // Glofox and dual blocks do offer them.
    expect(refuseToolForTurn('book_class', { turn: turn('glofox') })).toBeNull()
    expect(refuseToolForTurn('cancel_class_booking', { turn: turn('un1t_read_dual') })).toBeNull()
    // No turn: today's canBook rule.
    for (const name of ['get_my_membership', 'book_class', 'request_cancellation', 'list_my_upcoming_bookings']) {
      expect(refuseToolForTurn(name, { canBook: false })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      expect(refuseToolForTurn(name, { canBook: true })).toBeNull()
      expect(refuseToolForTurn(name, {})).toBeNull()
      expect(refuseToolForTurn(name, undefined)).toBeNull()
    }
    expect(refuseToolForTurn('list_upcoming_classes', { canBook: false })).toBeNull()
    expect(refuseToolForTurn('request_pause', { canBook: false })).toBeNull()
  })

  it('get_my_payment_reminder is allowed under both un1t read blocks and glofox, refused under no_booking', () => {
    for (const block of ['un1t_read', 'un1t_read_dual', 'glofox']) {
      expect(refuseToolForTurn(PAYMENT_REMINDER, { turn: turn(block) })).toBeNull()
    }
    expect(refuseToolForTurn(PAYMENT_REMINDER, { turn: turn('no_booking') })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
  })

  it('with a turn, the block decides and canBook is ignored', () => {
    expect(refuseToolForTurn('get_my_membership', { canBook: false, turn: turn('un1t_read') })).toBeNull()
    expect(refuseToolForTurn('get_my_membership', { canBook: true, turn: turn('no_booking') })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
  })

  it('the refusal rule matches what each block actually offers', () => {
    const blocks = {
      glofox: CACHED_ACCOUNT_TOOLS, no_booking: CACHED_NO_BOOKING_TOOLS,
      un1t_read: CACHED_UN1T_READ_TOOLS, un1t_read_dual: CACHED_UN1T_READ_DUAL_TOOLS,
    }
    for (const [block, tools] of Object.entries(blocks)) {
      const offered = new Set(names(tools))
      for (const t of ALL_AGENT_TOOLS) {
        const r = refuseToolForTurn(t.name, { turn: turn(block) })
        expect(r !== null, `${block}/${t.name}`).toBe(!offered.has(t.name))
      }
    }
  })

  it('un1t_full allows writes only on WhatsApp with un1tWrites; a malformed gate refuses', () => {
    const full = { block: 'un1t_full', answerable: [hatch], channel: 'whatsapp', un1tWrites: true }
    for (const name of UN1T_WRITE_TOOL_NAMES) {
      expect(refuseToolForTurn(name, { turn: full }), name).toBeNull()
      expect(refuseToolForTurn(name, { turn: { ...full, channel: 'instagram' } }), name).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      expect(refuseToolForTurn(name, { turn: { ...full, un1tWrites: false } }), name).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      expect(refuseToolForTurn(name, { turn: { ...full, un1tWrites: 'yes' } }), name).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    }
    expect(refuseToolForTurn('get_my_membership', { turn: { ...full, un1tWrites: false } })).toBeNull()
  })

  // MIAHATCH.6 (Task 19) — the purchase tools joined un1t_full: offered and
  // allowed there on WhatsApp with writes, refused when either is missing.
  it('un1t_full offers and allows the three purchase tools; Instagram or writes off refuses them', () => {
    const full = { block: 'un1t_full', answerable: [hatch], channel: 'whatsapp', un1tWrites: true }
    for (const name of UN1T_PURCHASE_TOOL_NAMES) {
      expect(names(CACHED_UN1T_FULL_TOOLS)).toContain(name)
      expect(refuseToolForTurn(name, { turn: full }), name).toBeNull()
      expect(refuseToolForTurn(name, { turn: { ...full, channel: 'instagram' } }), name).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      expect(refuseToolForTurn(name, { turn: { ...full, un1tWrites: false } }), name).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    }
  })

  it('invented tools: request_refund and book_class refused in un1t_read, allowed in un1t_full, before any db call', () => {
    const db = throwingDb()
    const full = { block: 'un1t_full', answerable: [hatch], channel: 'whatsapp', un1tWrites: true }
    for (const name of ['request_refund', 'book_class', 'cancel_class_booking', 'move_class_booking']) {
      expect(refuseToolForTurn(name, { db, turn: turn('un1t_read') }), name).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      expect(refuseToolForTurn(name, { db, turn: full }), name).toBeNull()
    }
    expect(refuseToolForTurn('request_refund', { db, turn: turn('un1t_read_dual') })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(refuseToolForTurn('move_class_booking', { db, turn: turn('un1t_read_dual') })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('the refusal rule matches what un1t_full offers (block names agree with the executor)', () => {
    const full = { block: 'un1t_full', answerable: [hatch], channel: 'whatsapp', un1tWrites: true }
    const offered = new Set(names(CACHED_UN1T_FULL_TOOLS))
    const every = [...new Set([...names(ALL_AGENT_TOOLS), 'request_refund', 'move_class_booking', ...UN1T_PURCHASE_TOOL_NAMES])]
    for (const name of every) {
      expect(refuseToolForTurn(name, { turn: full }) !== null, `un1t_full/${name}`).toBe(!offered.has(name))
    }
  })

  it('an unknown block still refuses the purchase tools and otherwise keeps the canBook rule', () => {
    expect(refuseToolForTurn('send_purchase_link', { turn: turn('bogus') })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(refuseToolForTurn('get_my_membership', { canBook: false, turn: turn('bogus') })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(refuseToolForTurn('get_my_membership', { turn: turn('bogus') })).toBeNull()
  })

  it('both executors refuse a block-excluded tool before any db read', async () => {
    const db = throwingDb()
    const ctx = { db, verifiedContactId: 'c1', locationId: HATCH_ID, turn: turn('un1t_read') }
    expect(await executeBookingTool('book_class', { event_id: 'x' }, ctx)).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(await executeBookingTool('cancel_class_booking', { booking_id: 'x' }, ctx)).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(await executeBookingTool('move_class_booking', { booking_id: 'un1t:x', event_id: 'un1t:y' }, ctx)).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(await executeAccountTool('send_purchase_link', {}, ctx)).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(db.from).not.toHaveBeenCalled()
  })
})

describe('parseAgentId and tagUn1tId', () => {
  it('tags with the un1t: prefix', () => {
    expect(UN1T_ID_PREFIX).toBe('un1t:')
    expect(tagUn1tId('9f1c')).toBe('un1t:9f1c')
    expect(tagUn1tId(42)).toBe('un1t:42')
  })

  it('parseAgentId: un1t:<id>, 24-hex, manual-x, empty', () => {
    expect(parseAgentId('un1t:9f1c-22')).toEqual({ provider: 'un1t_online', id: '9f1c-22' })
    expect(parseAgentId(tagUn1tId('abc'))).toEqual({ provider: 'un1t_online', id: 'abc' })
    expect(parseAgentId('64aa00000000000000000001')).toEqual({ provider: 'glofox', id: '64aa00000000000000000001' })
    expect(parseAgentId('manual-1234')).toEqual({ provider: 'glofox', id: 'manual-1234' })
    expect(parseAgentId('')).toBeNull()
    expect(parseAgentId('un1t:')).toBeNull()
    expect(parseAgentId(null)).toBeNull()
    expect(parseAgentId(undefined)).toBeNull()
    expect(parseAgentId(12)).toBeNull()
    // The prefix is exact: no case folding, no partial match.
    expect(parseAgentId('UN1T:abc')).toEqual({ provider: 'glofox', id: 'UN1T:abc' })
    expect(parseAgentId('un1tabc')).toEqual({ provider: 'glofox', id: 'un1tabc' })
  })
})
