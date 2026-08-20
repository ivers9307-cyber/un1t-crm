import { describe, it, expect, beforeEach, vi } from 'vitest'
import { pickCommsLocationTarget, resolveEventCommsLocation } from './event-comms-location'
import { resolveMasterLocationId } from './host-events'

// Isolate the async wrapper from its two IO helpers so we can unit-test its
// target-selection + row-load + fallback logic (the DB composition) directly.
vi.mock('./host-events', () => ({ resolveMasterLocationId: vi.fn() }))
vi.mock('./connection-registry', () => ({ overlayConnections: vi.fn((_db, row) => row) }))

describe('pickCommsLocationTarget', () => {
  it('uses the explicit override when set (wins over everything)', () => {
    expect(pickCommsLocationTarget(
      { sending_location_id: 'L1', host_id: 'h', location_id: 'anchor' }, 'MASTER',
    )).toBe('L1')
  })

  it('uses the org master for a host event with no override', () => {
    expect(pickCommsLocationTarget(
      { host_id: 'h', location_id: 'anchor' }, 'MASTER',
    )).toBe('MASTER')
  })

  it('falls back to the event location (anchor) when a host event has no master', () => {
    expect(pickCommsLocationTarget(
      { host_id: 'h', location_id: 'anchor' }, null,
    )).toBe('anchor')
  })

  it('uses the event location for a normal (non-host) event', () => {
    expect(pickCommsLocationTarget(
      { location_id: 'L2' }, null,
    )).toBe('L2')
  })

  it('returns null for a null event', () => {
    expect(pickCommsLocationTarget(null, 'MASTER')).toBeNull()
  })
})

describe('resolveEventCommsLocation', () => {
  beforeEach(() => { vi.clearAllMocks() })

  // Stub db: any `.from(<table>).select(...).eq('id', X).maybeSingle()` → rowsById[X].
  function makeDb(rowsById) {
    return {
      from() {
        let id = null
        const b = {
          select() { return b },
          eq(col, val) { if (col === 'id') id = val; return b },
          maybeSingle() { return Promise.resolve({ data: rowsById[id] ?? null, error: null }) },
        }
        return b
      },
    }
  }

  it('returns the event\'s own location for a normal event — no master lookup', async () => {
    const db = makeDb({ LOC: { id: 'LOC', name: 'Hatch', twilio_alpha_sender_id: 'UN1THATCH', organization_id: 'ORG' } })
    const row = await resolveEventCommsLocation(db, { location_id: 'LOC', host_id: null, sending_location_id: null })
    expect(row?.id).toBe('LOC')
    expect(resolveMasterLocationId).not.toHaveBeenCalled()
  })

  it('returns the org master row for a host event with no override', async () => {
    resolveMasterLocationId.mockResolvedValue('MASTER')
    const db = makeDb({
      ANCHOR: { organization_id: 'ORG' },
      MASTER: { id: 'MASTER', name: 'Stillorgan', twilio_alpha_sender_id: 'UN1T Dub', organization_id: 'ORG' },
    })
    const row = await resolveEventCommsLocation(db, { location_id: 'ANCHOR', host_id: 'H', sending_location_id: null })
    expect(row?.id).toBe('MASTER')
  })

  it('returns the explicit override row — no master lookup', async () => {
    const db = makeDb({ OVR: { id: 'OVR', name: 'Hatch', twilio_alpha_sender_id: 'UN1THATCH', organization_id: 'ORG' } })
    const row = await resolveEventCommsLocation(db, { location_id: 'ANCHOR', host_id: 'H', sending_location_id: 'OVR' })
    expect(row?.id).toBe('OVR')
    expect(resolveMasterLocationId).not.toHaveBeenCalled()
  })

  it('returns null when the target location row is not found (safe fallback for callers)', async () => {
    const db = makeDb({})
    const row = await resolveEventCommsLocation(db, { location_id: 'MISSING', host_id: null, sending_location_id: null })
    expect(row).toBeNull()
  })

  it('returns null for a null event', async () => {
    expect(await resolveEventCommsLocation(makeDb({}), null)).toBeNull()
  })

  // ── BAREWRITE.1 — an UNREADABLE row is not an ABSENT row ──────────────────
  // Both reads used to discard `error`, and the tier logic falls through on a
  // null: a transient failure on the anchor read left masterLocationId null,
  // pickCommsLocationTarget handed back the host's sender-less anchor, and the
  // event's comms went out under the wrong brand. "Could not read it" and
  // "there is no such row" must stay distinguishable.
  function makeFailingDb(errorOnId) {
    return {
      from() {
        let id = null
        const b = {
          select() { return b },
          eq(col, val) { if (col === 'id') id = val; return b },
          maybeSingle() {
            return id === errorOnId
              ? Promise.resolve({ data: null, error: { message: 'connection reset' } })
              : Promise.resolve({ data: { id, organization_id: 'ORG' }, error: null })
          },
        }
        return b
      },
    }
  }

  it('throws (does NOT fall back to the anchor) when the anchor read fails', async () => {
    const db = makeFailingDb('ANCHOR')
    await expect(
      resolveEventCommsLocation(db, { location_id: 'ANCHOR', host_id: 'H', sending_location_id: null }),
    ).rejects.toThrow(/anchor location read failed/)
    // The wrong-brand fallback is never reached.
    expect(resolveMasterLocationId).not.toHaveBeenCalled()
  })

  it('throws when the sending-location read fails, rather than returning null', async () => {
    const db = makeFailingDb('LOC')
    await expect(
      resolveEventCommsLocation(db, { location_id: 'LOC', host_id: null, sending_location_id: null }),
    ).rejects.toThrow(/sending location read failed/)
  })
})
