// UN1TWRITE.14 — the staff un1t.online booking gate and answer mapping.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./un1t-online-settings.js', async (importOriginal) => ({ ...(await importOriginal()), readUn1tWriteSettings: vi.fn() }))

import { gateUn1tStaffBooking, staffWriteAnswer, UN1T_STAFF_COPY } from './un1t-staff-booking'
import { readUn1tWriteSettings, Un1tSettingsReadError } from './un1t-online-settings.js'

const HATCH = 'a0000000-0000-4000-8000-000000000002'
const STILL = 'a0000000-0000-4000-8000-000000000001'
const C1 = 'c0000000-0000-4000-8000-000000000001'
const userAt = (...ids) => ({ id: 'u1', role: 'staff', profileRole: 'staff', isMaster: false, locations: ids.map((id) => ({ id })), rolesByLocation: Object.fromEntries(ids.map((id) => [id, 'staff'])), activeLocation: { id: ids[0] } })

let contactRow
let clientRow
const db = {
  from(table) {
    const b = { select: () => b, eq: () => b, limit: () => b, maybeSingle: async () => (table === 'contacts' ? { data: contactRow, error: null } : { data: clientRow, error: null }) }
    return b
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  readUn1tWriteSettings.mockResolvedValue({ membershipSource: 'un1t_online', studioName: 'Hatch Street', organizationId: 'org-1', settings: { writesEnabled: true } })
  // A Stillorgan contact (home studio elsewhere) with a Hatch account.
  contactRow = { id: C1, organization_id: 'org-1', name: 'Test Person', un1t_user_id: 'usr-1' }
  clientRow = { id: 'cl-1' }
})

describe('gateUn1tStaffBooking', () => {
  it('access is judged on the booking studio, not the contact\'s studio', async () => {
    const hatchOnly = await gateUn1tStaffBooking(db, userAt(HATCH), { locationId: HATCH, contactId: C1 })
    expect(hatchOnly).toMatchObject({ ok: true, un1tUserId: 'usr-1', studioName: 'Hatch Street' })
    const stillOnly = await gateUn1tStaffBooking(db, userAt(STILL), { locationId: HATCH, contactId: C1 })
    expect(stillOnly).toMatchObject({ ok: false, status: 403 })
  })

  it('no un1t_user_id or no un1t_clients row at the studio → 400 with the exact copy', async () => {
    contactRow = { ...contactRow, un1t_user_id: null }
    expect(await gateUn1tStaffBooking(db, userAt(HATCH), { locationId: HATCH, contactId: C1 })).toEqual({ ok: false, status: 400, error: 'This contact has no un1t.online account at Hatch Street. They can book through the website.' })
    contactRow = { ...contactRow, un1t_user_id: 'usr-1' }
    clientRow = null
    expect(await gateUn1tStaffBooking(db, userAt(HATCH), { locationId: HATCH, contactId: C1 })).toEqual({ ok: false, status: 400, error: UN1T_STAFF_COPY.noAccount('Hatch Street') })
  })

  it('contact in another organisation → 404', async () => {
    contactRow = { ...contactRow, organization_id: 'org-2' }
    expect(await gateUn1tStaffBooking(db, userAt(HATCH), { locationId: HATCH, contactId: C1 })).toMatchObject({ ok: false, status: 404 })
  })

  it('writes off or not a un1t.online studio → 400; unreadable settings → 503', async () => {
    readUn1tWriteSettings.mockResolvedValueOnce({ membershipSource: 'un1t_online', studioName: 'Hatch Street', organizationId: 'org-1', settings: { writesEnabled: false } })
    expect(await gateUn1tStaffBooking(db, userAt(HATCH), { locationId: HATCH, contactId: C1 })).toEqual({ ok: false, status: 400, error: 'un1t.online booking is off at Hatch Street.' })
    readUn1tWriteSettings.mockResolvedValueOnce({ membershipSource: 'glofox', studioName: 'Stillorgan', organizationId: 'org-1', settings: { writesEnabled: true } })
    expect((await gateUn1tStaffBooking(db, userAt(HATCH), { locationId: HATCH, contactId: C1 })).status).toBe(400)
    readUn1tWriteSettings.mockRejectedValueOnce(new Un1tSettingsReadError('x'))
    expect((await gateUn1tStaffBooking(db, userAt(HATCH), { locationId: HATCH, contactId: C1 })).status).toBe(503)
  })
})

describe('staffWriteAnswer', () => {
  const r = (over) => ({ verdict: 'done', id: 'bk-1', code: null, message: null, alreadyBooked: false, ledgerId: 'l-1', ...over })
  it('done, already booked, refused, budget, unknown and unconfirmed-already-booked', () => {
    expect(staffWriteAnswer(r({}), { op: 'book' })).toEqual({ status: 200, body: { success: true, data: { un1t_booking_id: 'bk-1', already_booked: false, message: null, ledger_id: 'l-1' } } })
    expect(staffWriteAnswer(r({ alreadyBooked: true }), { op: 'book' }).body.data.message).toBe('Already booked in un1t.online')
    expect(staffWriteAnswer(r({ verdict: 'refused', code: 'NO_CREDITS', message: 'No credits left' }), { op: 'book' })).toMatchObject({ status: 409, body: { error: 'No credits left', code: 'NO_CREDITS' } })
    expect(staffWriteAnswer(r({ verdict: 'refused', code: 'UN1T_RATE_BUDGET' }), { op: 'book' })).toMatchObject({ status: 429, body: { error: 'un1t.online is busy. Try again in a minute.' } })
    expect(staffWriteAnswer(r({ verdict: 'unknown', code: null }), { op: 'book' })).toMatchObject({ status: 502, body: { error: 'un1t.online did not answer clearly. Check the class in un1t.online before trying again.' } })
    expect(staffWriteAnswer(r({ verdict: 'unknown', code: 'already_booked_unverified' }), { op: 'book' }).body.error).toMatch(/could not confirm/)
    expect(staffWriteAnswer(r({ verdict: 'refused', code: 'UN1T_PERMISSION_MISSING', message: "The un1t.online token for Hatch Street is missing the 'bookings:create' permission, so nothing was sent." }), { op: 'book' })).toMatchObject({ status: 409 })
  })
})
