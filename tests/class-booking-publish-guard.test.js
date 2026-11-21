// BOOKQUEUE.1 guard. Class bookings reach Glofox one at a time: every
// class_booking_requests row is published only through publishClassBookingJob
// (src/lib/qstash.js), which enqueues on the class-bookings QStash queue at
// parallelism 1. A plain publish to the worker runs bookings side by side, and
// Glofox refused two of five simultaneous bookings with YOU_HAVE_NO_CREDITS_LEFT
// on an account holding credits (20 Nov 2026).
//
// So no app file names CLASS_BOOKINGS_WORKER_PATH except qstash.js (which
// defines it and the helper) and the worker route (which checks its own URL).
// A floor, not a proof: a path assembled at runtime is invisible here.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const ALLOWED = new Set([
  'src/lib/qstash.js',
  'src/app/api/webhooks/qstash/class-bookings/route.js',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|jsx|mjs|ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full)
  }
  return out
}

describe('class bookings publish only through the one-at-a-time queue', () => {
  it('no app file names CLASS_BOOKINGS_WORKER_PATH outside qstash.js and the worker', () => {
    const offenders = walk(path.join(ROOT, 'src'))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => {
        const code = stripComments(readFileSync(path.join(ROOT, rel), 'utf8'), rel)
        return code.includes('CLASS_BOOKINGS_WORKER_PATH')
      })
    expect(offenders).toEqual([])
  })

  it('the helper enqueues on the class-bookings queue at parallelism 1', () => {
    const src = readFileSync(path.join(ROOT, 'src/lib/qstash.js'), 'utf8')
    expect(src).toMatch(/CLASS_BOOKINGS_QUEUE_PARALLELISM = 1\b/)
    expect(src).toMatch(/queueName: CLASS_BOOKINGS_QUEUE_NAME/)
  })
})
