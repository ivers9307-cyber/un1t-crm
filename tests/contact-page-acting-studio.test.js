// CARDLENS.6 — the contact page acts at ONE studio (the acting studio) and
// hands it to every piece that sends, notes, books or reads that studio's
// templates. Source scan of the server page (a floor, not a proof): the
// decisions are pinned in src/lib/contact-acting-studio.test.js and
// src/lib/contact-page-gates-acting.test.js.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const src = stripComments(readFileSync(path.join(ROOT, 'src/app/(sales)/contacts/[id]/page.js'), 'utf8')).replace(/\s+/g, ' ')

describe('CARDLENS.6 — the contact page acts at the acting studio', () => {
  it('picks the studio from ?studio=, the options and the viewer', () => {
    expect(src).toContain('actingStudioOptions({ user, contact, studioRows: contactStudios.rows })')
    expect(src).toMatch(/pickActingStudio\(\{ options: actingOptions, requested: searchParams\?\.studio/)
  })

  it.each([
    ['channel flags', /contactChannelFlags\(user, actingId\)/],
    ['work gates', /contactWorkGates\(user, contact, \{ actingLocationId: actingId \}\)/],
    ['composer sends for it', /<ContactComposer[^>]*contactLocationId=\{actingId\}[^>]*sendLocationId=\{actingId\}/],
    ['Timeline actions', /<ContactActions[^>]*locationId=\{actingId\}/],
    ['header kebab (task, sequence)', /<ContactHeaderBand[^>]*actingLocationId=\{actingId\}/],
    ['Book card', /<ContactBookingCard[^>]*locationId=\{actingId\}/],
    ['studio bar', /<ActingStudioBar options=\{actingOptions\} actingId=\{actingId\}/],
    ['templates at that studio', /from\('whatsapp_templates'\)[^;]*\.eq\('location_id', actingId\)/],
    ['event types at that studio', /from\('event_types'\)[^;]*\.eq\('location_id', actingId\)/],
    ['the WhatsApp window is that studio\'s thread', /waConversations\.find\(\(c\) => c\.location_id === actingId\)/],
    ['un1t.online booking only for that studio', /un1tStudios\.filter\(\(s\) => s\.locationId === actingId\)/],
  ])('%s', (_label, re) => {
    expect(src).toMatch(re)
  })

  it('the Glofox Book card shows only where the acting studio runs Glofox or nothing', () => {
    expect(src).toMatch(/work\.canBook && bookHereWithGlofox && \( <ContactBookingCard/)
  })
})
