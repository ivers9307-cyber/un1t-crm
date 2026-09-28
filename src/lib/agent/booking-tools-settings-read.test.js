// REGISTRYREAD.1b — Mia must not tell a customer the studio has no booking
// system because one settings read failed. glofoxCredentialsForLocation
// answers a failed read with all-null credentials plus readError; each of the
// four booking tools that answered no_booking_system on null credentials now
// answers booking_system_unavailable for that case, and never calls Glofox.
// Draft mode never needed credentials and is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(),
  missingGlofoxCredentialsForLocation: vi.fn((c) => (c?.branchId ? [] : ['Branch ID', 'API Key', 'API Token'])),
  fetchUpcomingEvents: vi.fn(async () => { throw new Error('fetchUpcomingEvents must not be called') }),
  fetchUserBookingsResult: vi.fn(async () => { throw new Error('fetchUserBookingsResult must not be called') }),
  fetchUserCreditsResult: vi.fn(async () => { throw new Error('fetchUserCreditsResult must not be called') }),
  createBooking: vi.fn(async () => { throw new Error('createBooking must not be called') }),
  cancelBooking: vi.fn(async () => { throw new Error('cancelBooking must not be called') }),
}))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))

import * as glofox from '@/lib/glofox'
import { executeBookingTool, noBookingSystemAnswer } from './booking-tools'

const GLOFOX_MEMBER = '64aa000000000000000000aa'
const EVENT_ID = '64aa00000000000000000001'
const BOOKING_ID = '64bb00000000000000000001'

// One synthetic contact linked to Glofox; every other read comes back empty,
// every insert gets an id.
function stubDb() {
  const inserts = []
  return {
    inserts,
    from(table) {
      const st = { table, op: 'select' }
      const settle = (single) => {
        if (st.op === 'insert') { inserts.push(table); return { data: { id: 'req-1' }, error: null } }
        if (table === 'contacts') {
          const row = { id: 'c-1', glofox_member_id: GLOFOX_MEMBER, glofox_membership_status: 'member', glofox_membership_state: 'active' }
          return single ? { data: row, error: null } : { data: [row], error: null }
        }
        return { data: single ? null : [], error: null }
      }
      const b = {}
      for (const m of ['select', 'eq', 'neq', 'in', 'not', 'is', 'or', 'ilike', 'order', 'limit', 'range', 'gte', 'lte', 'filter', 'contains']) b[m] = () => b
      b.insert = () => { st.op = 'insert'; return b }
      b.update = () => { st.op = 'update'; return b }
      b.maybeSingle = async () => settle(true)
      b.single = async () => settle(true)
      b.then = (resolve, reject) => Promise.resolve(settle(false)).then(resolve, reject)
      return b
    },
  }
}

const ctxFor = (mode, db = stubDb()) => ({
  db, locationId: 'loc-1', verifiedContactId: 'c-1', contactId: 'c-1',
  conversationId: 'conv-1', conversationsTable: 'whatsapp_conversations', channel: 'whatsapp',
  nameHint: 'Test Person', settings: { booking_mode: mode },
})
const UNREADABLE = { branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' }
const NOT_CONFIGURED = { branchId: null, apiKey: null, apiToken: null, readError: null }

beforeEach(() => vi.clearAllMocks())

function expectNoGlofoxCall() {
  expect(glofox.fetchUpcomingEvents).not.toHaveBeenCalled()
  expect(glofox.fetchUserBookingsResult).not.toHaveBeenCalled()
  expect(glofox.fetchUserCreditsResult).not.toHaveBeenCalled()
  expect(glofox.createBooking).not.toHaveBeenCalled()
  expect(glofox.cancelBooking).not.toHaveBeenCalled()
}

describe('noBookingSystemAnswer', () => {
  it('an unreadable settings row is "unavailable just now", never "not connected"', () => {
    const a = noBookingSystemAnswer(UNREADABLE)
    expect(a.error).toBe('booking_system_unavailable')
    expect(a.message).not.toMatch(/not connected/)
    expect(a.message).toMatch(/hand off/)
  })
  it('a studio with no Glofox is still no_booking_system, word for word', () => {
    expect(noBookingSystemAnswer(NOT_CONFIGURED)).toEqual({
      error: 'no_booking_system',
      message: 'Class booking is not connected at this studio — hand off to the team.',
    })
    expect(noBookingSystemAnswer(null).error).toBe('no_booking_system')
  })
})

describe.each([
  ['list_upcoming_classes', {}, 'auto'],
  ['book_class', { event_id: EVENT_ID, class_name: 'HIIT', class_time: 'Mon 7am' }, 'auto'],
  ['list_my_upcoming_bookings', {}, 'auto'],
  ['cancel_class_booking', { booking_id: BOOKING_ID, class_name: 'HIIT', class_time: 'Mon 7am' }, 'auto'],
])('%s', (tool, input, mode) => {
  it('answers booking_system_unavailable on an unreadable settings row and never calls Glofox', async () => {
    glofox.glofoxCredentialsForLocation.mockResolvedValue(UNREADABLE)
    const out = await executeBookingTool(tool, input, ctxFor(mode))
    expect(out.error).toBe('booking_system_unavailable')
    expectNoGlofoxCall()
  })

  it('a studio with no Glofox still answers no_booking_system', async () => {
    glofox.glofoxCredentialsForLocation.mockResolvedValue(NOT_CONFIGURED)
    const out = await executeBookingTool(tool, input, ctxFor(mode))
    expect(out.error).toBe('no_booking_system')
  })
})

describe('draft mode never needed credentials and is unchanged', () => {
  it('book_class still drafts for staff on an unreadable settings row', async () => {
    glofox.glofoxCredentialsForLocation.mockResolvedValue(UNREADABLE)
    const db = stubDb()
    const out = await executeBookingTool('book_class', { event_id: EVENT_ID, class_name: 'HIIT' }, ctxFor('draft', db))
    expect(out.requested).toBe(true)
    expect(out.error).toBeUndefined()
    expect(db.inserts).toContain('agent_membership_requests')
    expectNoGlofoxCall()
  })

  it('cancel_class_booking still drafts for staff on an unreadable settings row', async () => {
    glofox.glofoxCredentialsForLocation.mockResolvedValue(UNREADABLE)
    const db = stubDb()
    const out = await executeBookingTool('cancel_class_booking', { booking_id: BOOKING_ID }, ctxFor('draft', db))
    expect(out.requested).toBe(true)
    expect(out.error).toBeUndefined()
    expectNoGlofoxCall()
  })
})
