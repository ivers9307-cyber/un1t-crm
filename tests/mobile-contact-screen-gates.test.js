// ROLEUI.1 — the phone's contact screen never judges an action at the ACTIVE
// studio. Its buttons read contactActionFlags (mobile/lib/contact-actions.js)
// over the server's per-contact `permissions`, and its Supabase-direct reads
// (event bookings) are left to RLS, which decides at the row's location. So
// the screen calls no canDashboard( and no canMobile( (comments ignored). The
// WhatsApp thread row kept an active-studio canMobile until INBOXLOC.1 (C37)
// moved the thread screen and its routes to the conversation's studio; the
// row now shows whatever thread RLS returns (wa_conv_select judges mobile
// `whatsapp` at the conversation's studio). There is no RN component test runner, so the
// decision is pinned in mobile/lib and this pins the screen's use of it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCREEN = path.join(ROOT, 'mobile/app/(staff)/contacts/[id].jsx')

describe('ROLEUI.1 — phone contact screen', () => {
  const code = stripComments(readFileSync(SCREEN, 'utf8'))

  it('has no active-studio permission check at all (INBOXLOC.1 removed the last, on the thread row)', () => {
    expect(code.match(/\bcanDashboard\(/g) || []).toEqual([])
    expect(code.match(/\bcanMobile\(/g) || []).toEqual([])
  })

  it('reads the contact\'s WhatsApp thread with no client gate (RLS decides at the thread\'s studio)', () => {
    expect(code).toMatch(/getWhatsAppThreadForContact\(id\)/)
    expect(code).not.toMatch(/canOpenWhatsAppThread/)
  })

  it('reads its button flags from the bundle through contactActionFlags', () => {
    expect(code).toMatch(/contactActionFlags\(/)
    expect(code).toMatch(/res\.permissions/)
  })
})
