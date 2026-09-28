// ROLEUI.1 — the phone's contact screen never judges an action at the ACTIVE
// studio. Its buttons read contactActionFlags (mobile/lib/contact-actions.js)
// over the server's per-contact `permissions`, and its Supabase-direct reads
// (event bookings) are left to RLS, which decides at the row's location. So
// the screen calls no canDashboard( and exactly one canMobile(, for the
// WhatsApp thread row (comments ignored). There is no RN component test runner, so the
// decision is pinned in mobile/lib and this pins the screen's use of it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCREEN = path.join(ROOT, 'mobile/app/(staff)/contacts/[id].jsx')

describe('ROLEUI.1 — phone contact screen', () => {
  const code = stripComments(readFileSync(SCREEN, 'utf8'))

  it('has no active-studio permission check on an action (one exception, below)', () => {
    expect(code.match(/\bcanDashboard\(/g) || []).toEqual([])
    // The ONLY canMobile left gates the WhatsApp THREAD row, which opens the
    // active-studio inbox screen (its route, GET /api/whatsapp/conversations/
    // [id], gates on the active studio too). No channel, cancel-form or kudos
    // button may use one.
    expect(code.match(/\bcanMobile\([^)]*\)/g) || []).toEqual(["canMobile(profile, 'whatsapp', activeLocation)"])
  })

  it('reads its button flags from the bundle through contactActionFlags', () => {
    expect(code).toMatch(/contactActionFlags\(/)
    expect(code).toMatch(/res\.permissions/)
  })
})
