// @vitest-environment jsdom
//
// MAIL-ALLLOC.1 — the pure decisions behind the multi-location Mail surface.
//
// Everything the tiles and the All-mode list DECIDE lives in mail-digest.js so
// it can be pinned here without rendering anything. Four families of decision
// matter enough to test exhaustively:
//
// 1. SCOPE PERSISTENCE. The chosen scope survives a reload per user, and a
//    persisted scope naming a studio that is no longer in the digest falls
//    back to All — never to a blank screen scoped to nothing.
// 2. SECTION BUILDING. A location that failed is REPORTED, never dropped, and
//    an empty section renders (hiding reads as missing mail).
// 3. THE LAST-GOOD TOTAL. `needs_reply_total: null` means "unknown", and an
//    unknown must keep the last good number on screen — never become 0.
// 4. THE SEARCH FAN-OUT MERGE. One failed studio must not take down the
//    other studios' results.

import { describe, it, expect, afterEach } from 'vitest'
import {
  MAIL_SCOPE_ALL,
  MAIL_SCOPE_KEY_PREFIX,
  mailScopeKey,
  readMailScope,
  writeMailScope,
  resolveMailScope,
  isUuidShaped,
  buildDigestSections,
  flattenSectionRows,
  resolveNeedsReplyTotal,
  buildLocationTiles,
  withLocationNeedsReply,
  buildSearchSections,
  groupMailboxesByStudio,
} from './mail-digest'

const LOC_A = 'a0000000-0000-4000-8000-000000000001'
const LOC_B = 'b0000000-0000-4000-8000-000000000002'
const LOC_C = 'c0000000-0000-4000-8000-000000000003'

const row = (id, locationId, extra = {}) => ({
  id, location_id: locationId, subject: `Subject ${id}`, ...extra,
})

const digestLocation = (locationId, name, extra = {}) => ({
  location_id: locationId,
  name,
  unavailable: false,
  needs_reply_count: 0,
  view_total: 0,
  conversations: [],
  ...extra,
})

afterEach(() => {
  try { window.localStorage.clear() } catch { /* jsdom always has it */ }
})

/* ── scope persistence ─────────────────────────────────────────────── */

describe('mail scope persistence', () => {
  it('keys storage per user under the house prefix', () => {
    expect(MAIL_SCOPE_KEY_PREFIX).toBe('un1t.mail.scope.')
    expect(mailScopeKey('me-1')).toBe('un1t.mail.scope.me-1')
  })

  it('refuses a key without a user — an unscoped preference could leak between logins', () => {
    expect(mailScopeKey(null)).toBeNull()
    expect(mailScopeKey('')).toBeNull()
  })

  it('round-trips a location scope per user', () => {
    writeMailScope('me-1', LOC_A)
    expect(readMailScope('me-1')).toBe(LOC_A)
    // Another user on the same browser sees their own default, not mine.
    expect(readMailScope('me-2')).toBe(MAIL_SCOPE_ALL)
  })

  it('round-trips All', () => {
    writeMailScope('me-1', LOC_A)
    writeMailScope('me-1', MAIL_SCOPE_ALL)
    expect(readMailScope('me-1')).toBe(MAIL_SCOPE_ALL)
  })

  it('defaults to All with nothing stored, no user, or corrupt storage', () => {
    expect(readMailScope('me-1')).toBe(MAIL_SCOPE_ALL)
    expect(readMailScope(null)).toBe(MAIL_SCOPE_ALL)
    window.localStorage.setItem(mailScopeKey('me-1'), 'not-a-uuid-or-all')
    expect(readMailScope('me-1')).toBe(MAIL_SCOPE_ALL)
  })

  it('never throws when localStorage itself throws (private window / blocked site data)', () => {
    const original = window.localStorage
    const throwing = {
      getItem() { throw new Error('blocked') },
      setItem() { throw new Error('blocked') },
    }
    Object.defineProperty(window, 'localStorage', { value: throwing, configurable: true })
    try {
      expect(readMailScope('me-1')).toBe(MAIL_SCOPE_ALL)
      expect(() => writeMailScope('me-1', LOC_A)).not.toThrow()
    } finally {
      Object.defineProperty(window, 'localStorage', { value: original, configurable: true })
    }
  })

  it('writes nothing for an invalid scope value', () => {
    writeMailScope('me-1', 'javascript:alert(1)')
    expect(window.localStorage.getItem(mailScopeKey('me-1'))).toBeNull()
  })
})

describe('resolveMailScope — fallback to All', () => {
  const known = [LOC_A, LOC_B]

  it('keeps a scope naming a location the digest knows', () => {
    expect(resolveMailScope(LOC_A, known)).toBe(LOC_A)
  })

  it('keeps All', () => {
    expect(resolveMailScope(MAIL_SCOPE_ALL, known)).toBe(MAIL_SCOPE_ALL)
  })

  it('falls back to All for a location no longer in the digest', () => {
    expect(resolveMailScope(LOC_C, known)).toBe(MAIL_SCOPE_ALL)
  })

  it('falls back to All for garbage', () => {
    expect(resolveMailScope(undefined, known)).toBe(MAIL_SCOPE_ALL)
    expect(resolveMailScope('', known)).toBe(MAIL_SCOPE_ALL)
    expect(resolveMailScope(LOC_A, [])).toBe(MAIL_SCOPE_ALL)
    expect(resolveMailScope(LOC_A, null)).toBe(MAIL_SCOPE_ALL)
  })
})

describe('isUuidShaped — the ?loc= validator', () => {
  it('accepts the house id shape', () => {
    expect(isUuidShaped(LOC_A)).toBe(true)
    expect(isUuidShaped('A0000000-0000-4000-8000-00000000000F')).toBe(true)
  })

  it('rejects everything else — a non-uuid ?loc= is not a legitimate deep link', () => {
    expect(isUuidShaped('all')).toBe(false)
    expect(isUuidShaped('..%2F..%2Ffoo')).toBe(false)
    expect(isUuidShaped('')).toBe(false)
    expect(isUuidShaped(null)).toBe(false)
    expect(isUuidShaped(`${LOC_A} `)).toBe(false)
  })
})

/* ── section building ──────────────────────────────────────────────── */

describe('buildDigestSections', () => {
  it('maps each digest location to a section, in the order the server sorted', () => {
    const sections = buildDigestSections({
      locations: [
        digestLocation(LOC_A, 'Hatch Street', {
          needs_reply_count: 3, view_total: 38,
          conversations: [row('t1', LOC_A), row('t2', LOC_A)],
        }),
        digestLocation(LOC_B, 'Stillorgan', {
          needs_reply_count: 1, view_total: 2,
          conversations: [row('t3', LOC_B), row('t4', LOC_B)],
        }),
      ],
    })
    expect(sections.map(s => s.locationId)).toEqual([LOC_A, LOC_B])
    expect(sections[0]).toMatchObject({
      name: 'Hatch Street', unavailable: false, needsReplyCount: 3, viewTotal: 38,
    })
    expect(sections[0].conversations.map(c => c.id)).toEqual(['t1', 't2'])
  })

  it('shows the View-all row only past the cap — view_total beyond what is on screen', () => {
    const sections = buildDigestSections({
      locations: [
        digestLocation(LOC_A, 'Hatch Street', { view_total: 38, conversations: [row('t1', LOC_A)] }),
        digestLocation(LOC_B, 'Stillorgan', { view_total: 1, conversations: [row('t2', LOC_B)] }),
      ],
    })
    expect(sections[0].hasMore).toBe(true)
    expect(sections[1].hasMore).toBe(false)
  })

  it('keeps an empty section — header plus quiet empty, never hidden', () => {
    const sections = buildDigestSections({
      locations: [digestLocation(LOC_A, 'Hatch Street', { view_total: 0 })],
    })
    expect(sections).toHaveLength(1)
    expect(sections[0].conversations).toEqual([])
    expect(sections[0].hasMore).toBe(false)
  })

  it('carries an unavailable location as an error section, with null counts', () => {
    const sections = buildDigestSections({
      locations: [
        digestLocation(LOC_A, 'Hatch Street', {
          unavailable: true, needs_reply_count: null, view_total: null,
        }),
        digestLocation(LOC_B, 'Stillorgan', { view_total: 1, conversations: [row('t2', LOC_B)] }),
      ],
    })
    expect(sections[0]).toMatchObject({ unavailable: true, needsReplyCount: null, viewTotal: null })
    // An unavailable section must never claim "View all null".
    expect(sections[0].hasMore).toBe(false)
    expect(sections[1].unavailable).toBe(false)
  })

  it('never offers View-all on an unavailable section even if a total sneaks through', () => {
    // The route nulls counts on unavailable — but the guard must not lean on
    // that: a mixed payload (a future server change, a cached shape) must not
    // paint a "View all 9" over an error state.
    const sections = buildDigestSections({
      locations: [digestLocation(LOC_A, 'Hatch Street', { unavailable: true, view_total: 9 })],
    })
    expect(sections[0].hasMore).toBe(false)
  })

  it('flags per-section count trouble from either server flag', () => {
    const sections = buildDigestSections({
      locations: [
        digestLocation(LOC_A, 'A', { counts_partial: true }),
        digestLocation(LOC_B, 'B', { counts_unavailable: true }),
        digestLocation(LOC_C, 'C'),
      ],
    })
    expect(sections.map(s => s.countsPartial)).toEqual([true, true, false])
  })

  it('answers [] for garbage payloads rather than throwing', () => {
    expect(buildDigestSections(null)).toEqual([])
    expect(buildDigestSections({})).toEqual([])
    expect(buildDigestSections({ locations: 'nope' })).toEqual([])
  })
})

describe('flattenSectionRows — the one ordered list j/k walks', () => {
  it('concatenates section rows in section order', () => {
    const sections = buildDigestSections({
      locations: [
        digestLocation(LOC_A, 'A', { view_total: 2, conversations: [row('t1', LOC_A), row('t2', LOC_A)] }),
        digestLocation(LOC_B, 'B', { view_total: 1, conversations: [row('t3', LOC_B)] }),
      ],
    })
    expect(flattenSectionRows(sections).map(c => c.id)).toEqual(['t1', 't2', 't3'])
  })

  it('skips nothing for an unavailable section (its rows are empty) and tolerates garbage', () => {
    const sections = buildDigestSections({
      locations: [
        digestLocation(LOC_A, 'A', { unavailable: true, needs_reply_count: null, view_total: null }),
        digestLocation(LOC_B, 'B', { view_total: 1, conversations: [row('t3', LOC_B)] }),
      ],
    })
    expect(flattenSectionRows(sections).map(c => c.id)).toEqual(['t3'])
    expect(flattenSectionRows(null)).toEqual([])
  })
})

/* ── the last-good total ───────────────────────────────────────────── */

describe('resolveNeedsReplyTotal', () => {
  it('takes a fresh number, including a genuine zero', () => {
    expect(resolveNeedsReplyTotal(5, 3)).toBe(5)
    expect(resolveNeedsReplyTotal(0, 3)).toBe(0)
  })

  it('keeps the last good number when the incoming total is unknown', () => {
    expect(resolveNeedsReplyTotal(null, 3)).toBe(3)
    expect(resolveNeedsReplyTotal(undefined, 3)).toBe(3)
  })

  it('answers null — never a fabricated 0 — when nothing was ever known', () => {
    expect(resolveNeedsReplyTotal(null, null)).toBeNull()
    expect(resolveNeedsReplyTotal(undefined, undefined)).toBeNull()
  })
})

/* ── tiles ─────────────────────────────────────────────────────────── */

describe('buildLocationTiles', () => {
  const eligible = [
    { id: LOC_A, name: 'Hatch Street' },
    { id: LOC_B, name: 'Stillorgan' },
  ]

  it('before the digest answers: one tile per eligible location, counts unknown (no chip, never 0)', () => {
    const tiles = buildLocationTiles({ eligible, digestLocations: null, allCount: null })
    expect(tiles.map(t => t.id)).toEqual([MAIL_SCOPE_ALL, LOC_A, LOC_B])
    expect(tiles[0].name).toBe('All locations')
    expect(tiles.map(t => t.count)).toEqual([null, null, null])
  })

  it('after the digest answers: tiles are the digest locations, with needs-reply counts', () => {
    const tiles = buildLocationTiles({
      eligible,
      digestLocations: [
        digestLocation(LOC_A, 'Hatch Street', { needs_reply_count: 4 }),
        digestLocation(LOC_B, 'Stillorgan', { needs_reply_count: 1 }),
      ],
      allCount: 5,
    })
    expect(tiles.map(t => t.count)).toEqual([5, 4, 1])
    expect(tiles[1].name).toBe('Hatch Street')
  })

  it('a mailbox-less studio (absent from the digest) loses its tile', () => {
    const tiles = buildLocationTiles({
      eligible: [...eligible, { id: LOC_C, name: 'Ghost' }],
      digestLocations: [
        digestLocation(LOC_A, 'Hatch Street'),
        digestLocation(LOC_B, 'Stillorgan'),
      ],
      allCount: 0,
    })
    expect(tiles.map(t => t.id)).toEqual([MAIL_SCOPE_ALL, LOC_A, LOC_B])
  })

  it('an unavailable studio keeps its tile with NO count — unknown must not render as 0', () => {
    const tiles = buildLocationTiles({
      eligible,
      digestLocations: [
        digestLocation(LOC_A, 'Hatch Street', {
          unavailable: true, needs_reply_count: null, view_total: null,
        }),
        digestLocation(LOC_B, 'Stillorgan', { needs_reply_count: 2 }),
      ],
      allCount: null,
    })
    expect(tiles[1].count).toBeNull()
    expect(tiles[2].count).toBe(2)
  })

  it('an unavailable studio has NO count even if a number sneaks past the route', () => {
    // Defensive twin of the section-level guard: the route nulls counts on
    // unavailable, but the tile must not lean on that.
    const tiles = buildLocationTiles({
      eligible,
      digestLocations: [digestLocation(LOC_A, 'Hatch Street', { unavailable: true, needs_reply_count: 6 })],
      allCount: null,
    })
    expect(tiles[1].count).toBeNull()
  })

  it('a genuinely-zero All total stays 0 — "known nothing waiting" is not "unknown"', () => {
    const tiles = buildLocationTiles({ eligible, digestLocations: null, allCount: 0 })
    expect(tiles[0].count).toBe(0)
  })
})

describe('withLocationNeedsReply — a scoped refresh updates its own tile', () => {
  it('replaces exactly one location count and leaves the rest alone', () => {
    const digestLocations = [
      digestLocation(LOC_A, 'A', { needs_reply_count: 4 }),
      digestLocation(LOC_B, 'B', { needs_reply_count: 1 }),
    ]
    const next = withLocationNeedsReply(digestLocations, LOC_A, 7)
    expect(next.map(l => l.needs_reply_count)).toEqual([7, 1])
    // Pure — the input is not mutated.
    expect(digestLocations[0].needs_reply_count).toBe(4)
  })

  it('leaves an unknown location list untouched', () => {
    expect(withLocationNeedsReply(null, LOC_A, 7)).toBeNull()
    const digestLocations = [digestLocation(LOC_B, 'B', { needs_reply_count: 1 })]
    expect(withLocationNeedsReply(digestLocations, LOC_A, 7)).toBe(digestLocations)
  })

  it('refuses a non-number — a failed count read must not overwrite a good one', () => {
    const digestLocations = [digestLocation(LOC_A, 'A', { needs_reply_count: 4 })]
    expect(withLocationNeedsReply(digestLocations, LOC_A, null)).toBe(digestLocations)
  })
})

/* ── the search fan-out merge ──────────────────────────────────────── */

describe('buildSearchSections', () => {
  const locations = [
    { locationId: LOC_A, name: 'Hatch Street' },
    { locationId: LOC_B, name: 'Stillorgan' },
  ]

  it('groups per-location results under the same section headers, uncapped', () => {
    const sections = buildSearchSections(locations, {
      [LOC_A]: { ok: true, conversations: [row('t1', LOC_A), row('t2', LOC_A)], searchPartial: false },
      [LOC_B]: { ok: true, conversations: [row('t3', LOC_B)], searchPartial: false },
    })
    expect(sections.map(s => s.locationId)).toEqual([LOC_A, LOC_B])
    expect(sections[0].conversations.map(c => c.id)).toEqual(['t1', 't2'])
    // Search sections never offer View-all — the results ARE everything found.
    expect(sections.every(s => s.hasMore === false)).toBe(true)
  })

  it('a failed studio becomes an error section while the others still render', () => {
    const sections = buildSearchSections(locations, {
      [LOC_A]: { ok: false },
      [LOC_B]: { ok: true, conversations: [row('t3', LOC_B)], searchPartial: false },
    })
    expect(sections[0]).toMatchObject({ unavailable: true, conversations: [] })
    expect(sections[1].conversations.map(c => c.id)).toEqual(['t3'])
  })

  it('a studio with no matches keeps its section (empty), and a missing result reads as failed', () => {
    const sections = buildSearchSections(locations, {
      [LOC_A]: { ok: true, conversations: [], searchPartial: false },
      // LOC_B never answered at all — that is a failure, not an empty result.
    })
    expect(sections[0]).toMatchObject({ unavailable: false, conversations: [] })
    expect(sections[1].unavailable).toBe(true)
  })

  it('carries each studio own truncation flag', () => {
    const sections = buildSearchSections(locations, {
      [LOC_A]: { ok: true, conversations: [row('t1', LOC_A)], searchPartial: true },
      [LOC_B]: { ok: true, conversations: [], searchPartial: false },
    })
    expect(sections.map(s => s.searchPartial)).toEqual([true, false])
  })
})

/* ── compose From grouping ─────────────────────────────────────────── */

describe('groupMailboxesByStudio', () => {
  const mb = (id, extra = {}) => ({ id, address: `${id}@x.ie`, label: null, is_default: false, active: true, ...extra })

  it('with 2+ studios: flattens in studio order and prefixes each label with the studio name', () => {
    const options = groupMailboxesByStudio([
      { locationId: LOC_A, name: 'Hatch Street', mailboxes: [mb('accounts')] },
      { locationId: LOC_B, name: 'Stillorgan', mailboxes: [mb('info', { label: 'Info' }), mb('sales')] },
    ])
    expect(options.map(o => o.id)).toEqual(['accounts', 'info', 'sales'])
    expect(options[0].label).toBe('Hatch Street · accounts@x.ie')
    expect(options[1].label).toBe('Stillorgan · Info')
  })

  it('with one studio holding mailboxes: hands its mailboxes back untouched — no prefix noise', () => {
    const single = [{ locationId: LOC_A, name: 'Hatch Street', mailboxes: [mb('accounts')] }]
    expect(groupMailboxesByStudio(single)).toEqual(single[0].mailboxes)
    // A second studio with NO mailboxes does not force prefixes either.
    const withEmpty = [...single, { locationId: LOC_B, name: 'Stillorgan', mailboxes: [] }]
    expect(groupMailboxesByStudio(withEmpty)).toEqual(single[0].mailboxes)
  })

  it('tolerates garbage', () => {
    expect(groupMailboxesByStudio(null)).toEqual([])
    expect(groupMailboxesByStudio([])).toEqual([])
  })
})
