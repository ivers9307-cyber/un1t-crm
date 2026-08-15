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
//
// HUBS.2f Task 1 adaptation — the standalone `/communications/tickets`
// SIDEBAR entry this file used to pin (`byHref(ALL_NAV, …)`) is gone: it
// collapsed into the single Messages hub entry, and nav-items.test.js now
// owns that guarantee (`email_inbox` folded into the Messages entry's
// anyPermission union). "Email inbox" as a LABEL didn't go away though — it
// still names the CommunicationsTabs tab for that same route, and that half
// was never this file's job to guard: CommunicationsTabs.test.jsx already
// pins the tab-label list (`['Send', 'Sent', 'Inbox', 'Email inbox',
// 'Templates', 'Segments']`) with `canEmailInbox` gating it. So this file's
// remaining guarantee is narrower but still real: the ⌘K palette command
// (a separate deep link, independent of the sidebar) keeps its label + href.
import { describe, it, expect } from 'vitest'
import { NAV_COMMANDS } from './command-palette.js'

const byHref = (list, href) => list.find((i) => i.href === href)

describe('COMMS-IA.3 — the email ticket queue is labelled "Email inbox"', () => {
  it('command palette entry', () => {
    expect(byHref(NAV_COMMANDS, '/communications/tickets')?.label).toBe('Email inbox')
  })

  it('leaves the route, permission and id alone — labels only', () => {
    const cmd = byHref(NAV_COMMANDS, '/communications/tickets')
    expect(cmd.permission).toBe('email_inbox')
    expect(cmd.id).toBe('email-tickets')
  })
})
