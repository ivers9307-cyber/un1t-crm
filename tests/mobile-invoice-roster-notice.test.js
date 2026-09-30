// D4 UINITS.1 (found planning A3) — the phone's invoice detail and the
// Approvals card's roster check say something when the roster comparison
// could not be read (rosterUnreadableNotice, mobile/lib/invoice-review.js,
// tested there). No RN component runner, so this pins the wiring.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (rel) => stripComments(readFileSync(path.join(ROOT, rel), 'utf8'))

describe('the roster-unreadable notice reaches both phone surfaces (D4 UINITS.1)', () => {
  it('invoice detail renders it beside the comparison', () => {
    const code = read('mobile/app/(staff)/invoices/[id].jsx')
    expect(code).toMatch(/rosterUnreadableNotice\(data\)/)
    expect(code).toMatch(/<RosterUnreadable text=\{rosterNotice\} \/>/)
  })

  it('the Approvals card\'s roster check renders it instead of the generic line', () => {
    const code = read('mobile/components/invoices/RosterComparison.jsx')
    expect(code).toMatch(/notice: rosterUnreadableNotice\(r\.data\)/)
    expect(code).toMatch(/<RosterUnreadable text=\{state\.notice\} compact \/>/)
  })
})
