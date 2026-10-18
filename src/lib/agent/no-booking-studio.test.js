// MIAORG.1 Task 5 — Mia at a studio without Glofox (Hatch Street, on
// un1t.online), and the pins that Stillorgan (Glofox, LIVE) is untouched.
//
// Fixtures in __fixtures__/ were captured from the real builders at the base
// commit (29b26df4), BEFORE any Task 5 edit: the Glofox prompt bytes and the
// Glofox cached tool block. They are the contract, not a re-render.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(),
  sendInteractiveOptions: vi.fn(),
  sendTypingIndicator: vi.fn(),
  sendCtaUrlMessage: vi.fn(),
  splitTrailingUrl: vi.fn(() => null),
  getOrCreateConversation: vi.fn(),
}))
vi.mock('@/lib/push', () => ({
  sendPushToRolesAtLocation: vi.fn(async () => {}),
  sendPushToInboxStaffAtLocation: vi.fn(async () => {}),
}))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Dublin' })),
}))
vi.mock('@/lib/person-links', () => ({
  personGroupResolver: vi.fn(async () => ({ groupOf: () => null, primaryOf: () => null })),
}))
// Every Glofox entry point the tools reach is a spy: a no-booking turn must
// call none of them.
vi.mock('@/lib/glofox', () => ({
  GLOFOX_BOOKING_MODEL: 'program',
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(async () => ({ ok: true, events: [] })),
  fetchUserBookingsResult: vi.fn(async () => ({ ok: true, bookings: [] })),
  fetchUserCreditsResult: vi.fn(async () => ({ ok: true, credits: [] })),
  createBooking: vi.fn(async () => ({ ok: true })),
  cancelBooking: vi.fn(async () => ({ ok: true })),
  interpretBookingResult: vi.fn(() => ({ success: true })),
}))
// The separate source read the turn used to make: a spy that fails, so a
// turn that still called it would fall back to `none` (no booking).
vi.mock('@/lib/membership/source', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveMembershipSource: vi.fn(async () => { throw new Error('membership_source read failed') }),
}))
vi.mock('@/lib/log', async (importOriginal) => ({
  ...(await importOriginal()),
  logError: vi.fn(),
}))

import fs from 'node:fs'
import path from 'node:path'
import * as glofox from '@/lib/glofox'
import { logError } from '@/lib/log'
import {
  ALL_AGENT_TOOLS, CACHED_ACCOUNT_TOOLS, CACHED_NO_BOOKING_TOOLS, NO_BOOKING_AGENT_TOOLS,
  agentToolsFor, linkButtonText, runChannelAgent,
} from './auto-reply'
import {
  BOOKING_SYSTEM_TOOL_NAMES, TOOL_NOT_AT_THIS_STUDIO, NO_BOOKING_CLASS_LIST_DESCRIPTION,
  deriveNoBookingTools, providerTakesBookings, refuseAtNoBookingStudio,
} from './tool-capability'
import {
  buildCachedSystem, buildCustomerSystemPromptParts, CUSTOMER_AGENT_BASE_PROMPT,
  renderCustomerAgentBasePrompt, NO_BOOKING_ACCOUNT_HANDOFF,
} from './prompt'
import {
  executeBookingTool, resolveConsultationEventType, shapeUn1tClassesForAgent,
  UN1T_TIMETABLE_DAYS, UN1T_TIMETABLE_LIMIT,
} from './booking-tools'
import { executeAccountTool } from './account-tools'
import { formatClassTime } from './dublin-format'
import { MEMBERSHIP_SOURCES, resolveMembershipSource } from '@/lib/membership/source'
import { STILLORGAN_BLOB } from './settings-fixtures.test-helpers'

const FIX_DIR = path.join(__dirname, '__fixtures__')
const PROMPT_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'glofox-system-prompt.fixture.json'), 'utf8'))
const TOOLS_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'glofox-agent-tools.fixture.json'), 'utf8'))

// Fictional ids.
const STILLORGAN = 'a1000000-0000-0000-0000-000000000001'
const HATCH = 'a1000000-0000-0000-0000-000000000002'
const STILLORGAN_CONTACT = 'c1000000-0000-0000-0000-000000000001'
const BOOKING_URL = 'https://hatch.example.test/book'

// The exact opts the fixture was captured with (zz capture, base commit).
const KNOWLEDGE = [
  { category: 'sales', title: 'Intro offer', content: 'Fictional: 3 classes for 30 euro.', enabled: true },
  { category: 'hours', title: 'Opening hours', content: 'Fictional: 6am to 9pm weekdays.', enabled: true },
]
const CARD_SETS = [{ name: 'Classes', description: 'when they ask what classes are like', cards: [{}, {}] }]
function stillorganOpts(extra = {}) {
  return {
    businessName: 'UN1T Dublin',
    locationName: 'UN1T Stillorgan',
    agentName: STILLORGAN_BLOB.agent_name,
    membershipUrl: 'https://example.test/join',
    membershipSource: { key: 'glofox', label: 'Glofox' },
    tone: STILLORGAN_BLOB.tone,
    extraRules: STILLORGAN_BLOB.extra_rules,
    knowledge: KNOWLEDGE,
    cardSets: CARD_SETS,
    today: 'Saturday, 17 October 2026',
    identityPreverified: false,
    multipleAccounts: false,
    knownContact: { firstName: 'Aoife', hasEmail: true },
    ...extra,
  }
}
function hatchOpts(extra = {}) {
  return {
    ...stillorganOpts(),
    locationName: 'UN1T Hatch Street',
    membershipUrl: null,
    membershipSource: { key: 'un1t_online', label: 'un1t.online' },
    bookings: false,
    bookingUrl: BOOKING_URL,
    ...extra,
  }
}

const NO_BOOKING_NAMES = [
  'verify_identity', 'request_pause', 'request_membership_purchase', 'list_upcoming_classes',
  'list_consultation_slots', 'book_consultation', 'save_lead_details', 'list_upcoming_events',
  'get_my_event_registrations', 'book_event', 'cancel_event_registration', 'reschedule_event_wave',
  'list_event_move_options', 'move_event_entry', 'send_card_set',
]

beforeEach(() => { vi.clearAllMocks() })

// ── T5-D: two cached tool arrays ────────────────────────────────────────
describe('tool blocks (T5-D)', () => {
  it('the full block is byte-identical to the base-commit definition', () => {
    expect(ALL_AGENT_TOOLS.map((t) => t.name)).toEqual(TOOLS_FIXTURE.names)
    expect(JSON.parse(JSON.stringify(CACHED_ACCOUNT_TOOLS))).toEqual(TOOLS_FIXTURE.cached_tools)
    expect(JSON.stringify(CACHED_ACCOUNT_TOOLS)).toBe(JSON.stringify(TOOLS_FIXTURE.cached_tools))
  })

  it('a Glofox studio gets the SAME full array object; a no-booking studio its own, both built once', () => {
    expect(agentToolsFor(true)).toBe(CACHED_ACCOUNT_TOOLS)
    expect(agentToolsFor(true)).toBe(agentToolsFor(true))
    expect(agentToolsFor(false)).toBe(CACHED_NO_BOOKING_TOOLS)
    expect(agentToolsFor(false)).toBe(agentToolsFor(false))
  })

  it('the no-booking block: exact names in the full order, one cache breakpoint on its last tool', () => {
    expect(NO_BOOKING_AGENT_TOOLS.map((t) => t.name)).toEqual(NO_BOOKING_NAMES)
    expect(CACHED_NO_BOOKING_TOOLS.map((t) => t.name)).toEqual(NO_BOOKING_NAMES)
    const marked = CACHED_NO_BOOKING_TOOLS.filter((t) => t.cache_control)
    expect(marked).toHaveLength(1)
    expect(CACHED_NO_BOOKING_TOOLS.at(-1).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    for (const name of BOOKING_SYSTEM_TOOL_NAMES) {
      expect(CACHED_NO_BOOKING_TOOLS.some((t) => t.name === name)).toBe(false)
    }
  })

  it('the timetable tool is re-described there (no verification, no booking), without touching the full one', () => {
    const lite = CACHED_NO_BOOKING_TOOLS.find((t) => t.name === 'list_upcoming_classes')
    expect(lite.description).toBe(NO_BOOKING_CLASS_LIST_DESCRIPTION)
    const full = CACHED_ACCOUNT_TOOLS.find((t) => t.name === 'list_upcoming_classes')
    expect(full.description).toBe(TOOLS_FIXTURE.cached_tools.find((t) => t.name === 'list_upcoming_classes').description)
    expect(deriveNoBookingTools(ALL_AGENT_TOOLS)).toEqual(NO_BOOKING_AGENT_TOOLS)
  })

  it('every tool kept in the no-booking block is the full block\'s own object (bytes shared)', () => {
    for (const t of NO_BOOKING_AGENT_TOOLS) {
      if (t.name === 'list_upcoming_classes') continue
      expect(ALL_AGENT_TOOLS).toContain(t)
    }
  })

  it('capability follows the provider: un1t.online and none take no bookings, Glofox does (T5-A)', () => {
    expect(MEMBERSHIP_SOURCES.un1t_online.capabilities).toEqual({ memberships: false, bookings: false, credits: false, invoices: true, schedule: false })
    expect(providerTakesBookings(MEMBERSHIP_SOURCES.un1t_online)).toBe(false)
    expect(providerTakesBookings(MEMBERSHIP_SOURCES.none)).toBe(false)
    expect(providerTakesBookings(MEMBERSHIP_SOURCES.glofox)).toBe(true)
    expect(providerTakesBookings(undefined)).toBe(false)
  })
})

// ── T5-E / T5-G / T5-I: the prompt ─────────────────────────────────────
describe('prompt variants', () => {
  it('Glofox prompt bytes are unchanged (fixture from the base commit) (T5-E)', () => {
    expect(CUSTOMER_AGENT_BASE_PROMPT).toBe(PROMPT_FIXTURE.base_prompt_default)
    expect(buildCachedSystem(stillorganOpts())).toEqual(PROMPT_FIXTURE.stillorgan_whatsapp)
    expect(buildCachedSystem(stillorganOpts({ membershipUrl: null, identityPreverified: true, knownContact: null })))
      .toEqual(PROMPT_FIXTURE.stillorgan_preverified_no_link)
    expect(buildCachedSystem(stillorganOpts({ cardSets: [], multipleAccounts: true })))
      .toEqual(PROMPT_FIXTURE.stillorgan_instagram_multi)
  })

  it('bookings: true (what auto-reply passes at Glofox) is the same bytes, and ignores a booking link', () => {
    expect(buildCachedSystem(stillorganOpts({ bookings: true, bookingUrl: BOOKING_URL }))).toEqual(PROMPT_FIXTURE.stillorgan_whatsapp)
    expect(renderCustomerAgentBasePrompt(undefined, { bookings: true, bookingUrl: BOOKING_URL })).toBe(PROMPT_FIXTURE.base_prompt_default)
  })

  it('cache_control placement is unchanged for Glofox: one 1h breakpoint on the stable block', () => {
    const sys = buildCachedSystem(stillorganOpts({ bookings: true }))
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(sys.slice(1).every((b) => !b.cache_control)).toBe(true)
  })

  it('no booking link: no booking claim, hand the customer to the team, account questions to the team', () => {
    const { stable } = buildCustomerSystemPromptParts(hatchOpts({ bookingUrl: null }))
    expect(stable).toContain("You can't book or cancel classes here. To book, hand the customer to the team.")
    expect(stable).toContain(NO_BOOKING_ACCOUNT_HANDOFF)
    expect(stable).not.toContain('You CAN book classes')
    expect(stable).not.toContain('You CAN cancel')
    expect(stable).not.toContain('https://hatch.example.test')
  })

  it('a booking link: share it, never book; the link is in the prompt (the membership-link pattern)', () => {
    const { stable } = buildCustomerSystemPromptParts(hatchOpts())
    expect(stable).toContain("You can't book or cancel classes here. To book, send the studio's booking link.")
    expect(stable).toContain(`The studio's booking link is ${BOOKING_URL}.`)
    expect(stable).toContain('For membership, payments or account questions, hand off to the team.')
    expect(stable).not.toContain('You CAN book classes')
  })

  it('the no-booking prompt names no tool Mia does not have there', () => {
    for (const link of [BOOKING_URL, null]) {
      const { stable } = buildCustomerSystemPromptParts(hatchOpts({ bookingUrl: link }))
      for (const name of BOOKING_SYSTEM_TOOL_NAMES) expect(stable).not.toContain(name)
    }
  })

  it('every line the no-booking prompt adds is free of em and en dashes', () => {
    const glofoxLines = new Set(PROMPT_FIXTURE.base_prompt_default.split('\n'))
    for (const link of [BOOKING_URL, null]) {
      const added = renderCustomerAgentBasePrompt({ key: 'un1t_online', label: 'un1t.online' }, { bookings: false, bookingUrl: link })
        .split('\n').filter((l) => !glofoxLines.has(l))
      expect(added.length).toBeGreaterThan(5)
      for (const l of added) expect(l).not.toMatch(/[—–]/)
    }
  })

  it('the no-booking stable prefix is byte-stable across turns at the same studio (T5-I)', () => {
    const a = buildCachedSystem(hatchOpts({ today: 'Saturday, 17 October 2026', identityPreverified: false }))
    const b = buildCachedSystem(hatchOpts({ today: 'Sunday, 18 October 2026', identityPreverified: true, knownContact: null }))
    expect(a[0]).toEqual(b[0])
    expect(a[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(buildCachedSystem(hatchOpts())[0].text).toBe(buildCachedSystem(hatchOpts())[0].text)
  })
})

// ── T5-G: the booking link as a button ─────────────────────────────────
describe('linkButtonText (T5-G)', () => {
  it('the booking link carries booking_cta_label, default "Book a class"', () => {
    expect(linkButtonText(BOOKING_URL, { booking_url: BOOKING_URL })).toBe('Book a class')
    expect(linkButtonText(`${BOOKING_URL}/`, { booking_url: BOOKING_URL, booking_cta_label: ' Book now ' })).toBe('Book now')
  })
  it('any other link keeps link_button_text / "Open link" (Glofox studios: no booking_url, unchanged)', () => {
    expect(linkButtonText('https://example.test/join', { booking_url: BOOKING_URL })).toBe('Open link')
    expect(linkButtonText('https://example.test/join', STILLORGAN_BLOB)).toBe('Open link')
    expect(linkButtonText('https://example.test/join', { link_button_text: 'Join' })).toBe('Join')
  })
})

// ── T5-B: the executor refuses ─────────────────────────────────────────
function throwingDb() {
  return { from: vi.fn(() => { throw new Error('no read may happen') }) }
}

describe('executor refusal at a no-booking studio (T5-B)', () => {
  it('refuses every booking-system tool only where canBook is explicitly false', () => {
    for (const name of BOOKING_SYSTEM_TOOL_NAMES) {
      expect(refuseAtNoBookingStudio(name, { canBook: false })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      expect(refuseAtNoBookingStudio(name, { canBook: true })).toBeNull()
      expect(refuseAtNoBookingStudio(name, {})).toBeNull()
    }
    expect(refuseAtNoBookingStudio('list_upcoming_classes', { canBook: false })).toBeNull()
    expect(refuseAtNoBookingStudio('request_pause', { canBook: false })).toBeNull()
  })

  it('a fabricated get_my_membership at Hatch is refused with no read and no Glofox call', async () => {
    const db = throwingDb()
    const r = await executeAccountTool('get_my_membership', {}, { db, canBook: false, verifiedContactId: STILLORGAN_CONTACT, locationId: HATCH })
    expect(r).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('a fabricated book_class / cancel at Hatch is refused with no Glofox call', async () => {
    for (const name of ['book_class', 'cancel_class_booking', 'list_my_upcoming_bookings']) {
      const db = throwingDb()
      const r = await executeBookingTool(name, { event_id: '64aa00000000000000000001' }, { db, canBook: false, verifiedContactId: STILLORGAN_CONTACT, locationId: HATCH })
      expect(r).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      expect(db.from).not.toHaveBeenCalled()
    }
    for (const fn of Object.values(glofox)) if (typeof fn === 'function' && fn.mock) expect(fn).not.toHaveBeenCalled()
  })
})

// ── T5-F: the un1t.online timetable ────────────────────────────────────
function timetableDb({ rows = [], error = null } = {}) {
  const calls = []
  const db = {
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {}
      for (const op of ['select', 'eq', 'gte', 'lte', 'order', 'limit']) {
        b[op] = (...args) => { q.ops.push([op, ...args]); return b }
      }
      b.then = (resolve, reject) => Promise.resolve({ data: error ? null : rows, error }).then(resolve, reject)
      return b
    },
  }
  return { db, calls }
}
const HATCH_CTX = { canBook: false, membershipSourceKey: 'un1t_online', locationId: HATCH, zone: 'Europe/Dublin' }

describe('list_upcoming_classes at an un1t.online studio (T5-F)', () => {
  it('reads THIS studio\'s scheduled un1t_events, next 14 days, earliest first, 100 max, two columns', async () => {
    const { db, calls } = timetableDb()
    const before = Date.now()
    await executeBookingTool('list_upcoming_classes', {}, { ...HATCH_CTX, db })
    expect(calls).toHaveLength(1)
    const { table, ops } = calls[0]
    expect(table).toBe('un1t_events')
    expect(ops).toContainEqual(['select', 'title, starts_at'])
    expect(ops).toContainEqual(['eq', 'location_id', HATCH])
    expect(ops).toContainEqual(['eq', 'status', 'scheduled'])
    expect(ops).toContainEqual(['order', 'starts_at', { ascending: true }])
    expect(ops).toContainEqual(['limit', UN1T_TIMETABLE_LIMIT])
    // Final review: Hatch runs ~59 classes in 14 days; 40 cut the window short.
    expect(UN1T_TIMETABLE_LIMIT).toBe(100)
    const gte = Date.parse(ops.find((o) => o[0] === 'gte')[2])
    const lte = Date.parse(ops.find((o) => o[0] === 'lte')[2])
    expect(ops.find((o) => o[0] === 'gte')[1]).toBe('starts_at')
    expect(gte).toBeGreaterThanOrEqual(before - 1000)
    expect(lte - gte).toBe(UN1T_TIMETABLE_DAYS * 86400_000)
    expect(UN1T_TIMETABLE_DAYS).toBe(14)
    // Never a verification gate on the public timetable, and never Glofox.
    expect(glofox.glofoxCredentialsForLocation).not.toHaveBeenCalled()
    expect(glofox.fetchUpcomingEvents).not.toHaveBeenCalled()
  })

  it('a full page (Hatch: 59+ classes in 14 days) says truncated: true; a shorter one does not; still name + time only', async () => {
    const at = (i) => new Date(Date.UTC(2026, 9, 20, 6) + i * 3600_000).toISOString()
    const many = Array.from({ length: UN1T_TIMETABLE_LIMIT }, (_, i) => ({ title: `Class ${i}`, starts_at: at(i), capacity: 12, bookings_count: 3 }))
    const full = await executeBookingTool('list_upcoming_classes', {}, { ...HATCH_CTX, db: timetableDb({ rows: many }).db })
    expect(Object.keys(full)).toEqual(['classes', 'truncated'])
    expect(full.truncated).toBe(true)
    expect(full.classes).toHaveLength(UN1T_TIMETABLE_LIMIT)
    for (const c of full.classes) expect(Object.keys(c)).toEqual(['name', 'starts_at'])
    const hatchFortnight = many.slice(0, 59)
    const part = await executeBookingTool('list_upcoming_classes', {}, { ...HATCH_CTX, db: timetableDb({ rows: hatchFortnight }).db })
    expect(Object.keys(part)).toEqual(['classes'])
    expect(part.classes).toHaveLength(59)
  })

  it('the no-booking timetable description tells Mia a truncated list is partial', () => {
    expect(NO_BOOKING_CLASS_LIST_DESCRIPTION).toMatch(/truncated: true/)
    expect(NO_BOOKING_CLASS_LIST_DESCRIPTION).toMatch(/never say a later day has nothing on/)
    expect(NO_BOOKING_CLASS_LIST_DESCRIPTION).not.toMatch(/\u2014|\u2013/)
  })

  it('answers { classes: [{ name, starts_at }] } ONLY, never capacity or bookings (Review Focus 5)', async () => {
    // Even if a row carried extra columns, the shape drops them.
    const rows = [{
      title: 'HYROX', starts_at: '2026-10-20T07:00:00Z',
      capacity: 12, bookings_count: 11, access_mode: 'open', raw: { clients_limit: 12, bookings_count: 11 },
    }]
    const { db } = timetableDb({ rows })
    const r = await executeBookingTool('list_upcoming_classes', {}, { ...HATCH_CTX, db })
    expect(Object.keys(r)).toEqual(['classes'])
    expect(r.classes).toEqual([{ name: 'HYROX', starts_at: 'Tue 20 Oct, 08:00' }])
    expect(Object.keys(r.classes[0])).toEqual(['name', 'starts_at'])
    expect(JSON.stringify(r)).not.toMatch(/capacity|bookings_count|access_mode|raw|clients_limit|full|limited|spaces/)
  })

  it('times are the studio\'s wall clock, formatted like the Glofox list', () => {
    const rows = [{ title: 'ENG1NE', starts_at: '2026-10-20T07:00:00Z' }, { title: '', starts_at: 'not a date' }]
    expect(shapeUn1tClassesForAgent(rows, 'Europe/Dublin')).toEqual([{ name: 'ENG1NE', starts_at: formatClassTime(Date.parse('2026-10-20T07:00:00Z') / 1000, 'Europe/Dublin') }])
    expect(shapeUn1tClassesForAgent(rows, 'America/New_York')[0].starts_at).toBe('Tue 20 Oct, 03:00')
    // Across the Dublin clock change (25 Oct 2026): 07:00Z is 08:00 before, 07:00 after.
    expect(shapeUn1tClassesForAgent([{ title: 'A', starts_at: '2026-10-26T07:00:00Z' }], 'Europe/Dublin')[0].starts_at).toBe('Mon 26 Oct, 07:00')
  })

  it('a read failure answers the no_booking_system shape and logs', async () => {
    const { db } = timetableDb({ error: { message: 'boom', code: '57014' } })
    const r = await executeBookingTool('list_upcoming_classes', {}, { ...HATCH_CTX, db })
    expect(r).toEqual({ error: 'no_booking_system', message: expect.any(String) })
    expect(logError).toHaveBeenCalledWith('agent-timetable', expect.any(String), expect.objectContaining({ locationId: HATCH }))
  })

  it('a no-booking studio with no source has no timetable: no_booking_system, no read', async () => {
    const db = throwingDb()
    const r = await executeBookingTool('list_upcoming_classes', {}, { ...HATCH_CTX, membershipSourceKey: 'none', db })
    expect(r.error).toBe('no_booking_system')
    expect(db.from).not.toHaveBeenCalled()
  })

  it('a Glofox studio keeps today\'s path (verification first, then Glofox)', async () => {
    const r = await executeBookingTool('list_upcoming_classes', {}, { canBook: true, membershipSourceKey: 'glofox', db: throwingDb(), locationId: STILLORGAN })
    expect(r.error).toBe('not_verified')
  })
})

// ── T5-H: consultation type guard ──────────────────────────────────────
function eventTypesDb({ pinned, discovered }) {
  const calls = []
  return {
    calls,
    from() {
      const q = { ops: [] }
      calls.push(q)
      const b = {}
      for (const op of ['select', 'eq', 'or', 'order', 'limit']) b[op] = (...a) => { q.ops.push([op, ...a]); return b }
      b.maybeSingle = () => Promise.resolve({ data: pinned, error: null })
      b.then = (resolve, reject) => Promise.resolve({ data: discovered ? [discovered] : [], error: null }).then(resolve, reject)
      return b
    },
  }
}

describe('resolveConsultationEventType (T5-H)', () => {
  const stillorganType = { id: 'e0000000-0000-0000-0000-0000000000e1', name: 'Consultation', location_id: STILLORGAN }
  const hatchType = { id: 'e0000000-0000-0000-0000-0000000000e2', name: 'Intro session', location_id: HATCH }

  it('a Stillorgan type pinned at Hatch is ignored; discovery finds Hatch\'s own', async () => {
    const db = eventTypesDb({ pinned: stillorganType, discovered: hatchType })
    const t = await resolveConsultationEventType(db, HATCH, { consultation_event_type_id: stillorganType.id })
    expect(t).toEqual(hatchType)
    expect(db.calls[1].ops).toContainEqual(['eq', 'location_id', HATCH])
  })

  it('a type pinned at its own studio wins, as before', async () => {
    const db = eventTypesDb({ pinned: stillorganType, discovered: null })
    expect(await resolveConsultationEventType(db, STILLORGAN, { consultation_event_type_id: stillorganType.id })).toEqual(stillorganType)
  })

  it('a foreign pin with nothing to discover is no consultation type, never the other studio\'s', async () => {
    const db = eventTypesDb({ pinned: stillorganType, discovered: null })
    expect(await resolveConsultationEventType(db, HATCH, { consultation_event_type_id: stillorganType.id })).toBeNull()
  })
})

// ── Review Focus 2 + 4: whole turns through the runner ─────────────────
function turnDb({ locationId, source, settings, conv, rows = [] }) {
  const reads = []
  const mk = (table) => {
    const state = { op: 'select', cols: null, selectOpts: null }
    const finish = () => {
      if (state.op === 'update') return { data: [{ id: 'conv-1' }], error: null }
      reads.push({ table, cols: state.cols })
      if (table === 'locations') {
        // A narrow source-only read (the old separate lookup) fails here.
        if (state.cols === 'membership_source') return { data: null, error: { message: 'statement timeout', code: '57014' } }
        return { data: { id: locationId, name: 'Studio', membership_source: source, settings: { customer_agent: settings } }, error: null }
      }
      if (table === 'whatsapp_conversations') return { data: conv, error: null }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: 0, error: null }
        if (state.sawGt) return { data: [], error: null }
        return { data: [{ direction: 'inbound', body: 'can I book the 7am class?', message_type: 'text', created_at: new Date().toISOString() }], error: null }
      }
      if (table === 'un1t_events') return { data: rows, error: null }
      return { data: [], error: null }
    }
    const builder = {
      select: (cols, opts) => { state.cols = cols; if (opts) state.selectOpts = opts; return builder },
      update: () => { state.op = 'update'; return builder },
      insert: () => Promise.resolve({ error: null }),
      eq: () => builder, or: () => builder, gte: () => builder, lte: () => builder,
      gt: () => { state.sawGt = true; return builder },
      is: () => builder, in: () => builder, order: () => builder, limit: () => builder,
      single: () => builder, maybeSingle: () => builder,
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return builder
  }
  return { db: { from: mk }, reads }
}

function makeAdapter() {
  return {
    name: 'whatsapp', label: 'WhatsApp',
    conversationsTable: 'whatsapp_conversations', messagesTable: 'whatsapp_messages',
    nameColumn: 'wa_profile_name', pushCategory: 'whatsapp', handoffType: 'whatsapp_agent_handoff',
    trustsSenderIdentity: false,
    send: vi.fn().mockResolvedValue({ messageId: 'wamid.x' }),
    outboundRow: ({ conversationId, locationId, contactId, messageId, text, now }) => ({
      conversation_id: conversationId, location_id: locationId, contact_id: contactId || null,
      wa_message_id: messageId, direction: 'outbound', message_type: 'text',
      body: text, status: 'sent', source: 'agent', sent_at: now,
    }),
  }
}

// The model's turns, in order; every request body is captured.
function modelTurns(turns) {
  const bodies = []
  let i = 0
  const fetchFn = vi.fn().mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => turns[Math.min(i++, turns.length - 1)] }
  })
  return { fetchFn, bodies }
}
const toolTurn = (name, input = {}) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name, input }] })
const textTurn = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })
const toolResultOf = (body) => JSON.parse(body.messages.at(-1).content[0].content)

// A Hatch thread (filed at Hatch) bound to a Stillorgan-homed, verified contact.
const HATCH_THREAD = { agent_active: true, contact_id: STILLORGAN_CONTACT, agent_verified_contact_id: STILLORGAN_CONTACT, agent_verified_at: new Date().toISOString(), agent_last_reply_at: null }
const turnCtx = (locationId) => ({
  conversationId: 'conv-1', locationId, recipient: '353870000000', contactId: STILLORGAN_CONTACT,
  messageType: 'text', body: 'can I book the 7am class?', connection: null,
})

let errSpy, warnSpy
describe('whole turns', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
    warnSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('Review Focus 4: a Hatch thread bound to a Stillorgan contact cannot reach get_my_membership', async () => {
    const { fetchFn, bodies } = modelTurns([toolTurn('get_my_membership'), textTurn('[[HANDOFF]] asks about their membership')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, reads } = turnDb({ locationId: HATCH, source: 'un1t_online', settings: { enabled: true }, conv: HATCH_THREAD })

    const result = await runChannelAgent(db, makeAdapter(), turnCtx(HATCH))

    // Never offered...
    expect(bodies[0].tools.map((t) => t.name)).toEqual(NO_BOOKING_NAMES)
    expect(bodies[0].system[0].text).toContain(NO_BOOKING_ACCOUNT_HANDOFF)
    // ...and refused when invented: no membership read, no Glofox call.
    expect(toolResultOf(bodies[1])).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(reads.some((r) => /glofox/.test(r.cols || ''))).toBe(false)
    for (const fn of Object.values(glofox)) if (typeof fn === 'function' && fn.mock) expect(fn).not.toHaveBeenCalled()
    expect(result).toMatchObject({ handled: true, action: 'handoff' })
  })

  it('Review Focus 2: "can I book the 7am class?" at Hatch with a link: no booking tool, a fabricated book_class is refused, the link goes out', async () => {
    const reply = `You can book the 7am class here: ${BOOKING_URL}`
    const { fetchFn, bodies } = modelTurns([toolTurn('book_class', { event_id: '64aa00000000000000000001' }), textTurn(reply)])
    vi.stubGlobal('fetch', fetchFn)
    const settings = { enabled: true, booking_url: BOOKING_URL }
    const { db } = turnDb({ locationId: HATCH, source: 'un1t_online', settings, conv: HATCH_THREAD })
    const adapter = makeAdapter()

    const result = await runChannelAgent(db, adapter, turnCtx(HATCH))

    const names = bodies[0].tools.map((t) => t.name)
    expect(names).not.toContain('book_class')
    expect(names).not.toContain('cancel_class_booking')
    expect(bodies[0].system[0].text).toContain(`The studio's booking link is ${BOOKING_URL}.`)
    expect(bodies[0].system[0].text).not.toContain('You CAN book classes')
    const refused = toolResultOf(bodies[1])
    expect(refused).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(refused.booked).toBeUndefined()
    expect(glofox.createBooking).not.toHaveBeenCalled()
    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(adapter.send.mock.calls[0][1]).toBe(reply)
    expect(linkButtonText(BOOKING_URL, adapter.send.mock.calls[0][2].settings)).toBe('Book a class')
  })

  it('Review Focus 2: with no link set, the prompt hands the booking to the team', async () => {
    const { fetchFn, bodies } = modelTurns([textTurn('[[HANDOFF]] wants to book the 7am class')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ locationId: HATCH, source: 'un1t_online', settings: { enabled: true }, conv: HATCH_THREAD })

    const result = await runChannelAgent(db, makeAdapter(), turnCtx(HATCH))

    expect(bodies[0].system[0].text).toContain("You can't book or cancel classes here. To book, hand the customer to the team.")
    expect(result).toMatchObject({ handled: true, action: 'handoff' })
  })

  it('Review Focus 5: the Hatch timetable answer the model sees has no capacity or bookings', async () => {
    const { fetchFn, bodies } = modelTurns([toolTurn('list_upcoming_classes'), textTurn('There is HYROX at 08:00 on Tuesday.')])
    vi.stubGlobal('fetch', fetchFn)
    const rows = [{ title: 'HYROX', starts_at: '2026-10-20T07:00:00Z', capacity: 12, bookings_count: 11, access_mode: 'open' }]
    const { db, reads } = turnDb({ locationId: HATCH, source: 'un1t_online', settings: { enabled: true }, conv: { ...HATCH_THREAD, agent_verified_contact_id: null, agent_verified_at: null }, rows })

    await runChannelAgent(db, makeAdapter(), turnCtx(HATCH))

    expect(reads.find((r) => r.table === 'un1t_events').cols).toBe('title, starts_at')
    const result = toolResultOf(bodies[1])
    expect(result).toEqual({ classes: [{ name: 'HYROX', starts_at: 'Tue 20 Oct, 08:00' }] })
    expect(JSON.stringify(bodies[1].messages.at(-1))).not.toMatch(/capacity|bookings_count|access_mode/)
  })

  it('the source comes off the resolver\'s location row: no separate source read, so a failing one cannot flip Stillorgan', async () => {
    const { fetchFn, bodies } = modelTurns([textTurn('Hi!')])
    vi.stubGlobal('fetch', fetchFn)
    const { db, reads } = turnDb({ locationId: STILLORGAN, source: 'glofox', settings: { enabled: true }, conv: HATCH_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx(STILLORGAN))

    expect(resolveMembershipSource).not.toHaveBeenCalled()
    const locReads = reads.filter((r) => r.table === 'locations')
    expect(locReads.map((r) => r.cols)).toEqual(['id, name, timezone, organization_id, membership_source, settings'])
    expect(bodies[0].tools).toEqual(JSON.parse(JSON.stringify(CACHED_ACCOUNT_TOOLS)))
    expect(bodies[0].system[0].text).toContain('You CAN book classes for verified members')
    // The prompt's app rules use the same value (Glofox payment page / app).
    expect(bodies[0].system[0].text).toContain('the Glofox app')
  })

  it('a location row with no source (a narrow select) is none: no booking, never a guess', async () => {
    const { fetchFn, bodies } = modelTurns([textTurn('Hi!')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ locationId: HATCH, source: undefined, settings: { enabled: true }, conv: HATCH_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx(HATCH))

    expect(bodies[0].tools.map((t) => t.name)).toEqual(NO_BOOKING_NAMES)
  })

  it('a Glofox studio turn sends the very same cached tool block and the booking prompt', async () => {
    const { fetchFn, bodies } = modelTurns([textTurn('Hi!')])
    vi.stubGlobal('fetch', fetchFn)
    const { db } = turnDb({ locationId: STILLORGAN, source: 'glofox', settings: { enabled: true, booking_url: BOOKING_URL }, conv: HATCH_THREAD })

    await runChannelAgent(db, makeAdapter(), turnCtx(STILLORGAN))

    expect(bodies[0].tools).toEqual(JSON.parse(JSON.stringify(CACHED_ACCOUNT_TOOLS)))
    expect(bodies[0].system[0].text).toContain('You CAN book classes for verified members')
    expect(bodies[0].system[0].text).not.toContain(BOOKING_URL)
  })
})
