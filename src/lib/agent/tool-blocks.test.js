// MIAHATCH.2 Task 3 — Mia's tool blocks at Hatch Street (un1t.online): the two
// provider-aware READ blocks, the pure block selector, refuseToolForTurn and
// the tagged ids. Production behaviour must not move: the Glofox and
// no-booking blocks are pinned to fixtures captured BEFORE this task.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  ALL_AGENT_TOOLS, CACHED_ACCOUNT_TOOLS, CACHED_NO_BOOKING_TOOLS,
  CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS, agentToolsFor,
} from './auto-reply'
import {
  UN1T_TOOL_DESCRIPTIONS, UN1T_WRITE_TOOL_NAMES, UN1T_PURCHASE_TOOL_NAMES,
  deriveUn1tReadTools, selectToolBlock, withCacheBreakpoint,
} from './tool-blocks'
import { UN1T_ID_PREFIX, tagUn1tId, parseAgentId } from './studio-ids'
import { TOOL_NOT_AT_THIS_STUDIO, refuseToolForTurn, deriveNoBookingTools } from './tool-capability'
import { executeAccountTool } from './account-tools'
import { executeBookingTool } from './booking-tools'
import { MEMBERSHIP_SOURCES } from '@/lib/membership/source'

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
const REDESCRIBED = ['get_my_membership', 'get_my_next_class', 'list_my_upcoming_bookings', 'get_my_recent_attendance', 'list_upcoming_classes']

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
    for (const block of [CACHED_ACCOUNT_TOOLS, CACHED_NO_BOOKING_TOOLS, CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS]) {
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
    expect(names(CACHED_UN1T_READ_TOOLS)).toEqual(glofoxNames.filter((n) => !TWO_BOOKING.includes(n) && n !== PAYMENT_REMINDER))
    expect(names(CACHED_UN1T_READ_DUAL_TOOLS)).toEqual(glofoxNames.filter((n) => n !== PAYMENT_REMINDER))
    for (const block of [CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS]) {
      for (const n of [...UN1T_PURCHASE_TOOL_NAMES, 'request_refund']) expect(names(block)).not.toContain(n)
    }
    for (const n of TWO_BOOKING) expect(names(CACHED_UN1T_READ_TOOLS)).not.toContain(n)
  })

  it('get_my_payment_reminder is in neither un1t block (its executor is Glofox only) but request_cancellation is', () => {
    for (const block of [CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS]) {
      expect(names(block)).not.toContain(PAYMENT_REMINDER)
      expect(names(block)).toContain('request_cancellation')
    }
    expect(names(CACHED_ACCOUNT_TOOLS)).toContain(PAYMENT_REMINDER)
    expect(names(CACHED_NO_BOOKING_TOOLS)).not.toContain(PAYMENT_REMINDER)
  })

  it('order is kept and only the five re-described tools are new objects', () => {
    for (const [block, dual] of [[CACHED_UN1T_READ_TOOLS, false], [CACHED_UN1T_READ_DUAL_TOOLS, true]]) {
      const derived = deriveUn1tReadTools(ALL_AGENT_TOOLS, { dual })
      expect(names(block)).toEqual(names(derived))
      for (const t of derived) {
        if (REDESCRIBED.includes(t.name)) {
          expect(ALL_AGENT_TOOLS).not.toContain(t)
          expect(t.description).toBe(UN1T_TOOL_DESCRIPTIONS[t.name])
        } else {
          expect(ALL_AGENT_TOOLS).toContain(t)
        }
      }
    }
    expect(Object.keys(UN1T_TOOL_DESCRIPTIONS).sort()).toEqual([...REDESCRIBED].sort())
    // The full list's own objects are never touched.
    expect(JSON.stringify(CACHED_ACCOUNT_TOOLS)).toBe(JSON.stringify(GLOFOX_FIXTURE.cached_tools))
  })

  it('the last tool is the same tool as in the Glofox block', () => {
    expect(CACHED_UN1T_READ_TOOLS.at(-1).name).toBe(CACHED_ACCOUNT_TOOLS.at(-1).name)
    expect(CACHED_UN1T_READ_DUAL_TOOLS.at(-1).name).toBe(CACHED_ACCOUNT_TOOLS.at(-1).name)
  })

  it('3a list_upcoming_classes description never says limited or spaces; descriptions free of em/en dashes', () => {
    const d = UN1T_TOOL_DESCRIPTIONS.list_upcoming_classes
    expect(d).toMatch(/event_id/)
    expect(d).toMatch(/\bfull\b/)
    for (const [name, text] of Object.entries(UN1T_TOOL_DESCRIPTIONS)) {
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
      for (const name of [...UN1T_PURCHASE_TOOL_NAMES, 'request_refund']) {
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

  it('get_my_payment_reminder is refused under un1t_read and un1t_read_dual, allowed under glofox, before any db call', async () => {
    const db = throwingDb()
    for (const block of ['un1t_read', 'un1t_read_dual']) {
      expect(refuseToolForTurn(PAYMENT_REMINDER, { db, turn: turn(block) })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      const ctx = { db, verifiedContactId: 'c1', locationId: HATCH_ID, turn: turn(block) }
      expect(await executeAccountTool(PAYMENT_REMINDER, {}, ctx)).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    }
    expect(refuseToolForTurn(PAYMENT_REMINDER, { turn: turn('glofox') })).toBeNull()
    expect(db.from).not.toHaveBeenCalled()
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
    for (const name of [...UN1T_WRITE_TOOL_NAMES, ...UN1T_PURCHASE_TOOL_NAMES]) {
      expect(refuseToolForTurn(name, { turn: full }), name).toBeNull()
      expect(refuseToolForTurn(name, { turn: { ...full, channel: 'instagram' } }), name).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      expect(refuseToolForTurn(name, { turn: { ...full, un1tWrites: false } }), name).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      expect(refuseToolForTurn(name, { turn: { ...full, un1tWrites: 'yes' } }), name).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    }
    expect(refuseToolForTurn('get_my_membership', { turn: { ...full, un1tWrites: false } })).toBeNull()
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
