// DATECHECK.1 — a floor, not a proof (the check:select-columns posture).
//
// isoDate (src/lib/schemas.js) checks the SHAPE of a date only, and 2026-02-30
// passes it: V8 reads it as 2 March and Postgres refuses it. Every schedule
// route now takes realIsoDate (shape AND calendar) for a schema date, or checks
// a raw query param with isRealCalendarDate. These two rules catch the
// regression that matters: a new or edited schedule route that goes back to
// the shape-only check.
//
// What they cannot see: a date that arrives some other way (a path segment, a
// body field read without a schema, a query param whose name is not
// date-like). Those still need a reviewer.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const IMPORTS_ISO_DATE = /import\s*{[^}]*\bisoDate\b[^}]*}\s*from\s*'@\/lib\/schemas'/
// A query param whose name says it is a date.
const DATE_PARAM = /searchParams\.get\(\s*'(?:[a-z_]*_date|from|to|[a-z_]*_start|[a-z_]*_end)'\s*\)/
const CALENDAR_CHECK = /\b(?:isRealCalendarDate|realIsoDate)\b/

describe('schedule routes refuse a date the calendar does not have (DATECHECK.1)', () => {
  it('the walk finds the schedule routes', () => {
    expect(ROUTES.map((r) => r.rel)).toContain(path.join('blocks', 'route.js'))
    expect(ROUTES.length).toBeGreaterThan(20)
  })

  it('a route that imports the shape-only isoDate also checks the calendar', () => {
    const offenders = ROUTES
      .filter((r) => IMPORTS_ISO_DATE.test(r.src) && !/\bisRealCalendarDate\b/.test(r.src))
      .map((r) => r.rel)
    expect(offenders).toEqual([])
  })

  it('a route that reads a date-named query param checks the calendar', () => {
    const offenders = ROUTES
      .filter((r) => DATE_PARAM.test(r.src) && !CALENDAR_CHECK.test(r.src))
      .map((r) => r.rel)
    expect(offenders).toEqual([])
  })
})
