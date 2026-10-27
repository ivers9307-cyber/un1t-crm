// src/lib/agent/studio-choice.test.js — MIAASKSTUDIO.1
import { describe, it, expect } from 'vitest'
import { matchStudioChoice, buildStudioChoiceBlock, CHOOSE_STUDIO_TOOL } from './studio-choice'
import { planTurnTools, planKey } from './turn-studios'
import { compactDecisionMeta } from './decision-log'

const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const CHOICES = [
  { locationId: HATCH, name: 'UN1T Hatch Street' },
  { locationId: STILL, name: 'UN1T Stillorgan' },
]

// Craig's shape: a Glofox account at Stillorgan and a un1t.online account at
// Hatch Street, active at neither, Mia on at both.
const studios = () => [
  { locationId: STILL, name: 'UN1T Stillorgan', providerKey: 'glofox', active: false, answerable: true, contactIds: ['c1'], glofoxMemberId: 'g1', liveRelationship: false },
  { locationId: HATCH, name: 'UN1T Hatch Street', providerKey: 'un1t_online', active: false, answerable: true, contactIds: ['c2'], un1tUserId: 'u1' },
]
const hatchThread = (memberStudios, channel = 'whatsapp') => planTurnTools({
  memberStudios,
  threadLocationId: HATCH,
  threadProvider: { key: 'un1t_online', capabilities: { bookings: false } },
  channel,
  un1tWrites: true,
})

describe('matchStudioChoice', () => {
  it('matches the full name, ignoring case and the UN1T prefix', () => {
    expect(matchStudioChoice(CHOICES, 'UN1T Hatch Street')?.locationId).toBe(HATCH)
    expect(matchStudioChoice(CHOICES, 'hatch street')?.locationId).toBe(HATCH)
  })

  it('matches one studio from part of its name', () => {
    expect(matchStudioChoice(CHOICES, 'Hatch')?.locationId).toBe(HATCH)
    expect(matchStudioChoice(CHOICES, 'stillorgan')?.locationId).toBe(STILL)
  })

  it('never guesses: no match, an empty name, or a name that fits both', () => {
    expect(matchStudioChoice(CHOICES, 'Rathmines')).toBeNull()
    expect(matchStudioChoice(CHOICES, '')).toBeNull()
    expect(matchStudioChoice(CHOICES, 'UN1T')).toBeNull()
    expect(matchStudioChoice(null, 'Hatch')).toBeNull()
  })
})

describe('buildStudioChoiceBlock', () => {
  it('names every studio and tells Mia to ask, or read it off the thread', () => {
    const block = buildStudioChoiceBlock(CHOICES)
    expect(block).toContain('"UN1T Hatch Street", "UN1T Stillorgan"')
    expect(block).toContain('choose_studio')
    expect(block).toContain('ask which studio')
  })

  it('is empty without at least two choices', () => {
    expect(buildStudioChoiceBlock(null)).toBe('')
    expect(buildStudioChoiceBlock([CHOICES[0]])).toBe('')
  })

  it('the tool takes one studio name', () => {
    expect(CHOOSE_STUDIO_TOOL.input_schema.required).toEqual(['studio'])
  })
})

describe('planTurnTools with studio choices', () => {
  it('no choice yet: today\'s block, and the choices to ask about', () => {
    const plan = hatchThread({ studios: studios(), readFailed: false })
    expect(plan.block).toBe('no_booking')
    expect(plan.studioChoices.map((c) => c.locationId)).toEqual([HATCH, STILL])
  })

  it('Hatch chosen: the full un1t.online block (the purchase tools), no choices', () => {
    const plan = hatchThread({ studios: studios(), readFailed: false, chosenLocationId: HATCH })
    expect(plan.block).toBe('un1t_full')
    expect(plan.un1tStudio?.locationId).toBe(HATCH)
    expect(plan.studioChoices).toBeNull()
  })

  it('never on Instagram (the choice is kept on the WhatsApp conversation)', () => {
    expect(hatchThread({ studios: studios(), readFailed: false }, 'instagram').studioChoices).toBeNull()
  })

  it('a plan that gains choices has a different key, so its prompt is rebuilt', () => {
    const without = hatchThread(undefined)
    const withChoices = hatchThread({ studios: studios(), readFailed: false })
    expect(without.block).toBe(withChoices.block)
    expect(planKey(withChoices)).not.toBe(planKey(without))
  })
})

describe('decision log', () => {
  it('records the chosen studio id', () => {
    expect(compactDecisionMeta({ chosenStudioId: HATCH })?.chosen_studio).toBe(HATCH)
  })
})
