// CARDLENS.10 — the lens filters what the page lists, "All studios" acts
// nowhere, and consent shows per studio. Source scan of the server page (a
// floor, not a proof).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const src = stripComments(readFileSync(path.join(ROOT, 'src/app/(sales)/contacts/[id]/page.js'), 'utf8')).replace(/\s+/g, ' ')

describe('CARDLENS.10 — lens filters', () => {
  it('one rule: filter only for a two-studio person on one studio; rows with no studio always show', () => {
    // Review: never filter to a studio that has no membership card (its row missing).
    expect(src).toContain('const filtering = memberships.length >= 2 && !lensAll && memberships.some((m) => m.locationId === actingId)')
    expect(src).toContain('const inLens = (row) => !filtering || !row?.location_id || row.location_id === actingId')
  })

  it.each([
    ['timeline', /mergeTimeline\(notes\.filter\(inLens\), activities\.filter\(inLens\)\)/],
    ['deals', /<ContactNextRail[^>]*deals=\{deals\.filter\(inLens\)\}/],
    ['upcoming registrations', /upcomingBookings=\{upcomingBookings\.filter\(inLens\)\}/],
    ['past registrations', /<PastEventsCard bookings=\{pastBookings\.filter\(inLens\)\}/],
    ['WhatsApp threads', /waConversations\.filter\(inLens\)\.map\(/],
    ['emails', /buildMessageHistory\(\(emailRes\.data \|\| \[\]\)\.filter\(inLens\)\)/],
  ])('%s', (_l, re) => expect(src).toMatch(re))

  it('emails carry their studio', () => {
    expect(src).toMatch(/from\('email_sends'\)\s?\.select\('id, location_id, created_at/)
  })
})

describe('CARDLENS.10 — All studios acts nowhere (Richard 2026-10-27)', () => {
  it('Note, Task and Sequence are off, and no Book card', () => {
    expect(src).toMatch(/const work = lensAll \? \{ \.\.\.actingWork, canNote: false, canTask: false, canSequence: false, canCancelForm: false, canCold: false, canLinkAccounts: false, canStartWhatsApp: false \} : actingWork/)
    expect(src).toMatch(/work\.canBook && !lensAll && actingId === contact\.location_id && \( <ContactBookingCard/)
    expect(src).toMatch(/!lensAll && un1tStudios\.filter/)
  })

  it('the composer is replaced by a pointer to the strip', () => {
    expect(src).toMatch(/\{lensAll \? \( <div[^>]*>[^<]*<p[^>]*>Viewing all studios\. Pick a studio above to send a message or add a note\.<\/p>/)
  })
})

describe('CARDLENS.10 — consent by studio', () => {
  it('reads contact_location_preferences only at studios the viewer can act at, for a multi-studio person', () => {
    expect(src).toMatch(/from\('contact_location_preferences'\)\s?\.select\('location_id, email_marketing, whatsapp_marketing'\)\s?\.eq\('contact_id', contact\.id\)\s?\.in\('location_id', actingOptions\.map\(\(o\) => o\.locationId\)\)/)
    expect(src).toMatch(/<ContactWhoRail[^>]*studioConsent=\{studioConsent\}/)
  })
})
