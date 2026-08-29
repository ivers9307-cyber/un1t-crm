// MAIL-ALLLOC.1 — the mobile decisions behind the location tiles and the
// All-locations digest view. Screens have no render harness (contract rule 6),
// so everything the Mail tab branches on for multi-location rendering is
// pinned here: scope persistence (AsyncStorage, fail-closed like the reply
// drafts store), the fallback-to-All rule, tile derivation (needs-reply
// ALWAYS, unavailable ≠ zero), section building (rows byte-shaped like list
// rows, View-all only when the cap hid something, empty rendered not hidden),
// the last-good-total rule (partial must never render as 0), the optimistic
// archive/undo ops over the digest shape, and the scope params the search +
// compose screens parse back out.
//
// AsyncStorage is mocked with a factory BEFORE import (the mail-drafts.js
// idiom): the RN runtime must never load under vitest's Node environment.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map()
let failStorage = false
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k) => {
      if (failStorage) throw new Error('storage unavailable')
      return store.has(k) ? store.get(k) : null
    }),
    setItem: vi.fn(async (k, v) => {
      if (failStorage) throw new Error('storage unavailable')
      store.set(k, v)
    }),
    removeItem: vi.fn(async (k) => {
      if (failStorage) throw new Error('storage unavailable')
      store.delete(k)
    }),
  },
}))

import {
  MAIL_SCOPE_PREFIX, ALL_SCOPE,
  mailScopeKey, readMailScope, writeMailScope, resolveScope,
  showLocationTiles, locationTiles, tileChipStyle, resolveNeedsReplyTotal,
  buildDigestSections, SECTION_EMPTY_TEXT, sectionUnavailableCopy,
  removeConversation, insertConversation, patchConversation,
  digestCountsNotice, allModeListState,
  buildScopeParams, parseLocationsParam, parseScopeParams,
} from './mail-digest'

beforeEach(() => {
  store.clear()
  failStorage = false
})

// ── Fixtures ─────────────────────────────────────────────────────────

const conv = (id, over = {}) => ({
  id,
  subject: `Subject ${id}`,
  status: 'open',
  requester_name: 'Sarah',
  requester_email: 'sarah@example.com',
  last_message_at: '2026-08-29T10:00:00Z',
  last_message_direction: 'inbound',
  needs_reply: true,
  archived: false,
  unread: true,
  unread_count_messages: 1,
  message_count: 2,
  has_attachments: false,
  mailbox_id: 'mb-1',
  location_id: 'loc-a',
  ...over,
})

const loc = (id, name, over = {}) => ({
  location_id: id,
  name,
  unavailable: false,
  needs_reply_count: 3,
  view_total: 8,
  conversations: [conv(`${id}-t1`, { location_id: id })],
  ...over,
})

// ── Scope persistence ────────────────────────────────────────────────

describe('mailScopeKey', () => {
  it('is the web key shape, per user', () => {
    expect(mailScopeKey('u-1')).toBe(`${MAIL_SCOPE_PREFIX}u-1`)
    expect(mailScopeKey('u-1')).toBe('un1t.mail.scope.u-1')
  })

  it('fails CLOSED with no user id — an unscoped scope is another user’s scope', () => {
    expect(mailScopeKey(null)).toBe(null)
    expect(mailScopeKey('')).toBe(null)
    expect(mailScopeKey(undefined)).toBe(null)
  })
})

describe('readMailScope / writeMailScope', () => {
  it('round-trips a location scope', async () => {
    expect(await writeMailScope('u-1', 'loc-b')).toBe(true)
    expect(await readMailScope('u-1')).toBe('loc-b')
  })

  it('round-trips the All scope', async () => {
    await writeMailScope('u-1', ALL_SCOPE)
    expect(await readMailScope('u-1')).toBe(ALL_SCOPE)
  })

  it('is per user — one person’s scope never hydrates another’s', async () => {
    await writeMailScope('u-1', 'loc-b')
    expect(await readMailScope('u-2')).toBe(null)
  })

  it('reads null with nothing stored, no user id, or broken storage', async () => {
    expect(await readMailScope('u-1')).toBe(null)
    expect(await readMailScope(null)).toBe(null)
    await writeMailScope('u-1', 'loc-b')
    failStorage = true
    expect(await readMailScope('u-1')).toBe(null)
  })

  it('refuses to write junk or without a user id, and never throws on broken storage', async () => {
    expect(await writeMailScope(null, 'loc-b')).toBe(false)
    expect(await writeMailScope('u-1', '')).toBe(false)
    expect(await writeMailScope('u-1', 42)).toBe(false)
    failStorage = true
    expect(await writeMailScope('u-1', 'loc-b')).toBe(false)
  })
})

describe('resolveScope', () => {
  const locations = [loc('loc-a', 'Hatch Street'), loc('loc-b', 'Stillorgan')]

  it('defaults to All when nothing is persisted', () => {
    expect(resolveScope(null, locations)).toBe(ALL_SCOPE)
    expect(resolveScope(undefined, locations)).toBe(ALL_SCOPE)
  })

  it('keeps a persisted All', () => {
    expect(resolveScope(ALL_SCOPE, locations)).toBe(ALL_SCOPE)
  })

  it('keeps a persisted location still present in the digest', () => {
    expect(resolveScope('loc-b', locations)).toBe('loc-b')
  })

  it('falls back to All when the persisted location left the digest', () => {
    expect(resolveScope('loc-gone', locations)).toBe(ALL_SCOPE)
    expect(resolveScope('loc-b', [loc('loc-a', 'Hatch Street')])).toBe(ALL_SCOPE)
  })
})

// ── Tiles ────────────────────────────────────────────────────────────

describe('showLocationTiles', () => {
  it('renders only from two locations — a single-location caller sees today’s UI', () => {
    expect(showLocationTiles([])).toBe(false)
    expect(showLocationTiles([loc('loc-a', 'Hatch Street')])).toBe(false)
    expect(showLocationTiles([loc('loc-a', 'A'), loc('loc-b', 'B')])).toBe(true)
    expect(showLocationTiles(null)).toBe(false)
  })
})

describe('locationTiles', () => {
  it('leads with All carrying the summed needs-reply total, then one tile per studio', () => {
    const tiles = locationTiles(
      [loc('loc-a', 'Hatch Street', { needs_reply_count: 4 }), loc('loc-b', 'Stillorgan', { needs_reply_count: 1 })],
      5,
    )
    expect(tiles).toEqual([
      { id: ALL_SCOPE, label: 'All', count: '5' },
      { id: 'loc-a', label: 'Hatch Street', count: '4' },
      { id: 'loc-b', label: 'Stillorgan', count: '1' },
    ])
  })

  it('shows no chip at zero, for an unknown total, and for an unavailable location — never a confident 0', () => {
    const tiles = locationTiles(
      [
        loc('loc-a', 'Hatch Street', { needs_reply_count: 0 }),
        loc('loc-b', 'Stillorgan', { unavailable: true, needs_reply_count: null, view_total: null, conversations: [] }),
      ],
      null,
    )
    expect(tiles[0].count).toBe(null) // unknown All total: nothing, not 0
    expect(tiles[1].count).toBe(null) // a genuine zero: quiet
    expect(tiles[2].count).toBe(null) // unavailable: no claim at all
  })

  it('an unavailable location makes no claim even over a stale non-null count', () => {
    // The route nulls counts on unavailable; this pins the rule so the tile
    // never depends on that staying true.
    const tiles = locationTiles([loc('loc-a', 'A', { unavailable: true, needs_reply_count: 7 })], 7)
    expect(tiles[1].count).toBe(null)
  })

  it('caps like every other badge', () => {
    const tiles = locationTiles([loc('loc-a', 'A', { needs_reply_count: 250 })], 250)
    expect(tiles[0].count).toBe('99+')
    expect(tiles[1].count).toBe('99+')
  })

  it('falls back to a plain word for an unnamed location', () => {
    expect(locationTiles([loc('loc-a', null)], 0)[1].label).toBe('Studio')
  })
})

describe('tileChipStyle', () => {
  it('is the contract’s amber chip recipe on a light tile', () => {
    expect(tileChipStyle(false)).toEqual({ cls: 'bg-amber-500/10', text: 'text-amber-700' })
  })
  it('goes solid light amber on the selected ink tile — the /10 wash is invisible on ink', () => {
    expect(tileChipStyle(true)).toEqual({ cls: 'bg-amber-50', text: 'text-amber-700' })
  })
})

describe('resolveNeedsReplyTotal', () => {
  it('takes a real number, zero included', () => {
    expect(resolveNeedsReplyTotal(5, 2)).toBe(5)
    expect(resolveNeedsReplyTotal(0, 2)).toBe(0)
  })

  it('keeps the LAST GOOD number when the digest answered partial (null)', () => {
    expect(resolveNeedsReplyTotal(null, 7)).toBe(7)
    expect(resolveNeedsReplyTotal(undefined, 7)).toBe(7)
  })

  it('answers null — never 0 — when there has never been a good number', () => {
    expect(resolveNeedsReplyTotal(null, null)).toBe(null)
    expect(resolveNeedsReplyTotal(NaN, null)).toBe(null)
  })
})

// ── Sections ─────────────────────────────────────────────────────────

describe('buildDigestSections', () => {
  it('shapes rows exactly like list rows, stamps each with its location, and never a mailbox label', () => {
    const sections = buildDigestSections([
      loc('loc-a', 'Hatch Street', { conversations: [conv('t1', { location_id: 'loc-a' })] }),
    ])
    expect(sections).toHaveLength(1)
    const row = sections[0].data[0]
    expect(row.id).toBe('t1')
    expect(row.location_id).toBe('loc-a')
    expect(row.needs_reply).toBe(true)
    expect(row.unread).toBe(true)
    // All mode groups by studio so no row ever grows a label (locked design).
    expect(row.mailbox_label).toBe(null)
  })

  it('keeps the digest’s name order and keys sections by location', () => {
    const sections = buildDigestSections([loc('loc-a', 'Hatch Street'), loc('loc-b', 'Stillorgan')])
    expect(sections.map(s => s.key)).toEqual(['loc-a', 'loc-b'])
    expect(sections.map(s => s.name)).toEqual(['Hatch Street', 'Stillorgan'])
  })

  it('offers View-all only when the cap hid something, naming the view’s true total', () => {
    const sections = buildDigestSections([
      loc('loc-a', 'Hatch Street', { view_total: 38, conversations: [conv('t1'), conv('t2')] }),
      loc('loc-b', 'Stillorgan', { view_total: 2, conversations: [conv('t3'), conv('t4')] }),
    ])
    expect(sections[0].viewAllLabel).toBe('View all 38 in Hatch Street →')
    // Everything already on screen: no View-all row (mockup §01 note 3).
    expect(sections[1].viewAllLabel).toBe(null)
  })

  it('renders an empty section as header + quiet empty, never hides it — hiding reads as missing mail', () => {
    const sections = buildDigestSections([
      loc('loc-a', 'Hatch Street', { view_total: 0, needs_reply_count: 0, conversations: [] }),
    ])
    expect(sections).toHaveLength(1)
    expect(sections[0].state).toBe('empty')
    expect(sections[0].data).toEqual([])
    expect(sections[0].viewAllLabel).toBe(null)
    expect(SECTION_EMPTY_TEXT).toBe('Nothing here')
  })

  it('renders an unavailable location as its own inline error state', () => {
    const sections = buildDigestSections([
      loc('loc-a', 'Hatch Street', { unavailable: true, needs_reply_count: null, view_total: null, conversations: [] }),
      loc('loc-b', 'Stillorgan'),
    ])
    expect(sections[0].state).toBe('error')
    expect(sections[0].data).toEqual([])
    expect(sections[1].state).toBe('rows')
  })

  it('states the needs-reply count in the header, pluralised, and only when it is a number above zero', () => {
    const [a, b, c, d] = buildDigestSections([
      loc('loc-a', 'A', { needs_reply_count: 3 }),
      loc('loc-b', 'B', { needs_reply_count: 1 }),
      loc('loc-c', 'C', { needs_reply_count: 0 }),
      loc('loc-d', 'D', { unavailable: true, needs_reply_count: null, view_total: null, conversations: [] }),
    ])
    expect(a.headerDetail).toBe('3 need reply')
    expect(b.headerDetail).toBe('1 needs reply')
    expect(c.headerDetail).toBe(null)
    expect(d.headerDetail).toBe(null)
  })

  it('handles null/empty input without guards for consumers', () => {
    expect(buildDigestSections(null)).toEqual([])
    expect(buildDigestSections([])).toEqual([])
  })
})

describe('sectionUnavailableCopy', () => {
  it('names the studio and offers the retry', () => {
    expect(sectionUnavailableCopy('Hatch Street')).toEqual({
      text: 'Hatch Street couldn’t be reached',
      retry: 'Retry',
    })
  })
  it('survives a nameless location', () => {
    expect(sectionUnavailableCopy(null).text).toBe('This studio couldn’t be reached')
  })
})

// ── Optimistic ops over the digest shape ─────────────────────────────

describe('removeConversation', () => {
  const locations = [
    loc('loc-a', 'A', { view_total: 3, conversations: [conv('t1'), conv('t2')] }),
    loc('loc-b', 'B', { view_total: 1, conversations: [conv('t3')] }),
  ]

  it('removes the row, remembers where it was, and decrements the view total', () => {
    const { locations: next, removed } = removeConversation(locations, 't2')
    expect(next[0].conversations.map(c => c.id)).toEqual(['t1'])
    expect(next[0].view_total).toBe(2)
    expect(removed).toEqual({ locationId: 'loc-a', index: 1, conversation: locations[0].conversations[1] })
    // Pure — the input is untouched (the snack holds a reference into it).
    expect(locations[0].conversations).toHaveLength(2)
    expect(locations[0].view_total).toBe(3)
  })

  it('leaves other locations alone', () => {
    const { locations: next } = removeConversation(locations, 't3')
    expect(next[0]).toBe(locations[0])
    expect(next[1].conversations).toEqual([])
    expect(next[1].view_total).toBe(0)
  })

  it('answers removed:null for an unknown id and never drops the total below zero', () => {
    const { removed } = removeConversation(locations, 't-nope')
    expect(removed).toBe(null)
    const zeroed = [loc('loc-a', 'A', { view_total: 0, conversations: [conv('t1')] })]
    expect(removeConversation(zeroed, 't1').locations[0].view_total).toBe(0)
  })
})

describe('insertConversation', () => {
  const locations = [loc('loc-a', 'A', { view_total: 2, conversations: [conv('t1'), conv('t3')] })]

  it('puts an undone row back where it was and restores the view total', () => {
    const next = insertConversation(locations, 'loc-a', conv('t2'), 1)
    expect(next[0].conversations.map(c => c.id)).toEqual(['t1', 't2', 't3'])
    expect(next[0].view_total).toBe(3)
    expect(locations[0].conversations).toHaveLength(2) // pure
  })

  it('clamps a stale index and appends on a negative one', () => {
    expect(insertConversation(locations, 'loc-a', conv('t9'), 99)[0].conversations.map(c => c.id))
      .toEqual(['t1', 't3', 't9'])
    expect(insertConversation(locations, 'loc-a', conv('t9'), -1)[0].conversations.map(c => c.id))
      .toEqual(['t1', 't3', 't9'])
  })

  it('never duplicates a row the list already holds again', () => {
    const next = insertConversation(locations, 'loc-a', conv('t1'), 0)
    expect(next[0].conversations.map(c => c.id)).toEqual(['t1', 't3'])
    expect(next[0].view_total).toBe(2)
  })

  it('is a no-op for a location no longer in the digest', () => {
    const next = insertConversation(locations, 'loc-gone', conv('t9'), 0)
    expect(next[0].conversations).toHaveLength(2)
  })
})

describe('patchConversation', () => {
  it('patches exactly the one row, purely', () => {
    const locations = [loc('loc-a', 'A', { conversations: [conv('t1', { unread: true }), conv('t2')] })]
    const next = patchConversation(locations, 't1', { unread: false })
    expect(next[0].conversations[0].unread).toBe(false)
    expect(next[0].conversations[1]).toBe(locations[0].conversations[1])
    expect(locations[0].conversations[0].unread).toBe(true)
  })
})

// ── Honest states ────────────────────────────────────────────────────

describe('digestCountsNotice', () => {
  it('says so when ANY section’s read-state scan failed — the C2 rule, summed', () => {
    expect(digestCountsNotice([loc('loc-a', 'A'), loc('loc-b', 'B', { counts_unavailable: true })]))
      .toBe('Couldn’t check read state — unread marks may be missing.')
  })
  it('reports a partial scan', () => {
    expect(digestCountsNotice([loc('loc-a', 'A', { counts_partial: true })]))
      .toBe('Read state is incomplete on this page.')
  })
  it('unavailable outranks partial; healthy is quiet', () => {
    expect(digestCountsNotice([
      loc('loc-a', 'A', { counts_partial: true }),
      loc('loc-b', 'B', { counts_unavailable: true }),
    ])).toBe('Couldn’t check read state — unread marks may be missing.')
    expect(digestCountsNotice([loc('loc-a', 'A')])).toBe(null)
  })
})

describe('allModeListState', () => {
  it('shows sections when the load worked, or when a SAME-view refresh failed (banner, not blank)', () => {
    expect(allModeListState({ error: null, loadedView: 'inbox', view: 'inbox' })).toBe('sections')
    expect(allModeListState({ error: 'x', loadedView: 'inbox', view: 'inbox' })).toBe('sections')
  })
  it('shows the error state when the sections on screen answer ANOTHER view — the audit S1 rule', () => {
    expect(allModeListState({ error: 'x', loadedView: 'inbox', view: 'archived' })).toBe('error')
  })
  it('a view mismatch WITHOUT an error is not an error — that is just a load in flight', () => {
    expect(allModeListState({ error: null, loadedView: 'inbox', view: 'archived' })).toBe('sections')
  })
})

// ── Scope params (search + compose hand-off) ─────────────────────────

describe('scope params', () => {
  const locations = [loc('loc-a', 'Hatch Street'), loc('loc-b', 'Stillorgan')]

  it('round-trips through expo-router string params', () => {
    const params = buildScopeParams(ALL_SCOPE, locations)
    expect(params.scope).toBe(ALL_SCOPE)
    expect(parseLocationsParam(params.locs)).toEqual([
      { id: 'loc-a', name: 'Hatch Street' },
      { id: 'loc-b', name: 'Stillorgan' },
    ])
    expect(parseScopeParams(params, 'loc-active')).toEqual({
      mode: 'all',
      locations: [
        { id: 'loc-a', name: 'Hatch Street' },
        { id: 'loc-b', name: 'Stillorgan' },
      ],
    })
  })

  it('carries a studio scope as scoped mode', () => {
    const params = buildScopeParams('loc-b', locations)
    expect(parseScopeParams(params, 'loc-active')).toEqual({ mode: 'scoped', locationId: 'loc-b' })
  })

  it('falls back to today’s behaviour with no params, junk JSON, or an All scope with no targets', () => {
    expect(parseScopeParams({}, 'loc-active')).toEqual({ mode: 'scoped', locationId: 'loc-active' })
    expect(parseScopeParams({ scope: ALL_SCOPE, locs: '{not json' }, 'loc-active'))
      .toEqual({ mode: 'scoped', locationId: 'loc-active' })
    expect(parseScopeParams({ scope: ALL_SCOPE, locs: '[]' }, 'loc-active'))
      .toEqual({ mode: 'scoped', locationId: 'loc-active' })
  })

  it('drops malformed location entries rather than fanning out to garbage', () => {
    const locs = JSON.stringify([{ id: 'loc-a', name: 'A' }, { id: '', name: 'B' }, 'junk', { name: 'C' }])
    expect(parseLocationsParam(locs)).toEqual([{ id: 'loc-a', name: 'A' }])
  })
})
