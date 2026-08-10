// COMMS-IA.3 / COMMS-IA.4 — two operator-facing renames the product owner
// decided, guarded here because each one has to be made in several places at
// once and a half-done rename is worse than none.
//
//  .3  "Sends" → "Sent" (the route has been /communications/sent all along)
//      and the sidebar / palette / tab label "Email" → "Email inbox". The
//      second one reverses INBOX-SPLIT.1 — see the note on the tab itself.
//  .4  "Templates" meant two things. Content templates (email + WhatsApp) keep
//      the plain word; the packaged automation ones are "Automation recipes",
//      matching the language src/lib/sequence-templates.js and the gallery
//      copy already used ("pre-built recipes" / "Pre-built automation
//      recipes"). Routes, tables and identifiers are deliberately unchanged.

import { describe, it, expect } from 'vitest'
import { ALL_NAV } from './nav-items.js'
import { NAV_COMMANDS } from './command-palette.js'

const byHref = (list, href) => list.find((i) => i.href === href)

describe('COMMS-IA.3 — the email ticket queue is labelled "Email inbox"', () => {
  it('sidebar entry', () => {
    expect(byHref(ALL_NAV, '/communications/tickets')?.label).toBe('Email inbox')
  })

  it('command palette entry', () => {
    expect(byHref(NAV_COMMANDS, '/communications/tickets')?.label).toBe('Email inbox')
  })

  it('leaves the route, permission and id alone — labels only', () => {
    const nav = byHref(ALL_NAV, '/communications/tickets')
    expect(nav.permission).toBe('email_inbox')
    expect(byHref(NAV_COMMANDS, '/communications/tickets').id).toBe('email-tickets')
  })
})
