// ROLEUI.2 — the contact page hands every formerly ungated component its flag
// from contactWorkGates (src/lib/contact-page-gates.js, judged at the
// CONTACT's location). The decisions are pinned in
// src/lib/contact-page-gates-roleui2.test.js and each component's own test;
// this pins the WIRING, which neither of those can see: a component that
// fails closed but is never handed its flag hides a button from everyone.
// A source scan (the page is an async server component that loads a dozen
// tables): a floor, not a proof.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const page = stripComments(readFileSync(path.join(ROOT, 'src/app/(sales)/contacts/[id]/page.js'), 'utf8'))
const squash = (s) => s.replace(/\s+/g, ' ')
const src = squash(page)

describe('ROLEUI.2 — the contact page wires contactWorkGates into each component', () => {
  it('computes the gates at the contact', () => {
    expect(src).toContain('const work = contactWorkGates(user, contact)')
  })

  it.each([
    ['the header kebab (Task, Sequence, cancellation form, Cold)', /<ContactHeaderBand[^>]*actionGates=\{work\}/],
    ['Linked accounts', /<ContactWhoRail[^>]*canLinkAccounts=\{work\.canLinkAccounts\}/],
    ['Note', /<ContactActions[^>]*canNote=\{work\.canNote\}/],
    ['Activity', /<ContactActions[^>]*canTask=\{work\.canTask\}/],
    ['Sequence', /<ContactActions[^>]*canSequence=\{work\.canSequence\}/],
    ['Start WhatsApp', /\{work\.canStartWhatsApp && \( <StartWhatsAppButton/],
    ['the Book card', /\{work\.canBook && \( <ContactBookingCard/],
    ['the consent history', /\{work\.canReadConsent && \( <div className="mt-8"> <ContactConsentHistoryCard/],
  ])('%s', (_label, re) => {
    expect(src).toMatch(re)
  })
})
