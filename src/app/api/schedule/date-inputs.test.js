// DATECHECK.1 — a floor, not a proof (the check:select-columns posture).
//
// isoDate (src/lib/schemas.js) checks the SHAPE of a date only, and 2026-02-30
// passes it: V8 reads it as 2 March and Postgres refuses it. Every schedule
// route now takes realIsoDate (shape AND calendar) for a schema date, or checks
// a raw query param with isRealCalendarDate. Two rules, both judged PER VALUE
// (one checked read no longer excuses another in the same file, which is how
// time-off/route.js on main would have passed: its preview checked, its list
// did not):
//
//   1. every schema field that checks only the shape (`name: isoDate`, or a
//      route-local `name: z.string().regex(/^\d{4}-\d{2}-\d{2}$/…)`) is
//      calendar-checked by name; plus a backstop that a file using either
//      shape check calls isRealCalendarDate somewhere;
//   2. every date-named query param read (either quote; *_date/_start/_end/
//      _from/_to/_day/_week/_month, date, day, week, month, from, to, since,
//      until, start, end) lands in a variable or key that is calendar-checked.
//
// "Calendar-checked" means: its schema field is realIsoDate, it is passed to
// isRealCalendarDate(x) directly, or it sits in the [['label', x], …] list
// the routes loop over with isRealCalendarDate.
//
// FALSE ALARMS it can raise (it fails closed): a non-date param whose name
// ends in a date-like suffix, e.g. `assigned_to` or `created_by_day`, is
// treated as a date. Rename or calendar-check it; don't loosen the pattern.
//
// BLIND SPOTS — still a reviewer's job, deliberately not chased with regex:
//   - a date in a path segment ([date]/route.js), a header, or a body field
//     read without a schema (`body.start_date` straight into a query);
//   - a query param whose name is not date-like (`?d=`, `?period=`, `?year=`),
//     or a params object not named *params (`sp.get('from')`);
//   - "checked" is judged by NAME, not by data flow: a check on a different
//     variable of the same name, a check that runs after the read it guards,
//     or a check whose result is ignored all pass;
//   - a shape schema aliased first (`const D = isoDate; … from: D`) is caught
//     only by the file-wide backstop;
//   - range SPAN is not checked here (each route's own tests pin its cap);
//     range ORDER is Rule 3 below, for query params only — a body range
//     (rosters, reports, time-off POST) is its route test's job.
//
// RANGEVALID.1 — Rule 3: a route that reads BOTH ends of a query range
// (start_date/end_date, from/to, start/end, period_start/period_end) hands
// them together to rangeQueryError / reportPeriodError, or compares them
// inline (`end < start` or `start > end`). A bound handed to either helper
// also counts as calendar-checked for Rule 2 (the helpers check each bound).
// Rule 3 reads the source with its comments stripped: a comment is never the
// check.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../tests/helpers/js-code.js'

const SCHEDULE_DIR = path.dirname(fileURLToPath(import.meta.url))

function routeFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (entry.name === 'route.js') out.push(full)
  }
  return out
}

const ROUTES = routeFiles(SCHEDULE_DIR).map((file) => ({
  rel: path.relative(SCHEDULE_DIR, file),
  src: fs.readFileSync(file, 'utf8'),
}))

// An import of the shape-only isoDate from the shared schemas (comments that
// merely mention it do not count).
const IMPORTS_ISO_DATE = /import\s*{[^}]*\bisoDate\b[^}]*}\s*from\s*['"]@\/lib\/schemas['"]/
// The shape-only pattern written out in a route instead of imported.
const LOCAL_SHAPE = String.raw`z\.string\(\)\.regex\(\s*\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/`
// A schema field that checks only the shape: `name: isoDate…` or
// `name: z.string().regex(/^\d{4}-\d{2}-\d{2}$/…)`.
const SHAPE_FIELD = new RegExp(String.raw`([\w$]+)\s*:\s*(?:isoDate\b|${LOCAL_SHAPE})`, 'g')

// A query param whose name says it is a date, read in either quote, and the
// thing it is read into: `const x = …get('…')` (group 1) or `key: …get('…')`
// (group 2). A read in any other form is an offender (the guard cannot follow it).
const DATE_NAME = String.raw`[a-z_]*_(?:date|start|end|from|to|day|week|month)|date|day|week|month|from|to|since|until|start|end`
const PARAM_READ = new RegExp(
  String.raw`(?:(?:const|let|var)\s+([\w$]+)\s*=\s*|([\w$]+)\s*:\s*)?[\w$.]*[pP]arams\.get\(\s*(['"])(?:${DATE_NAME})\3\s*\)`,
  'g',
)

const escapeRe = (s) => s.replace(/[$]/g, '\\$')

/**
 * Is the value called `name` (a variable, or a schema / object key) checked
 * against the calendar? Either its schema field is realIsoDate, or it is
 * handed to isRealCalendarDate directly, or it sits in the
 * [['label', value], …] list that a loop hands to isRealCalendarDate.
 */
function calendarChecked(src, name) {
  const n = escapeRe(name)
  if (new RegExp(String.raw`(?<![\w$])${n}\s*:\s*realIsoDate\b`).test(src)) return true
  if (new RegExp(String.raw`isRealCalendarDate\(\s*(?:[\w$]+\.)?${n}\s*\)`).test(src)) return true
  // RANGEVALID.1 — the shared range helpers check each bound they are handed
  // (first or second argument).
  if (new RegExp(String.raw`\b(?:rangeQueryError|reportPeriodError)\(\s*(?:[\w$.]+\s*,\s*)?(?:[\w$]+\.)?${n}\s*[,)]`).test(src)) return true
  return /isRealCalendarDate\(/.test(src)
    && new RegExp(String.raw`\[\s*['"][\w]+['"]\s*,\s*(?:[\w$]+\.)?${n}\s*\]`).test(src)
}

/** Rule 1: a shape-only schema date whose own field is not calendar-checked. */
function shapeOnlyOffence(src) {
  for (const [, field] of src.matchAll(SHAPE_FIELD)) {
    if (!calendarChecked(src, field)) return true
  }
  // Backstop for a shape check the field rule cannot see (aliased to a const
  // first, say): the file must at least call the calendar check somewhere.
  const shapeAnywhere = IMPORTS_ISO_DATE.test(src) || new RegExp(LOCAL_SHAPE).test(src)
  return shapeAnywhere && !/\bisRealCalendarDate\b/.test(src)
}

/** Rule 2: a date-named query param read whose own value is not calendar-checked. */
function uncheckedParamOffence(src) {
  for (const [, variable, key] of src.matchAll(PARAM_READ)) {
    const name = variable || key
    if (!name || !calendarChecked(src, name)) return true
  }
  return false
}

// RANGEVALID.1 — Rule 3. The two ends of a query range, and the names they
// are read into (`const x = …get('…')` or `key: …get('…')`), in file order:
// the i-th start read pairs with the i-th end read (time-off reads its list
// pair, then its preview pair).
const RANGE_PAIRS = [['start_date', 'end_date'], ['from', 'to'], ['start', 'end'], ['period_start', 'period_end']]
const NAMED_PARAM_READ = new RegExp(
  String.raw`(?:(?:const|let|var)\s+([\w$]+)\s*=\s*|([\w$]+)\s*:\s*)?[\w$.]*[pP]arams\.get\(\s*(['"])(\w+)\3\s*\)`,
  'g',
)

// The source with its `//` and `/* */` comments blanked, so a comment that
// reads like the check (`// TODO: refuse endDate < startDate`) never counts as
// one: the TypeScript parser's comment ranges (tests/helpers/js-code.js), not a
// hand state machine that lost track after a regex literal (GUARDSTRIP.1).

/** Rule 3: both ends of a query range are read, and never put in order. */
function unorderedPairOffence(rawSrc) {
  const src = stripComments(rawSrc)
  const reads = [...src.matchAll(NAMED_PARAM_READ)].map((m) => ({ binding: m[1] || m[2] || null, param: m[4] }))
  for (const [startParam, endParam] of RANGE_PAIRS) {
    const starts = reads.filter((r) => r.param === startParam)
    const ends = reads.filter((r) => r.param === endParam)
    for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
      const s = starts[i].binding
      const e = ends[i].binding
      if (!s || !e) return true // read in a form the guard cannot follow
      const S = escapeRe(s)
      const E = escapeRe(e)
      const viaHelper = new RegExp(String.raw`\b(?:rangeQueryError|reportPeriodError)\(\s*(?:[\w$]+\.)?${S}\s*,\s*(?:[\w$]+\.)?${E}\s*[,)]`).test(src)
      // `end < start` or `start > end`; strict only, as the routes write it.
      const inline = new RegExp(String.raw`(?<![\w$.])${E}\s*<\s*${S}(?![\w$])`).test(src)
        || new RegExp(String.raw`(?<![\w$.])${S}\s*>\s*${E}(?![\w$])`).test(src)
      if (!viaHelper && !inline) return true
    }
  }
  return false
}

describe('the guard\'s own rules, on sources written to break them', () => {
  it('rule 2 is per param: one checked read does not excuse another', () => {
    // time-off/route.js on main: the preview checked its start, the list did not.
    const src = `
      import { isRealCalendarDate } from '@/lib/schemas'
      const startDate = searchParams.get('start_date')
      const start = searchParams.get('start_date') || ''
      if (!isRealCalendarDate(start)) return bad()`
    expect(uncheckedParamOffence(src)).toBe(true)
  })

  it('rule 2 sees double quotes and plain date/week/month names', () => {
    for (const src of [
      `const d = searchParams.get("start_date")`,
      `const d = searchParams.get('date')`,
      `const d = url.searchParams.get('week')`,
      `const d = searchParams.get('month')`,
      `const d = searchParams.get('shift_day')`,
    ]) expect(uncheckedParamOffence(src)).toBe(true)
  })

  it('rule 2 passes each checked form in use', () => {
    for (const src of [
      // hand-read, checked in the name/value loop (blocks, shifts, time-off list)
      `const startDate = searchParams.get('start_date')
       for (const [name, value] of [['start_date', startDate]]) { if (value && !isRealCalendarDate(value)) {} }`,
      // hand-read, checked directly (time-off preview)
      `const start = searchParams.get('start_date') || ''
       if (!isRealCalendarDate(start)) {}`,
      // a query schema field (overview, week-cost, contractor-spend)
      `const Q = z.object({ week_start: realIsoDate })
       Q.safeParse({ week_start: url.searchParams.get('week_start') })`,
      // shape schema, then the loop (change-log)
      `const Q = z.object({ from: isoDate })
       Q.safeParse({ from: url.searchParams.get('from') })
       for (const [name, value] of [['from', from]]) { if (!isRealCalendarDate(value)) {} }`,
    ]) expect(uncheckedParamOffence(src)).toBe(false)
  })

  it('rule 2 does not mistake a non-date param for a date', () => {
    for (const src of [`searchParams.get('location_id')`, `searchParams.get('status')`, `searchParams.get('year')`, `searchParams.get('for_me')`]) {
      expect(uncheckedParamOffence(src)).toBe(false)
    }
  })

  it('rule 1 sees a route-local shape regex, not only the shared isoDate', () => {
    const src = `const Q = z.object({ from: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/, 'YYYY-MM-DD') })`
    expect(shapeOnlyOffence(src)).toBe(true)
  })

  it('rule 1 is per field: a calendar check on one field does not excuse another', () => {
    const src = `
      import { isoDate, isRealCalendarDate } from '@/lib/schemas'
      const S = z.object({ start_date: isoDate, end_date: isoDate })
      if (!isRealCalendarDate(body.start_date)) {}`
    expect(shapeOnlyOffence(src)).toBe(true)
  })

  it('rule 1 passes realIsoDate fields and a shape field checked by name', () => {
    for (const src of [
      `import { realIsoDate } from '@/lib/schemas'
       const S = z.object({ block_date: realIsoDate })`,
      `import { isoDate, isRealCalendarDate } from '@/lib/schemas'
       const Q = z.object({ from: isoDate })
       for (const [name, value] of [['from', from]]) { if (!isRealCalendarDate(value)) {} }`,
    ]) expect(shapeOnlyOffence(src)).toBe(false)
  })

  it('rule 2 passes a bound handed to the shared range helpers (RANGEVALID.1)', () => {
    for (const src of [
      `const startDate = searchParams.get('start_date')
       const endDate = searchParams.get('end_date')
       const rangeError = rangeQueryError(startDate, endDate, { maxDays: 92 })`,
      `const start = searchParams.get('start') || undefined
       const end = searchParams.get('end') || undefined
       const e = rangeQueryError(start, end, { startName: 'start', endName: 'end' })`,
    ]) expect(uncheckedParamOffence(src)).toBe(false)
  })

  it('rule 3 flags a query range whose ends are never put in order', () => {
    expect(unorderedPairOffence(`
      const startDate = searchParams.get('start_date')
      const endDate = searchParams.get('end_date')
      for (const [name, value] of [['start_date', startDate], ['end_date', endDate]]) { if (value && !isRealCalendarDate(value)) {} }`)).toBe(true)
    // the helper with the ends swapped does not order them
    expect(unorderedPairOffence(`
      const startDate = searchParams.get('start_date')
      const endDate = searchParams.get('end_date')
      rangeQueryError(endDate, startDate)`)).toBe(true)
    // nor does the inline comparison turned round
    expect(unorderedPairOffence(`
      const startDate = searchParams.get('start_date')
      const endDate = searchParams.get('end_date')
      if (endDate > startDate) {}`)).toBe(true)
  })

  it('rule 3 is not satisfied by a comment that looks like the check', () => {
    for (const src of [
      `const startDate = searchParams.get('start_date')
       const endDate = searchParams.get('end_date')
       // TODO: refuse endDate < startDate
       return list(startDate, endDate)`,
      `const startDate = searchParams.get('start_date')
       const endDate = searchParams.get('end_date')
       /* rangeQueryError(startDate, endDate) was here */
       return list(startDate, endDate)`,
    ]) expect(unorderedPairOffence(src)).toBe(true)
  })

  it('rule 3 is per pair: an ordered preview does not excuse an unordered list (time-off on main)', () => {
    expect(unorderedPairOffence(`
      const startDate = searchParams.get('start_date')
      const endDate = searchParams.get('end_date')
      const start = searchParams.get('start_date') || ''
      const end = searchParams.get('end_date') || start
      if (end < start) {}`)).toBe(true)
  })

  it('rule 3 passes each ordered form in use', () => {
    for (const src of [
      // the helper (blocks, shifts, offers, the time-off list, overview)
      `const startDate = searchParams.get('start_date')
       const endDate = searchParams.get('end_date')
       const rangeError = rangeQueryError(startDate, endDate, { maxDays: 92 })`,
      `const Q = z.object({ from: realIsoDate, to: realIsoDate })
       Q.safeParse({ from: url.searchParams.get('from'), to: url.searchParams.get('to') })
       const periodError = reportPeriodError(from, to, { startName: 'from', endName: 'to', maxDays: 60 })`,
      // inline (availability, change-log, compare, the time-off preview)
      `const startDate = url.searchParams.get('start_date')
       const endDate = url.searchParams.get('end_date')
       if (endDate < startDate) return bad('end_date must be on or after start_date')`,
      `const parsed = Q.safeParse({ from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined })
       if (from && to && to < from) return fail(400, 'to must be on or after from')`,
      // inline, the same comparison written start-first
      `const startDate = url.searchParams.get('start_date')
       const endDate = url.searchParams.get('end_date')
       if (startDate > endDate) return bad('end_date must be on or after start_date')`,
      // one end alone is not a range (grid's start_date, week-cost's week_start)
      `const d = url.searchParams.get('start_date')`,
    ]) expect(unorderedPairOffence(src)).toBe(false)
  })
})

describe('schedule routes refuse a date the calendar does not have (DATECHECK.1)', () => {
  it('the walk finds the schedule routes', () => {
    expect(ROUTES.map((r) => r.rel)).toContain(path.join('blocks', 'route.js'))
    expect(ROUTES.length).toBeGreaterThan(20)
  })

  it('a route that takes a shape-only schema date also checks the calendar', () => {
    expect(ROUTES.filter((r) => shapeOnlyOffence(r.src)).map((r) => r.rel)).toEqual([])
  })

  it('a route that reads a date-named query param checks the calendar', () => {
    expect(ROUTES.filter((r) => uncheckedParamOffence(r.src)).map((r) => r.rel)).toEqual([])
  })

  it('a route that reads both ends of a query range puts them in order (RANGEVALID.1)', () => {
    expect(ROUTES.filter((r) => unorderedPairOffence(r.src)).map((r) => r.rel)).toEqual([])
  })
})
