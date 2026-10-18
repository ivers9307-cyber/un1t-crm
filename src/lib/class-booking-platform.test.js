import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeOfFile } from '../../tests/helpers/js-code.js'
import {
  CRM_CLASS_MESSAGING_PLATFORM,
  crmMayActOnClassBooking,
  scopeToCrmActionable,
  readUn1tOnlineLocationIds,
} from './class-booking-platform.js'
import * as classBookings from './class-bookings.js'

const GLOFOX_STUDIO = 'a0000000-0000-4000-8000-000000000001'
const ONLINE_STUDIO = 'b0000000-0000-4000-8000-000000000002'
const online = new Set([ONLINE_STUDIO])

// A minimal stand-in for the supabase builder `listLocationsByMembershipSource`
// walks: from().select().eq().order().range() -> { data, error }.
function fakeDb(result) {
  const calls = []
  const builder = {
    select: (...a) => (calls.push(['select', ...a]), builder),
    eq: (...a) => (calls.push(['eq', ...a]), builder),
    order: (...a) => (calls.push(['order', ...a]), builder),
    range: (...a) => (calls.push(['range', ...a]), Promise.resolve(result)),
  }
  return { db: { from: (t) => (calls.push(['from', t]), builder) }, calls }
}

describe('crmMayActOnClassBooking', () => {
  it('a glofox row at a Glofox studio is actionable', () => {
    expect(crmMayActOnClassBooking({ source_platform: 'glofox', location_id: GLOFOX_STUDIO }, { un1tOnlineLocationIds: online })).toBe(true)
  })

  it('a un1t_online row is not', () => {
    expect(crmMayActOnClassBooking({ source_platform: 'un1t_online', location_id: GLOFOX_STUDIO }, { un1tOnlineLocationIds: online })).toBe(false)
  })

  it('a glofox-tagged row at a un1t_online studio is not', () => {
    expect(crmMayActOnClassBooking({ source_platform: 'glofox', location_id: ONLINE_STUDIO }, { un1tOnlineLocationIds: online })).toBe(false)
  })

  it('a row with no source_platform key is not', () => {
    expect(crmMayActOnClassBooking({ location_id: GLOFOX_STUDIO }, { un1tOnlineLocationIds: online })).toBe(false)
    expect(crmMayActOnClassBooking({ source_platform: null, location_id: GLOFOX_STUDIO }, { un1tOnlineLocationIds: online })).toBe(false)
  })

  it('throws TypeError without a Set', () => {
    const row = { source_platform: 'glofox', location_id: GLOFOX_STUDIO }
    expect(() => crmMayActOnClassBooking(row, { un1tOnlineLocationIds: [ONLINE_STUDIO] })).toThrow(TypeError)
    expect(() => crmMayActOnClassBooking(row, { un1tOnlineLocationIds: null })).toThrow(TypeError)
    expect(() => crmMayActOnClassBooking(row, {})).toThrow(TypeError)
    expect(() => crmMayActOnClassBooking(row)).toThrow(TypeError)
  })
})

describe('CRM_CLASS_MESSAGING_PLATFORM', () => {
  it("is 'glofox' and class-bookings.js re-exports the same constant", () => {
    expect(CRM_CLASS_MESSAGING_PLATFORM).toBe('glofox')
    expect(classBookings.CRM_CLASS_MESSAGING_PLATFORM).toBe(CRM_CLASS_MESSAGING_PLATFORM)
  })
})

describe('scopeToCrmActionable', () => {
  it('adds eq source_platform glofox and returns the builder', () => {
    const next = {}
    const query = { eq: vi.fn(() => next) }
    expect(scopeToCrmActionable(query)).toBe(next)
    expect(query.eq).toHaveBeenCalledWith('source_platform', 'glofox')
  })
})

describe('readUn1tOnlineLocationIds', () => {
  it('returns a Set of ids', async () => {
    const { db, calls } = fakeDb({ data: [{ id: ONLINE_STUDIO }], error: null })
    const out = await readUn1tOnlineLocationIds(db)
    expect(out.error).toBeNull()
    expect(out.ids).toBeInstanceOf(Set)
    expect([...out.ids]).toEqual([ONLINE_STUDIO])
    expect(calls).toContainEqual(['eq', 'membership_source', 'un1t_online'])
  })

  it('a failed read returns ids null and the error', async () => {
    const failure = { message: 'boom' }
    const { db } = fakeDb({ data: null, error: failure })
    // listLocationsByMembershipSource logs the failure; keep the run quiet.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const out = await readUn1tOnlineLocationIds(db)
      expect(out.ids).toBeNull()
      expect(out.error).toBe(failure)
    } finally {
      quiet.mockRestore()
    }
  })
})

describe('the module consults nothing but the row and the location list', () => {
  it('consults no capability, setting or env', () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'class-booking-platform.js')
    const code = codeOfFile(file)
    expect(code).not.toMatch(/capabilities/)
    expect(code).not.toMatch(/notification_config/)
    expect(code).not.toMatch(/settings/)
    expect(code).not.toMatch(/process\.env/)
  })
})
