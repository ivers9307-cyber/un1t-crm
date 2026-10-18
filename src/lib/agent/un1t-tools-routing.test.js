// MIAHATCH.2 — the dispatch in executeAccountTool / executeBookingTool: a turn
// whose tool block starts with `un1t_` routes the four member reads to
// un1t-tools. The other half (every other turn runs today's code and never loads
// un1t-tools) is un1t-tools-glofox-only.test.js, which needs a module registry
// of its own.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const probe = vi.hoisted(() => ({ executeUn1tRead: vi.fn(async () => ({ routed: 'un1t' })) }))
vi.mock('./un1t-tools', () => ({ executeUn1tRead: probe.executeUn1tRead }))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))

import { executeAccountTool } from './account-tools'
import { executeBookingTool } from './booking-tools'

const HATCH = { locationId: 'loc-h', name: 'Hatch', providerKey: 'un1t_online', active: true, answerable: true, contactIds: ['c-1'], un1tUserId: 'u-1' }

// A db that answers every read with nothing and remembers which tables it was asked for.
function recordingDb() {
  const tables = []
  const from = (table) => {
    tables.push(table)
    const b = {
      select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b, range: () => b, gte: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
    }
    return b
  }
  return { from, tables }
}

const turn = (block) => ({ block, answerable: [HATCH], channel: 'whatsapp', un1tWrites: false })
const ctxOf = (db, over = {}) => ({ db, conversationId: 'conv-1', conversationsTable: 'whatsapp_conversations', contactId: 'c-1', verifiedContactId: 'c-1', locationId: 'loc-h', channel: 'whatsapp', ...over })

beforeEach(() => {
  probe.executeUn1tRead.mockClear()
})

describe('un1t block -> executeUn1tRead', () => {
  it.each([
    ['un1t_read'], ['un1t_read_dual'], ['un1t_full'],
  ])('routes the three account reads in %s with the turn\'s answerable studios', async (block) => {
    const db = recordingDb()
    for (const tool of ['get_my_membership', 'get_my_next_class', 'get_my_recent_attendance']) {
      const ctx = ctxOf(db, { turn: turn(block) })
      expect(await executeAccountTool(tool, { x: 1 }, ctx)).toEqual({ routed: 'un1t' })
      expect(probe.executeUn1tRead).toHaveBeenLastCalledWith(tool, { x: 1 }, ctx, ctx.turn.answerable)
    }
    expect(db.tables).toEqual([])
  })
  it('routes list_my_upcoming_bookings through executeBookingTool', async () => {
    const db = recordingDb()
    const ctx = ctxOf(db, { turn: turn('un1t_read') })
    expect(await executeBookingTool('list_my_upcoming_bookings', {}, ctx)).toEqual({ routed: 'un1t' })
    expect(probe.executeUn1tRead).toHaveBeenLastCalledWith('list_my_upcoming_bookings', {}, ctx, ctx.turn.answerable)
    expect(db.tables).toEqual([])
  })
  it('an unverified turn gets today\'s not_verified object and never reaches un1t', async () => {
    const expected = { error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' }
    const ctx = ctxOf(recordingDb(), { turn: turn('un1t_read'), verifiedContactId: null })
    expect(await executeAccountTool('get_my_membership', {}, ctx)).toEqual(expected)
    expect(await executeBookingTool('list_my_upcoming_bookings', {}, ctx)).toEqual(expected)
    expect(probe.executeUn1tRead).not.toHaveBeenCalled()
  })
  it('tools outside the four reads keep their own executor in a un1t block', async () => {
    const db = recordingDb()
    expect(await executeAccountTool('get_my_payment_reminder', {}, ctxOf(db, { turn: turn('un1t_read') })))
      .toMatchObject({ error: 'not_available_at_this_studio' })
    expect(probe.executeUn1tRead).not.toHaveBeenCalled()
  })
})
