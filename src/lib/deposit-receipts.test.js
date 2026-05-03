// Tests for the deposit-paid receipt SMS helper (mig 078).
//
// Same testing posture as activity-events.test.js — mock the db
// chain with vi.fn() spies so we can assert on what gets called
// without standing up a real Supabase. @/lib/twilio is mocked at
// module level so sendLocationSms returns whatever each test
// dictates.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Module-level mock for the Twilio dep — must be hoisted so
// it intercepts the import in deposit-receipts.js.
vi.mock('./twilio', () => {
  class TwilioError extends Error {
    constructor(message, { status, code } = {}) {
      super(message)
      this.name = 'TwilioError'
      this.status = status
      this.code = code
    }
  }
  return {
    TwilioError,
    sendLocationSms: vi.fn(),
  }
})

import { sendDepositReceiptSms, buildReceiptBody } from './deposit-receipts'
import { sendLocationSms, TwilioError } from './twilio'

function mockDb({
  carUpdateThrows = false,
  noteInsertThrows = false,
} = {}) {
  const carsUpdateEqSpy = vi.fn(() =>
    carUpdateThrows
      ? Promise.reject(new Error('cars-update-failed'))
      : Promise.resolve({ data: null, error: null })
  )
  const carsUpdateSpy = vi.fn(() => ({ eq: carsUpdateEqSpy }))

  const carNotesInsertSpy = vi.fn(() =>
    noteInsertThrows
      ? Promise.reject(new Error('notes-insert-failed'))
      : Promise.resolve({ data: null, error: null })
  )

  const fromSpy = vi.fn((table) => {
    if (table === 'cars') return { update: carsUpdateSpy }
    if (table === 'car_notes') return { insert: carNotesInsertSpy }
    throw new Error(`unexpected table in test: ${table}`)
  })

  return { db: { from: fromSpy }, fromSpy, carsUpdateSpy, carsUpdateEqSpy, carNotesInsertSpy }
}

const baseCar = {
  id: 'car-1',
  location_id: 'loc-ccf',
  buyer_phone: '+353871234567',
  buyer_name: 'Sarah Murphy',
  make: 'Tesla',
  model: 'Model 3',
  irish_reg: '241-D-1234',
  deposit_amount: 500,
  deposit_paid_amount: 500,
  deposit_receipt_sent_at: null,
}
const baseLocation = {
  id: 'loc-ccf',
  name: 'CCF Autos',
  car_deposit_receipt_sms_enabled: true,
  twilio_alpha_sender_id: 'CCFautos',
}

beforeEach(() => {
  vi.mocked(sendLocationSms).mockReset()
})

describe('sendDepositReceiptSms', () => {
  it('happy path: sends, stamps, inserts note, returns sent', async () => {
    vi.mocked(sendLocationSms).mockResolvedValue({
      sid: 'SMxyz',
      status: 'queued',
      to: '+353871234567',
    })
    const { db, carsUpdateSpy, carsUpdateEqSpy, carNotesInsertSpy } = mockDb()

    const result = await sendDepositReceiptSms({ db, car: baseCar, location: baseLocation })

    expect(result.status).toBe('sent')
    expect(result.sid).toBe('SMxyz')
    expect(result.body).toMatch(/Sarah,/)
    expect(result.body).toMatch(/Tesla Model 3 241-D-1234/)
    expect(result.body).toMatch(/€500\.00/)
    expect(result.body).toMatch(/CCF Autos\.$/)
    expect(result.sent_at).toBeTruthy()

    // SMS sent with right args
    expect(sendLocationSms).toHaveBeenCalledTimes(1)
    expect(sendLocationSms).toHaveBeenCalledWith({
      location: baseLocation,
      to: '+353871234567',
      body: expect.stringContaining('CCF Autos'),
    })

    // Stamp lands on the right car
    expect(carsUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ deposit_receipt_sent_at: expect.any(String) })
    )
    expect(carsUpdateEqSpy).toHaveBeenCalledWith('id', 'car-1')

    // System note recorded with phone + SID + body
    expect(carNotesInsertSpy).toHaveBeenCalledTimes(1)
    const note = carNotesInsertSpy.mock.calls[0][0]
    expect(note).toMatchObject({
      car_id: 'car-1',
      location_id: 'loc-ccf',
      kind: 'system',
      created_by: null,
    })
    expect(note.content).toContain('+353871234567')
    expect(note.content).toContain('SMxyz')
    expect(note.content).toContain(result.body)
  })

  it('skipped: location toggle off', async () => {
    const { db } = mockDb()
    const result = await sendDepositReceiptSms({
      db,
      car: baseCar,
      location: { ...baseLocation, car_deposit_receipt_sms_enabled: false },
    })
    expect(result).toEqual({ status: 'skipped', reason: 'location_toggle_off' })
    expect(sendLocationSms).not.toHaveBeenCalled()
  })

  it('skipped: missing location object treated as toggle off (defensive)', async () => {
    const { db } = mockDb()
    const result = await sendDepositReceiptSms({ db, car: baseCar, location: null })
    expect(result).toEqual({ status: 'skipped', reason: 'location_toggle_off' })
    expect(sendLocationSms).not.toHaveBeenCalled()
  })

  it('skipped: already sent (idempotency for at-least-once webhook)', async () => {
    const { db } = mockDb()
    const result = await sendDepositReceiptSms({
      db,
      car: { ...baseCar, deposit_receipt_sent_at: '2026-05-03T20:00:00Z' },
      location: baseLocation,
    })
    expect(result).toEqual({ status: 'skipped', reason: 'already_sent' })
    expect(sendLocationSms).not.toHaveBeenCalled()
  })

  it('skipped: no buyer phone', async () => {
    const { db } = mockDb()
    const result = await sendDepositReceiptSms({
      db,
      car: { ...baseCar, buyer_phone: null },
      location: baseLocation,
    })
    expect(result).toEqual({ status: 'skipped', reason: 'no_buyer_phone' })
    expect(sendLocationSms).not.toHaveBeenCalled()
  })

  it('failed: sendLocationSms throws — does NOT stamp, returns failed', async () => {
    vi.mocked(sendLocationSms).mockRejectedValue(
      new TwilioError('Phone unreachable', { code: 30005, status: 422 })
    )
    const { db, carsUpdateSpy, carNotesInsertSpy } = mockDb()

    const result = await sendDepositReceiptSms({ db, car: baseCar, location: baseLocation })

    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/Twilio/)
    expect(result.reason).toMatch(/Phone unreachable/)

    // Critical: must not stamp on failure (so a future webhook delivery can retry).
    expect(carsUpdateSpy).not.toHaveBeenCalled()
    // And no note (the operator should see the absence of a system note as the signal).
    expect(carNotesInsertSpy).not.toHaveBeenCalled()
  })

  it('failed: non-Twilio exception still returns failed (no special-cased class)', async () => {
    vi.mocked(sendLocationSms).mockRejectedValue(new Error('network down'))
    const { db, carsUpdateSpy } = mockDb()

    const result = await sendDepositReceiptSms({ db, car: baseCar, location: baseLocation })
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('network down')
    expect(carsUpdateSpy).not.toHaveBeenCalled()
  })

  it('returns sent even if the stamp UPDATE fails (sms went out — duplicate-on-retry beats lose-the-signal)', async () => {
    vi.mocked(sendLocationSms).mockResolvedValue({ sid: 'SMabc', to: '+353871234567' })
    const { db } = mockDb({ carUpdateThrows: true })

    const result = await sendDepositReceiptSms({ db, car: baseCar, location: baseLocation })
    expect(result.status).toBe('sent')
    expect(result.sid).toBe('SMabc')
  })

  it('returns sent even if the notes INSERT fails (best-effort note)', async () => {
    vi.mocked(sendLocationSms).mockResolvedValue({ sid: 'SMabc', to: '+353871234567' })
    const { db } = mockDb({ noteInsertThrows: true })

    const result = await sendDepositReceiptSms({ db, car: baseCar, location: baseLocation })
    expect(result.status).toBe('sent')
  })

  it('passes actorId through to the system note when provided (manual-route case)', async () => {
    vi.mocked(sendLocationSms).mockResolvedValue({ sid: 'SMabc', to: '+353871234567' })
    const { db, carNotesInsertSpy } = mockDb()

    await sendDepositReceiptSms({
      db,
      car: baseCar,
      location: baseLocation,
      actorId: 'profile-operator-1',
    })
    expect(carNotesInsertSpy.mock.calls[0][0].created_by).toBe('profile-operator-1')
  })
})

describe('buildReceiptBody', () => {
  it('uses the buyer first name (handles full names cleanly)', () => {
    const body = buildReceiptBody({
      car: { ...baseCar, buyer_name: 'Sarah O Brien' },
      location: baseLocation,
    })
    expect(body).toMatch(/^Hi Sarah,/)
  })

  it("falls back to 'there' when buyer_name is empty", () => {
    const body = buildReceiptBody({
      car: { ...baseCar, buyer_name: '' },
      location: baseLocation,
    })
    expect(body).toMatch(/^Hi there,/)
  })

  it('uses the make/model/reg for car identity', () => {
    const body = buildReceiptBody({
      car: { ...baseCar, make: 'Tesla', model: 'Model Y', irish_reg: '252-D-9999' },
      location: baseLocation,
    })
    expect(body).toMatch(/Tesla Model Y 252-D-9999/)
  })

  it("falls back to 'your Tesla' when make/model/reg are all empty", () => {
    const body = buildReceiptBody({
      car: { ...baseCar, make: null, model: null, irish_reg: null },
      location: baseLocation,
    })
    expect(body).toMatch(/your Tesla/)
  })

  it('prefers deposit_paid_amount over deposit_amount when both present', () => {
    const body = buildReceiptBody({
      car: { ...baseCar, deposit_amount: 500, deposit_paid_amount: 750 },
      location: baseLocation,
    })
    expect(body).toMatch(/€750\.00/)
    expect(body).not.toMatch(/€500/)
  })

  it('falls back to deposit_amount if deposit_paid_amount is null', () => {
    const body = buildReceiptBody({
      car: { ...baseCar, deposit_paid_amount: null },
      location: baseLocation,
    })
    expect(body).toMatch(/€500\.00/)
  })

  it('omits the amount string entirely if both fields are zero/null/missing', () => {
    const body = buildReceiptBody({
      car: { ...baseCar, deposit_paid_amount: null, deposit_amount: null },
      location: baseLocation,
    })
    expect(body).toMatch(/received your deposit for/)
    expect(body).not.toMatch(/€/)
  })

  it("uses the location's name (so the toggle works for non-CCF business units)", () => {
    const body = buildReceiptBody({
      car: baseCar,
      location: { ...baseLocation, name: 'UN1T Hatch Street' },
    })
    expect(body).toMatch(/UN1T Hatch Street\.$/)
  })

  it("falls back to 'CCF Autos' when location name is missing (defensive)", () => {
    const body = buildReceiptBody({
      car: baseCar,
      location: { name: '' },
    })
    expect(body).toMatch(/CCF Autos\.$/)
  })
})
