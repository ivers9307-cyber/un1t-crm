import { describe, it, expect, beforeEach, vi } from 'vitest'
import { pickCommsLocationTarget, resolveEventCommsLocation } from './event-comms-location'
import { resolveMasterLocationIdStrict } from './host-events'

// Isolate the async wrapper from its two IO helpers so we can unit-test its
// target-selection + row-load + fallback logic (the DB composition) directly.
vi.mock('./host-events', () => ({ resolveMasterLocationIdStrict: vi.fn() }))
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
    expect(resolveMasterLocationIdStrict).not.toHaveBeenCalled()
  })

  it('returns the org master row for a host event with no override', async () => {
    resolveMasterLocationIdStrict.mockResolvedValue('MASTER')
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
    expect(resolveMasterLocationIdStrict).not.toHaveBeenCalled()
  })

  it('returns null when the target location row is not found (safe fallback for callers)', async () => {
    const db = makeDb({})
    const row = await resolveEventCommsLocation(db, { location_id: 'MISSING', host_id: null, sending_location_id: null })
    expect(row).toBeNull()
  })

  it('returns null for a null event', async () => {
    expect(await resolveEventCommsLocation(makeDb({}), null)).toBeNull()
  })

  // ── BAREWRITE.4 — A READ FAILURE NEVER COSTS THE MESSAGE, AT ANY HOP ───────
  //
  // BAREWRITE.1 made an unreadable row THROW, on the theory that falling
  // through to the event's own location could send under the wrong brand.
  // BAREWRITE.3 narrowed the throw to the brand-crossing hops. BAREWRITE.4
  // removes it, because the brand it was protecting cannot differ:
  //
  //   • email identity resolves per ORGANISATION (resolveEmailSender →
  //     tenant_email_domains keyed on the location's organization_id), and a
  //     host anchor and its org master are in the same organisation BY
  //     CONSTRUCTION (ensureAnchorLocation / resolveMasterLocationIdStrict);
  //   • SMS identity is the location's alpha sender, falling back to the ORG
  //     default. Measured against prod 2026-08-20: one host anchor exists
  //     ("Pride Training Club (host events)") and its sender is `UN1T Dub` —
  //     identical to its org master's; the only sending_location_id overrides
  //     point at that same master. No prod pair differs.
  //
  // Against that, every caller here is delivering a message a customer paid for
  // or asked for, and nothing retries: race-confirmations is only invoked on a
  // FRESH payment transition, and the event-reminders cron runs DAILY against a
  // fixed day-offset, so a skipped tick destroys the reminder rather than
  // deferring it. The throw was trading a certain loss against an impossible
  // one. What survives is VISIBILITY — every discarded read is reported through
  // logError with the ids to act on.
  //
  // These tests are the old ones INVERTED: the same four failure points, now
  // asserting the message is never lost.
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

  it('RECEIPT NOT LOST: a failed ANCHOR read resolves to null instead of throwing', async () => {
    const db = makeFailingDb('ANCHOR')
    await expect(
      resolveEventCommsLocation(db, { location_id: 'ANCHOR', host_id: 'H', sending_location_id: null }),
    ).resolves.toBeNull()
    // The org-master lookup is skipped (we have no organization_id to give it),
    // so the caller's `|| event.location_id` fallback stands — same org, same
    // sender, message still goes out.
    expect(resolveMasterLocationIdStrict).not.toHaveBeenCalled()
  })

  it('RECEIPT NOT LOST: a plain event whose own location read fails returns null (same-location fallback), it does NOT throw', async () => {
    const db = makeFailingDb('LOC')
    // host_id null + no override → target === event.location_id === 'LOC'.
    await expect(
      resolveEventCommsLocation(db, { location_id: 'LOC', host_id: null, sending_location_id: null }),
    ).resolves.toBeNull()
  })

  // Fails the Nth `.maybeSingle()` of the call and serves every other one, so a
  // test can break the TARGET read while the anchor read ahead of it succeeds.
  function makeDbFailingOnNthRead(n) {
    let reads = 0
    return {
      from() {
        let id = null
        const b = {
          select() { return b },
          eq(col, val) { if (col === 'id') id = val; return b },
          maybeSingle() {
            reads += 1
            return reads === n
              ? Promise.resolve({ data: null, error: { message: 'connection reset' } })
              : Promise.resolve({ data: { id, organization_id: 'ORG' }, error: null })
          },
        }
        return b
      },
    }
  }

  it('RECEIPT NOT LOST: a host event with no org master resolves to its own anchor, so a failed target read there is fail-open too', async () => {
    resolveMasterLocationIdStrict.mockResolvedValue(null) // no master → target === anchor
    // Read 1 = the anchor's organization_id (ok); read 2 = the target row (fails).
    await expect(
      resolveEventCommsLocation(makeDbFailingOnNthRead(2), { location_id: 'ANCHOR', host_id: 'H', sending_location_id: null }),
    ).resolves.toBeNull()
  })

  // The two hops BAREWRITE.3 kept failing CLOSED. These are the receipts the
  // guard was costing: on this data the fallback resolves to the same org and
  // the same alpha sender, so the throw bought nothing and deleted the message.
  it('RECEIPT NOT LOST: an unreadable sending_location_id override returns null, it does NOT throw', async () => {
    const db = makeFailingDb('OVR')
    await expect(
      resolveEventCommsLocation(db, { location_id: 'LOC', host_id: null, sending_location_id: 'OVR' }),
    ).resolves.toBeNull()
  })

  it('RECEIPT NOT LOST: a host event whose ORG MASTER row cannot be read returns null, it does NOT throw', async () => {
    resolveMasterLocationIdStrict.mockResolvedValue('MASTER')
    const db = makeFailingDb('MASTER')
    await expect(
      resolveEventCommsLocation(db, { location_id: 'ANCHOR', host_id: 'H', sending_location_id: null }),
    ).resolves.toBeNull()
  })

  // The MIDDLE hop. `resolveMasterLocationIdStrict` still THROWS — that is its
  // job, and `resolveMasterLocationId` (the contact-homing helper) still needs
  // the strict variant to exist. What changed is where the throw stops: it is
  // caught HERE and logged, so the distinction between "unreadable" and
  // "absent" survives in the log without escaping to the send path.
  it('RECEIPT NOT LOST: a master-lookup throw is caught, logged, and degraded to the anchor', async () => {
    resolveMasterLocationIdStrict.mockRejectedValue(new Error('organizations read failed'))
    const db = makeDb({
      ANCHOR: { id: 'ANCHOR', name: 'Pride (host events)', twilio_alpha_sender_id: 'UN1T Dub', organization_id: 'ORG' },
      MASTER: { id: 'MASTER', name: 'Stillorgan', twilio_alpha_sender_id: 'UN1T Dub', organization_id: 'ORG' },
    })
    const row = await resolveEventCommsLocation(db, { location_id: 'ANCHOR', host_id: 'H', sending_location_id: null })
    // Same organisation ⇒ same email identity; same alpha sender in prod.
    expect(row?.id).toBe('ANCHOR')
  })

  // The property, stated once and checked at EVERY hop rather than case by
  // case — a future hop that reaches for a throw fails here.
  it('NEVER THROWS: every read in the chain can fail and the call still resolves', async () => {
    resolveMasterLocationIdStrict.mockRejectedValue(new Error('organizations read failed'))
    const allReadsFail = {
      from() {
        const b = {
          select() { return b },
          eq() { return b },
          maybeSingle() { return Promise.resolve({ data: null, error: { message: 'connection reset' } }) },
        }
        return b
      },
    }
    const events = [
      { location_id: 'LOC', host_id: null, sending_location_id: null },        // plain
      { location_id: 'ANCHOR', host_id: 'H', sending_location_id: null },      // host
      { location_id: 'LOC', host_id: null, sending_location_id: 'OVR' },       // override
      { location_id: 'ANCHOR', host_id: 'H', sending_location_id: 'OVR' },     // host + override
    ]
    for (const ev of events) {
      await expect(resolveEventCommsLocation(allReadsFail, ev)).resolves.toBeNull()
    }
  })
})
