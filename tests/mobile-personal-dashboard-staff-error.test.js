// D4 UINITS.1 — the phone's Today "Ask a coach to cover" picker said "Could
// not load staff" (an Alert, the moment the staff read failed) even when the
// ranked colleague list (GET /api/schedule/blocks/[id]/candidates) arrived and
// the picker had plenty to show. The failure now goes where Manage mode's
// does (MANAGEMODE.1): staffLoadOutcome keeps the pool null with a reason,
// the sheet gets it as `error` (+ Try again), and candidatePickerView shows it
// only when there is no ranking and no row (mobile/lib/candidates-view.js,
// tested there). No RN component runner, so this pins the screen's wiring.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCREEN = path.join(ROOT, 'mobile/components/dashboard/PersonalDashboard.jsx')

describe('PersonalDashboard — the swap picker\'s staff read (D4 UINITS.1)', () => {
  const code = stripComments(readFileSync(SCREEN, 'utf8'))

  it('never alerts "Could not load staff" over a picker that has rows', () => {
    expect(code).not.toMatch(/Could not load staff/)
  })

  it('settles the read through staffLoadOutcome (a failed first load stays null, so the next open retries)', () => {
    expect(code).toMatch(/staffLoadOutcome\(/)
  })

  it('hands the failure to the sheet as error + onRetry, which shows it only with nothing to show', () => {
    const sheet = code.match(/<CoachPickerSheet[\s\S]*?\/>/)
    expect(sheet, 'the swap CoachPickerSheet').toBeTruthy()
    expect(sheet[0]).toMatch(/\berror=\{/)
    expect(sheet[0]).toMatch(/\bonRetry=\{/)
  })
})
