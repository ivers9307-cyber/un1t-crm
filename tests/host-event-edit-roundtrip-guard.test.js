// RATINGCOPY.1 — every column the host event SAVE writes must reach the form.
//
// The host form posts every field on every save, and PUT /api/host/events/[id]
// writes each one unconditionally (`input.x ?? null`). So a column the route
// writes but the edit page does not hand to the form is wiped by the host's
// next save, whatever they changed: the field starts blank and posts null.
//
// Live from HOSTPAGE.2 (PR #2327, 8 Nov 2026): the edit page SELECTed
// rating_email_subject / rating_email_intro and never put them in `initial`,
// so a host's customised rating request copy was erased the next time they
// saved that event. The same PR's POST /api/host/events accepted both fields
// in the schema and never inserted them, and duplicateEvent copied every
// other email copy column but not these two.
//
// This reads the two routes and the page as source and fails when:
//   1. PUT writes a body column that hostEventFormInitial() does not return
//      (or returns from a different column), or the page does not select it;
//   2. PUT writes a body column that POST (create) does not insert;
//   3. the edit page stops building `initial` through hostEventFormInitial.
//
// Blind spots (a floor, not proof): a column written through a variable or a
// helper rather than a key in the `.update({ … })` / `.insert({ … })` literal,
// and the form itself (HostEventForm.test.jsx covers reading `initial`).
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { stripCommentsOfFile, stripComments } from './helpers/js-code.js'
import { hostEventFormInitial } from '../src/lib/host-event-form-initial.js'
import { DUPLICATE_COLUMNS } from '../src/lib/event-duplicate.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const PUT_ROUTE = 'src/app/api/host/events/[id]/route.js'
const POST_ROUTE = 'src/app/api/host/events/route.js'
const EDIT_PAGE = 'src/app/host/(portal)/events/[id]/setup/page.js'
const code = (rel) => stripCommentsOfFile(path.join(ROOT, rel))

/**
 * Columns the PUT route decides itself, never read from the form, each with
 * the reason. An entry the route no longer writes fails (stale).
 */
export const ROUTE_DECIDED = {
  status: 'the edit transition (computeEditTransition): a host never sets it',
  submitted_at: 'stamped by a re-review',
  reviewed_at: 'cleared by a re-review',
}

/** The object literal that opens at the first `{` after `marker` (braces matched). */
export function objectLiteralAfter(source, marker) {
  const at = source.indexOf(marker)
  if (at === -1) return null
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  return null
}

/** Every `key:` in an object literal, at any depth (conditional spreads included). */
export function keysOf(literal) {
  return [...new Set([...literal.matchAll(/[{,]\s*([a-z_][a-z0-9_]*)\s*:/g)].map((m) => m[1]))]
}

const putKeys = keysOf(objectLiteralAfter(code(PUT_ROUTE), ".from('race_events').update("))
const postKeys = keysOf(objectLiteralAfter(code(POST_ROUTE), '.insert('))
const formColumns = putKeys.filter((k) => !(k in ROUTE_DECIDED))

describe('host event edit round trip (RATINGCOPY.1)', () => {
  it('reads the routes (the scan is not blind)', () => {
    expect(formColumns.length).toBeGreaterThanOrEqual(22)
    for (const k of ['name', 'race_date', 'venue_name', 'confirmation_email_subject', 'rating_email_subject', 'rating_email_intro', 'series_id']) {
      expect(putKeys, k).toContain(k)
    }
    expect(postKeys).toContain('host_id')
  })

  it('ROUTE_DECIDED holds only columns the PUT route still writes', () => {
    expect(Object.keys(ROUTE_DECIDED).filter((k) => !putKeys.includes(k))).toEqual([])
  })

  it('every column PUT writes from the body is handed to the form by hostEventFormInitial', () => {
    // A row whose every column holds its own name: the mapper must return that
    // value under that key, so a missing key AND a crossed one both fail.
    const row = Object.fromEntries(formColumns.map((c) => [c, `value-of-${c}`]))
    const initial = hostEventFormInitial({ ...row, race_waves: [] })
    const lost = formColumns.filter((c) => initial[c] !== `value-of-${c}`)
    expect(lost, `PUT ${PUT_ROUTE} writes these columns but the edit form never receives them, so the next save wipes them`).toEqual([])
  })

  it('the edit page selects every one of them and builds `initial` through the helper', () => {
    const page = code(EDIT_PAGE)
    expect(page).toMatch(/const initial = hostEventFormInitial\(event\)/)
    expect(page).toMatch(/<HostEventForm[^>]*\binitial=\{initial\}/)
    // The select's columns are loadHostEvent's last argument (HOSTPORTAL.2:
    // the page no longer spells the query): everything between the call and
    // the `if (!event) notFound()` that follows it.
    const from = page.indexOf('loadHostEvent(\n')
    expect(from, 'the page reads its event through loadHostEvent').toBeGreaterThan(-1)
    const select = page.slice(from, page.indexOf('if (!event) notFound()', from))
    expect(select.length).toBeGreaterThan(100)
    const unselected = formColumns.filter((c) => !new RegExp(`\\b${c}\\b`).test(select))
    expect(unselected, 'columns the form needs that the page does not select').toEqual([])
  })

  it('every column PUT writes from the body is inserted by POST (create) too', () => {
    const dropped = formColumns.filter((c) => !postKeys.includes(c))
    expect(dropped, `the form sends these on create and ${POST_ROUTE} drops them`).toEqual([])
  })

  it('a copy of an event keeps the rating request copy with the other email copy', () => {
    for (const c of ['confirmation_email_subject', 'confirmation_email_intro', 'reminder_email_subject', 'reminder_email_intro', 'rating_email_subject', 'rating_email_intro']) {
      expect(DUPLICATE_COLUMNS, c).toContain(c)
    }
  })
})

describe('the scan itself', () => {
  const SAMPLE = stripComments(`
    const slugPatch = { slug: 'x' }
    await db.from('race_events').update({
      ...slugPatch,
      name: input.name,
      // gone_column: input.gone,
      venue_name: input.venue_name ?? null,
      ...('series_id' in input ? { series_id: input.series_id ?? null } : {}),
      ...(t.reReview ? { submitted_at: new Date().toISOString(), reviewed_at: null } : {}),
    }).eq('id', id)
  `, 'sample.js')
  it('finds top-level keys and keys inside conditional spreads, never a commented one', () => {
    expect(keysOf(objectLiteralAfter(SAMPLE, ".from('race_events').update("))).toEqual(['name', 'venue_name', 'series_id', 'submitted_at', 'reviewed_at'])
  })
  it('a missing marker is null, not an empty list', () => {
    expect(objectLiteralAfter(SAMPLE, '.upsert(')).toBeNull()
  })
})
