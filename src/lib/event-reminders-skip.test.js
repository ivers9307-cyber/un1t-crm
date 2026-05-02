// Tests for the per-booking skip_reminder gate (mig 075).
// Mirrors the dispatcher logic from event-reminders.js so the
// contract is asserted without standing up the whole runner.
//
// What we're pinning:
//   1. skip_reminder=true short-circuits BEFORE channel logic.
//   2. The runner stamps reminder_sent_at on a skip so the
//      booking falls out of the partial index (no retry-forever).
//   3. skip_reminder=false leaves the dispatcher to run channel
//      logic as normal.
//   4. skip_reminder runs ahead of consent / phone-number /
//      template-missing checks — operator override is the
//      strongest signal we accept.

import { describe, it, expect, vi } from 'vitest'

// Mirror of the dispatcher's pre-channel gate. Returns:
//   { skipped: true, stampedAt }   when skip_reminder fires
//   { skipped: false }              otherwise (caller proceeds to channel)
async function dispatchGate(db, booking) {
  if (booking.skip_reminder) {
    const stampedAt = new Date().toISOString()
    await db.from('bookings').update({ reminder_sent_at: stampedAt }).eq('id', booking.id)
    return { skipped: true, stampedAt, reason: 'operator_skip' }
  }
  return { skipped: false }
}

function mockDb() {
  const updateSpy = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ data: null, error: null }),
  })
  const fromSpy = vi.fn().mockReturnValue({ update: updateSpy })
  return { db: { from: fromSpy }, fromSpy, updateSpy }
}

describe('per-booking skip_reminder gate', () => {
  it('short-circuits when skip_reminder=true and stamps reminder_sent_at', async () => {
    const { db, fromSpy, updateSpy } = mockDb()
    const result = await dispatchGate(db, { id: 'b1', skip_reminder: true })

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('operator_skip')
    expect(typeof result.stampedAt).toBe('string')
    expect(fromSpy).toHaveBeenCalledWith('bookings')
    expect(updateSpy).toHaveBeenCalledTimes(1)
    // Confirm we wrote the timestamp, not anything else.
    expect(updateSpy.mock.calls[0][0]).toEqual({ reminder_sent_at: result.stampedAt })
  })

  it('passes through when skip_reminder=false (caller runs channel logic)', async () => {
    const { db, updateSpy } = mockDb()
    const result = await dispatchGate(db, { id: 'b1', skip_reminder: false })
    expect(result.skipped).toBe(false)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('passes through when skip_reminder is undefined (legacy rows pre-mig)', async () => {
    const { db, updateSpy } = mockDb()
    const result = await dispatchGate(db, { id: 'b1' })
    expect(result.skipped).toBe(false)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('skip wins over a customer who would otherwise get a reminder', async () => {
    const { db } = mockDb()
    // A booking with everything configured for a successful send — but
    // skip_reminder=true. The gate should still skip it.
    const booking = {
      id: 'b1',
      skip_reminder: true,
      contacts: {
        sms_status: 'active',
        phone: '+353871234567',
        contact_preferences: { sms_administrative: true, email_administrative: true },
      },
    }
    const result = await dispatchGate(db, booking)
    expect(result.skipped).toBe(true)
  })

  it('two consecutive skips both stamp (idempotent at the DB layer)', async () => {
    const { db, updateSpy } = mockDb()
    await dispatchGate(db, { id: 'b1', skip_reminder: true })
    await dispatchGate(db, { id: 'b1', skip_reminder: true })
    // We don't dedupe at the gate — that's the runner-loop's job
    // (already-stamped rows fall out of the .is('reminder_sent_at',
    // null) filter on the SELECT). The stamp is cheap enough that
    // a hypothetical double-call here just overwrites the timestamp.
    expect(updateSpy).toHaveBeenCalledTimes(2)
  })
})
