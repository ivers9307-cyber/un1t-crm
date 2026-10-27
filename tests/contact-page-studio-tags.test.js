// CARDLENS.2 — the contact page hands studioNameMap() to every list that can
// hold rows from more than one studio, and each WhatsApp thread opens itself in
// the inbox. Source scan of the server page (a floor, not a proof); the tag
// rendering is pinned in src/components/contact/ContactRails-studio-cards.test.jsx.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const src = stripComments(readFileSync(path.join(ROOT, 'src/app/(sales)/contacts/[id]/page.js'), 'utf8')).replace(/\s+/g, ' ')

describe('CARDLENS.2 — studio tags on the contact page', () => {
  it('builds the names from the contact_studios rows', () => {
    expect(src).toContain('const studioNames = studioNameMap(contactStudios.rows)')
  })

  it.each([
    ['the timeline', /<ContactTimeline[^>]*studioNames=\{studioNames\}/],
    ['the right rail (deals, upcoming registrations)', /<ContactNextRail[^>]*studioNames=\{studioNames\}/],
    ['past registrations', /<PastEventsCard[^>]*studioNames=\{studioNames\}/],
    ['each WhatsApp thread', /<StudioTag locationId=\{conv\.location_id\} names=\{studioNames\}/],
  ])('%s gets the names', (_label, re) => {
    expect(src).toMatch(re)
  })

  it('reads each thread\'s studio and links to that thread', () => {
    expect(src).toMatch(/from\('whatsapp_conversations'\)\.select\('id, location_id,/)
    expect(src).toContain('href={`/communications/inbox?c=${conv.id}`}')
  })

  it('the Messages card has no SMS branch left (SMS retired, TWILIO-RETIRE.1)', () => {
    expect(src).not.toContain("m.channel === 'email'")
  })
})

describe('CARDLENS.1 — the page imports what decides the Glofox card', () => {
  it('imports membershipSourceState and glofoxCardMode', () => {
    expect(src).toContain("import { membershipSourceState } from '@/lib/membership/source'")
    expect(src).toContain("import { glofoxCardMode } from '@/lib/contact-platforms'")
    expect(src).toMatch(/<ContactWhoRail[^>]*glofoxMode=\{glofoxMode\}/)
  })
})
