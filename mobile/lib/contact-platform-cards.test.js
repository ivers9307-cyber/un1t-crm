import { describe, it, expect } from 'vitest'
import { glofoxCardView, studioTag, latestThreadPerStudio, GLOFOX_CARD_TITLE } from './contact-platform-cards.js'

const LINKED = { glofox_member_id: 'g1' }

describe('glofoxCardView', () => {
  it('an old server (no glofox_card) renders the card as before', () => {
    expect(glofoxCardView({ success: true }, LINKED)).toMatchObject({ show: true, linked: true, title: GLOFOX_CARD_TITLE })
    expect(glofoxCardView({ success: true }, {})).toMatchObject({ show: true, linked: false })
  })
  it('a failed bundle keeps the old card', () => {
    expect(glofoxCardView('error', LINKED)).toMatchObject({ show: true, linked: true })
  })
  it('draws nothing while the bundle loads', () => {
    expect(glofoxCardView('loading', LINKED).show).toBe(false)
  })
  it('hidden: no card', () => {
    expect(glofoxCardView({ glofox_card: { mode: 'hidden', studio_name: null } }, {}).show).toBe(false)
  })
  it('pushable: the unlinked hint, reworded', () => {
    const v = glofoxCardView({ glofox_card: { mode: 'pushable', studio_name: 'UN1T Stillorgan' } }, {})
    expect(v).toEqual({ show: true, linked: false, title: 'Glofox · UN1T Stillorgan', unlinkedHint: 'Not in Glofox yet. Add them from the web CRM.' })
  })
  it('linked with and without a studio name', () => {
    expect(glofoxCardView({ glofox_card: { mode: 'linked', studio_name: 'UN1T Stillorgan' } }, LINKED).title).toBe('Glofox · UN1T Stillorgan')
    expect(glofoxCardView({ glofox_card: { mode: 'linked', studio_name: null } }, LINKED).title).toBe(GLOFOX_CARD_TITLE)
  })
})

describe('studioTag', () => {
  const bundle = { studio_tags: { h: 'Hatch Street', s: 'Stillorgan' } }
  it('names a row\'s studio', () => expect(studioTag(bundle, 'h')).toBe('Hatch Street'))
  it('null for an old server, an unknown studio or no location', () => {
    expect(studioTag({}, 'h')).toBeNull()
    expect(studioTag('loading', 'h')).toBeNull()
    expect(studioTag(bundle, 'x')).toBeNull()
    expect(studioTag(bundle, null)).toBeNull()
  })
})

describe('latestThreadPerStudio', () => {
  it('keeps the newest thread per studio, newest first, capped', () => {
    const rows = [
      { id: 'a', location_id: 'h' }, { id: 'b', location_id: 'h' },
      { id: 'c', location_id: 's' }, { id: 'd', location_id: null },
      { id: 'e', location_id: 'x' },
    ]
    expect(latestThreadPerStudio(rows).map((r) => r.id)).toEqual(['a', 'c', 'd'])
    expect(latestThreadPerStudio(rows, 5).map((r) => r.id)).toEqual(['a', 'c', 'd', 'e'])
  })
  it('tolerates junk', () => {
    expect(latestThreadPerStudio(null)).toEqual([])
    expect(latestThreadPerStudio([null, {}])).toEqual([])
  })
})
