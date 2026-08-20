// EVENT-COPY.1 — the customer-visible location label must never be an
// ops-only anchor row's name.
//
// `ensureAnchorLocation` mints one hidden location per host, named
// "<host> (host events)" and flagged is_host_anchor. It is bookkeeping. In prod
// today one such row exists and two ACTIVE upcoming events sit on it, so every
// tier below is reachable with real data.
//
// TWO helpers, not one, and the split is the point:
//   pickAudienceVenueName   — WHERE THE EVENT IS. Never consults the sending
//                             identity, because that is not a venue.
//   pickAudienceSignoffName — WHO IS MESSAGING YOU. May consult it, because
//                             that is exactly what it is.
// The first cut had a single helper doing both, which fixed an internal string
// leaking into the "Where" row by putting a wrong GYM there instead.

import { describe, it, expect } from 'vitest'
import {
  isHostAnchorLocation,
  pickAudienceVenueName,
  pickAudienceSignoffName,
} from './event-comms-location'

const ANCHOR = { id: 'ANCHOR', name: 'Pride Training Club (host events)', is_host_anchor: true }
const STILLORGAN = { id: 'LOC1', name: 'UN1T Stillorgan', is_host_anchor: false }
const HATCH = { id: 'LOC2', name: 'UN1T Hatch Street', is_host_anchor: false }

describe('isHostAnchorLocation', () => {
  it('recognises the flag', () => {
    expect(isHostAnchorLocation({ name: 'Anything', is_host_anchor: true })).toBe(true)
  })

  it('recognises the name suffix even when the select forgot the flag', () => {
    // Deliberately redundant: this predicate is called from four modules with
    // four hand-written selects. A select that drops is_host_anchor must not
    // silently re-open the defect.
    expect(isHostAnchorLocation({ name: 'Pride Training Club (host events)' })).toBe(true)
    expect(isHostAnchorLocation({ name: 'Pride Training Club (Host Events)  ' })).toBe(true)
  })

  it('leaves a real location alone', () => {
    expect(isHostAnchorLocation(STILLORGAN)).toBe(false)
    expect(isHostAnchorLocation(null)).toBe(false)
  })
})

describe('pickAudienceVenueName — the "Where" row and {{location}}', () => {
  it('prefers the venue name', () => {
    expect(pickAudienceVenueName({ venueName: 'UN1T STILLORGAN', eventLocation: ANCHOR }))
      .toBe('UN1T STILLORGAN')
  })

  it('THE DEFECT: never returns the anchor label, even as the last resort', () => {
    expect(pickAudienceVenueName({ venueName: null, eventLocation: ANCHOR })).toBe('')
  })

  it('uses the event location for a plain (non-host) event', () => {
    expect(pickAudienceVenueName({ venueName: null, eventLocation: STILLORGAN }))
      .toBe('UN1T Stillorgan')
  })

  it('NEVER prints the SENDING location as a venue — an omitted "Where" row beats a wrong address', () => {
    // The regression this split exists to prevent. `sending_location_id`
    // (mig 553) is a comms identity: an operator repointing a Hatch Street
    // event's sender at Stillorgan for deliverability must NOT move the venue
    // the attendee reads. The helper takes no commsLocation at all, so the
    // mistake is unrepresentable rather than merely unmade.
    expect(pickAudienceVenueName({ venueName: null, eventLocation: HATCH })).toBe('UN1T Hatch Street')
    expect(pickAudienceVenueName({ venueName: null, eventLocation: ANCHOR, commsLocation: STILLORGAN }))
      .toBe('')
  })

  it('ignores a blank/whitespace venue name rather than emitting it', () => {
    expect(pickAudienceVenueName({ venueName: '   ', eventLocation: STILLORGAN }))
      .toBe('UN1T Stillorgan')
  })

  it('returns "" — never undefined — when nothing is usable', () => {
    expect(pickAudienceVenueName({})).toBe('')
    expect(pickAudienceVenueName()).toBe('')
  })
})

describe('pickAudienceSignoffName — the SMS "— <name>" sign-off', () => {
  it('prefers the venue name', () => {
    expect(pickAudienceSignoffName({
      venueName: 'UN1T STILLORGAN', commsLocation: STILLORGAN, eventLocation: ANCHOR,
    })).toBe('UN1T STILLORGAN')
  })

  it('THE DEFECT: never returns the anchor label, even as the last resort', () => {
    // The payment-link SMS signed off with exactly this string.
    expect(pickAudienceSignoffName({
      venueName: null, commsLocation: null, eventLocation: ANCHOR,
    })).toBe('')
  })

  it('falls through the anchor to the RESOLVED comms location', () => {
    // Legitimate HERE and only here: the sign-off says who is texting you, and
    // for a host event that is the org master. A blank sign-off would also be
    // acceptable; a real brand name is better.
    expect(pickAudienceSignoffName({
      venueName: null, commsLocation: STILLORGAN, eventLocation: ANCHOR,
    })).toBe('UN1T Stillorgan')
  })

  it('skips an anchor that arrives as the COMMS location too', () => {
    // An explicit sending_location_id can legitimately resolve to an anchor —
    // still the right row for the Twilio sender, never for the name.
    expect(pickAudienceSignoffName({
      venueName: null, commsLocation: ANCHOR, eventLocation: STILLORGAN,
    })).toBe('UN1T Stillorgan')
  })

  it('falls back to the event location for a plain (non-host) event', () => {
    expect(pickAudienceSignoffName({
      venueName: null, commsLocation: null, eventLocation: STILLORGAN,
    })).toBe('UN1T Stillorgan')
  })

  it('returns "" — never undefined — when nothing is usable', () => {
    expect(pickAudienceSignoffName({})).toBe('')
    expect(pickAudienceSignoffName()).toBe('')
  })
})
